import { z } from "zod";

import { defineTool } from "../core/tools.js";
import {
  createIntakeSource,
  deleteIntakeSource,
  listIntakeSources,
  updateIntakeSource,
} from "../data-intake/source-store.js";
import { initDataIntake } from "../data-intake/index.js";
import { getDataSource, listDataSources } from "../data-intake/registry.js";

function requireDb(ctx: { db?: unknown }) {
  return ctx.db ?? null;
}

export const dataIntakeSourceList = defineTool({
  name: "data_intake_source_list",
  description: "List configured data intake sources (active source instances).",
  parameters: z.object({
    includeDisabled: z.boolean().default(false),
  }),
  execute: async (args, ctx) => {
    initDataIntake();
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const rows = listIntakeSources({ db: db as any, includeDisabled: args.includeDisabled });
    return JSON.stringify(rows, null, 2);
  },
});

export const dataIntakeSourceAdd = defineTool({
  name: "data_intake_source_add",
  description: "Add a configured data intake source instance (e.g., a new stock ticker or RSS feed).",
  parameters: z.object({
    sourceId: z.string().min(1),
    label: z.string().max(120).optional(),
    intervalMs: z.number().int().min(60_000).optional(),
    params: z.record(z.unknown()).default({}),
  }),
  execute: async (args, ctx) => {
    initDataIntake();
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const source = getDataSource(args.sourceId);
    if (!source) {
      const available = listDataSources().map((s) => s.id).join(", ");
      return `ERROR: unknown source '${args.sourceId}'. Available: ${available}`;
    }
    const intervalMs = args.intervalMs ?? source.defaultTtlMs;
    const row = createIntakeSource({
      db: db as any,
      sourceId: args.sourceId,
      label: args.label,
      params: args.params,
      intervalMs,
      nowMs: ctx.nowMs(),
    });
    return JSON.stringify(row, null, 2);
  },
});

export const dataIntakeSourceUpdate = defineTool({
  name: "data_intake_source_update",
  description: "Update a configured data intake source instance.",
  parameters: z.object({
    id: z.string().min(1),
    label: z.string().max(120).optional(),
    intervalMs: z.number().int().min(60_000).optional(),
    params: z.record(z.unknown()).optional(),
    enabled: z.boolean().optional(),
  }),
  execute: async (args, ctx) => {
    initDataIntake();
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = updateIntakeSource({
      db: db as any,
      id: args.id,
      label: args.label,
      paramsJson: args.params ? JSON.stringify(args.params) : undefined,
      intervalMs: args.intervalMs,
      enabled: args.enabled,
      nowMs: ctx.nowMs(),
    });
    if (!row) return "ERROR: source not found";
    return JSON.stringify(row, null, 2);
  },
});

export const dataIntakeSourceDelete = defineTool({
  name: "data_intake_source_delete",
  description: "Delete a configured data intake source instance.",
  parameters: z.object({
    id: z.string().min(1),
  }),
  execute: async (args, ctx) => {
    initDataIntake();
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const ok = deleteIntakeSource({ db: db as any, id: args.id });
    return ok ? "OK" : "ERROR: source not found";
  },
});
