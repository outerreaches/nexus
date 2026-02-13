import type { NexusDatabase } from "../storage/database.js";
import { nextCronTimeMs, parseCron, validateTimeZone } from "../scheduler/cron.js";

type SystemJobSpec = {
  id: string;
  name: string;
  cron: string;
  timezone: string;
  ownerAgentId?: string;
  spec:
    | {
        mode: "tool_call";
        tool: string;
        args: Record<string, unknown>;
      }
    | {
        mode: "agent_task";
        task: string;
      };
};

const DAILY_REFLECTION_TASK = [
  "Run a daily reflection on recent conversations for this agent.",
  "",
  "Goals:",
  "- Extract key decisions, user preferences, reusable workflows, and open follow-ups.",
  "- Persist durable learnings with memory_store while avoiding duplicates.",
  "- Record concrete action items in NOTES.md only when there is something substantive to track.",
  "- If reflection reveals durable operating-policy improvements, update AGENTS.md so future runs inherit them.",
  "",
  "Procedure:",
  "1) Review recent conversation context available in this run.",
  "2) Identify important decisions, preferences, and lessons learned.",
  "3) Check existing memories first (memory_search/memory_recall) to avoid duplicates.",
  "4) Store only high-signal memories via memory_store with stable, specific keys.",
  "5) If there are actionable follow-ups, append concise bullets to NOTES.md with file_write (root=\"state\", mode=\"append\").",
  "6) If durable behavior rules should change, edit AGENTS.md in root=\"state\" with minimal, reversible updates.",
  "7) If there are no meaningful new learnings, say so explicitly.",
  "",
  "Output requirements:",
  "- Briefly summarize what was learned and what was stored/updated.",
  "- End with exactly one line: JOB_STATUS: ok",
].join("\n");

const SYSTEM_JOBS: SystemJobSpec[] = [
  {
    id: "SYS_DB_BACKUP",
    name: "System: Database Backup",
    cron: "0 2 * * *", // Daily at 2am UTC (before maintenance)
    timezone: "UTC",
    spec: {
      mode: "tool_call",
      tool: "db_backup",
      args: { action: "run" },
    },
  },
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
  {
    id: "SYS_REFLECTION_DAILY",
    name: "System: Daily Reflection",
    cron: "0 4 * * *", // Daily at 4am UTC
    timezone: "UTC",
    ownerAgentId: "main",
    spec: {
      mode: "agent_task",
      task: DAILY_REFLECTION_TASK,
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
      .run(
        job.id,
        job.ownerAgentId ?? "system",
        job.name,
        job.cron,
        job.timezone,
        1,
        JSON.stringify(job.spec),
        nextRunAt,
        nowMs,
        nowMs,
      );

    log(`system-jobs: created ${job.id} (next_run_at=${new Date(nextRunAt).toISOString()})`);
  }
}
