import { z } from "zod";

import { defineTool } from "../core/tools.js";
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

function requireDb(ctx: { db?: unknown }) {
  return ctx.db ?? null;
}

export const dataIntakeListSources = defineTool({
  name: "data_intake_list_sources",
  description: "List available data intake sources. Optionally filter by tag.",
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
  description: "Run a data intake source and store normalized results in the local data store.",
  parameters: z.object({
    sourceId: z.string().min(1),
    params: z.record(z.unknown()).default({}),
  }),
  execute: async (args, ctx) => {
    initDataIntake();
    const source = getDataSource(args.sourceId);
    if (!source) return `ERROR: unknown data source '${args.sourceId}'`;
    const result = await runDataSource(source, args.params, {
      db: ctx.db as any,
      nowMs: ctx.nowMs,
      log: ctx.log,
      request: ctx.request,
    });
    return JSON.stringify(result, null, 2);
  },
});

export const dataIntakeQuery = defineTool({
  name: "data_intake_query",
  description: "Read-only query for stored data intake records by source, tag, or subject.",
  parameters: z.object({
    sourceId: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    subject: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    includeExpired: z.boolean().default(false),
    latestOnly: z.boolean().default(false),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const query = args.latestOnly ? listLatestDataItems : listDataItems;
    const rows = query({
      db: db as any,
      sourceId: args.sourceId,
      tag: args.tag,
      subject: args.subject,
      limit: args.limit,
      includeExpired: args.includeExpired,
      nowMs: ctx.nowMs(),
    });
    return JSON.stringify(rows, null, 2);
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
    const task = [
      `Run data intake source '${args.sourceId}'.`,
      "",
      "Call this tool:",
      "- data_intake_run",
      "",
      "Arguments:",
      JSON.stringify({ sourceId: args.sourceId, params: args.params }, null, 2),
      "",
      "Then report success/failure.",
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
        ctx.request?.agentId ?? "main",
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
    return JSON.stringify(row, null, 2);
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
      "1) Call data_intake_source_list with includeDisabled=false.",
      "2) For each source instance, call data_intake_run using source_id and params_json.",
      "3) Report any failures.",
      "",
      "Parsing params_json:",
      "- params_json is a JSON string; parse it to an object before passing to data_intake_run.",
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
        ctx.request?.agentId ?? "main",
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
    return JSON.stringify(row, null, 2);
  },
});
