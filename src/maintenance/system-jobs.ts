import type { NexusDatabase } from "../storage/database.js";
import { nextCronTimeMs, parseCron, validateTimeZone } from "../scheduler/cron.js";

type SystemJobSpec = {
  id: string;
  name: string;
  cron: string;
  timezone: string;
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

function schedulerAgentId(): string {
  const value = (process.env.NEXUS_SCHEDULER_AGENT_ID ?? "main").trim();
  return value || "main";
}

function buildDailyReflectionTask(stateDir: string): string {
  const statePath = stateDir.replace(/\\/g, "/");
  return [
    "Run a daily reflection on recent conversations for this agent.",
    "",
    "Goals:",
    "- Extract key decisions, user preferences, reusable workflows, and open follow-ups.",
    "- Persist durable learnings with memory_store while avoiding duplicates.",
    "- Record concrete action items in NOTES.md only when there is something substantive to track.",
    "- If reflection reveals durable operating-policy improvements, update AGENTS.md so future runs inherit them.",
    "- If reflection uncovers durable concrete facts that are not hot enough for AGENTS.md, archive them in MEMORY.md with timestamps and source.",
    "",
    "Procedure:",
    "1) Review recent conversation context available in this run.",
    "2) Identify important decisions, preferences, and lessons learned.",
    "3) Check existing memories first (memory_search/memory_recall) to avoid duplicates.",
    "4) Store only high-signal memories via memory_store with stable, specific keys.",
    "5) File I/O requirements (mandatory): use absolute paths for NOTES.md, AGENTS.md, and MEMORY.md under stateDir.",
    `   - Example read: file_read({ path: "${statePath}/NOTES.md" })`,
    `   - Example append: file_write({ path: "${statePath}/NOTES.md", mode: "append", content: "..." })`,
    `   - Example edit: file_edit({ path: "${statePath}/AGENTS.md", find: "...", replace: "..." })`,
    `   - Example archive append: file_write({ path: "${statePath}/MEMORY.md", mode: "append", content: "..." })`,
    "6) If NOTES.md or MEMORY.md does not exist, create missing files at absolute stateDir paths and continue (do not fail the reflection run).",
    "7) If there are actionable follow-ups, append concise bullets to NOTES.md.",
    "8) If durable behavior rules should change, edit AGENTS.md with minimal, reversible updates.",
    "9) If there are no meaningful new learnings, say so explicitly.",
    "",
    "Output requirements:",
    "- Briefly summarize what was learned and what was stored/updated.",
    "- End with exactly one line: JOB_STATUS: ok",
  ].join("\n");
}

function systemJobs(stateDir: string): SystemJobSpec[] {
  return [
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
      cron: "0 3 * * *", // Daily at 3am America/New_York
      timezone: "America/New_York",
      spec: {
        mode: "agent_task",
        task: buildDailyReflectionTask(stateDir),
      },
    },
  ];
}

export function ensureSystemJobs(params: { db: NexusDatabase; nowMs: number; stateDir: string; log?: (msg: string) => void }): void {
  const { db, nowMs, log = () => {} } = params;

  for (const job of systemJobs(params.stateDir)) {
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
        schedulerAgentId(),
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
