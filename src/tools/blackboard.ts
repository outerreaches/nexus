import crypto from "node:crypto";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import { cleanupManagedBlackboardAttachments } from "../storage/blackboard-attachments.js";
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
    "its path in the attachments array. " +
    "Optionally set a TTL so entries expire automatically.",
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
    ttlMs: z
      .number()
      .int()
      .min(60_000)
      .max(30 * 24 * 60 * 60_000)
      .optional()
      .describe("Optional TTL in ms (min 1 minute, max 30 days). If set, entry expires after this duration."),
    metadata: z.record(z.unknown()).optional().describe("Optional metadata key-value pairs"),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";

    const id = crypto.randomUUID();
    const nowMs = ctx.nowMs();
    const expiresAt = typeof args.ttlMs === "number" ? nowMs + args.ttlMs : null;
    const metadata = { ...(args.metadata ?? {}), ...(args.ttlMs ? { ttlMs: args.ttlMs } : {}) };

    try {
      db.db
        .prepare(
          `INSERT INTO blackboard (id, session_scope, type, agent_id, agent_preset, title, content, attachments_json, metadata_json, created_at, last_accessed_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          JSON.stringify(metadata),
          nowMs,
          nowMs,
          expiresAt,
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
    "Read entries from the shared Blackboard. Filter by type, agent preset, title, or keyword. " +
    "Returns full content for entries that fit within the response budget. " +
    "Entries that exceed the budget are listed as summaries (title + ID) so you can fetch them individually.",
  parameters: z.object({
    type: z.enum(["artifact", "finding", "note", "status"]).optional().describe("Filter by entry type"),
    agentPreset: z.string().optional().describe("Filter by the agent preset that wrote the entry"),
    title: z.string().optional().describe("Exact title match"),
    keyword: z.string().optional().describe("Search keyword in title and content"),
    ids: z.array(z.string()).optional().describe("Fetch specific entries by ID"),
    limit: z.number().int().min(1).max(50).default(10).describe("Max entries to return"),
    maxTotalChars: z
      .number()
      .int()
      .min(1000)
      .max(100000)
      .default(32000)
      .describe("Max total chars in response. Entries beyond budget are listed as title-only summaries."),
    refreshTtl: z
      .boolean()
      .default(false)
      .describe("If true, refresh TTL to now+ttlMs for entries that include a ttlMs metadata value."),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";

    const nowMs = ctx.nowMs();

    // Prune expired entries on read and cleanup managed attachment files.
    const expiredRows = db.db
      .prepare("SELECT attachments_json FROM blackboard WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .all(nowMs) as { attachments_json: string | null }[];
    if (expiredRows.length > 0) {
      db.db.prepare("DELETE FROM blackboard WHERE expires_at IS NOT NULL AND expires_at <= ?").run(nowMs);
      await cleanupManagedBlackboardAttachments({ stateDir: ctx.stateDir, rows: expiredRows });
    }

    const scope = sessionScope(ctx);
    let rows: Record<string, unknown>[];

    // If specific IDs requested, fetch those directly (across any scope for context injection)
    if (args.ids && args.ids.length > 0) {
      const placeholders = args.ids.map(() => "?").join(", ");
      rows = db.db
        .prepare(`SELECT * FROM blackboard WHERE id IN (${placeholders}) ORDER BY created_at DESC`)
        .all(...args.ids) as Record<string, unknown>[];
    } else {
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
      if (args.title) {
        conditions.push("title = ?");
        params.push(args.title);
      }
      if (args.keyword) {
        conditions.push("(title LIKE ? OR content LIKE ?)");
        const like = `%${args.keyword}%`;
        params.push(like, like);
      }

      conditions.push("(expires_at IS NULL OR expires_at > ?)");
      params.push(nowMs);

      params.push(args.limit);

      const sql = `SELECT * FROM blackboard WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`;
      rows = db.db.prepare(sql).all(...params) as Record<string, unknown>[];
    }

    if (rows.length === 0) return "No blackboard entries found matching the filters.";

    touchEntries(db, rows, nowMs, args.refreshTtl);

    return formatWithBudget(rows, args.maxTotalChars);
  },
});

export const blackboardManage = defineTool({
  name: "blackboard_manage",
  description:
    "Manage blackboard lifecycle with one tool. " +
    "Use action='delete' for specific IDs, action='clear' to wipe a scope, and action='prune' for expired/old entries.",
  parameters: z
    .object({
      action: z.enum(["delete", "clear", "prune"]).describe("Management action to run."),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe("Required when action='delete'."),
      scope: z
        .enum(["session", "global", "all"])
        .optional()
        .describe("Scope for action='clear' and action='prune'. Defaults to session."),
      maxAgeMs: z
        .number()
        .int()
        .min(60_000)
        .max(30 * 24 * 60 * 60_000)
        .optional()
        .describe("Optional for action='prune': delete entries older than this age."),
      includeUnexpired: z
        .boolean()
        .optional()
        .describe("Optional for action='prune'. If true, prune by age even if TTL has not expired."),
    })
    .superRefine((args, refineCtx) => {
      if (args.action === "delete" && (!args.ids || args.ids.length === 0)) {
        refineCtx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ids"],
          message: "ids is required when action='delete'",
        });
      }
    }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";

    if (args.action === "delete") {
      const ids = args.ids ?? [];
      const placeholders = ids.map(() => "?").join(", ");
      const rows = db.db
        .prepare(`SELECT attachments_json FROM blackboard WHERE id IN (${placeholders})`)
        .all(...ids) as { attachments_json: string | null }[];
      const stmt = db.db.prepare(`DELETE FROM blackboard WHERE id IN (${placeholders})`);
      const res = stmt.run(...ids);
      const cleanup = await cleanupManagedBlackboardAttachments({ stateDir: ctx.stateDir, rows });
      return `OK: deleted ${res.changes} entries (attachment files removed=${cleanup.removed}, failed=${cleanup.failed})`;
    }

    if (args.action === "clear") {
      const requestedScope = args.scope ?? "session";
      if (requestedScope === "all") {
        const rows = db.db.prepare("SELECT attachments_json FROM blackboard").all() as { attachments_json: string | null }[];
        const res = db.db.prepare("DELETE FROM blackboard").run();
        const cleanup = await cleanupManagedBlackboardAttachments({ stateDir: ctx.stateDir, rows });
        return `OK: deleted ${res.changes} entries (all scopes, attachment files removed=${cleanup.removed}, failed=${cleanup.failed})`;
      }

      const scope = requestedScope === "global" ? "global" : sessionScope(ctx);
      const rows = db.db
        .prepare("SELECT attachments_json FROM blackboard WHERE session_scope = ?")
        .all(scope) as { attachments_json: string | null }[];
      const res = db.db.prepare("DELETE FROM blackboard WHERE session_scope = ?").run(scope);
      const cleanup = await cleanupManagedBlackboardAttachments({ stateDir: ctx.stateDir, rows });
      return `OK: deleted ${res.changes} entries (scope=${scope}, attachment files removed=${cleanup.removed}, failed=${cleanup.failed})`;
    }

    const nowMs = ctx.nowMs();
    const requestedScope = args.scope ?? "session";
    const scope = requestedScope === "all" ? null : requestedScope === "global" ? "global" : sessionScope(ctx);
    const includeUnexpired = args.includeUnexpired ?? false;

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (scope) {
      clauses.push("session_scope = ?");
      params.push(scope);
    }

    if (args.maxAgeMs) {
      const cutoff = nowMs - args.maxAgeMs;
      if (includeUnexpired) {
        clauses.push("created_at <= ?");
        params.push(cutoff);
      } else {
        clauses.push("((expires_at IS NOT NULL AND expires_at <= ?) OR created_at <= ?)");
        params.push(nowMs, cutoff);
      }
    } else {
      clauses.push("expires_at IS NOT NULL AND expires_at <= ?");
      params.push(nowMs);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.db
      .prepare(`SELECT attachments_json FROM blackboard ${where}`)
      .all(...params) as { attachments_json: string | null }[];
    const res = db.db.prepare(`DELETE FROM blackboard ${where}`).run(...params);
    const cleanup = await cleanupManagedBlackboardAttachments({ stateDir: ctx.stateDir, rows });
    return `OK: deleted ${res.changes} entries (attachment files removed=${cleanup.removed}, failed=${cleanup.failed})`;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

type FormattedEntry = {
  id: string;
  type: string;
  agentPreset: string;
  title: string;
  content: string;
  attachments: unknown[];
  createdAt: number;
};

/**
 * Format entries with a total character budget. Entries are included in full
 * until the budget is exhausted. Remaining entries are listed as title-only
 * summaries so the agent knows they exist and can fetch by ID.
 */
function formatWithBudget(rows: Record<string, unknown>[], maxTotalChars: number): string {
  const full: FormattedEntry[] = [];
  const overflow: { id: string; title: string; type: string; agentPreset: string; chars: number }[] = [];
  let totalChars = 0;

  for (const r of rows) {
    const content = String(r.content ?? "");
    const entry: FormattedEntry = {
      id: r.id as string,
      type: r.type as string,
      agentPreset: r.agent_preset as string,
      title: r.title as string,
      content,
      attachments: safeJsonParse(r.attachments_json as string, []) as unknown[],
      createdAt: r.created_at as number,
    };

    // Estimate this entry's JSON size (~overhead + content)
    const entryChars = content.length + (entry.title?.length ?? 0) + 200;

    if (totalChars + entryChars <= maxTotalChars) {
      full.push(entry);
      totalChars += entryChars;
    } else {
      overflow.push({
        id: entry.id,
        title: entry.title,
        type: entry.type,
        agentPreset: entry.agentPreset,
        chars: content.length,
      });
    }
  }

  const result: { entries: FormattedEntry[]; overflow?: typeof overflow; totalEntries: number } = {
    entries: full,
    totalEntries: rows.length,
  };

  if (overflow.length > 0) {
    result.overflow = overflow;
  }

  return JSON.stringify(result, null, 2);
}

function touchEntries(
  db: NexusDatabase,
  rows: Record<string, unknown>[],
  nowMs: number,
  refreshTtl: boolean,
): void {
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id).filter(Boolean) as string[];
  if (ids.length === 0) return;

  const placeholders = ids.map(() => "?").join(", ");
  db.db.prepare(`UPDATE blackboard SET last_accessed_at = ? WHERE id IN (${placeholders})`).run(nowMs, ...ids);

  if (!refreshTtl) return;

  for (const row of rows) {
    const metadata = safeJsonParse(String(row.metadata_json ?? "{}"), {}) as Record<string, unknown>;
    const ttlMs = typeof metadata.ttlMs === "number" ? metadata.ttlMs : null;
    if (!ttlMs || !Number.isFinite(ttlMs)) continue;
    const expiresAt = nowMs + ttlMs;
    if (!row.id) continue;
    db.db.prepare("UPDATE blackboard SET expires_at = ? WHERE id = ?").run(expiresAt, row.id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Blackboard lifecycle — archive old entries at orchestrator run start
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Archive all blackboard entries for a session to a markdown file, then clear them.
 * Called at the start of each orchestrator run so context stays clean.
 * Returns the number of entries archived (0 means nothing to archive).
 */
export async function archiveAndClearBlackboard(params: {
  db: NexusDatabase;
  sessionScope: string;
  workspaceDir: string;
  nowMs: number;
}): Promise<number> {
  const { db, sessionScope: scope, workspaceDir, nowMs } = params;

  const rows = db.db
    .prepare("SELECT * FROM blackboard WHERE session_scope = ? ORDER BY created_at ASC")
    .all(scope) as Record<string, unknown>[];

  if (rows.length === 0) return 0;

  // Build markdown archive
  const lines: string[] = [
    `# Blackboard Archive`,
    ``,
    `Session: ${scope}`,
    `Archived at: ${new Date(nowMs).toISOString()}`,
    `Entries: ${rows.length}`,
    ``,
    `---`,
    ``,
  ];

  for (const r of rows) {
    const attachments = safeJsonParse(String(r.attachments_json ?? "[]"), []) as { path?: string; mimeType?: string }[];
    lines.push(`## [${r.type}] ${r.title}`);
    lines.push(``);
    lines.push(`- **ID**: ${r.id}`);
    lines.push(`- **Agent**: ${r.agent_id} (${r.agent_preset})`);
    lines.push(`- **Created**: ${new Date(Number(r.created_at)).toISOString()}`);
    lines.push(``);
    lines.push(String(r.content ?? ""));
    if (attachments.length > 0) {
      lines.push(``);
      lines.push(`**Attachments:**`);
      for (const a of attachments) {
        lines.push(`- ${a.path ?? "unknown"}${a.mimeType ? ` (${a.mimeType})` : ""}`);
      }
    }
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  }

  // Write archive file
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const archiveDir = path.join(workspaceDir, ".blackboard-archives");
  await fs.mkdir(archiveDir, { recursive: true });
  const timestamp = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  const archivePath = path.join(archiveDir, `${timestamp}.md`);
  await fs.writeFile(archivePath, lines.join("\n"), "utf8");

  // Clear blackboard entries for this session
  db.db.prepare("DELETE FROM blackboard WHERE session_scope = ?").run(scope);

  return rows.length;
}

function safeJsonParse(raw: string, fallback: unknown): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
