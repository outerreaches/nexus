import crypto from "node:crypto";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";
import { archiveAndDeleteJob } from "../storage/job-archive.js";
import { nextCronTimeMs, parseCron, validateTimeZone } from "../scheduler/cron.js";

const ONE_SHOT_CRON = "@once";

function randomId(prefix: string): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(10);
  let out = prefix;
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function requireDb(ctx: { db?: unknown }): NexusDatabase | null {
  const db = ctx.db as NexusDatabase | undefined;
  return db ?? null;
}

function schedulerAgentId(): string {
  const value = (process.env.NEXUS_SCHEDULER_AGENT_ID ?? "main").trim();
  return value || "main";
}

function computeNextRunAt(params: { cron: string; timezone: string; afterMs: number }): number {
  const tz = validateTimeZone(params.timezone);
  const schedule = parseCron(params.cron);
  return nextCronTimeMs({ schedule, afterMs: params.afterMs, timeZone: tz });
}

function isOneShotCron(cron: string): boolean {
  return cron.trim() === ONE_SHOT_CRON;
}

function parseAtTimestamp(input: number | string): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error("invalid 'at' timestamp");
    return Math.max(0, Math.floor(input));
  }

  const raw = input.trim();
  if (!raw) throw new Error("invalid 'at' timestamp");

  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error("invalid 'at' timestamp");
    return Math.max(0, Math.floor(n));
  }

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error("invalid 'at' timestamp (use epoch ms or ISO-8601)");
  return Math.max(0, Math.floor(parsed));
}

function getOneShotAtMs(spec: unknown): number | null {
  if (!spec || typeof spec !== "object") return null;
  const value = (spec as { oneShotAtMs?: unknown }).oneShotAtMs;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

function parseJobSpec(specJson: unknown): Record<string, unknown> {
  if (typeof specJson !== "string" || !specJson.trim()) return {};
  try {
    const parsed = JSON.parse(specJson);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function cleanSpecForMode(spec: Record<string, unknown>): void {
  switch (spec.mode) {
    case "tool_call":
      delete spec.command;
      break;
    case "script":
      delete spec.tool;
      delete spec.args;
      break;
    case "agent_task":
      delete spec.command;
      delete spec.tool;
      delete spec.args;
      break;
    default:
      break;
  }
}

function toUtcIso(ts: number | null): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "null";
  return new Date(Math.floor(ts)).toISOString();
}

function isOneShotJob(cron: string, spec: Record<string, unknown>): boolean {
  if (isOneShotCron(cron)) return true;
  if (spec.scheduleKind === "one_shot") return true;
  return getOneShotAtMs(spec) !== null;
}

function isHeartbeatChannel(channel: unknown, channelKey: unknown): boolean {
  if (typeof channel === "string" && channel.trim().toLowerCase() === "heartbeat") return true;
  if (typeof channelKey === "string" && channelKey.trim().toLowerCase().startsWith("heartbeat")) return true;
  return false;
}

function getNextRunAtMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

function heartbeatDeleteGuard(params: {
  nowMs: number;
  cron: string;
  nextRunAtMs: number | null;
  spec: Record<string, unknown>;
}): { blocked: boolean; reason: string | null; oneShot: boolean } {
  const oneShot = isOneShotJob(params.cron, params.spec);
  const oneShotAtMs = getOneShotAtMs(params.spec);
  const effectiveNextRunAtMs = params.nextRunAtMs ?? oneShotAtMs;
  if (typeof effectiveNextRunAtMs === "number" && effectiveNextRunAtMs > params.nowMs) {
    const reason = oneShot
      ? `blocked heartbeat delete for future one-shot job: now_utc=${toUtcIso(params.nowMs)} next_run_utc=${toUtcIso(effectiveNextRunAtMs)}`
      : `blocked heartbeat delete for future scheduled job: now_utc=${toUtcIso(params.nowMs)} next_run_utc=${toUtcIso(effectiveNextRunAtMs)}`;
    return { blocked: true, reason, oneShot };
  }
  return { blocked: false, reason: null, oneShot };
}

export const jobCreate = defineTool({
  name: "job_create",
  description:
    "Create a scheduled job. Use `cron` for recurring jobs, or `at` for a one-shot run (archived then removed after completion). " +
    "Jobs are executed by the orchestrator agent in background lane.",
  parameters: z
    .object({
      name: z.string().min(1).max(120),
      cron: z.string().min(1).max(120).optional().describe("5-field cron: min hour dom mon dow (recurring jobs)"),
      at: z
        .union([z.number().int().min(0), z.string().min(1)])
        .optional()
        .describe("One-shot run timestamp (epoch ms or ISO-8601). Mutually exclusive with cron."),
      timezone: z.string().max(64).default("UTC").describe("IANA timezone, e.g. UTC or America/New_York"),
      enabled: z.boolean().default(true),
      mode: z.enum(["agent_task", "script", "tool_call"]).default("agent_task").describe("Execution mode"),
      task: z.string().max(4000).optional().describe("For agent_task mode: instructions for the agent"),
      contextMode: z
        .enum(["full", "delta", "none"])
        .optional()
        .describe("For agent_task mode: context strategy (full=latest telegram history, delta=bounded telegram deltas, none=job-local only)"),
      command: z.string().optional().describe("For script mode: shell command to run"),
      tool: z.string().optional().describe("For tool_call mode: tool name"),
      args: z.record(z.any()).optional().describe("For tool_call mode: tool arguments"),
    })
    .superRefine((value, issueCtx) => {
      const hasCron = typeof value.cron === "string" && value.cron.trim().length > 0;
      const hasAt = value.at !== undefined;
      if (hasCron === hasAt) {
        issueCtx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Provide exactly one of `cron` (recurring) or `at` (one-shot).",
          path: ["cron"],
        });
      }
    }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const schedulerAgent = schedulerAgentId();

    const nowMs = ctx.nowMs();
    const id = randomId("J");
    const hasAt = args.at !== undefined;
    let oneShotAtMs: number | null = null;
    if (hasAt) {
      try {
        oneShotAtMs = parseAtTimestamp(args.at as number | string);
      } catch (e) {
        return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    const cron = hasAt ? ONE_SHOT_CRON : String(args.cron ?? "").trim();
    if (!hasAt && !cron) return "ERROR: `cron` is required for recurring jobs";
    if (!hasAt && isOneShotCron(cron)) return `ERROR: cron value '${ONE_SHOT_CRON}' is reserved; use 'at' for one-shot jobs`;

    const nextRunAt = !args.enabled
      ? null
      : hasAt
        ? Math.max(oneShotAtMs ?? nowMs, nowMs)
        : computeNextRunAt({ cron, timezone: args.timezone, afterMs: nowMs });

    let spec: any = {};
    if (args.mode === "agent_task") {
      if (!args.task) return "ERROR: 'task' is required for agent_task mode";
      spec = { mode: "agent_task", task: args.task };
      if (args.contextMode) spec.contextMode = args.contextMode;
    } else if (args.mode === "script") {
      if (!args.command) return "ERROR: 'command' is required for script mode";
      spec = { mode: "script", command: args.command };
    } else if (args.mode === "tool_call") {
      if (!args.tool) return "ERROR: 'tool' is required for tool_call mode";
      spec = { mode: "tool_call", tool: args.tool, args: args.args ?? {} };
    }
    if (hasAt) {
      spec.oneShotAtMs = oneShotAtMs;
      spec.scheduleKind = "one_shot";
      spec.autoDeleteAfterRun = true;
    }

    try {
      db.db
        .prepare(
          "INSERT INTO jobs (id, owner_agent_id, name, cron, timezone, enabled, spec_json, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          schedulerAgent,
          args.name,
          cron,
          validateTimeZone(args.timezone),
          args.enabled ? 1 : 0,
          JSON.stringify(spec),
          nextRunAt,
          nowMs,
          nowMs,
        );

      const row = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as any;
      return JSON.stringify(row);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

export const jobList = defineTool({
  name: "job_list",
  description: "List scheduled jobs.",
  parameters: z.object({
    includeDisabled: z.boolean().default(true),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const sql = "SELECT * FROM jobs WHERE (? = 1 OR enabled = 1) ORDER BY created_at DESC LIMIT ?";
    const stmt = db.db.prepare(sql);
    const rows = stmt.all(args.includeDisabled ? 1 : 0, args.limit) as any[];
    return JSON.stringify(rows);
  },
});

export const jobGet = defineTool({
  name: "job_get",
  description: "Get a scheduled job by id.",
  parameters: z.object({
    id: z.string().min(1).max(32),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(args.id) as any;
    if (!row) return "ERROR: not found";
    return JSON.stringify(row);
  },
});

export const jobUpdate = defineTool({
  name: "job_update",
  description: "Update a scheduled job (cron/one-shot/task/enabled), or manually set the next run time to stagger execution.",
  parameters: z.object({
    id: z.string().min(1).max(32),
    name: z.string().min(1).max(120).optional(),
    cron: z.string().min(1).max(120).optional(),
    at: z
      .union([z.number().int().min(0), z.string().min(1)])
      .optional()
      .describe("Convert to/update a one-shot run timestamp (epoch ms or ISO-8601)."),
    timezone: z.string().max(64).optional(),
    enabled: z.boolean().optional(),
    task: z.string().max(4000).optional(),
    mode: z.enum(["agent_task", "script", "tool_call"]).optional(),
    command: z.string().optional(),
    tool: z.string().optional(),
    args: z.record(z.any()).optional(),
    contextMode: z
      .enum(["full", "delta", "none"])
      .optional()
      .describe("For agent_task mode: context strategy (full=latest telegram history, delta=bounded telegram deltas, none=job-local only)"),
    cleanSpec: z
      .boolean()
      .default(false)
      .describe("When true, remove mode-incompatible fields from spec before save (e.g. command in tool_call mode)."),
    nextRunAtMs: z.number().int().min(0).optional().describe("Manually set the next run time (epoch ms). Useful for staggering jobs."),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const nowMs = ctx.nowMs();

    const existing = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(args.id) as any;
    if (!existing) return "ERROR: not found";

    const name = args.name ?? String(existing.name);
    if (args.at !== undefined && args.cron !== undefined) return "ERROR: provide only one of `at` or `cron`";

    const existingCron = String(existing.cron);
    let cron = args.cron ?? existingCron;
    if (args.cron !== undefined && isOneShotCron(args.cron)) {
      return `ERROR: cron value '${ONE_SHOT_CRON}' is reserved; use 'at' for one-shot jobs`;
    }
    const timezone = validateTimeZone(args.timezone ?? String(existing.timezone));

    const enabled = args.enabled === undefined ? Number(existing.enabled) === 1 : args.enabled;

    let spec: any = null;
    try {
      spec = JSON.parse(String(existing.spec_json ?? "{}"));
    } catch {
      spec = {};
    }

    // Merge updates
    if (args.mode) spec.mode = args.mode;
    if (args.task !== undefined) spec.task = args.task;
    if (args.command !== undefined) spec.command = args.command;
    if (args.tool !== undefined) spec.tool = args.tool;
    if (args.args !== undefined) spec.args = args.args;
    if (args.contextMode !== undefined) spec.contextMode = args.contextMode;

    // Ensure mode defaults if missing
    if (!spec.mode) spec.mode = "agent_task";

    if (args.at !== undefined) {
      let atMs = 0;
      try {
        atMs = parseAtTimestamp(args.at);
      } catch (e) {
        return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
      cron = ONE_SHOT_CRON;
      spec.oneShotAtMs = atMs;
      spec.scheduleKind = "one_shot";
      spec.autoDeleteAfterRun = true;
    } else if (args.cron !== undefined && !isOneShotCron(args.cron)) {
      delete spec.oneShotAtMs;
      delete spec.scheduleKind;
      delete spec.autoDeleteAfterRun;
    } else if (isOneShotCron(cron) && getOneShotAtMs(spec) === null && typeof existing.next_run_at === "number") {
      spec.oneShotAtMs = Math.max(0, Math.floor(existing.next_run_at));
      spec.scheduleKind = "one_shot";
      spec.autoDeleteAfterRun = true;
    }

    // Validate
    if (spec.mode === "agent_task" && !spec.task) return "ERROR: 'task' is required for agent_task mode";
    if (spec.mode === "script" && !spec.command) return "ERROR: 'command' is required for script mode";
    if (spec.mode === "tool_call" && !spec.tool) return "ERROR: 'tool' is required for tool_call mode";
    if (args.cleanSpec) cleanSpecForMode(spec);
    if (spec.mode !== "agent_task") delete spec.contextMode;

    const specJson = JSON.stringify(spec ?? {});

    const scheduleChanged =
      args.cron !== undefined || args.at !== undefined || args.timezone !== undefined || args.enabled !== undefined;
    let nextRunAt = existing.next_run_at as number | null;
    if (!enabled) {
      nextRunAt = null;
    } else if (args.nextRunAtMs !== undefined) {
      nextRunAt = args.nextRunAtMs;
    } else if (isOneShotCron(cron)) {
      const oneShotAtMs = getOneShotAtMs(spec);
      if (scheduleChanged || nextRunAt === null) nextRunAt = Math.max(oneShotAtMs ?? nowMs, nowMs);
    } else if (scheduleChanged || nextRunAt === null) {
      // Recompute only when schedule semantics changed or there was no next run.
      nextRunAt = computeNextRunAt({ cron, timezone, afterMs: nowMs });
    }

    db.db
      .prepare(
        "UPDATE jobs SET name = ?, cron = ?, timezone = ?, enabled = ?, spec_json = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(name, cron, timezone, enabled ? 1 : 0, specJson, nextRunAt, nowMs, args.id);

    const row = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(args.id) as any;
    return JSON.stringify(row);
  },
});

export const jobPause = defineTool({
  name: "job_pause",
  description: "Pause a job (disable scheduling).",
  parameters: z.object({
    id: z.string().min(1).max(32),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const nowMs = ctx.nowMs();
    const row = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(args.id) as any;
    if (!row) return "ERROR: not found";
    db.db.prepare("UPDATE jobs SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ?").run(nowMs, args.id);
    return "OK";
  },
});

export const jobResume = defineTool({
  name: "job_resume",
  description: "Resume a paused job (enable scheduling).",
  parameters: z.object({
    id: z.string().min(1).max(32),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const nowMs = ctx.nowMs();
    const row = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(args.id) as any;
    if (!row) return "ERROR: not found";
    let nextRunAt = nowMs;
    const cron = String(row.cron);
    if (isOneShotCron(cron)) {
      let spec: any = {};
      try {
        spec = JSON.parse(String(row.spec_json ?? "{}"));
      } catch {
        spec = {};
      }
      nextRunAt = Math.max(getOneShotAtMs(spec) ?? nowMs, nowMs);
    } else {
      nextRunAt = computeNextRunAt({ cron, timezone: String(row.timezone), afterMs: nowMs });
    }
    db.db.prepare("UPDATE jobs SET enabled = 1, next_run_at = ?, updated_at = ? WHERE id = ?").run(nextRunAt, nowMs, args.id);
    return "OK";
  },
});

export const jobDelete = defineTool({
  name: "job_delete",
  description: "Delete a job. Job definition, runs, and events are archived before removal.",
  parameters: z.object({
    id: z.string().min(1).max(32),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const nowMs = ctx.nowMs();
    const row = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(args.id) as any;
    if (!row) return "ERROR: not found";

    const requestChannel = ctx.request?.channel ?? null;
    const requestChannelKey = ctx.request?.channelKey ?? null;
    const requestSessionId = ctx.request?.sessionId ?? null;
    const requestAgentId = ctx.request?.agentId ?? "unknown";

    const linked = db.db
      .prepare("SELECT id, source_id, label FROM data_intake_sources WHERE job_id = ? LIMIT 1")
      .get(args.id) as { id: string; source_id: string; label: string | null } | undefined;
    if (linked) {
      const label = linked.label ?? linked.source_id;
      return `ERROR: job is linked to data intake source '${label}' (instance ${linked.id}). Delete the source instead.`;
    }

    const spec = parseJobSpec(row.spec_json);
    const cron = String(row.cron ?? "");
    const nextRunAtMs = getNextRunAtMs(row.next_run_at);
    const fromHeartbeat = isHeartbeatChannel(requestChannel, requestChannelKey);
    if (fromHeartbeat) {
      const guard = heartbeatDeleteGuard({ nowMs, cron, nextRunAtMs, spec });
      if (guard.blocked) {
        const reason = guard.reason ?? "blocked heartbeat delete";
        ctx.log(
          `job_delete guard: id=${args.id} channel=heartbeat blocked=true one_shot=${guard.oneShot} ${reason} session=${requestSessionId ?? "n/a"}`,
        );
        return `ERROR: refusing to delete job '${args.id}' from heartbeat while next_run_at is in the future (${reason})`;
      }
    }

    const oneShot = isOneShotJob(cron, spec);
    const archivedBy = fromHeartbeat ? `tool:job_manage:delete_heartbeat:${requestAgentId}` : `tool:job_manage:delete:${requestAgentId}`;
    const archiveReason = fromHeartbeat ? "heartbeat_delete" : "manual_delete";

    ctx.log(
      `job_delete audit: id=${args.id} channel=${requestChannel ?? "unknown"} channel_key=${requestChannelKey ?? "unknown"} one_shot=${oneShot} next_run_utc=${toUtcIso(nextRunAtMs)} now_utc=${toUtcIso(nowMs)} archived_by=${archivedBy}`,
    );

    const archived = archiveAndDeleteJob({
      db,
      jobId: args.id,
      archivedAtMs: nowMs,
      archiveReason,
      archivedBy,
      metadata: {
        channel: requestChannel,
        channelKey: requestChannelKey,
        sessionId: requestSessionId,
        heartbeatDelete: fromHeartbeat,
        oneShot,
        nextRunAtMs,
        nextRunAtUtc: toUtcIso(nextRunAtMs),
        deletedAtUtc: toUtcIso(nowMs),
      },
    });
    if (!archived.found) return "ERROR: not found";
    return "OK";
  },
});

export const jobRunNow = defineTool({
  name: "job_run_now",
  description: "Trigger a job to run ASAP (sets next_run_at to now if enabled).",
  parameters: z.object({
    id: z.string().min(1).max(32),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const nowMs = ctx.nowMs();
    const row = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(args.id) as any;
    if (!row) return "ERROR: not found";
    if (Number(row.enabled) !== 1) return "ERROR: job is disabled (resume it first)";
    db.db.prepare("UPDATE jobs SET next_run_at = ?, updated_at = ? WHERE id = ?").run(nowMs, nowMs, args.id);
    return "OK";
  },
});

export const jobRuns = defineTool({
  name: "job_runs",
  description: "List recent runs for a job.",
  parameters: z.object({
    id: z.string().min(1).max(32),
    limit: z.number().int().min(1).max(200).default(25),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const job = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(args.id) as any;
    if (!job) return "ERROR: not found";
    const rows = db.db.prepare("SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?").all(args.id, args.limit) as any[];
    return JSON.stringify(rows);
  },
});

export const jobRunGet = defineTool({
  name: "job_run_get",
  description: "Get a specific job run by id.",
  parameters: z.object({
    runId: z.string().min(1).max(32),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = db.db.prepare("SELECT * FROM job_runs WHERE id = ?").get(args.runId) as any;
    if (!row) return "ERROR: not found";
    return JSON.stringify(row);
  },
});

export const jobEvents = defineTool({
  name: "job_events",
  description: "List recent job events for a job.",
  parameters: z.object({
    id: z.string().min(1).max(32),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const job = db.db.prepare("SELECT * FROM jobs WHERE id = ?").get(args.id) as any;
    if (!job) return "ERROR: not found";
    const rows = db.db
      .prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(args.id, args.limit) as any[];
    return JSON.stringify(rows);
  },
});

export const jobManage = defineTool({
  name: "job_manage",
  description:
    "Unified scheduler management tool. Action can create/list/get/update/pause/resume/run_now/delete jobs, list runs/events, or fetch a specific run.",
  parameters: z.object({
    action: z
      .enum(["create", "list", "get", "update", "pause", "resume", "run_now", "delete", "runs", "run_get", "events"])
      .default("list"),
    id: z.string().min(1).max(32).optional(),
    runId: z.string().min(1).max(32).optional(),
    name: z.string().min(1).max(120).optional(),
    cron: z.string().min(1).max(120).optional(),
    at: z.union([z.number().int().min(0), z.string().min(1)]).optional(),
    timezone: z.string().max(64).optional(),
    enabled: z.boolean().optional(),
    mode: z.enum(["agent_task", "script", "tool_call"]).optional(),
    task: z.string().max(4000).optional(),
    contextMode: z.enum(["full", "delta", "none"]).optional(),
    command: z.string().optional(),
    tool: z.string().optional(),
    args: z.record(z.any()).optional(),
    cleanSpec: z.boolean().default(false),
    nextRunAtMs: z.number().int().min(0).optional(),
    includeDisabled: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).superRefine((value, issueCtx) => {
    const requiresId = new Set(["get", "update", "pause", "resume", "run_now", "delete", "runs", "events"]);
    if (requiresId.has(value.action) && !value.id) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `id is required when action='${value.action}'`,
        path: ["id"],
      });
    }
    if (value.action === "run_get" && !value.runId) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "runId is required when action='run_get'",
        path: ["runId"],
      });
    }
    if (value.action === "create" && !value.name) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "name is required when action='create'",
        path: ["name"],
      });
    }
  }),
  execute: async (args, ctx) => {
    switch (args.action) {
      case "create":
        return jobCreate.execute(
          {
            name: args.name ?? "",
            ...(args.cron !== undefined ? { cron: args.cron } : {}),
            ...(args.at !== undefined ? { at: args.at } : {}),
            ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
            ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
            ...(args.mode !== undefined ? { mode: args.mode } : {}),
            ...(args.task !== undefined ? { task: args.task } : {}),
            ...(args.contextMode !== undefined ? { contextMode: args.contextMode } : {}),
            ...(args.command !== undefined ? { command: args.command } : {}),
            ...(args.tool !== undefined ? { tool: args.tool } : {}),
            ...(args.args !== undefined ? { args: args.args } : {}),
          },
          ctx,
        );
      case "list":
        return jobList.execute(
          {
            ...(args.includeDisabled !== undefined ? { includeDisabled: args.includeDisabled } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          },
          ctx,
        );
      case "get":
        return jobGet.execute({ id: args.id ?? "" }, ctx);
      case "update":
        return jobUpdate.execute(
          {
            id: args.id ?? "",
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.cron !== undefined ? { cron: args.cron } : {}),
            ...(args.at !== undefined ? { at: args.at } : {}),
            ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
            ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
            ...(args.task !== undefined ? { task: args.task } : {}),
            ...(args.mode !== undefined ? { mode: args.mode } : {}),
            ...(args.command !== undefined ? { command: args.command } : {}),
            ...(args.tool !== undefined ? { tool: args.tool } : {}),
            ...(args.args !== undefined ? { args: args.args } : {}),
            ...(args.contextMode !== undefined ? { contextMode: args.contextMode } : {}),
            ...(args.cleanSpec !== undefined ? { cleanSpec: args.cleanSpec } : {}),
            ...(args.nextRunAtMs !== undefined ? { nextRunAtMs: args.nextRunAtMs } : {}),
          },
          ctx,
        );
      case "pause":
        return jobPause.execute({ id: args.id ?? "" }, ctx);
      case "resume":
        return jobResume.execute({ id: args.id ?? "" }, ctx);
      case "run_now":
        return jobRunNow.execute({ id: args.id ?? "" }, ctx);
      case "delete":
        return jobDelete.execute({ id: args.id ?? "" }, ctx);
      case "runs":
        return jobRuns.execute(
          {
            id: args.id ?? "",
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          },
          ctx,
        );
      case "run_get":
        return jobRunGet.execute({ runId: args.runId ?? "" }, ctx);
      case "events":
        return jobEvents.execute(
          {
            id: args.id ?? "",
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          },
          ctx,
        );
      default:
        return `ERROR: unsupported action '${args.action}'`;
    }
  },
});
