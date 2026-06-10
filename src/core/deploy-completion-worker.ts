import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { NexusDatabase } from "../storage/database.js";
import { enqueueRunReport } from "../storage/run-reports.js";
import {
  syncCandidateForDeployCompletion,
  syncDeployRequestForCompletion,
} from "./deploy-requests.js";

type DeployCompletionRequest = {
  channel?: string | null;
  channelKey?: string | null;
  agentId?: string | null;
  homeAgentId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  parentRunId?: string | null;
};

type DeployCompletionArtifact = {
  id: string;
  action: string;
  status: string;
  triggerId?: string | null;
  approvalId?: string | null;
  candidateId?: string | null;
  effectiveSha?: string | null;
  lastGoodSha?: string | null;
  failureReason?: string | null;
  createdAt?: string | null;
  request?: DeployCompletionRequest | null;
};

export type DeployCompletionWorker = {
  /** Stops the timer and resolves once any in-flight tick has settled. */
  stop: () => Promise<void>;
  tick: () => Promise<number>;
};

function envBool(name: string): boolean | null {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v === "1" || v === "true" || v === "yes" || v === "y") return true;
  if (v === "0" || v === "false" || v === "no" || v === "n") return false;
  return null;
}

function envInt(name: string): number | null {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function completionsDir(stateDir: string): string {
  return path.join(stateDir, "deploy-completions");
}

function completionRunReportId(artifactId: string): string {
  const digest = crypto.createHash("sha256").update(artifactId).digest("hex").slice(0, 24).toUpperCase();
  return `RRDC${digest}`;
}

const KNOWN_COMPLETION_ACTIONS = new Set(["apply", "rollback"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseArtifact(raw: string): DeployCompletionArtifact {
  const parsed = JSON.parse(raw) as unknown;
  if (!isPlainObject(parsed)) throw new Error("artifact must be an object");
  const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
  const action = typeof parsed.action === "string" ? parsed.action.trim() : "";
  const status = typeof parsed.status === "string" ? parsed.status.trim() : "";
  if (!id || !action || !status) throw new Error("artifact missing required id/action/status");
  const request = isPlainObject(parsed.request)
    ? {
        channel: typeof parsed.request.channel === "string" ? parsed.request.channel : null,
        channelKey: typeof parsed.request.channelKey === "string" ? parsed.request.channelKey : null,
        agentId: typeof parsed.request.agentId === "string" ? parsed.request.agentId : null,
        homeAgentId: typeof parsed.request.homeAgentId === "string" ? parsed.request.homeAgentId : null,
        sessionId: typeof parsed.request.sessionId === "string" ? parsed.request.sessionId : null,
        runId: typeof parsed.request.runId === "string" ? parsed.request.runId : null,
        parentRunId: typeof parsed.request.parentRunId === "string" ? parsed.request.parentRunId : null,
      }
    : null;
  return {
    id,
    action,
    status,
    triggerId: typeof parsed.triggerId === "string" ? parsed.triggerId : null,
    approvalId: typeof parsed.approvalId === "string" ? parsed.approvalId : null,
    candidateId: typeof parsed.candidateId === "string" ? parsed.candidateId : null,
    effectiveSha: typeof parsed.effectiveSha === "string" ? parsed.effectiveSha : null,
    lastGoodSha: typeof parsed.lastGoodSha === "string" ? parsed.lastGoodSha : null,
    failureReason: typeof parsed.failureReason === "string" ? parsed.failureReason : null,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : null,
    request,
  };
}

function formatDeployCompletionTitle(artifact: DeployCompletionArtifact): string {
  if (artifact.status === "started") {
    return artifact.action === "rollback" ? "Rollback started" : "Deploy started";
  }
  if (artifact.action === "rollback") {
    return artifact.status === "rolled_back" ? "Rollback completed" : "Rollback failed";
  }
  if (artifact.status === "finalized") return "Deploy finalized";
  if (artifact.status === "finalized_without_ack") return "Deploy finalized after ack timeout";
  if (artifact.status === "finalize_failed") return "Deploy finalize failed";
  if (artifact.status === "finalize_failed_without_ack") return "Deploy finalize failed after ack timeout";
  if (artifact.status === "applied_local_push_failed") return "Deploy applied, push failed";
  if (artifact.status.startsWith("applied_local")) return "Deploy applied";
  return "Deploy failed";
}

function formatDeployCompletionBody(artifact: DeployCompletionArtifact): string {
  const lines: string[] = [];
  if (artifact.status === "started") {
    if (artifact.action === "rollback") {
      lines.push("Rollback started on the host.");
    } else {
      lines.push("Deploy started on the host.");
      lines.push("Nexus is building the inactive slot and will switch traffic after health checks pass.");
    }
  } else if (artifact.action === "rollback") {
    lines.push(
      artifact.status === "rolled_back"
        ? "Rollback completed."
        : "Rollback failed.",
    );
  } else if (artifact.status === "finalized") {
    lines.push("Deploy finalized successfully. Both active and standby slots should now be on the new code.");
  } else if (artifact.status === "finalized_without_ack") {
    lines.push("Deploy finalized after waiting for operator ack timeout.");
    lines.push("The active gateway is serving the new code and the old slot was rebuilt, but the original request cycle never wrote a matching deploy ack.");
  } else if (artifact.status === "finalize_failed") {
    lines.push("Deploy applied, but finalizing the old standby slot failed.");
    lines.push("The active gateway is serving the new code, but redundancy may be degraded until standby is rebuilt.");
  } else if (artifact.status === "finalize_failed_without_ack") {
    lines.push("Deploy applied, ack timed out, and finalizing the old standby slot failed.");
    lines.push("The active gateway is serving the new code, but redundancy may be degraded until standby is rebuilt.");
  } else if (artifact.status === "applied_local_push_failed") {
    lines.push("Deploy applied and the active gateway switched, but push to the remote failed.");
  } else if (artifact.status.startsWith("applied_local")) {
    lines.push("Deploy applied successfully and the active gateway switched to the new code.");
    lines.push("Background finalization of the old primary may still continue after this notification.");
  } else {
    lines.push("Deploy failed.");
  }
  if (artifact.approvalId) lines.push(`Approval ID: ${artifact.approvalId}`);
  if (artifact.candidateId) lines.push(`Candidate ID: ${artifact.candidateId}`);
  lines.push(`Status: ${artifact.status}`);
  if (artifact.effectiveSha) lines.push(`Effective SHA: ${artifact.effectiveSha}`);
  if (artifact.lastGoodSha) lines.push(`Last good SHA: ${artifact.lastGoodSha}`);
  if (artifact.failureReason) lines.push(`Reason: ${artifact.failureReason}`);
  return lines.join("\n");
}

async function moveAside(sourcePath: string, suffix: string): Promise<string> {
  const targetPath = `${sourcePath}${suffix}`;
  await fs.rename(sourcePath, targetPath);
  return targetPath;
}

const DEFAULT_NOTIFIED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DEAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Deletes processed artifacts past their retention window so the
 *  deploy-completions directory does not grow without bound. */
async function pruneProcessedArtifacts(params: {
  dir: string;
  notifiedRetentionMs: number;
  deadRetentionMs: number;
  log: (msg: string) => void;
}): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(params.dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
    throw err;
  }
  const nowMs = Date.now();
  let pruned = 0;
  for (const name of names) {
    const retentionMs = name.endsWith(".notified")
      ? params.notifiedRetentionMs
      : name.endsWith(".dead")
        ? params.deadRetentionMs
        : null;
    if (retentionMs === null) continue;
    const fullPath = path.join(params.dir, name);
    try {
      const stats = await fs.stat(fullPath);
      if (nowMs - stats.mtimeMs <= retentionMs) continue;
      await fs.unlink(fullPath);
      pruned += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      const message = err instanceof Error ? err.message : String(err);
      params.log(`deploy_completion_worker: prune_failed path=${name} err=${message}`);
    }
  }
  if (pruned > 0) params.log(`deploy_completion_worker: pruned=${pruned}`);
  return pruned;
}

async function enqueueCompletionReport(db: NexusDatabase, artifact: DeployCompletionArtifact): Promise<void> {
  const targetAgentId = artifact.request?.homeAgentId ?? artifact.request?.agentId ?? null;
  if (!targetAgentId) throw new Error("missing_target_agent");
  enqueueRunReport(db, {
    id: completionRunReportId(artifact.id),
    kind: "deploy_completion",
    title: formatDeployCompletionTitle(artifact),
    body: formatDeployCompletionBody(artifact),
    sourceRunId: artifact.request?.runId ?? null,
    parentRunId: artifact.request?.parentRunId ?? null,
    sourceAgentId: artifact.request?.agentId ?? null,
    sourceChannel: artifact.request?.channel ?? null,
    sourceChannelKey: artifact.request?.channelKey ?? null,
    targetAgentId,
    targetChannel: "home_channel",
    metadata: {
      action: artifact.action,
      status: artifact.status,
      approvalId: artifact.approvalId ?? null,
      candidateId: artifact.candidateId ?? null,
      triggerId: artifact.triggerId ?? null,
      effectiveSha: artifact.effectiveSha ?? null,
      lastGoodSha: artifact.lastGoodSha ?? null,
      failureReason: artifact.failureReason ?? null,
      deliveryKind: "deploy_completion",
    },
    nowMs: Date.now(),
  });
}

export function startDeployCompletionWorker(params: {
  db: NexusDatabase;
  stateDir: string;
  candidateRootDir?: string;
  log: (msg: string) => void;
}): DeployCompletionWorker | null {
  const enabled = envBool("NEXUS_DEPLOY_COMPLETION_WORKER") ?? true;
  if (!enabled) return null;

  const tickIntervalMs = clamp(envInt("NEXUS_DEPLOY_COMPLETION_TICK_MS") ?? 10_000, 1_000, 120_000);
  const maxPerTick = clamp(envInt("NEXUS_DEPLOY_COMPLETION_MAX_PER_TICK") ?? 12, 1, 100);
  const notifiedRetentionMs = Math.max(60_000, envInt("NEXUS_DEPLOY_COMPLETION_NOTIFIED_RETENTION_MS") ?? DEFAULT_NOTIFIED_RETENTION_MS);
  const deadRetentionMs = Math.max(60_000, envInt("NEXUS_DEPLOY_COMPLETION_DEAD_RETENTION_MS") ?? DEFAULT_DEAD_RETENTION_MS);
  const dir = completionsDir(params.stateDir);
  let stopped = false;
  let running = false;
  let lastTickPromise: Promise<unknown> | null = null;
  let lastPruneAt = 0;

  const tick = async (): Promise<number> => {
    if (stopped || running) return 0;
    running = true;
    try {
      let entries: Array<string> = [];
      try {
        entries = (await fs.readdir(dir))
          .filter((name) => name.endsWith(".json"))
          .sort()
          .slice(0, maxPerTick);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return 0;
        throw err;
      }

      let processed = 0;
      for (const name of entries) {
        const fullPath = path.join(dir, name);
        let claimedPath: string | null = null;
        try {
          claimedPath = await moveAside(fullPath, ".processing");
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
          throw err;
        }

        try {
          const raw = await fs.readFile(claimedPath, "utf8");
          const artifact = parseArtifact(raw);
          if (!KNOWN_COMPLETION_ACTIONS.has(artifact.action)) {
            params.log(`deploy_completion_worker: unknown_action action=${artifact.action} id=${artifact.id}`);
          }
          const nowMs = Date.now();
          if (artifact.approvalId) {
            syncDeployRequestForCompletion({
              db: params.db,
              approvalId: artifact.approvalId,
              action: artifact.action,
              status: artifact.status,
              candidateId: artifact.candidateId ?? null,
              triggerId: artifact.triggerId ?? null,
              effectiveSha: artifact.effectiveSha ?? null,
              lastGoodSha: artifact.lastGoodSha ?? null,
              failureReason: artifact.failureReason ?? null,
              nowMs,
            });
          }
          await syncCandidateForDeployCompletion({
            candidateRootDir: params.candidateRootDir,
            candidateId: artifact.candidateId ?? null,
            action: artifact.action,
            status: artifact.status,
            failureReason: artifact.failureReason ?? null,
            nowMs,
            log: params.log,
          });
          try {
            await enqueueCompletionReport(params.db, artifact);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (!/UNIQUE constraint failed: run_reports\.id/i.test(message)) {
              throw err;
            }
          }
          await moveAside(claimedPath, ".notified");
          processed += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          params.log(`deploy_completion_worker: artifact_failed path=${name} err=${message}`);
          if (claimedPath) {
            try {
              await moveAside(claimedPath, ".dead");
            } catch {
              // ignore cleanup failure
            }
          }
        }
      }

      if (processed > 0) params.log(`deploy_completion_worker: processed=${processed}`);

      if (Date.now() - lastPruneAt >= PRUNE_INTERVAL_MS) {
        lastPruneAt = Date.now();
        try {
          await pruneProcessedArtifacts({
            dir,
            notifiedRetentionMs,
            deadRetentionMs,
            log: params.log,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          params.log(`deploy_completion_worker: prune_pass_failed err=${message}`);
        }
      }
      return processed;
    } finally {
      running = false;
    }
  };

  const trackedTick = (): Promise<number> => {
    const p = tick();
    lastTickPromise = p.catch(() => undefined);
    return p;
  };

  const timer = setInterval(() => {
    void trackedTick().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      params.log(`deploy_completion_worker: tick_failed err=${message}`);
    });
  }, tickIntervalMs);
  if (typeof timer.unref === "function") timer.unref();

  params.log(`deploy_completion_worker: started tickIntervalMs=${tickIntervalMs} maxPerTick=${maxPerTick}`);
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (lastTickPromise) await lastTickPromise;
    },
    tick: trackedTick,
  };
}
