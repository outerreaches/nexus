import type { NexusDatabase } from "../storage/database.js";

export type TelegramDeltaCursor = {
  telegramSessionId: string | null;
  lastMessageId: number | null;
};

export type TelegramDeltaOptions = {
  maxMessages: number;
  maxChars: number;
  bootstrapMessages: number;
  maxCharsPerMessage?: number;
};

export type TelegramDeltaBuildResult = {
  block: string | null;
  nextCursor: TelegramDeltaCursor | null;
  stats: {
    source: "none" | "incremental" | "bootstrap";
    sessionId: string | null;
    includedMessages: number;
    omittedMessages: number;
    hasMore: boolean;
    bytes: number;
  };
};

type LatestTelegramSession = {
  sessionId: string;
  channelKey: string;
};

type TelegramMessageRow = {
  id: number;
  role: string;
  content: string;
  name: string | null;
  tool_call_id: string | null;
};

export function getLatestTelegramSessionForAgent(db: NexusDatabase, agentId: string): LatestTelegramSession | null {
  const row = db.db
    .prepare(
      `SELECT
         s.id AS session_id,
         s.channel_key AS channel_key,
         COALESCE(MAX(m.created_at), s.created_at) AS last_message_at
       FROM sessions s
       LEFT JOIN messages m ON m.session_id = s.id
       WHERE s.channel = 'telegram' AND s.agent_id = ?
       GROUP BY s.id
       ORDER BY last_message_at DESC, s.created_at DESC
       LIMIT 1`,
    )
    .get(agentId) as { session_id: string; channel_key: string } | undefined;
  if (!row?.session_id || !row?.channel_key) return null;
  return {
    sessionId: String(row.session_id),
    channelKey: String(row.channel_key),
  };
}

function listIncrementalRows(
  db: NexusDatabase,
  params: { sessionId: string; afterMessageId: number; fetchLimit: number },
): { rows: TelegramMessageRow[]; hasMore: boolean } {
  const fetched = db.db
    .prepare(
      `SELECT id, role, content, name, tool_call_id
       FROM messages
       WHERE session_id = ? AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(params.sessionId, params.afterMessageId, params.fetchLimit + 1) as TelegramMessageRow[];
  const hasMore = fetched.length > params.fetchLimit;
  return { rows: hasMore ? fetched.slice(0, params.fetchLimit) : fetched, hasMore };
}

function listBootstrapRows(
  db: NexusDatabase,
  params: { sessionId: string; fetchLimit: number },
): { rows: TelegramMessageRow[]; hasMore: boolean } {
  const fetched = db.db
    .prepare(
      `SELECT id, role, content, name, tool_call_id
       FROM messages
       WHERE session_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(params.sessionId, params.fetchLimit + 1) as TelegramMessageRow[];
  const hasMore = fetched.length > params.fetchLimit;
  const page = hasMore ? fetched.slice(0, params.fetchLimit) : fetched;
  page.reverse();
  return { rows: page, hasMore };
}

function compactText(input: string, maxChars: number): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (!normalized) return "(empty)";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…(+${normalized.length - maxChars} chars)`;
}

function roleTag(row: TelegramMessageRow): string {
  const role = row.role.trim().toLowerCase();
  if (role === "tool") {
    const name = row.name?.trim() || row.tool_call_id?.trim() || "tool";
    return `tool:${name}`;
  }
  if (role === "assistant" || role === "user" || role === "system") return role;
  return "message";
}

export function buildTelegramDelta(
  db: NexusDatabase,
  params: {
    agentId: string;
    cursor: TelegramDeltaCursor | null;
    options: TelegramDeltaOptions;
  },
): TelegramDeltaBuildResult {
  const latest = getLatestTelegramSessionForAgent(db, params.agentId);
  if (!latest) {
    return {
      block: null,
      nextCursor: null,
      stats: {
        source: "none",
        sessionId: null,
        includedMessages: 0,
        omittedMessages: 0,
        hasMore: false,
        bytes: 0,
      },
    };
  }

  const maxMessages = Math.max(1, Math.floor(params.options.maxMessages));
  const maxChars = Math.max(800, Math.floor(params.options.maxChars));
  const bootstrapMessages = Math.max(1, Math.floor(params.options.bootstrapMessages));
  const maxCharsPerMessage = Math.max(80, Math.floor(params.options.maxCharsPerMessage ?? 600));

  const current = params.cursor;
  const isIncremental = Boolean(current?.telegramSessionId && current.telegramSessionId === latest.sessionId);
  const afterMessageId = Math.max(0, Math.floor(current?.lastMessageId ?? 0));
  const fetchLimit = isIncremental ? maxMessages : bootstrapMessages;

  const fetched = isIncremental
    ? listIncrementalRows(db, { sessionId: latest.sessionId, afterMessageId, fetchLimit })
    : listBootstrapRows(db, { sessionId: latest.sessionId, fetchLimit });
  const source: TelegramDeltaBuildResult["stats"]["source"] = isIncremental ? "incremental" : "bootstrap";

  if (fetched.rows.length === 0) {
    const nextCursor = isIncremental
      ? {
          telegramSessionId: latest.sessionId,
          lastMessageId: current?.lastMessageId ?? null,
        }
      : {
          telegramSessionId: latest.sessionId,
          lastMessageId: null,
        };
    return {
      block: null,
      nextCursor,
      stats: {
        source,
        sessionId: latest.sessionId,
        includedMessages: 0,
        omittedMessages: 0,
        hasMore: false,
        bytes: 0,
      },
    };
  }

  const lines: string[] = [];
  let bytes = 0;
  let included = 0;
  let lastIncludedMessageId: number | null = null;
  for (const row of fetched.rows) {
    if (included >= maxMessages) break;
    const line = `[${roleTag(row)}] ${compactText(String(row.content ?? ""), maxCharsPerMessage)}`;
    const candidateBytes = line.length + 1;
    if (included > 0 && bytes + candidateBytes > maxChars) break;
    if (included === 0 && candidateBytes > maxChars) {
      const prefix = `[${roleTag(row)}] `;
      const room = Math.max(32, maxChars - prefix.length - 1);
      const clipped = compactText(String(row.content ?? ""), room);
      const clippedLine = `${prefix}${clipped}`;
      lines.push(clippedLine);
      bytes += clippedLine.length + 1;
      included += 1;
      lastIncludedMessageId = row.id;
      break;
    }
    lines.push(line);
    bytes += candidateBytes;
    included += 1;
    lastIncludedMessageId = row.id;
  }

  const omittedFromCharCap = Math.max(0, fetched.rows.length - included);
  const omittedMessages = omittedFromCharCap + (fetched.hasMore ? 1 : 0);
  const hasMore = omittedMessages > 0;
  const header = source === "incremental"
    ? `TELEGRAM DELTA (since message_id>${afterMessageId}, session=${latest.channelKey})`
    : `TELEGRAM DELTA (session switch/bootstrap, session=${latest.channelKey})`;
  const footer = hasMore ? `\n[delta truncated: omitted>=${omittedMessages}]` : "";
  const block = `${header}\n${lines.join("\n")}${footer}`;

  return {
    block,
    nextCursor: {
      telegramSessionId: latest.sessionId,
      lastMessageId: lastIncludedMessageId,
    },
    stats: {
      source,
      sessionId: latest.sessionId,
      includedMessages: included,
      omittedMessages,
      hasMore,
      bytes,
    },
  };
}
