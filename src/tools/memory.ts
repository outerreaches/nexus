import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";

function requireDb(ctx: { db?: unknown }): NexusDatabase | null {
  return (ctx.db as NexusDatabase | undefined) ?? null;
}

function currentAgentId(ctx: { request?: { agentId: string } }): string {
  return ctx.request?.agentId ? String(ctx.request.agentId) : "main";
}

const EXCLUDE_SYSTEM_MEMORIES_SQL =
  "key NOT LIKE 'compaction:%' " +
  "AND tags_json NOT LIKE '%\"compaction\"%' " +
  "AND tags_json NOT LIKE '%\"context-summary\"%'";
const DEFAULT_VALUE_PREVIEW_CHARS = 220;

type MemorySearchRow = {
  key: string;
  value: string;
  category: "fact" | "observation" | "preference" | "plan";
  tags_json: string | null;
  access_count: number;
};

function parseTags(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

function previewValue(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…(+${value.length - maxChars} chars)`;
}

function formatMemorySearchResult(
  row: MemorySearchRow,
  opts: { includeValues: boolean; valuePreviewChars: number },
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    key: row.key,
    category: row.category,
    tags: parseTags(row.tags_json),
    access_count: row.access_count,
  };

  if (opts.includeValues) {
    base.value = row.value;
    return base;
  }

  base.value_preview = previewValue(row.value, opts.valuePreviewChars);
  base.value_chars = row.value.length;
  return base;
}

export const memoryStore = defineTool({
  name: "memory_store",
  description:
    "Store a persistent memory (key-value). Upserts: if the key already exists for this agent, the value is updated. Use for facts, observations, preferences, plans, or anything worth remembering across sessions.",
  parameters: z.object({
    key: z.string().min(1).max(200).describe("Unique key identifying this memory"),
    value: z.string().min(1).max(8000).describe("The content to remember"),
    category: z
      .enum(["fact", "observation", "preference", "plan"])
      .default("observation")
      .describe("Category for organization and filtering"),
    tags: z.array(z.string().max(50)).max(10).default([]).describe("Optional tags for search"),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const agentId = currentAgentId(ctx);
    const nowMs = ctx.nowMs();

    try {
      db.db
        .prepare(
          `INSERT INTO memories (agent_id, key, value, category, tags_json, created_at, updated_at, accessed_at, access_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(agent_id, key) DO UPDATE SET
             value = excluded.value,
             category = excluded.category,
             tags_json = excluded.tags_json,
             updated_at = excluded.updated_at`,
        )
        .run(agentId, args.key, args.value, args.category, JSON.stringify(args.tags), nowMs, nowMs, nowMs);

      return `OK: stored memory "${args.key}" [${args.category}]`;
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

export const memoryRecall = defineTool({
  name: "memory_recall",
  description: "Retrieve a specific memory by exact key. Updates access tracking.",
  parameters: z.object({
    key: z.string().min(1).max(200),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const agentId = currentAgentId(ctx);
    const nowMs = ctx.nowMs();

    const row = db.db
      .prepare("SELECT * FROM memories WHERE agent_id = ? AND key = ?")
      .get(agentId, args.key) as any;

    if (!row) return `NOT_FOUND: no memory with key "${args.key}"`;

    // Update access tracking
    db.db
      .prepare("UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?")
      .run(nowMs, row.id);

    return JSON.stringify(
      {
        key: row.key,
        value: row.value,
        category: row.category,
        tags: JSON.parse(row.tags_json || "[]"),
        created_at: row.created_at,
        updated_at: row.updated_at,
        access_count: row.access_count + 1,
      },
      null,
      2,
    );
  },
});

export const memorySearch = defineTool({
  name: "memory_search",
  description:
    "Search memories by keyword (searches key, value, and tags). Optionally filter by category. " +
    "If query is empty, returns most recent memories. Results are sorted by relevance (access frequency + recency). " +
    "By default, returns compact previews (not full values) to reduce token usage.",
  parameters: z.object({
    query: z.string().max(200).default("").describe("Search term (case-insensitive substring match). Empty returns recent memories."),
    category: z
      .enum(["fact", "observation", "preference", "plan"])
      .optional()
      .describe("Filter by category"),
    limit: z.number().int().min(1).max(50).default(10),
    includeValues: z
      .boolean()
      .default(false)
      .describe("If true, include full memory values in results. Default false returns compact previews."),
    valuePreviewChars: z
      .number()
      .int()
      .min(0)
      .max(2000)
      .default(DEFAULT_VALUE_PREVIEW_CHARS)
      .describe("Preview length used when includeValues=false."),
    includeSystem: z
      .boolean()
      .default(false)
      .describe("If true, include system-generated compaction/context-summary memories."),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const agentId = currentAgentId(ctx);
    const query = (args.query ?? "").trim();
    const pattern = `%${query}%`;
    const includeValues = args.includeValues === true;
    const valuePreviewChars = Math.max(0, args.valuePreviewChars ?? DEFAULT_VALUE_PREVIEW_CHARS);
    const visibilityClause = args.includeSystem ? "" : `AND ${EXCLUDE_SYSTEM_MEMORIES_SQL}`;

    if (!query) {
      const rows = db.db
        .prepare(
          `
          SELECT key, value, category, tags_json, created_at, updated_at, access_count
          FROM memories
          WHERE agent_id = ? ${visibilityClause}
          ORDER BY updated_at DESC
          LIMIT ?
        `,
        )
        .all(agentId, args.limit) as MemorySearchRow[];

      if (rows.length === 0) return "No memories found.";

      const results = rows.map((r) => formatMemorySearchResult(r, { includeValues, valuePreviewChars }));

      return JSON.stringify(results, null, 2);
    }

    const categoryClause = args.category ? "AND category = ?" : "";
    const sql = `
      SELECT key, value, category, tags_json, created_at, updated_at, access_count
      FROM memories
      WHERE agent_id = ? ${visibilityClause} AND (key LIKE ? OR value LIKE ? OR tags_json LIKE ?) ${categoryClause}
      ORDER BY access_count DESC, updated_at DESC
      LIMIT ?
    `;

    const params = args.category
      ? [agentId, pattern, pattern, pattern, args.category, args.limit]
      : [agentId, pattern, pattern, pattern, args.limit];

    const rows = db.db.prepare(sql).all(...params) as MemorySearchRow[];

    if (rows.length === 0) return `No memories found matching "${args.query}"`;

    const results = rows.map((r) => formatMemorySearchResult(r, { includeValues, valuePreviewChars }));

    return JSON.stringify(results, null, 2);
  },
});

export const memoryDelete = defineTool({
  name: "memory_delete",
  description: "Delete a memory by key.",
  parameters: z.object({
    key: z.string().min(1).max(200),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const agentId = currentAgentId(ctx);

    const result = db.db
      .prepare("DELETE FROM memories WHERE agent_id = ? AND key = ?")
      .run(agentId, args.key);

    if (result.changes === 0) return `NOT_FOUND: no memory with key "${args.key}"`;
    return "OK";
  },
});
