import type { NexusDatabase } from "../../storage/database.js";
import type { ProcessManager } from "../../process/manager.js";
import type { AgentTracker } from "../../core/agent-tracker.js";
import { listLatestDataItemsPerSource } from "../../data-intake/store.js";
import { listIntakeSources } from "../../data-intake/source-store.js";
import type {
  AgentRunInfo,
  ManagedProcessInfo,
  AgentRunRow,
  JobRow,
  JobRunRow,
  BlackboardRow,
  DataIntakePanelState,
  DataIntakeRow,
  HAEventRow,
  BackupRow,
} from "./types.js";

export function listProcesses(manager: ProcessManager | undefined, nowMs: number, windowMs: number): ManagedProcessInfo[] {
  if (!manager) return [];
  const cutoff = nowMs - windowMs;
  return manager
    .list()
    .filter((p) => p.status === "running" || (p.endedAt !== null && p.endedAt >= cutoff));
}

export function listAgents(tracker: AgentTracker | undefined, nowMs: number, windowMs: number): { active: AgentRunInfo[]; recent: AgentRunInfo[] } {
  if (!tracker) return { active: [], recent: [] };
  return {
    active: tracker.listActive(),
    recent: tracker.listRecent({ sinceMs: nowMs - windowMs, limit: 200 }),
  };
}

export function listAgentGraph(db: NexusDatabase | undefined, allowedRunIds: Set<string>): AgentRunRow[] {
  if (!db) return [];
  if (allowedRunIds.size === 0) return [];
  const ids = [...allowedRunIds];
  const placeholders = ids.map(() => "?").join(", ");
  return db.db
    .prepare(
      `SELECT run_id, parent_run_id, agent_id, preset, status, started_at, ended_at, task FROM agent_runs WHERE run_id IN (${placeholders}) ORDER BY started_at ASC`,
    )
    .all(...ids) as AgentRunRow[];
}

export function listJobs(db: NexusDatabase | undefined, limit: number): JobRow[] {
  if (!db) return [];
  return db.db
    .prepare(
      "SELECT id, owner_agent_id, name, cron, timezone, enabled, next_run_at, last_run_at, consecutive_failures, last_failure_at, spec_json FROM jobs ORDER BY created_at DESC LIMIT ?",
    )
    .all(limit) as JobRow[];
}

export function listJobRuns(db: NexusDatabase | undefined, limit: number): JobRunRow[] {
  if (!db) return [];
  return db.db
    .prepare(
      "SELECT id, job_id, owner_agent_id, scheduled_for, started_at, ended_at, status, error, tool_calls_used, iterations_used FROM job_runs ORDER BY started_at DESC LIMIT ?",
    )
    .all(limit) as JobRunRow[];
}

export function listRunningJobRuns(db: NexusDatabase | undefined): JobRunRow[] {
  if (!db) return [];
  return db.db
    .prepare(
      "SELECT id, job_id, owner_agent_id, scheduled_for, started_at, ended_at, status, error, tool_calls_used, iterations_used FROM job_runs WHERE status = 'running' ORDER BY started_at DESC",
    )
    .all() as JobRunRow[];
}

export function listBlackboard(db: NexusDatabase | undefined, limit: number, scope?: string | null): BlackboardRow[] {
  if (!db) return [];
  if (scope) {
    return db.db
      .prepare(
        "SELECT id, session_scope, type, agent_id, agent_preset, title, content, created_at, expires_at FROM blackboard WHERE session_scope = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(scope, limit) as BlackboardRow[];
  }
  return db.db
    .prepare(
      "SELECT id, session_scope, type, agent_id, agent_preset, title, content, created_at, expires_at FROM blackboard ORDER BY created_at DESC LIMIT ?",
    )
    .all(limit) as BlackboardRow[];
}

export function listBlackboardScopes(db: NexusDatabase | undefined, limit: number): string[] {
  if (!db) return [];
  const rows = db.db
    .prepare(
      "SELECT session_scope, MAX(created_at) AS last_seen FROM blackboard GROUP BY session_scope ORDER BY last_seen DESC LIMIT ?",
    )
    .all(limit) as { session_scope: string }[];
  return rows.map((r) => r.session_scope);
}

export function listDataIntake(
  db: NexusDatabase | undefined,
  nowMs: number,
  limit: number,
  hideOrphans: boolean,
): DataIntakePanelState {
  if (!db) return { enabled: true, targets: [], rows: [], sources: [], hideOrphans };
  let rows = listLatestDataItemsPerSource({
    db,
    includeExpired: false,
    limit,
    nowMs,
  }) as unknown as DataIntakeRow[];
  const sources = listIntakeSources({ db, includeDisabled: true }).map((row) => ({
    id: row.id,
    source_id: row.source_id,
    label: row.label,
    params_json: row.params_json,
    interval_ms: row.interval_ms,
    enabled: row.enabled,
    last_run_at: row.last_run_at,
    last_error: row.last_error,
  }));
  if (hideOrphans) {
    const sourceIds = new Set(sources.map((s) => s.source_id));
    rows = rows.filter((r) => sourceIds.has(r.source_id));
  }
  return { enabled: true, targets: sources.map((row) => row.source_id), rows, sources, hideOrphans };
}

export function listHAEvents(db: NexusDatabase | undefined, limit: number): HAEventRow[] {
  if (!db) return [];
  try {
    return db.db
      .prepare("SELECT id, event_type, source, from_instance, to_instance, details_json, created_at FROM ha_events ORDER BY created_at DESC LIMIT ?")
      .all(limit) as HAEventRow[];
  } catch {
    return [];
  }
}

export function getLastBackup(db: NexusDatabase | undefined): BackupRow | null {
  if (!db) return null;
  try {
    return db.db
      .prepare("SELECT id, filename, completed_at, size_bytes, status, backup_type FROM db_backups WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1")
      .get() as BackupRow | undefined ?? null;
  } catch {
    return null;
  }
}

export function clampInt(value: string | undefined, min: number, max: number): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
