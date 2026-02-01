import crypto from "node:crypto";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";

function requireDb(ctx: { db?: unknown }): NexusDatabase | null {
  return (ctx.db as NexusDatabase | undefined) ?? null;
}

function sessionScope(ctx: { request?: { sessionId: string } }): string {
  return ctx.request?.sessionId ?? "global";
}

function agentId(ctx: { request?: { agentId: string } }): string {
  return ctx.request?.agentId ?? "main";
}

// ─────────────────────────────────────────────────────────────────────────────
// write_to_blackboard
// ─────────────────────────────────────────────────────────────────────────────

export const writeToBlackboard = defineTool({
  name: "write_to_blackboard",
  description:
    "Write an entry to the shared Blackboard so other agents can read it. " +
    "Use this to share artifacts, findings, notes, or status updates between agents. " +
    "For binary content (images, PDFs), write the file to disk first, then reference " +
    "its path in the attachments array.",
  parameters: z.object({
    type: z
      .enum(["artifact", "finding", "note", "status"])
      .describe("Entry type: artifact (code/file), finding (research result), note (misc), status (progress update)"),
    title: z.string().min(1).max(200).describe("Short title for this entry"),
    content: z.string().min(1).max(16000).describe("Text content — for binary, describe what the file is"),
    attachments: z
      .array(
        z.object({
          path: z.string().describe("File path to the binary content"),
          mimeType: z.string().optional().describe("MIME type (e.g. image/png, application/pdf)"),
        }),
      )
      .max(10)
      .default([])
      .describe("References to binary files (images, PDFs, etc.) — paths only, not content"),
    preset: z.string().optional().describe("Agent preset name (auto-populated if omitted)"),
    metadata: z.record(z.unknown()).optional().describe("Optional metadata key-value pairs"),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";

    const id = crypto.randomUUID();
    const nowMs = ctx.nowMs();

    try {
      db.db
        .prepare(
          `INSERT INTO blackboard (id, session_scope, type, agent_id, agent_preset, title, content, attachments_json, metadata_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          sessionScope(ctx),
          args.type,
          agentId(ctx),
          args.preset ?? "unknown",
          args.title,
          args.content,
          JSON.stringify(args.attachments),
          JSON.stringify(args.metadata ?? {}),
          nowMs,
        );

      return `OK: written to blackboard (id=${id}, type=${args.type}, title="${args.title}")`;
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// read_from_blackboard
// ─────────────────────────────────────────────────────────────────────────────

export const readFromBlackboard = defineTool({
  name: "read_from_blackboard",
  description:
    "Read entries from the shared Blackboard. Returns text content inline and " +
    "attachment paths as references (never binary content). Filter by type, " +
    "agent preset, or keyword search.",
  parameters: z.object({
    type: z.enum(["artifact", "finding", "note", "status"]).optional().describe("Filter by entry type"),
    agentPreset: z.string().optional().describe("Filter by the agent preset that wrote the entry"),
    keyword: z.string().optional().describe("Search keyword in title and content"),
    ids: z.array(z.string()).optional().describe("Fetch specific entries by ID"),
    limit: z.number().int().min(1).max(50).default(20).describe("Max entries to return"),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";

    const scope = sessionScope(ctx);

    // If specific IDs requested, fetch those directly (across any scope for context injection)
    if (args.ids && args.ids.length > 0) {
      const placeholders = args.ids.map(() => "?").join(", ");
      const rows = db.db
        .prepare(`SELECT * FROM blackboard WHERE id IN (${placeholders}) ORDER BY created_at DESC`)
        .all(...args.ids) as Record<string, unknown>[];
      return JSON.stringify(formatEntries(rows), null, 2);
    }

    // Build filtered query
    const conditions: string[] = ["session_scope = ?"];
    const params: unknown[] = [scope];

    if (args.type) {
      conditions.push("type = ?");
      params.push(args.type);
    }
    if (args.agentPreset) {
      conditions.push("agent_preset = ?");
      params.push(args.agentPreset);
    }
    if (args.keyword) {
      conditions.push("(title LIKE ? OR content LIKE ?)");
      const like = `%${args.keyword}%`;
      params.push(like, like);
    }

    params.push(args.limit);

    const sql = `SELECT * FROM blackboard WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`;
    const rows = db.db.prepare(sql).all(...params) as Record<string, unknown>[];

    if (rows.length === 0) return "No blackboard entries found matching the filters.";

    return JSON.stringify(formatEntries(rows), null, 2);
  },
});

function formatEntries(
  rows: Record<string, unknown>[],
): { id: string; type: string; agentPreset: string; title: string; content: string; attachments: unknown[]; metadata: unknown; createdAt: number }[] {
  return rows.map((r) => ({
    id: r.id as string,
    type: r.type as string,
    agentPreset: r.agent_preset as string,
    title: r.title as string,
    content: r.content as string,
    attachments: safeJsonParse(r.attachments_json as string, []) as unknown[],
    metadata: safeJsonParse(r.metadata_json as string, {}),
    createdAt: r.created_at as number,
  }));
}

function safeJsonParse(raw: string, fallback: unknown): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
