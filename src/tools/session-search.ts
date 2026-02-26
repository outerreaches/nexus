import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";

type SessionScope = {
  mode: "session_only" | "run_descendants";
  runId: string | null;
  sessionId: string | null;
  sessionIds: string[];
};

type MessageRow = {
  id: number;
  session_id: string;
  role: string;
  name: string | null;
  content: string;
  created_at: number;
  channel: string;
  channel_key: string;
  agent_id: string;
  match_snippet?: string | null;
  score?: number | null;
};

type SessionMetaRow = {
  id: string;
  channel: string;
  channel_key: string;
  agent_id: string;
  created_at: number;
  last_message_at: number | null;
};

function requireDb(ctx: { db?: unknown }): NexusDatabase | null {
  return (ctx.db as NexusDatabase | undefined) ?? null;
}

function normalizeNullable(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.max(16, Math.floor((maxChars - 12) / 2));
  const omitted = text.length - half * 2;
  return `${text.slice(0, half)}\n...(+${omitted} chars)...\n${text.slice(-half)}`;
}

function snippetForQuery(content: string, query: string, maxChars: number): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (!query.trim()) return truncateMiddle(clean, maxChars);
  const idx = clean.toLowerCase().indexOf(query.trim().toLowerCase());
  if (idx < 0) return truncateMiddle(clean, maxChars);
  const half = Math.max(24, Math.floor((maxChars - 6) / 2));
  const start = Math.max(0, idx - half);
  const end = Math.min(clean.length, idx + query.length + half);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < clean.length ? "..." : "";
  return `${prefix}${clean.slice(start, end)}${suffix}`;
}

function resolveSessionScope(params: {
  db: NexusDatabase;
  runId: string | null;
  sessionId: string | null;
}): SessionScope {
  const fallbackSessionIds = params.sessionId ? [params.sessionId] : [];
  if (!params.runId) {
    return {
      mode: "session_only",
      runId: null,
      sessionId: params.sessionId,
      sessionIds: fallbackSessionIds,
    };
  }

  const rows = params.db.db
    .prepare(
      `
      WITH RECURSIVE run_tree(run_id) AS (
        SELECT ?
        UNION ALL
        SELECT ar.run_id
        FROM agent_runs ar
        JOIN run_tree rt ON ar.parent_run_id = rt.run_id
      )
      SELECT DISTINCT ar.session_id AS session_id
      FROM agent_runs ar
      JOIN run_tree rt ON ar.run_id = rt.run_id
      WHERE ar.session_id IS NOT NULL
      `,
    )
    .all(params.runId) as Array<{ session_id: string | null }>;

  const out = new Set<string>();
  for (const row of rows) {
    const sessionId = normalizeNullable(row.session_id);
    if (sessionId) out.add(sessionId);
  }
  if (params.sessionId) out.add(params.sessionId);

  return {
    mode: "run_descendants",
    runId: params.runId,
    sessionId: params.sessionId,
    sessionIds: [...out],
  };
}

function loadSessionMeta(db: NexusDatabase, sessionIds: string[]): Map<string, SessionMetaRow> {
  if (sessionIds.length === 0) return new Map();
  const placeholders = sessionIds.map(() => "?").join(", ");
  const rows = db.db
    .prepare(
      `SELECT
         s.id,
         s.channel,
         s.channel_key,
         s.agent_id,
         s.created_at,
         MAX(m.created_at) AS last_message_at
       FROM sessions s
       LEFT JOIN messages m ON m.session_id = s.id
       WHERE s.id IN (${placeholders})
       GROUP BY s.id, s.channel, s.channel_key, s.agent_id, s.created_at`,
    )
    .all(...sessionIds) as SessionMetaRow[];
  const byId = new Map<string, SessionMetaRow>();
  for (const row of rows) byId.set(row.id, row);
  return byId;
}

function queryMessagesWithFts(params: {
  db: NexusDatabase;
  sessionIds: string[];
  query: string;
  limit: number;
}): MessageRow[] {
  if (params.sessionIds.length === 0) return [];
  const placeholders = params.sessionIds.map(() => "?").join(", ");
  const rows = params.db.db
    .prepare(
      `SELECT
         m.id,
         m.session_id,
         m.role,
         m.name,
         m.content,
         m.created_at,
         s.channel,
         s.channel_key,
         s.agent_id,
         snippet(messages_fts, 0, '<<', '>>', '...', 20) AS match_snippet,
         bm25(messages_fts) AS score
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       JOIN sessions s ON s.id = m.session_id
       WHERE m.session_id IN (${placeholders}) AND messages_fts MATCH ?
       ORDER BY score ASC, m.created_at DESC
       LIMIT ?`,
    )
    .all(...params.sessionIds, params.query, params.limit) as MessageRow[];
  return rows;
}

function queryMessagesWithLike(params: {
  db: NexusDatabase;
  sessionIds: string[];
  query: string;
  limit: number;
}): MessageRow[] {
  if (params.sessionIds.length === 0) return [];
  const placeholders = params.sessionIds.map(() => "?").join(", ");
  const rows = params.db.db
    .prepare(
      `SELECT
         m.id,
         m.session_id,
         m.role,
         m.name,
         m.content,
         m.created_at,
         s.channel,
         s.channel_key,
         s.agent_id
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE m.session_id IN (${placeholders}) AND m.content LIKE ?
       ORDER BY m.created_at DESC
       LIMIT ?`,
    )
    .all(...params.sessionIds, `%${params.query}%`, params.limit) as MessageRow[];
  return rows;
}

function queryLatestMessages(params: {
  db: NexusDatabase;
  sessionIds: string[];
  limit: number;
}): MessageRow[] {
  if (params.sessionIds.length === 0) return [];
  const placeholders = params.sessionIds.map(() => "?").join(", ");
  const rows = params.db.db
    .prepare(
      `SELECT
         m.id,
         m.session_id,
         m.role,
         m.name,
         m.content,
         m.created_at,
         s.channel,
         s.channel_key,
         s.agent_id
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE m.session_id IN (${placeholders})
       ORDER BY m.created_at DESC
       LIMIT ?`,
    )
    .all(...params.sessionIds, params.limit) as MessageRow[];
  return rows;
}

export const sessionSearch = defineTool({
  name: "session_search",
  description:
    "Search conversation history within this run scope. " +
    "Scope is strictly limited to your current session and descendant sub-agent sessions. " +
    "Parent agents can search spawned sub-agent sessions; sub-agents cannot search parent sessions.",
  parameters: z.object({
    query: z.string().max(300).default("").describe("FTS query string. Empty returns latest scoped messages."),
    limit: z.number().int().min(1).max(60).default(20).describe("Maximum total messages to return."),
    perSessionLimit: z.number().int().min(1).max(20).default(8).describe("Maximum messages per session in the result."),
    includeContent: z.boolean().default(false).describe("Include content previews for each hit."),
    contentChars: z.number().int().min(80).max(4000).default(900).describe("Max chars for content previews."),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const runId = normalizeNullable(ctx.request?.runId);
    const sessionId = normalizeNullable(ctx.request?.sessionId);
    const scope = resolveSessionScope({ db, runId, sessionId });

    if (scope.sessionIds.length === 0) {
      return JSON.stringify(
        {
          query: args.query,
          scope: {
            mode: scope.mode,
            runId: scope.runId,
            sessionId: scope.sessionId,
            scopedSessionCount: 0,
          },
          totalMatches: 0,
          sessions: [],
          messages: [],
        },
        null,
        2,
      );
    }

    const expandedLimit = Math.max(args.limit, args.perSessionLimit) * 4;
    const query = args.query.trim();
    let rows: MessageRow[] = [];
    let searchMode: "fts5" | "like" | "latest" = "latest";

    if (query) {
      try {
        rows = queryMessagesWithFts({
          db,
          sessionIds: scope.sessionIds,
          query,
          limit: expandedLimit,
        });
        searchMode = "fts5";
      } catch (err) {
        ctx.log(`session_search: fts query failed, falling back to LIKE (${err instanceof Error ? err.message : String(err)})`);
        rows = queryMessagesWithLike({
          db,
          sessionIds: scope.sessionIds,
          query,
          limit: expandedLimit,
        });
        searchMode = "like";
      }
    } else {
      rows = queryLatestMessages({
        db,
        sessionIds: scope.sessionIds,
        limit: expandedLimit,
      });
      searchMode = "latest";
    }

    const perSessionCount = new Map<string, number>();
    const selected: MessageRow[] = [];
    for (const row of rows) {
      const used = perSessionCount.get(row.session_id) ?? 0;
      if (used >= args.perSessionLimit) continue;
      selected.push(row);
      perSessionCount.set(row.session_id, used + 1);
      if (selected.length >= args.limit) break;
    }

    const returnedSessionIds = [...new Set(selected.map((row) => row.session_id))];
    const sessionMeta = loadSessionMeta(db, returnedSessionIds);
    const messages = selected.map((row) => {
      const preview = row.match_snippet && row.match_snippet.trim().length > 0
        ? row.match_snippet
        : snippetForQuery(row.content, query, Math.max(80, Math.floor(args.contentChars / 2)));
      return {
        id: row.id,
        sessionId: row.session_id,
        role: row.role,
        ...(row.name ? { name: row.name } : {}),
        createdAt: row.created_at,
        matchSnippet: preview,
        ...(args.includeContent
          ? { contentPreview: truncateMiddle(row.content, args.contentChars) }
          : {}),
        ...(typeof row.score === "number" && Number.isFinite(row.score) ? { score: row.score } : {}),
      };
    });
    const sessions = returnedSessionIds
      .map((id) => sessionMeta.get(id))
      .filter((row): row is SessionMetaRow => Boolean(row))
      .sort((a, b) => (b.last_message_at ?? b.created_at) - (a.last_message_at ?? a.created_at))
      .map((row) => ({
        id: row.id,
        channel: row.channel,
        channelKey: row.channel_key,
        agentId: row.agent_id,
        createdAt: row.created_at,
        lastMessageAt: row.last_message_at,
      }));

    return JSON.stringify(
      {
        query,
        scope: {
          mode: scope.mode,
          runId: scope.runId,
          sessionId: scope.sessionId,
          scopedSessionCount: scope.sessionIds.length,
          returnedSessionCount: sessions.length,
        },
        searchMode,
        totalMatches: selected.length,
        sessions,
        messages,
      },
      null,
      2,
    );
  },
});
