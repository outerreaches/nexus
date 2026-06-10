import fs from "node:fs/promises";
import path from "node:path";

import { cachedPrepare, type NexusDatabase } from "../storage/database.js";
import {
  listDeployRequests,
  upsertDeployRequest,
} from "../storage/deploy-requests.js";
import { syncDeployRequestForHumanAction } from "./deploy-requests.js";
import { continueApprovedDeployAfterApproval } from "../tools/ha-deploy.js";

export type DeployApprovalWorker = {
  /** Stops the timer and resolves once any in-flight tick has settled. */
  stop: () => Promise<void>;
  tick: () => Promise<number>;
};

type DeployApprovalHumanActionRow = {
  id: string;
  status: "pending" | "fulfilled" | "canceled" | "expired";
  createdAt: number;
  respondedAt: number | null;
  responseText: string | null;
  metadataJson: string | null;
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

function mapHumanActionRow(row: any): DeployApprovalHumanActionRow {
  return {
    id: String(row.id),
    status: String(row.status) as DeployApprovalHumanActionRow["status"],
    createdAt: Number(row.created_at ?? 0),
    respondedAt: row.responded_at === null || row.responded_at === undefined ? null : Number(row.responded_at),
    responseText: row.response_text === null || row.response_text === undefined ? null : String(row.response_text),
    metadataJson: row.metadata_json === null || row.metadata_json === undefined ? null : String(row.metadata_json),
  };
}

const LIST_DEPLOY_APPROVAL_HUMAN_ACTIONS_SQL =
  "SELECT id, status, created_at, responded_at, response_text, metadata_json " +
  "FROM human_actions " +
  "WHERE kind = 'confirm' AND json_extract(metadata_json, '$.kind') = 'ha_deploy_approval' " +
  "ORDER BY COALESCE(responded_at, created_at) ASC, created_at ASC " +
  "LIMIT ?";

function listDeployApprovalHumanActions(
  db: NexusDatabase,
  maxPerTick: number,
): DeployApprovalHumanActionRow[] {
  const rows = cachedPrepare(db, LIST_DEPLOY_APPROVAL_HUMAN_ACTIONS_SQL)
    .all(maxPerTick);
  return (rows as any[]).map(mapHumanActionRow);
}

async function readQueuedTrigger(stateDir: string): Promise<{
  triggerId: string | null;
  approvalId: string | null;
} | null> {
  for (const name of ["deploy-trigger.json", "deploy-trigger.processing.json"]) {
    const fullPath = path.join(stateDir, name);
    try {
      const parsed = JSON.parse(await fs.readFile(fullPath, "utf8")) as Record<string, unknown>;
      return {
        triggerId: typeof parsed.id === "string" ? parsed.id : null,
        approvalId: typeof parsed.approvalId === "string" ? parsed.approvalId : null,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
    }
  }
  return null;
}

export function startDeployApprovalWorker(params: {
  db: NexusDatabase;
  stateDir: string;
  candidateRootDir?: string;
  log: (msg: string) => void;
}): DeployApprovalWorker | null {
  const enabled = envBool("NEXUS_DEPLOY_APPROVAL_WORKER") ?? true;
  if (!enabled) return null;

  const tickIntervalMs = clamp(envInt("NEXUS_DEPLOY_APPROVAL_TICK_MS") ?? 5_000, 1_000, 120_000);
  const maxPerTick = clamp(envInt("NEXUS_DEPLOY_APPROVAL_MAX_PER_TICK") ?? 500, 1, 2_000);
  let stopped = false;
  let running = false;
  // Tracks the most recent tick promise so stop() can await mid-flight work
  // before returning. Errors are swallowed for tracking purposes only — the
  // original promise still surfaces them to the timer callback.
  let lastTickPromise: Promise<unknown> | null = null;

  const tick = async (): Promise<number> => {
    if (stopped || running) return 0;
    running = true;
    try {
      let processed = 0;
      const approvalActions = listDeployApprovalHumanActions(params.db, maxPerTick);
      for (const row of approvalActions) {
        const synced = syncDeployRequestForHumanAction({
          db: params.db,
          approvalId: row.id,
          metadataJson: row.metadataJson,
          status: row.status,
          responseText: row.responseText,
          nowMs: row.respondedAt ?? row.createdAt,
        });
        if (synced) processed += 1;
      }

      let pendingTrigger = await readQueuedTrigger(params.stateDir);
      if (pendingTrigger?.approvalId) {
        upsertDeployRequest(params.db, {
          approvalId: pendingTrigger.approvalId,
          status: "queued",
          triggerId: pendingTrigger.triggerId,
          queuedAt: Date.now(),
          lastError: null,
          nowMs: Date.now(),
        });
      }

      const approved = listDeployRequests(params.db, {
        statuses: ["approved"],
        limit: Math.min(50, maxPerTick),
      });
      for (const request of approved) {
        pendingTrigger = await readQueuedTrigger(params.stateDir);
        if (pendingTrigger) {
          if (pendingTrigger.approvalId === request.approvalId) {
            upsertDeployRequest(params.db, {
              approvalId: request.approvalId,
              status: "queued",
              triggerId: pendingTrigger.triggerId,
              queuedAt: request.queuedAt ?? Date.now(),
              lastError: null,
              nowMs: Date.now(),
            });
            processed += 1;
          }
          break;
        }

        const result = await continueApprovedDeployAfterApproval({
          approvalId: request.approvalId,
          metadataJson: request.metadataJson,
          stateDir: params.stateDir,
          candidateRootDir: params.candidateRootDir,
          nowMs: Date.now(),
          log: params.log,
        });

        if (result.status === "queued") {
          upsertDeployRequest(params.db, {
            approvalId: request.approvalId,
            status: "queued",
            triggerId: result.triggerId ?? null,
            queuedAt: request.queuedAt ?? Date.now(),
            lastError: null,
            nowMs: Date.now(),
          });
          processed += 1;
          continue;
        }
        if (result.status === "busy") {
          upsertDeployRequest(params.db, {
            approvalId: request.approvalId,
            status: "approved",
            lastError: result.message,
            nowMs: Date.now(),
          });
          break;
        }
        upsertDeployRequest(params.db, {
          approvalId: request.approvalId,
          status: result.status === "stale" ? "stale" : "failed",
          lastError: result.message,
          completedAt: Date.now(),
          nowMs: Date.now(),
        });
        processed += 1;
      }

      if (processed > 0) params.log(`deploy_approval_worker: processed=${processed}`);
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
      params.log(`deploy_approval_worker: tick_failed err=${message}`);
    });
  }, tickIntervalMs);
  if (typeof timer.unref === "function") timer.unref();

  params.log(`deploy_approval_worker: started tickIntervalMs=${tickIntervalMs} maxPerTick=${maxPerTick}`);
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (lastTickPromise) await lastTickPromise;
    },
    tick: trackedTick,
  };
}
