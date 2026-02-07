import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { defineTool } from "../core/tools.js";

const execFileAsync = promisify(execFile);
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;
const QUEUE_ROOT_NAME = "change-queue";

type QueueState = "pending" | "processing" | "done" | "failed";

type ChangeRequest = {
  id: string;
  title: string;
  summary?: string;
  baseSha: string;
  autoApply: boolean;
  targetRemote: string;
  targetBranch: string;
  validate: string[];
  changeSet: unknown;
  fallbackPatch?: string;
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
  title: string;
  summary?: string;
  baseSha: string;
  autoApply: boolean;
  targetRemote: string;
  targetBranch: string;
  requestedAt: string;
  requestedAtMs: number;
  requestedBy: string;
  channel: string;
  channelKey: string;
  agentId: string;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  logFile?: string;
  commitSha?: string;
};

const writeFileOpSchema = z.object({
  op: z.literal("write_file"),
  path: z.string().min(1),
  mode: z.enum(["create", "overwrite"]).default("overwrite"),
  content: z.string(),
});

const editLinesOpSchema = z.object({
  op: z.literal("edit_lines"),
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
  content: z.string(),
});

const editTextOpSchema = z.object({
  op: z.literal("edit_text"),
  path: z.string().min(1),
  find: z.string().min(1),
  replace: z.string(),
  replaceAll: z.boolean().default(false),
});

const deleteFileOpSchema = z.object({
  op: z.literal("delete_file"),
  path: z.string().min(1),
});

const changeSetSchema = z.object({
  format: z.enum(["ops", "patch"]).default("ops"),
  ops: z
    .array(z.union([writeFileOpSchema, editLinesOpSchema, editTextOpSchema, deleteFileOpSchema]))
    .max(200)
    .optional(),
  patch: z.string().max(1_000_000).optional(),
});

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
  await fs.mkdir(path.join(stateDir, QUEUE_ROOT_NAME, "logs"), { recursive: true });
  return dirs;
}

async function gitResolveCommit(codeDir: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", codeDir, "rev-parse", "--verify", `${ref}^{commit}`]);
    const resolved = stdout.trim();
    return resolved || null;
  } catch {
    return null;
  }
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
      const parsed = JSON.parse(raw) as Partial<ChangeRequest> & {
        startedAt?: string;
        finishedAt?: string;
        message?: string;
        logFile?: string;
        commitSha?: string;
      };
      if (!parsed || typeof parsed !== "object") continue;
      const id = typeof parsed.id === "string" ? parsed.id : name.replace(/\.json$/, "");
      const title = typeof parsed.title === "string" ? parsed.title : "(untitled)";
      const baseSha = typeof parsed.baseSha === "string" ? parsed.baseSha : "";
      const autoApply = Boolean(parsed.autoApply);
      const targetRemote = typeof parsed.targetRemote === "string" ? parsed.targetRemote : "host";
      const targetBranch = typeof parsed.targetBranch === "string" ? parsed.targetBranch : "main";
      const summary = typeof parsed.summary === "string" ? parsed.summary : undefined;
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
        title,
        summary,
        baseSha,
        autoApply,
        targetRemote,
        targetBranch,
        requestedAt,
        requestedAtMs,
        requestedBy,
        channel,
        channelKey,
        agentId,
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
        finishedAt: typeof parsed.finishedAt === "string" ? parsed.finishedAt : undefined,
        message: typeof parsed.message === "string" ? parsed.message : undefined,
        logFile: typeof parsed.logFile === "string" ? parsed.logFile : undefined,
        commitSha: typeof parsed.commitSha === "string" ? parsed.commitSha : undefined,
      });
    } catch {
      // Ignore malformed queue files.
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

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
}

function validateChangeSetPayload(changeSet: z.infer<typeof changeSetSchema>): string | null {
  if (changeSet.format === "ops") {
    if (!changeSet.ops || changeSet.ops.length === 0) {
      return "changeSet.ops is required when format='ops'";
    }
    return null;
  }
  if (!changeSet.patch || !changeSet.patch.trim()) {
    return "changeSet.patch is required when format='patch'";
  }
  return null;
}

export const codeChangeRequestCreate = defineTool({
  name: "code_change_request_create",
  description:
    "Queue a host-side code change request. " +
    "Use this when code is mounted read-only in the runtime and host worker owns git/apply/deploy.",
  parameters: z.object({
    title: z.string().min(3).max(200),
    summary: z.string().max(1000).optional(),
    baseSha: z
      .string()
      .min(7)
      .max(40)
      .optional()
      .describe("Base commit to apply against. Defaults to current HEAD."),
    autoApply: z.boolean().default(true),
    targetRemote: z.string().min(1).max(80).default("host"),
    targetBranch: z.string().min(1).max(120).default("main"),
    validate: z.array(z.string().min(1).max(300)).min(1).max(10).default(["npm run typecheck", "npm run build"]),
    changeSet: changeSetSchema,
    fallbackPatch: z.string().max(1_000_000).optional(),
    requestId: z.string().max(80).optional(),
  }),
  execute: async (args, ctx) => {
    if (!ctx.stateDir) return "ERROR: stateDir is not available";
    if (!ctx.codeDir) return "ERROR: codeDir is not available";

    const invalidChangeSet = validateChangeSetPayload(args.changeSet);
    if (invalidChangeSet) return `ERROR: ${invalidChangeSet}`;

    const requestedBase = args.baseSha?.trim() ?? "";
    if (requestedBase && !COMMIT_RE.test(requestedBase)) {
      return "ERROR: baseSha must be 7-40 hexadecimal characters";
    }
    const headSha = await gitResolveCommit(ctx.codeDir, "HEAD");
    if (!headSha) return `ERROR: unable to resolve HEAD in ${ctx.codeDir}`;
    const baseSha = requestedBase || headSha;
    const resolvedBase = await gitResolveCommit(ctx.codeDir, baseSha);
    if (!resolvedBase) {
      return `ERROR: baseSha ${baseSha} does not exist in ${ctx.codeDir}`;
    }
    if (resolvedBase !== headSha) {
      return (
        `ERROR: baseSha ${baseSha} is not current HEAD (${headSha.slice(0, 12)}). ` +
        "Refresh code context and retry from latest HEAD."
      );
    }

    const dirs = await ensureQueue(ctx.stateDir);
    const nowMs = ctx.nowMs();
    const requestId = sanitizeId(args.requestId?.trim() || `chg-${nowMs}-${crypto.randomBytes(3).toString("hex")}`);
    const payload: ChangeRequest = {
      id: requestId,
      title: args.title.trim(),
      summary: args.summary?.trim() || undefined,
      baseSha: resolvedBase,
      autoApply: args.autoApply,
      targetRemote: args.targetRemote.trim(),
      targetBranch: args.targetBranch.trim(),
      validate: args.validate.map((cmd) => cmd.trim()).filter(Boolean),
      changeSet: args.changeSet,
      fallbackPatch: args.fallbackPatch,
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
    ctx.log(`code-change: queued request id=${requestId} base=${resolvedBase.slice(0, 12)} autoApply=${args.autoApply ? "1" : "0"}`);

    return JSON.stringify(
      {
        ok: true,
        queued: true,
        requestId,
        baseSha: resolvedBase,
        title: payload.title,
        queueFile: fullPath,
        nextStep: "Host change worker will pick up this request automatically.",
      },
      null,
      2,
    );
  },
});

export const codeChangeRequestStatus = defineTool({
  name: "code_change_request_status",
  description: "Read code change request queue status from state/change-queue.",
  parameters: z.object({
    requestId: z.string().max(80).optional(),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  execute: async (args, ctx) => {
    if (!ctx.stateDir) return "ERROR: stateDir is not available";
    await ensureQueue(ctx.stateDir);
    const all = await listAllEntries(ctx.stateDir);
    const filtered = args.requestId ? all.filter((e) => e.id === args.requestId) : all;
    const entries = filtered.slice(0, args.limit).map((e) => ({
      id: e.id,
      state: e.state,
      title: e.title,
      summary: e.summary,
      baseSha: e.baseSha,
      commitSha: e.commitSha,
      autoApply: e.autoApply,
      targetRemote: e.targetRemote,
      targetBranch: e.targetBranch,
      requestedAt: e.requestedAt,
      requestedBy: e.requestedBy,
      startedAt: e.startedAt,
      finishedAt: e.finishedAt,
      message: e.message,
      logFile: e.logFile,
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

export const codeChangeRequestList = defineTool({
  name: "code_change_request_list",
  description: "List recent code change requests.",
  parameters: z.object({
    state: z.enum(["pending", "processing", "done", "failed", "all"]).default("all"),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  execute: async (args, ctx) => {
    if (!ctx.stateDir) return "ERROR: stateDir is not available";
    await ensureQueue(ctx.stateDir);
    const all = await listAllEntries(ctx.stateDir);
    const filtered = args.state === "all" ? all : all.filter((e) => e.state === args.state);
    return JSON.stringify(
      {
        ok: true,
        entries: filtered.slice(0, args.limit).map((e) => ({
          id: e.id,
          state: e.state,
          title: e.title,
          requestedAt: e.requestedAt,
          baseSha: e.baseSha,
          commitSha: e.commitSha,
          message: e.message,
        })),
      },
      null,
      2,
    );
  },
});

export const codeChangeRequestCancel = defineTool({
  name: "code_change_request_cancel",
  description: "Cancel a pending code change request.",
  parameters: z.object({
    requestId: z.string().min(1).max(80),
    reason: z.string().max(300).default("cancelled by operator"),
  }),
  execute: async (args, ctx) => {
    if (!ctx.stateDir) return "ERROR: stateDir is not available";
    const dirs = await ensureQueue(ctx.stateDir);
    const pending = await readQueueEntries(dirs.pending, "pending");
    const target = pending.find((entry) => entry.id === args.requestId);
    if (!target) {
      return `ERROR: request ${args.requestId} is not pending (only pending requests can be cancelled)`;
    }
    const raw = await fs.readFile(target.file, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const next = {
      ...parsed,
      state: "failed",
      finishedAt: new Date(ctx.nowMs()).toISOString(),
      message: `cancelled: ${args.reason}`,
    };
    const dest = path.join(dirs.failed, path.basename(target.file));
    await fs.writeFile(dest, JSON.stringify(next, null, 2) + "\n", "utf8");
    await fs.unlink(target.file).catch(() => {});
    return JSON.stringify({ ok: true, cancelled: true, requestId: args.requestId, file: dest }, null, 2);
  },
});
