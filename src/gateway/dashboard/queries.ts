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
  LlmSessionRow,
  LlmMessageRow,
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

function isVisibleRun(params: { status: string; endedAt: number | null | undefined; nowMs: number; visibleWindowMs: number }): boolean {
  const endedAt = params.endedAt ?? null;
  return params.status === "running" || endedAt === null || params.nowMs - endedAt < params.visibleWindowMs;
}

export function filterVisibleAgentRuns(rows: AgentRunInfo[], nowMs: number, visibleWindowMs: number): AgentRunInfo[] {
  return rows.filter((row) => isVisibleRun({ status: row.status, endedAt: row.endedAt ?? null, nowMs, visibleWindowMs }));
}

export function filterVisibleAgentGraph(rows: AgentRunRow[], nowMs: number, visibleWindowMs: number): AgentRunRow[] {
  return rows.filter((row) => isVisibleRun({ status: row.status, endedAt: row.ended_at, nowMs, visibleWindowMs }));
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

export function listLlmSessions(
  db: NexusDatabase | undefined,
  params: {
    limit: number;
    channel?: string | null;
    channelKey?: string | null;
    agentId?: string | null;
  },
): LlmSessionRow[] {
  if (!db) return [];
  const clauses: string[] = [];
  const args: unknown[] = [];
  const channel = params.channel?.trim();
  const channelKey = params.channelKey?.trim();
  const agentId = params.agentId?.trim();

  if (channel) {
    clauses.push("s.channel = ?");
    args.push(channel);
  }
  if (channelKey) {
    clauses.push("s.channel_key = ?");
    args.push(channelKey);
  }
  if (agentId) {
    clauses.push("s.agent_id = ?");
    args.push(agentId);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.db
    .prepare(
      `SELECT
         s.id,
         s.channel,
         s.channel_key,
         s.agent_id,
         s.created_at,
         COALESCE(MAX(m.created_at), s.created_at) AS last_message_at,
         COUNT(m.id) AS message_count
       FROM sessions s
       LEFT JOIN messages m ON m.session_id = s.id
       ${where}
       GROUP BY s.id
       ORDER BY last_message_at DESC
       LIMIT ?`,
    )
    .all(...args, params.limit) as LlmSessionRow[];
}

export function listLlmMessages(
  db: NexusDatabase | undefined,
  params: {
    sessionId: string;
    limit: number;
    beforeId?: number | null;
  },
): { messages: LlmMessageRow[]; hasMore: boolean; nextBeforeId: number | null } {
  if (!db) return { messages: [], hasMore: false, nextBeforeId: null };
  const hasBefore = typeof params.beforeId === "number" && Number.isFinite(params.beforeId) && params.beforeId > 0;
  const sql = hasBefore
    ? `SELECT id, session_id, role, content, name, tool_call_id, tool_calls_json, created_at
       FROM messages
       WHERE session_id = ? AND id < ?
       ORDER BY id DESC
       LIMIT ?`
    : `SELECT id, session_id, role, content, name, tool_call_id, tool_calls_json, created_at
       FROM messages
       WHERE session_id = ?
       ORDER BY id DESC
       LIMIT ?`;

  const rows = hasBefore
    ? db.db.prepare(sql).all(params.sessionId, params.beforeId, params.limit + 1) as LlmMessageRow[]
    : db.db.prepare(sql).all(params.sessionId, params.limit + 1) as LlmMessageRow[];
  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;
  const ordered = page.reverse();
  const nextBeforeId = hasMore && ordered.length > 0 ? ordered[0]!.id : null;
  return {
    messages: ordered,
    hasMore,
    nextBeforeId,
  };
}

export function clampInt(value: string | undefined, min: number, max: number): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
