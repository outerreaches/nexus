import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { defineTool } from "../core/tools.js";

const execFileAsync = promisify(execFile);
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;
const QUEUE_ROOT_NAME = "deploy-queue";

type QueueState = "pending" | "processing" | "done" | "failed";

type DeployRequest = {
  id: string;
  commitSha: string;
  finalize: boolean;
  reason: string;
  requestedAt: string;
  requestedAtMs: number;
  requestedBy: string;
  source: "agent";
  channel: string;
  channelKey: string;
  agentId: string;
};

type QueueEntry = {
  state: QueueState;
  file: string;
  id: string;
  commitSha: string;
  finalize: boolean;
  reason: string;
  requestedAt: string;
  requestedAtMs: number;
  requestedBy: string;
  channel: string;
  channelKey: string;
  agentId: string;
};

function queueDirs(stateDir: string): Record<QueueState, string> {
  const root = path.join(stateDir, QUEUE_ROOT_NAME);
  return {
    pending: path.join(root, "pending"),
    processing: path.join(root, "processing"),
    done: path.join(root, "done"),
    failed: path.join(root, "failed"),
  };
}

async function ensureQueue(stateDir: string): Promise<Record<QueueState, string>> {
  const dirs = queueDirs(stateDir);
  for (const dir of Object.values(dirs)) {
    await fs.mkdir(dir, { recursive: true });
  }
  return dirs;
}

async function gitCommitExists(codeDir: string, commitSha: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", codeDir, "cat-file", "-e", `${commitSha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
}

async function readQueueEntries(dir: string, state: QueueState): Promise<QueueEntry[]> {
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const files = names.filter((n) => n.endsWith(".json")).sort();
  const out: QueueEntry[] = [];
  for (const name of files) {
    const full = path.join(dir, name);
    try {
      const raw = await fs.readFile(full, "utf8");
      const parsed = JSON.parse(raw) as Partial<DeployRequest>;
      if (!parsed || typeof parsed !== "object") continue;
      const id = typeof parsed.id === "string" ? parsed.id : name.replace(/\.json$/, "");
      const commitSha = typeof parsed.commitSha === "string" ? parsed.commitSha : "";
      const finalize = Boolean(parsed.finalize);
      const reason = typeof parsed.reason === "string" ? parsed.reason : "";
      const requestedAt = typeof parsed.requestedAt === "string" ? parsed.requestedAt : "";
      const requestedAtMs = typeof parsed.requestedAtMs === "number" ? parsed.requestedAtMs : 0;
      const requestedBy = typeof parsed.requestedBy === "string" ? parsed.requestedBy : "unknown";
      const channel = typeof parsed.channel === "string" ? parsed.channel : "unknown";
      const channelKey = typeof parsed.channelKey === "string" ? parsed.channelKey : "unknown";
      const agentId = typeof parsed.agentId === "string" ? parsed.agentId : "unknown";
      out.push({
        state,
        file: full,
        id,
        commitSha,
        finalize,
        reason,
        requestedAt,
        requestedAtMs,
        requestedBy,
        channel,
        channelKey,
        agentId,
      });
    } catch {
      // Ignore malformed files so queue remains robust.
    }
  }
  return out;
}

async function listAllEntries(stateDir: string): Promise<QueueEntry[]> {
  const dirs = queueDirs(stateDir);
  const [pending, processing, done, failed] = await Promise.all([
    readQueueEntries(dirs.pending, "pending"),
    readQueueEntries(dirs.processing, "processing"),
    readQueueEntries(dirs.done, "done"),
    readQueueEntries(dirs.failed, "failed"),
  ]);
  return [...pending, ...processing, ...done, ...failed].sort((a, b) => b.requestedAtMs - a.requestedAtMs);
}

export const haDeployRequest = defineTool({
  name: "ha_deploy_request",
  description:
    "Queue a host-side HA deployment request by commit SHA. " +
    "The host deployer daemon consumes requests from state/deploy-queue and runs ha-rollout.",
  parameters: z.object({
    commitSha: z
      .string()
      .min(7)
      .max(40)
      .describe("Git commit SHA to deploy (7-40 hex chars). Must exist in the code repository."),
    finalize: z
      .boolean()
      .default(true)
      .describe("If true, host deployer runs finalize after successful deploy."),
    reason: z
      .string()
      .max(400)
      .default("Requested by orchestrator after coder commit")
      .describe("Short reason/audit note."),
    requestId: z
      .string()
      .max(80)
      .optional()
      .describe("Optional stable request ID. If omitted, a generated ID is used."),
  }),
  execute: async (args, ctx) => {
    const commitSha = args.commitSha.trim();
    if (!COMMIT_RE.test(commitSha)) {
      return "ERROR: commitSha must be 7-40 hexadecimal characters";
    }
    if (!ctx.stateDir) return "ERROR: stateDir is not available";
    if (!ctx.codeDir) return "ERROR: codeDir is not available";

    const commitExists = await gitCommitExists(ctx.codeDir, commitSha);
    if (!commitExists) {
      return `ERROR: commit ${commitSha} does not exist in ${ctx.codeDir}`;
    }

    const dirs = await ensureQueue(ctx.stateDir);
    const existing = (await Promise.all([
      readQueueEntries(dirs.pending, "pending"),
      readQueueEntries(dirs.processing, "processing"),
    ]))
      .flat()
      .find((e) => e.commitSha.toLowerCase() === commitSha.toLowerCase());
    if (existing) {
      return JSON.stringify(
        {
          ok: true,
          queued: false,
          message: "deploy request already queued",
          requestId: existing.id,
          commitSha: existing.commitSha,
          state: existing.state,
          file: existing.file,
        },
        null,
        2,
      );
    }

    const nowMs = ctx.nowMs();
    const requestId = sanitizeId(args.requestId?.trim() || `deploy-${nowMs}-${crypto.randomBytes(3).toString("hex")}`);
    const payload: DeployRequest = {
      id: requestId,
      commitSha,
      finalize: args.finalize,
      reason: args.reason.trim(),
      requestedAt: new Date(nowMs).toISOString(),
      requestedAtMs: nowMs,
      requestedBy: ctx.request?.agentId ?? "orchestrator",
      source: "agent",
      channel: ctx.request?.channel ?? "unknown",
      channelKey: ctx.request?.channelKey ?? "unknown",
      agentId: ctx.request?.agentId ?? "unknown",
    };
    const filename = `${String(nowMs).padStart(13, "0")}-${requestId}.json`;
    const fullPath = path.join(dirs.pending, filename);
    await fs.writeFile(fullPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    ctx.log(`ha-deploy: queued request id=${requestId} commit=${commitSha} finalize=${args.finalize ? "1" : "0"}`);

    return JSON.stringify(
      {
        ok: true,
        queued: true,
        requestId,
        commitSha,
        finalize: args.finalize,
        queueFile: fullPath,
        nextStep: "Host deployer daemon will pick up this request automatically.",
      },
      null,
      2,
    );
  },
});

export const haDeployStatus = defineTool({
  name: "ha_deploy_status",
  description: "Read deploy queue status from state/deploy-queue (pending, processing, done, failed).",
  parameters: z.object({
    requestId: z.string().max(80).optional().describe("Optional request id filter."),
    limit: z.number().int().min(1).max(50).default(10).describe("Max entries to return."),
  }),
  execute: async (args, ctx) => {
    if (!ctx.stateDir) return "ERROR: stateDir is not available";
    await ensureQueue(ctx.stateDir);
    const all = await listAllEntries(ctx.stateDir);
    const filtered = args.requestId ? all.filter((e) => e.id === args.requestId) : all;
    const entries = filtered.slice(0, args.limit).map((e) => ({
      id: e.id,
      state: e.state,
      commitSha: e.commitSha,
      finalize: e.finalize,
      reason: e.reason,
      requestedAt: e.requestedAt,
      requestedBy: e.requestedBy,
      channel: e.channel,
      channelKey: e.channelKey,
      agentId: e.agentId,
      file: e.file,
    }));

    const summary = {
      pending: all.filter((e) => e.state === "pending").length,
      processing: all.filter((e) => e.state === "processing").length,
      done: all.filter((e) => e.state === "done").length,
      failed: all.filter((e) => e.state === "failed").length,
    };

    return JSON.stringify(
      {
        ok: true,
        queueRoot: path.join(ctx.stateDir, QUEUE_ROOT_NAME),
        summary,
        entries,
      },
      null,
      2,
    );
  },
});
