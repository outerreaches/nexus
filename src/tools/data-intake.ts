import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { defineTool, type Tool } from "../core/tools.js";
import {
  initDataIntake,
  findDataSourcesByTag,
  getDataSource,
  listDataSources,
  listDataItems,
  listLatestDataItems,
  pruneDataItems,
  runDataSource,
} from "../data-intake/index.js";
import { randomId } from "../data-intake/utils.js";
import { validateSourceParams } from "../data-intake/param-negotiation.js";

function requireDb(ctx: { db?: unknown }) {
  return ctx.db ?? null;
}

function schedulerAgentId(): string {
  const value = (process.env.NEXUS_SCHEDULER_AGENT_ID ?? "main").trim();
  return value || "main";
}

export const dataIntakeListSources = defineTool({
  name: "data_intake_list_sources",
  description:
    "List available data intake sources with usage notes and parameter schemas. Optionally filter by tag.",
  parameters: z.object({
    tag: z.string().min(1).optional(),
  }),
  execute: async (args) => {
    initDataIntake();
    const sources = args.tag ? findDataSourcesByTag(args.tag) : listDataSources();
    return JSON.stringify(
      sources.map((source) => ({
        id: source.id,
        name: source.name,
        description: source.description,
        usageNote: source.usageNote,
        paramsSchema: source.paramsSchema
          ? zodToJsonSchema(source.paramsSchema, { target: "jsonSchema7" })
          : null,
        tags: source.tags,
        schemaVersion: source.schemaVersion,
        defaultTtlMs: source.defaultTtlMs,
      })),
      null,
      2,
    );
  },
});

export const dataIntakeRun = defineTool({
  name: "data_intake_run",
  description:
    "Run a data intake source and store normalized results. " +
    "Use instanceId to run a configured source (recommended) — the instance's label will be added as a tag for easy querying. " +
    "Alternatively, provide sourceId + params directly for ad-hoc runs.",
  parameters: z.object({
    instanceId: z.string().min(1).optional().describe("ID of a configured data intake source instance"),
    sourceId: z.string().min(1).optional().describe("Source type ID (e.g., 'weather.open-meteo') for ad-hoc runs"),
    params: z.record(z.unknown()).optional().describe("Params for ad-hoc runs (ignored if instanceId is provided)"),
  }),
  execute: async (args, ctx) => {
    initDataIntake();
    const db = ctx.db as any;
    const attemptedAtMs = ctx.nowMs();

    let sourceId: string;
    let params: unknown;
    const instanceTags: string[] = [];
    let instance: { id: string; source_id: string; label: string | null; params_json: string } | null = null;
    let updateInstanceStatus:
      | ((next: { lastRunAtMs: number; lastError: string | null }) => void)
      | null = null;

    const formatErrorForStorage = (errors: string[]): string | null => {
      if (!errors || errors.length === 0) return null;
      const first = String(errors[0] ?? "").trim();
      if (!first) return null;
      const suffix = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
      const msg = `${first}${suffix}`;
      return msg.length > 2000 ? `${msg.slice(0, 2000)}…` : msg;
    };

    // If instanceId is provided, look up the configured source
    if (args.instanceId) {
      if (!db) return "ERROR: database is not available";
      const { getIntakeSource, updateIntakeSource } = await import("../data-intake/source-store.js");
      instance = getIntakeSource({ db, id: args.instanceId }) as any;
      if (!instance) return `ERROR: unknown instance '${args.instanceId}'`;
      updateInstanceStatus = (next) => {
        try {
          updateIntakeSource({
            db,
            id: instance!.id,
            lastRunAt: next.lastRunAtMs,
            lastError: next.lastError,
            nowMs: ctx.nowMs(),
          });
        } catch {
          // ignore (non-critical)
        }
      };
      sourceId = instance.source_id;
      try {
        params = JSON.parse(instance.params_json);
      } catch {
        params = {};
      }
      // Add instance label as a tag for easy querying
      if (instance.label) {
        instanceTags.push(instance.label);
      }
    } else if (args.sourceId) {
      sourceId = args.sourceId;
      params = args.params ?? {};
    } else {
      return "ERROR: either instanceId or sourceId must be provided";
    }

    const source = getDataSource(sourceId);
    if (!source) {
      updateInstanceStatus?.({ lastRunAtMs: attemptedAtMs, lastError: `Unknown data source '${sourceId}'` });
      return `ERROR: unknown data source '${sourceId}'`;
    }
    const validation = validateSourceParams(source, params);
    if (!validation.ok) {
      updateInstanceStatus?.({
        lastRunAtMs: attemptedAtMs,
        lastError: formatErrorForStorage(validation.response.validationErrors) ?? validation.response.message,
      });
      return JSON.stringify(validation.response);
    }
    let result: Awaited<ReturnType<typeof runDataSource>>;
    try {
      result = await runDataSource(
        source,
        validation.params,
        {
          db,
          nowMs: ctx.nowMs,
          log: ctx.log,
          request: ctx.request,
        },
        { instanceTags },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      updateInstanceStatus?.({ lastRunAtMs: attemptedAtMs, lastError: `Run error: ${msg}` });
      return `ERROR: ${msg}`;
    }

    updateInstanceStatus?.({ lastRunAtMs: attemptedAtMs, lastError: formatErrorForStorage(result.errors) });
    return JSON.stringify(result);
  },
});

export const dataIntakeQuery = defineTool({
  name: "data_intake_query",
  description:
    "Read-only query for stored data intake records. " +
    "Use 'tag' to query by the source instance label (e.g., 'Innisfil Temperature'). " +
    "Use 'sourceId' (or alias 'sourceType') to filter by source type. Use 'subjectLike' for partial subject matches.",
  parameters: z.object({
    sourceId: z.string().min(1).optional(),
    sourceType: z.string().min(1).optional().describe("Alias of sourceId for compatibility"),
    tag: z.string().min(1).optional(),
    subject: z.string().min(1).optional().describe("Exact subject match"),
    subjectLike: z.string().min(1).optional().describe("Partial subject match using SQL LIKE (use % as wildcard)"),
    limit: z.number().int().min(1).max(100).default(20),
    includeExpired: z.boolean().default(false),
    latestOnly: z.boolean().default(false),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const sourceId = args.sourceId ?? args.sourceType;
    const query = args.latestOnly ? listLatestDataItems : listDataItems;
    const rows = query({
      db: db as any,
      sourceId,
      tag: args.tag,
      subject: args.subject,
      subjectLike: args.subjectLike,
      limit: args.limit,
      includeExpired: args.includeExpired,
      nowMs: ctx.nowMs(),
    });
    return JSON.stringify(rows);
  },
});

export const dataIntakePrune = defineTool({
  name: "data_intake_prune",
  description: "Prune expired or old data intake records.",
  parameters: z.object({
    maxAgeMs: z.number().int().min(60_000).optional(),
    includeUnexpired: z.boolean().default(false),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const deleted = pruneDataItems({
      db: db as any,
      nowMs: ctx.nowMs(),
      maxAgeMs: args.maxAgeMs,
      includeUnexpired: args.includeUnexpired,
    });
    return `OK: deleted ${deleted} data items`;
  },
});

export const dataIntakeScheduleRefresh = defineTool({
  name: "data_intake_schedule_refresh",
  description: "Create a scheduled job to refresh a data intake source on a cron schedule.",
  parameters: z.object({
    name: z.string().min(1).max(120),
    cron: z.string().min(1).max(120),
    timezone: z.string().max(64).default("UTC"),
    sourceId: z.string().min(1),
    params: z.record(z.unknown()).default({}),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const name = `data-intake: ${args.name}`;
    const nowMs = ctx.nowMs();
    const id = randomId("J");
    const spec = {
      mode: "tool_call",
      tool: "data_intake_manage",
      args: { action: "run", args: { sourceId: args.sourceId, params: args.params } },
    };
    const { nextCronTimeMs, parseCron, validateTimeZone } = await import("../scheduler/cron.js");
    const next = nextCronTimeMs({
      schedule: parseCron(args.cron),
      afterMs: nowMs,
      timeZone: validateTimeZone(args.timezone),
    });

    (db as any).db
      .prepare(
        "INSERT INTO jobs (id, owner_agent_id, name, cron, timezone, enabled, spec_json, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        schedulerAgentId(),
        name,
        args.cron,
        validateTimeZone(args.timezone),
        1,
        JSON.stringify(spec),
        next,
        nowMs,
        nowMs,
      );

    const row = (db as any).db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as any;
    return JSON.stringify(row);
  },
});

export const dataIntakeScheduleAll = defineTool({
  name: "data_intake_schedule_all",
  description: "Create a scheduled job that refreshes all enabled data intake source instances.",
  parameters: z.object({
    name: z.string().min(1).max(120),
    cron: z.string().min(1).max(120),
    timezone: z.string().max(64).default("UTC"),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const name = `data-intake: ${args.name}`;
    const task = [
      "Refresh all enabled data intake source instances from storage.",
      "",
      "Steps:",
      "1) Call data_intake_manage with action='source_list' and args={ includeDisabled: false }.",
      "2) For each source instance, call data_intake_manage with action='run' and args={ instanceId: <id> }.",
      "3) Report any failures.",
      "",
      "Data format notes:",
      "- data_intake_source_list returns camelCase fields: sourceId and params (already parsed object).",
      "- Prefer instance id for execution so source labels/tags remain consistent.",
    ].join("\n");

    const nowMs = ctx.nowMs();
    const id = randomId("J");
    const spec = { mode: "agent_task", task };
    const { nextCronTimeMs, parseCron, validateTimeZone } = await import("../scheduler/cron.js");
    const next = nextCronTimeMs({
      schedule: parseCron(args.cron),
      afterMs: nowMs,
      timeZone: validateTimeZone(args.timezone),
    });

    (db as any).db
      .prepare(
        "INSERT INTO jobs (id, owner_agent_id, name, cron, timezone, enabled, spec_json, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        schedulerAgentId(),
        name,
        args.cron,
        validateTimeZone(args.timezone),
        1,
        JSON.stringify(spec),
        next,
        nowMs,
        nowMs,
      );

    const row = (db as any).db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as any;
    return JSON.stringify(row);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Unified data_intake_manage tool (facade over individual tools)
// ─────────────────────────────────────────────────────────────────────────────

import {
  dataIntakeSourceList,
  dataIntakeSourceAdd,
  dataIntakeSourceUpdate,
  dataIntakeSourceDelete,
} from "./data-intake-sources.js";

const DATA_INTAKE_ACTIONS = [
  "list_sources",
  "source_list",
  "source_add",
  "source_update",
  "source_delete",
  "run",
  "query",
  "prune",
  "schedule_refresh",
  "schedule_all",
] as const;

type DataIntakeAction = typeof DATA_INTAKE_ACTIONS[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapSelfNestedArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (isRecord(value)) {
      const keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === key) {
        out[key] = value[key];
        continue;
      }
    }
    out[key] = value;
  }
  return out;
}

function dataIntakeActionArgs(input: { args?: Record<string, unknown> } & Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = isRecord(input.args) ? { ...input.args } : {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "action" || key === "args" || value === undefined) continue;
    merged[key] = value;
  }
  return unwrapSelfNestedArgs(merged);
}

const DATA_INTAKE_DISPATCH: Record<DataIntakeAction, Tool> = {
  list_sources: dataIntakeListSources,
  source_list: dataIntakeSourceList,
  source_add: dataIntakeSourceAdd,
  source_update: dataIntakeSourceUpdate,
  source_delete: dataIntakeSourceDelete,
  run: dataIntakeRun,
  query: dataIntakeQuery,
  prune: dataIntakePrune,
  schedule_refresh: dataIntakeScheduleRefresh,
  schedule_all: dataIntakeScheduleAll,
};

export const dataIntakeManage = defineTool({
  name: "data_intake_manage",
  description:
    "Unified data intake management tool. Actions: " +
    "list_sources (available source types), source_list (configured instances), " +
    "source_add, source_update, source_delete (instance CRUD), " +
    "run (fetch data), query (read stored records), prune (cleanup), " +
    "schedule_refresh (cron for one source), schedule_all (cron for all instances). " +
    "Pass action-specific arguments in the `args` object.",
  parameters: z.object({
    action: z.enum(DATA_INTAKE_ACTIONS),
    args: z.record(z.unknown()).default({}).describe(
      "Action-specific arguments (same schema as the individual data_intake_* tools).",
    ),
  }).passthrough(),
  execute: async (args, ctx) => {
    const target = DATA_INTAKE_DISPATCH[args.action];
    if (!target) return `ERROR: unsupported action '${args.action}'`;
    return target.execute(dataIntakeActionArgs(args), ctx);
  },
});
