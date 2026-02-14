import type { NexusDatabase } from "../storage/database.js";
import { randomId } from "./utils.js";

export type DataIntakeSourceRow = {
  id: string;
  source_id: string;
  label: string | null;
  params_json: string;
  interval_ms: number;
  enabled: number;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  last_error: string | null;
  job_id: string | null;
};

export function listIntakeSources(params: { db: NexusDatabase; includeDisabled?: boolean }): DataIntakeSourceRow[] {
  const includeDisabled = params.includeDisabled ?? false;
  const sql = includeDisabled
    ? "SELECT * FROM data_intake_sources ORDER BY created_at DESC"
    : "SELECT * FROM data_intake_sources WHERE enabled = 1 ORDER BY created_at DESC";
  return params.db.db.prepare(sql).all() as DataIntakeSourceRow[];
}

export function getIntakeSource(params: { db: NexusDatabase; id: string }): DataIntakeSourceRow | null {
  const row = params.db.db.prepare("SELECT * FROM data_intake_sources WHERE id = ?").get(params.id) as
    | DataIntakeSourceRow
    | undefined;
  return row ?? null;
}

/** Convert intervalMs to a simple cron expression (minute-resolution) */
function intervalMsToCron(intervalMs: number): string {
  const minutes = Math.max(1, Math.floor(intervalMs / 60_000));
  if (minutes < 60) {
    // Every N minutes: */N * * * *
    return `*/${minutes} * * * *`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    // Every N hours: 0 */N * * *
    return `0 */${hours} * * *`;
  }
  // Daily or longer: once a day at midnight
  return "0 0 * * *";
}

function sourceJobName(sourceId: string, label: string | null): string {
  return `data-intake: ${label || sourceId}`;
}

function schedulerAgentId(): string {
  const value = (process.env.NEXUS_SCHEDULER_AGENT_ID ?? "main").trim();
  return value || "main";
}

/** Create a cron job for this data intake source */
function createJobForSource(params: {
  db: NexusDatabase;
  sourceId: string;
  instanceId: string;
  label: string | null;
  intervalMs: number;
  nowMs: number;
}): string {
  const jobId = randomId("J");
  const cron = intervalMsToCron(params.intervalMs);
  const jobName = sourceJobName(params.sourceId, params.label);
  const spec = {
    mode: "tool_call",
    tool: "data_intake_run",
    args: { instanceId: params.instanceId },
  };

  params.db.db
    .prepare(
      "INSERT INTO jobs (id, owner_agent_id, name, cron, timezone, enabled, spec_json, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(jobId, schedulerAgentId(), jobName, cron, "UTC", 1, JSON.stringify(spec), params.nowMs, params.nowMs, params.nowMs);

  return jobId;
}

function syncJobForSource(params: {
  db: NexusDatabase;
  jobId: string;
  sourceId: string;
  label: string | null;
  intervalMs: number;
  enabled: number;
  nowMs: number;
  resetNextRun: boolean;
}): void {
  const cron = intervalMsToCron(params.intervalMs);
  const jobName = sourceJobName(params.sourceId, params.label);
  params.db.db
    .prepare(
      `UPDATE jobs
       SET name = ?, cron = ?, enabled = ?,
           next_run_at = CASE
             WHEN ? = 0 THEN NULL
             WHEN ? = 1 THEN ?
             ELSE next_run_at
           END,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(
      jobName,
      cron,
      params.enabled,
      params.enabled,
      params.resetNextRun ? 1 : 0,
      params.nowMs,
      params.nowMs,
      params.jobId,
    );
}

export function createIntakeSource(params: {
  db: NexusDatabase;
  sourceId: string;
  label?: string;
  params: Record<string, unknown>;
  intervalMs: number;
  nowMs?: number;
}): DataIntakeSourceRow {
  const now = params.nowMs ?? Date.now();
  const id = randomId("DIS");
  const intervalMs = Math.max(60_000, params.intervalMs);
  const jobId = params.db.db.transaction(() => {
    const createdJobId = createJobForSource({
      db: params.db,
      sourceId: params.sourceId,
      instanceId: id,
      label: params.label ?? null,
      intervalMs,
      nowMs: now,
    });
    params.db.db
      .prepare(
        "INSERT INTO data_intake_sources (id, source_id, label, params_json, interval_ms, enabled, created_at, updated_at, job_id) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)",
      )
      .run(id, params.sourceId, params.label ?? null, JSON.stringify(params.params ?? {}), intervalMs, now, now, createdJobId);
    return createdJobId;
  })();
  const row = params.db.db.prepare("SELECT * FROM data_intake_sources WHERE id = ?").get(id) as DataIntakeSourceRow | undefined;
  if (!row) {
    throw new Error(`failed to create intake source ${id} (job ${jobId})`);
  }
  return row;
}

export function updateIntakeSource(params: {
  db: NexusDatabase;
  id: string;
  label?: string | null;
  paramsJson?: string;
  intervalMs?: number;
  enabled?: boolean;
  lastRunAt?: number | null;
  lastError?: string | null;
  nowMs?: number;
}): DataIntakeSourceRow | null {
  const existing = getIntakeSource({ db: params.db, id: params.id });
  if (!existing) return null;
  const nextLabel = params.label ?? existing.label;
  const nextParams = params.paramsJson ?? existing.params_json;
  const nextInterval = Math.max(60_000, params.intervalMs ?? existing.interval_ms);
  const nextEnabled = params.enabled === undefined ? existing.enabled : params.enabled ? 1 : 0;
  const nextLastRun = params.lastRunAt === undefined ? existing.last_run_at : params.lastRunAt;
  const nextLastError = params.lastError === undefined ? existing.last_error : params.lastError;
  const now = params.nowMs ?? Date.now();
  const shouldResetNextRun = params.intervalMs !== undefined || (params.enabled !== undefined && nextEnabled === 1);

  params.db.db.transaction(() => {
    params.db.db
      .prepare(
        "UPDATE data_intake_sources SET label = ?, params_json = ?, interval_ms = ?, enabled = ?, updated_at = ?, last_run_at = ?, last_error = ? WHERE id = ?",
      )
      .run(nextLabel, nextParams, nextInterval, nextEnabled, now, nextLastRun, nextLastError, params.id);

    if (existing.job_id) {
      syncJobForSource({
        db: params.db,
        jobId: existing.job_id,
        sourceId: existing.source_id,
        label: nextLabel,
        intervalMs: nextInterval,
        enabled: nextEnabled,
        nowMs: now,
        resetNextRun: shouldResetNextRun,
      });
    }
  })();

  return getIntakeSource({ db: params.db, id: params.id });
}

export function deleteIntakeSource(params: { db: NexusDatabase; id: string }): boolean {
  // Get the source to find the linked job
  const existing = getIntakeSource({ db: params.db, id: params.id });
  if (!existing) return false;
  const jobId = existing.job_id;

  const tx = params.db.db.transaction(() => {
    // Delete the source row first to avoid FK issues in databases where data_intake_sources.job_id
    // has a foreign key to jobs(id).
    const res = params.db.db.prepare("DELETE FROM data_intake_sources WHERE id = ?").run(params.id);
    if (res.changes === 0) {
      throw new Error("Source delete failed");
    }

    // Delete the linked job if it exists
    if (jobId) {
      // Delete events first to be compatible with schemas where job_events.run_id may reference job_runs(id).
      params.db.db.prepare("DELETE FROM job_events WHERE job_id = ?").run(jobId);
      params.db.db.prepare("DELETE FROM job_runs WHERE job_id = ?").run(jobId);
      params.db.db.prepare("DELETE FROM job_leases WHERE job_id = ?").run(jobId);
      params.db.db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
    }
  });

  tx();
  return true;
}
