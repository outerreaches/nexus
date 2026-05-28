import crypto from "node:crypto";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";
import { archiveAndDeleteJob } from "../storage/job-archive.js";
import { findNearestTelegramAncestorRun } from "../storage/run-reports.js";
import { nextCronTimeMs, parseCron, validateTimeZone } from "../scheduler/cron.js";
import {
  applyOrigin,
  clearAgentTaskDeliveryMetadata,
  getOneShotAtMs,
  hasResumableOrigin,
  ONE_SHOT_CRON,
  parseJobSpec,
  parsePositiveTelegramChatId,
  readDeliveryMode,
  readOrigin,
  type AgentTaskDeliveryMode,
  type AgentTaskOrigin,
  isOneShotCron,
  migrateLegacyDataIntakeJobSpecs,
} from "../scheduler/job-spec.js";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const JOB_SPEC_TOP_LEVEL_FIELDS = [
  "mode",
  "task",
  "tool",
  "command",
  "args",
  "deliveryMode",
  "contextMode",
  "oneShotAtMs",
  "scheduleKind",
  "autoDeleteAfterRun",
] as const;

/**
 * Some LLMs nest the entire job spec inside a single wrapper key (most
 * commonly `deliveryMode`, because the field name is suggestive), producing
 * shapes like `{ deliveryMode: { mode, task, deliveryMode: "report_only", ... } }`.
 * The top-level then has no `mode` or `task`, and the per-mode validators
 * reject the update with a generic "'task' is required" error.
 *
 * Detect that single-key-wrapper pattern: if the spec has exactly one key
 * AND that key's value is a record carrying at least one real spec field,
 * flatten it. This is the same family of fix as `unwrapSelfNestedArgs` in
 * data-intake.ts for `data_intake_manage`.
 */
export function unwrapJobSpec(spec: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(spec);
  if (keys.length !== 1) return spec;
  const inner = spec[keys[0]!];
  if (!isRecord(inner)) return spec;
  const innerKeys = Object.keys(inner);
  const hasSpecField = innerKeys.some((k) => (JOB_SPEC_TOP_LEVEL_FIELDS as readonly string[]).includes(k));
  if (!hasSpecField) return spec;
  return { ...inner };
}

function describeSpecShapeForError(spec: Record<string, unknown>): string {
  const keys = Object.keys(spec);
  if (keys.length === 0) return "empty spec";
  return `top-level keys: ${keys.join(", ")}`;
}

function nestedManageArgs(value: { args?: Record<string, unknown> }): Record<string, unknown> {
  return isRecord(value.args) ? value.args : {};
}

function readStringArg(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readNumberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

function readBooleanArg(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function resolveJobManageId(value: { id?: string; jobId?: string; args?: Record<string, unknown> }): string | undefined {
  const nested = nestedManageArgs(value);
  return readStringArg(value.id) ?? readStringArg(value.jobId) ?? readStringArg(nested.id) ?? readStringArg(nested.jobId);
}

function resolveJobManageRunId(value: { runId?: string; args?: Record<string, unknown> }): string | undefined {
  const nested = nestedManageArgs(value);
  return readStringArg(value.runId) ?? readStringArg(nested.runId);
}

function resolveJobManageLimit(value: { limit?: number; args?: Record<string, unknown> }): number | undefined {
  const nested = nestedManageArgs(value);
  return readNumberArg(value.limit) ?? readNumberArg(nested.limit);
}

function resolveJobManageIncludeDisabled(value: { includeDisabled?: boolean; args?: Record<string, unknown> }): boolean | undefined {
  const nested = nestedManageArgs(value);
  return readBooleanArg(value.includeDisabled) ?? readBooleanArg(nested.includeDisabled);
}

function toIsoOrNull(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(Math.floor(value)).toISOString();
}

function formatJobRunHistoryRow(row: Record<string, unknown>): Record<string, unknown> {
  const startedAt = typeof row.started_at === "number" ? row.started_at : null;
  const endedAt = typeof row.ended_at === "number" ? row.ended_at : null;
  const durationMs =
    startedAt !== null && endedAt !== null && endedAt >= startedAt ? endedAt - startedAt : null;
  return {
    id: row.id,
    jobId: row.job_id,
    ownerAgentId: row.owner_agent_id,
    status: row.status,
    scheduledFor: row.scheduled_for ?? null,
    scheduledForIso: toIsoOrNull(row.scheduled_for),
    startedAt,
    startedAtIso: toIsoOrNull(startedAt),
    endedAt,
    endedAtIso: toIsoOrNull(endedAt),
    durationMs,
    error: row.error ?? null,
    output: row.output ?? null,
    toolCallsUsed: row.tool_calls_used ?? null,
    iterationsUsed: row.iterations_used ?? null,
  };
}

function jobListStatus(row: Record<string, unknown>, nowMs: number): string {
  const enabled = Number(row.enabled) === 1;
  const consecutiveFailures = typeof row.consecutive_failures === "number" ? row.consecutive_failures : 0;
  const lastFailureAt = typeof row.last_failure_at === "number" ? row.last_failure_at : null;
  const lastRunAt = typeof row.last_run_at === "number" ? row.last_run_at : null;
  const nextRunAt = getNextRunAtMs(row.next_run_at);
  const spec = parseJobSpec(typeof row.spec_json === "string" ? row.spec_json : "{}");
  const cron = typeof row.cron === "string" ? row.cron : "";
  const oneShot = isOneShotJob(cron, spec);

  if (!enabled) {
    if (lastFailureAt !== null && consecutiveFailures > 0) return "failed";
    if (oneShot && lastRunAt !== null) return "executed";
    return "disabled";
  }
  if (oneShot) {
    if (nextRunAt === null && lastRunAt !== null) return "executed";
    return "pending";
  }
  if (lastFailureAt !== null && consecutiveFailures > 0) return "failed";
  if (nextRunAt !== null && nextRunAt <= nowMs) return "pending";
  return "scheduled";
}

function isInteractiveOriginChannel(channel: string): boolean {
  return channel === "telegram" || channel === "cli";
}

function resolveAgentTaskOrigin(ctx: { request?: Record<string, unknown>; db?: unknown }): AgentTaskOrigin | null {
  const db = requireDb(ctx);
  const request = ctx.request as
    | {
        channel?: unknown;
        channelKey?: unknown;
        sessionId?: unknown;
        agentId?: unknown;
        runId?: unknown;
        preset?: unknown;
      }
    | undefined;
  if (!request) return null;

  const channel = typeof request.channel === "string" ? request.channel.trim().toLowerCase() : "";
  const channelKey = typeof request.channelKey === "string" ? request.channelKey.trim() : "";
  const sessionId = typeof request.sessionId === "string" && request.sessionId.trim() ? request.sessionId.trim() : null;
  const agentId = typeof request.agentId === "string" && request.agentId.trim() ? request.agentId.trim() : null;
  const runId = typeof request.runId === "string" && request.runId.trim() ? request.runId.trim() : null;
  const preset = typeof request.preset === "string" && request.preset.trim() ? request.preset.trim() : null;

  if (channel && channelKey && agentId && isInteractiveOriginChannel(channel)) {
    return {
      channel,
      channelKey,
      sessionId,
      agentId,
      runId,
      preset,
      telegramChatId: channel === "telegram" ? parsePositiveTelegramChatId(channelKey) : null,
      recoveredFrom: "direct_request",
    };
  }

  if (db && runId) {
    const ancestor = findNearestTelegramAncestorRun(db, runId);
    if (ancestor) {
      return {
        channel: "telegram",
        channelKey: ancestor.channelKey,
        sessionId: ancestor.sessionId,
        agentId: ancestor.agentId,
        runId: ancestor.runId,
        preset: ancestor.preset,
        telegramChatId: parsePositiveTelegramChatId(ancestor.channelKey),
        recoveredFrom: "telegram_ancestor",
      };
    }
  }

  return null;
}

function chooseAgentTaskDeliveryMode(params: {
  explicit?: AgentTaskDeliveryMode;
  oneShot: boolean;
  origin: AgentTaskOrigin | null;
}): AgentTaskDeliveryMode {
  if (params.explicit === "session_resume") return "session_resume";
  if (params.explicit === "report_only") return "report_only";
  return params.oneShot && params.origin ? "session_resume" : "report_only";
}

function applyAgentTaskDeliveryDefaults(params: {
  spec: Record<string, unknown>;
  cron: string;
  origin: AgentTaskOrigin | null;
  explicit?: AgentTaskDeliveryMode;
}): AgentTaskDeliveryMode {
  const oneShot = isOneShotCron(params.cron);
  const deliveryMode = chooseAgentTaskDeliveryMode({
    explicit: params.explicit,
    oneShot,
    origin: params.origin,
  });

  if (deliveryMode === "session_resume") {
    if (!oneShot) throw new Error("deliveryMode='session_resume' requires a one-shot job (`at`)");
    if (!params.origin) {
      throw new Error("deliveryMode='session_resume' requires a resumable interactive origin (telegram/cli or telegram ancestor)");
    }
  }

  params.spec.deliveryMode = deliveryMode;
  if (params.origin) {
    applyOrigin(params.spec, params.origin);
  } else if (deliveryMode === "session_resume") {
    throw new Error("session_resume origin resolution failed");
  } else {
    applyOrigin(params.spec, null);
  }

  if (deliveryMode === "report_only" && oneShot && !hasResumableOrigin(params.spec)) {
    params.spec.resumeUnavailable = true;
  } else {
    delete params.spec.resumeUnavailable;
  }

  return deliveryMode;
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
      deliveryMode: z
        .enum(["session_resume", "report_only"])
        .optional()
        .describe("For agent_task mode: session_resume continues an interactive conversation; report_only runs as detached background work."),
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

    if (args.mode === "agent_task") {
      const origin = resolveAgentTaskOrigin(ctx);
      try {
        applyAgentTaskDeliveryDefaults({
          spec,
          cron,
          origin,
          explicit: args.deliveryMode,
        });
      } catch (e) {
        return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
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
    const nowMs = ctx.nowMs();
    return JSON.stringify(rows.map((row) => ({ ...row, status: jobListStatus(row, nowMs) })));
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
    deliveryMode: z.enum(["session_resume", "report_only"]).optional(),
    command: z.string().optional(),
    tool: z.string().optional(),
    args: z.record(z.any()).optional(),
    spec: z.record(z.unknown()).optional().describe("Direct replacement for spec_json. Top-level keys: `mode` ('agent_task'|'script'|'tool_call'), and one of `task` (agent_task), `command` (script), `tool`+`args` (tool_call). Optional: `deliveryMode` ('session_resume'|'report_only', string), `contextMode`, `oneShotAtMs`, `scheduleKind`, `autoDeleteAfterRun`. Do NOT nest mode/task inside a wrapper key like `deliveryMode`. Explicit `mode`/`task`/`tool`/`args` args on this call still override matching fields in `spec`."),
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
    if (args.spec !== undefined) {
      spec = unwrapJobSpec({ ...args.spec });
    } else {
      try {
        spec = JSON.parse(String(existing.spec_json ?? "{}"));
      } catch {
        spec = {};
      }
    }

    // Merge updates
    if (args.mode) spec.mode = args.mode;
    if (args.task !== undefined) spec.task = args.task;
    if (args.deliveryMode !== undefined) spec.deliveryMode = args.deliveryMode;
    if (args.command !== undefined) spec.command = args.command;
    if (args.tool !== undefined) spec.tool = args.tool;
    if (args.args !== undefined) spec.args = args.args;
    if (args.contextMode !== undefined) spec.contextMode = args.contextMode;

    // Ensure mode defaults if missing
    if (!spec.mode) spec.mode = "agent_task";

    // If `deliveryMode` was passed as an object (LLM nesting mistake), and
    // none of the actual spec fields it would carry are at the top level
    // yet, try to recover the nested fields too. Common shape:
    // spec.deliveryMode = { deliveryMode: "report_only", mode, task, ... }
    if (isRecord(spec.deliveryMode)) {
      const nested = spec.deliveryMode as Record<string, unknown>;
      const innerDelivery = nested.deliveryMode;
      if (typeof innerDelivery === "string") {
        for (const field of JOB_SPEC_TOP_LEVEL_FIELDS) {
          if (field === "deliveryMode") continue;
          if (spec[field] === undefined && nested[field] !== undefined) {
            spec[field] = nested[field];
          }
        }
        // Pull origin* metadata too if the nested object had it.
        for (const [k, v] of Object.entries(nested)) {
          if (k.startsWith("origin") && spec[k] === undefined) spec[k] = v;
        }
        spec.deliveryMode = innerDelivery;
      }
    }

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
    if (spec.mode === "agent_task" && !spec.task) {
      return `ERROR: 'task' is required for agent_task mode (${describeSpecShapeForError(spec)}). Pass spec like {"mode":"agent_task","task":"...","deliveryMode":"report_only"} — do not nest mode/task inside another wrapper key.`;
    }
    if (spec.mode === "script" && !spec.command) {
      return `ERROR: 'command' is required for script mode (${describeSpecShapeForError(spec)}).`;
    }
    if (spec.mode === "tool_call" && !spec.tool) {
      return `ERROR: 'tool' is required for tool_call mode (${describeSpecShapeForError(spec)}).`;
    }
    if (args.cleanSpec) cleanSpecForMode(spec);
    if (spec.mode !== "agent_task") {
      clearAgentTaskDeliveryMetadata(spec);
    } else {
      const existingOrigin = readOrigin(spec);
      const currentOrigin = resolveAgentTaskOrigin(ctx);
      const mergedOrigin = currentOrigin ?? existingOrigin;
      const persistedDeliveryMode = readDeliveryMode(spec);
      try {
        applyAgentTaskDeliveryDefaults({
          spec,
          cron,
          origin: mergedOrigin,
          explicit: args.deliveryMode ?? (persistedDeliveryMode === "report_only" ? "report_only" : undefined),
        });
      } catch (e) {
        return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

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

export const jobRunHistory = defineTool({
  name: "job_run_history",
  description:
    "List recent runs for a job with timestamps (epoch + ISO), duration, status, error, and full output. " +
    "Use this for debugging failures; prefer job_runs when you only need raw rows.",
  parameters: z.object({
    id: z.string().min(1).max(32),
    limit: z.number().int().min(1).max(200).default(25),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const job = db.db.prepare("SELECT id FROM jobs WHERE id = ?").get(args.id) as any;
    if (!job) return "ERROR: not found";
    const rows = db.db
      .prepare("SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(args.id, args.limit) as any[];
    return JSON.stringify(rows.map((row) => formatJobRunHistoryRow(row)));
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
    "Unified scheduler management tool. Action can create/list/get/update/pause/resume/run_now/delete jobs, " +
    "list runs (`runs`/`list_runs` return raw rows; `run_history` returns timestamps + durationMs + full error/output for debugging), " +
    "fetch a specific run, list events, or migrate legacy specs.",
  parameters: z.object({
    action: z
      .enum([
        "create",
        "list",
        "get",
        "update",
        "pause",
        "resume",
        "run_now",
        "delete",
        "runs",
        "list_runs",
        "run_history",
        "run_get",
        "events",
        "migrate_specs",
      ])
      .default("list"),
    id: z.string().min(1).max(32).optional(),
    jobId: z.string().min(1).max(32).optional().describe("Alias of id for job-oriented actions."),
    runId: z.string().min(1).max(32).optional(),
    name: z.string().min(1).max(120).optional(),
    cron: z.string().min(1).max(120).optional(),
    at: z.union([z.number().int().min(0), z.string().min(1)]).optional(),
    timezone: z.string().max(64).optional(),
    enabled: z.boolean().optional(),
    mode: z.enum(["agent_task", "script", "tool_call"]).optional(),
    task: z.string().max(4000).optional(),
    deliveryMode: z.enum(["session_resume", "report_only"]).optional(),
    contextMode: z.enum(["full", "delta", "none"]).optional(),
    command: z.string().optional(),
    tool: z.string().optional(),
    args: z.record(z.any()).optional(),
    spec: z.record(z.unknown()).optional().describe("Direct replacement for spec_json when action='update'."),
    cleanSpec: z.boolean().default(false),
    nextRunAtMs: z.number().int().min(0).optional(),
    includeDisabled: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }).superRefine((value, issueCtx) => {
    const requiresId = new Set(["get", "update", "pause", "resume", "run_now", "delete", "runs", "list_runs", "run_history", "events"]);
    if (requiresId.has(value.action) && !resolveJobManageId(value)) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `id is required when action='${value.action}'`,
        path: ["id"],
      });
    }
    if (value.action === "run_get" && !resolveJobManageRunId(value)) {
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
    const id = resolveJobManageId(args) ?? "";
    const runId = resolveJobManageRunId(args) ?? "";
    const limit = resolveJobManageLimit(args);
    const includeDisabled = resolveJobManageIncludeDisabled(args);

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
            ...(args.deliveryMode !== undefined ? { deliveryMode: args.deliveryMode } : {}),
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
            ...(includeDisabled !== undefined ? { includeDisabled } : {}),
            ...(limit !== undefined ? { limit } : {}),
          },
          ctx,
        );
      case "get":
        return jobGet.execute({ id }, ctx);
      case "update":
        return jobUpdate.execute(
          {
            id,
            ...(args.name !== undefined ? { name: args.name } : {}),
            ...(args.cron !== undefined ? { cron: args.cron } : {}),
            ...(args.at !== undefined ? { at: args.at } : {}),
            ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
            ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
            ...(args.task !== undefined ? { task: args.task } : {}),
            ...(args.mode !== undefined ? { mode: args.mode } : {}),
            ...(args.deliveryMode !== undefined ? { deliveryMode: args.deliveryMode } : {}),
            ...(args.command !== undefined ? { command: args.command } : {}),
            ...(args.tool !== undefined ? { tool: args.tool } : {}),
            ...(args.args !== undefined ? { args: args.args } : {}),
            ...(args.spec !== undefined ? { spec: args.spec } : {}),
            ...(args.contextMode !== undefined ? { contextMode: args.contextMode } : {}),
            ...(args.cleanSpec !== undefined ? { cleanSpec: args.cleanSpec } : {}),
            ...(args.nextRunAtMs !== undefined ? { nextRunAtMs: args.nextRunAtMs } : {}),
          },
          ctx,
        );
      case "pause":
        return jobPause.execute({ id }, ctx);
      case "resume":
        return jobResume.execute({ id }, ctx);
      case "run_now":
        return jobRunNow.execute({ id }, ctx);
      case "delete":
        return jobDelete.execute({ id }, ctx);
      case "runs":
      case "list_runs":
        return jobRuns.execute(
          {
            id,
            ...(limit !== undefined ? { limit } : {}),
          },
          ctx,
        );
      case "run_history":
        return jobRunHistory.execute(
          {
            id,
            ...(limit !== undefined ? { limit } : {}),
          },
          ctx,
        );
      case "run_get":
        return jobRunGet.execute({ runId }, ctx);
      case "events":
        return jobEvents.execute(
          {
            id,
            ...(limit !== undefined ? { limit } : {}),
          },
          ctx,
        );
      case "migrate_specs": {
        const db = requireDb(ctx);
        if (!db) return "ERROR: database is not available";
        return JSON.stringify(migrateLegacyDataIntakeJobSpecs(db, (line) => ctx.log(`job_manage: ${line}`)));
      }
      default:
        return `ERROR: unsupported action '${args.action}'`;
    }
  },
});
