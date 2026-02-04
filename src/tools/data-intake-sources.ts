import { z } from "zod";

import { defineTool } from "../core/tools.js";
import {
  createIntakeSource,
  deleteIntakeSource,
  getIntakeSource,
  listIntakeSources,
  updateIntakeSource,
} from "../data-intake/source-store.js";
import type { DataIntakeSourceRow } from "../data-intake/source-store.js";
import { initDataIntake } from "../data-intake/index.js";
import { getDataSource, listDataSources } from "../data-intake/registry.js";
import { validateSourceParams } from "../data-intake/param-negotiation.js";

function requireDb(ctx: { db?: unknown }) {
  return ctx.db ?? null;
}

type RateState = { count: number; resetAt: number };

const RATE_STATE = new Map<string, RateState>();
const RATE_LIMIT = envInt("NEXUS_INTAKE_ADD_LIMIT") ?? 2;
const RATE_WINDOW_MS = envInt("NEXUS_INTAKE_ADD_WINDOW_MS") ?? 30 * 60_000;
const RATE_STATE_MAX = 5000;

function envInt(name: string): number | null {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

function getRateKey(ctx: { request?: { runId?: string; sessionId?: string; channel?: string; channelKey?: string } }): string {
  const runId = ctx.request?.runId;
  if (runId) return `run:${runId}`;
  const sessionId = ctx.request?.sessionId;
  if (sessionId) return `session:${sessionId}`;
  const channel = ctx.request?.channel ?? "unknown";
  const key = ctx.request?.channelKey ?? "unknown";
  return `channel:${channel}:${key}`;
}

function cleanupRateState(nowMs: number): void {
  if (RATE_STATE.size === 0) return;
  for (const [key, value] of RATE_STATE.entries()) {
    if (value.resetAt <= nowMs) RATE_STATE.delete(key);
  }
  if (RATE_STATE.size <= RATE_STATE_MAX) return;
  const overflow = RATE_STATE.size - RATE_STATE_MAX;
  let removed = 0;
  for (const key of RATE_STATE.keys()) {
    RATE_STATE.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
}

function checkRateLimit(ctx: { request?: { runId?: string; sessionId?: string; channel?: string; channelKey?: string }; nowMs: () => number }): { ok: true; remaining: number } | { ok: false; retryAt: number } {
  if (RATE_LIMIT <= 0) return { ok: true, remaining: 0 };
  const nowMs = ctx.nowMs();
  cleanupRateState(nowMs);
  const key = getRateKey(ctx);
  const entry = RATE_STATE.get(key);
  if (!entry || entry.resetAt <= nowMs) {
    const next = { count: 1, resetAt: nowMs + RATE_WINDOW_MS };
    RATE_STATE.set(key, next);
    return { ok: true, remaining: Math.max(0, RATE_LIMIT - next.count) };
  }
  if (entry.count >= RATE_LIMIT) {
    return { ok: false, retryAt: entry.resetAt };
  }
  entry.count += 1;
  RATE_STATE.set(key, entry);
  return { ok: true, remaining: Math.max(0, RATE_LIMIT - entry.count) };
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
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
  description:
    "Add a configured data intake source instance (e.g., a new stock ticker or RSS feed). " +
    "Returns the instance ID which you should use with data_intake_run(instanceId) to fetch data. " +
    "The label you provide will be added as a tag, making it easy to query with data_intake_query(tag).\n\n" +
    "IMPORTANT: Each source has different required parameters. If unsure, call data_intake_list_sources first to see the paramsSchema. " +
    "If you receive a NEEDS_PARAMS response, DO NOT ask the user — retry this tool immediately with the params shown in the usageNote.\n\n" +
    "Example: data_intake_source_add({ sourceId: \"stocks.yahoo\", symbols: [\"AAPL\", \"MSFT\"], label: \"Tech Stocks\" })",
  // Note: we allow extra top-level keys and treat them as source params.
  // This makes the tool easier for LLMs to use given source usageNotes like:
  // "Example params: { symbols: [\"AAPL\"] }" (which models often paste at the top level).
  parameters: z
    .object({
      sourceId: z.string().min(1),
      label: z.string().max(120).optional().describe("Human-friendly label (becomes a queryable tag)"),
      intervalMs: z.number().int().min(60_000).optional(),
      params: z.record(z.unknown()).default({}),
    })
    .passthrough(),
  execute: async (args, ctx) => {
    initDataIntake();
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const source = getDataSource(args.sourceId);
    if (!source) {
      const available = listDataSources().map((s) => s.id).join(", ");
      return `ERROR: unknown source '${args.sourceId}'. Available: ${available}`;
    }
    const extraParams = Object.fromEntries(
      Object.entries(args as Record<string, unknown>).filter(([key]) => !["sourceId", "label", "intervalMs", "params"].includes(key)),
    );
    const mergedParams = { ...extraParams, ...(args.params ?? {}) };
    const validation = validateSourceParams(source, mergedParams);
    if (!validation.ok) {
      return JSON.stringify(validation.response, null, 2);
    }
    const canonicalParams = validation.params as Record<string, unknown>;

    // De-dup existing source instances with identical params.
    const normalizedNew = stableStringify(canonicalParams);
    const existing = (db as any).db
      .prepare("SELECT * FROM data_intake_sources WHERE source_id = ? ORDER BY created_at DESC")
      .all(args.sourceId) as DataIntakeSourceRow[];
    for (const row of existing) {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(row.params_json ?? "{}");
      } catch {
        parsed = {};
      }
      if (stableStringify(parsed) === normalizedNew) {
        // Optionally set label if missing.
        if (args.label && (!row.label || row.label.trim().length === 0)) {
          updateIntakeSource({
            db: db as any,
            id: row.id,
            label: args.label,
            nowMs: ctx.nowMs(),
          });
        }
        const result = {
          ...row,
          _note: "Deduped: matching source instance already exists.",
        };
        return JSON.stringify(result, null, 2);
      }
    }

    // Rate limit new source creation to prevent runaway add loops.
    const rateCheck = checkRateLimit({ request: ctx.request, nowMs: ctx.nowMs });
    if (!rateCheck.ok) {
      return `ERROR: rate limit exceeded for data_intake_source_add. Try again after ${new Date(rateCheck.retryAt).toISOString()}.`;
    }

    const intervalMs = args.intervalMs ?? source.defaultTtlMs;
    const row = createIntakeSource({
      db: db as any,
      sourceId: args.sourceId,
      label: args.label,
      params: mergedParams,
      intervalMs,
      nowMs: ctx.nowMs(),
    });
    // Return helpful guidance along with the row data
    const result = {
      ...row,
      _hint: `Use data_intake_run(instanceId: "${row.id}") to fetch data. Query with data_intake_query(tag: "${args.label || row.source_id}").`,
    };
    return JSON.stringify(result, null, 2);
  },
});

export const dataIntakeSourceUpdate = defineTool({
  name: "data_intake_source_update",
  description: "Update a configured data intake source instance.",
  // Allow extra keys as convenience params (see data_intake_source_add).
  parameters: z
    .object({
      id: z.string().min(1),
      label: z.string().max(120).optional(),
      intervalMs: z.number().int().min(60_000).optional(),
      params: z.record(z.unknown()).optional(),
      enabled: z.boolean().optional(),
    })
    .passthrough(),
  execute: async (args, ctx) => {
    initDataIntake();
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const extraParams = Object.fromEntries(
      Object.entries(args as Record<string, unknown>).filter(([key]) => !["id", "label", "intervalMs", "params", "enabled"].includes(key)),
    );
    const mergedParams = args.params || Object.keys(extraParams).length > 0 ? { ...extraParams, ...(args.params ?? {}) } : undefined;
    if (mergedParams) {
      const existing = getIntakeSource({ db: db as any, id: args.id });
      if (!existing) return "ERROR: source not found";
      const source = getDataSource(existing.source_id);
      if (!source) return `ERROR: unknown source '${existing.source_id}'`;
      const validation = validateSourceParams(source, mergedParams);
      if (!validation.ok) {
        return JSON.stringify(validation.response, null, 2);
      }
    }
    const row = updateIntakeSource({
      db: db as any,
      id: args.id,
      label: args.label,
      paramsJson: mergedParams ? JSON.stringify(mergedParams) : undefined,
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
