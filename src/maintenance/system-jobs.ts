import type { NexusDatabase } from "../storage/database.js";
import { nextCronTimeMs, parseCron, validateTimeZone } from "../scheduler/cron.js";

type SystemJobSpec = {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  spec: {
    mode: "tool_call";
    tool: string;
    args: Record<string, unknown>;
  };
};

const SYSTEM_JOBS: SystemJobSpec[] = [
  {
    id: "SYS_DB_MAINTENANCE",
    name: "System: Database Maintenance",
    cron: "0 3 * * *", // Daily at 3am UTC
    timezone: "UTC",
    spec: {
      mode: "tool_call",
      tool: "db_maintenance",
      args: { action: "run" },
    },
  },
];

export function ensureSystemJobs(params: { db: NexusDatabase; nowMs: number; log?: (msg: string) => void }): void {
  const { db, nowMs, log = () => {} } = params;

  for (const job of SYSTEM_JOBS) {
    const existing = db.db.prepare("SELECT id, enabled FROM jobs WHERE id = ?").get(job.id) as
      | { id: string; enabled: number }
      | undefined;

    if (existing) {
      log(`system-jobs: ${job.id} already exists (enabled=${existing.enabled})`);
      continue;
    }

    const schedule = parseCron(job.cron);
    const tz = validateTimeZone(job.timezone);
    const nextRunAt = nextCronTimeMs({ schedule, afterMs: nowMs, timeZone: tz });

    db.db
      .prepare(
        `INSERT INTO jobs (id, owner_agent_id, name, cron, timezone, enabled, spec_json, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(job.id, "system", job.name, job.cron, job.timezone, 1, JSON.stringify(job.spec), nextRunAt, nowMs, nowMs);

    log(`system-jobs: created ${job.id} (next_run_at=${new Date(nextRunAt).toISOString()})`);
  }
}
