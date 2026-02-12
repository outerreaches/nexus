import crypto from "node:crypto";

import type { ChatMessage } from "../core/types.js";
import { renderUserContentForStorage } from "../core/message-content.js";
import type { NexusDatabase } from "./database.js";

const ANCHOR_ROLLOVER_MULTIPLIER = 2;
const ANCHOR_FETCH_MULTIPLIER = 6;

type HistoryEntry = {
  id: number;
  message: ChatMessage;
};

type MessageRow = {
  id: number;
  role: string;
  content: string;
  name: string | null;
  tool_call_id: string | null;
  tool_calls_json: string | null;
};

function sanitizeHistoryEntries(entries: HistoryEntry[]): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  let openToolCallIds = new Set<string>();

  for (const entry of entries) {
    const msg = entry.message;
    if (msg.role === "assistant") {
      out.push(entry);
      openToolCallIds = new Set((msg.toolCalls ?? []).map((tc) => tc.id).filter(Boolean));
      continue;
    }

    if (msg.role === "tool") {
      if (msg.toolCallId && openToolCallIds.has(msg.toolCallId)) {
        out.push(entry);
        openToolCallIds.delete(msg.toolCallId);
      }
      continue;
    }

    out.push(entry);
    openToolCallIds.clear();
  }

  return out;
}

function rowToHistoryEntry(row: MessageRow): HistoryEntry {
  if (row.role === "tool") {
    return {
      id: row.id,
      message: { role: "tool", content: row.content, name: row.name ?? "", toolCallId: row.tool_call_id ?? "" },
    };
  }
  if (row.role === "assistant") {
    if (row.tool_calls_json) {
      try {
        const toolCalls = JSON.parse(row.tool_calls_json) as unknown;
        return {
          id: row.id,
          message: {
            role: "assistant",
            content: row.content,
            toolCalls: Array.isArray(toolCalls) ? (toolCalls as any) : undefined,
          },
        };
      } catch {
        return { id: row.id, message: { role: "assistant", content: row.content } };
      }
    }
    return { id: row.id, message: { role: "assistant", content: row.content } };
  }
  if (row.role === "system") {
    return { id: row.id, message: { role: "system", content: row.content } };
  }
  return { id: row.id, message: { role: "user", content: row.content } };
}

function findSliceStart(entries: HistoryEntry[], preferredStart: number): number {
  let start = Math.max(0, preferredStart);
  while (start < entries.length && entries[start]?.message.role === "tool") start += 1;
  if (start < entries.length) return start;
  return Math.max(0, entries.length - 1);
}

export function getOrCreateSessionId(params: {
  db: NexusDatabase;
  channel: string;
  channelKey: string;
  agentId: string;
  nowMs: number;
}): string {
  const existing = params.db.db
    .prepare("SELECT id FROM sessions WHERE channel = ? AND channel_key = ? AND agent_id = ?")
    .get(params.channel, params.channelKey, params.agentId) as { id: string } | undefined;
  if (existing?.id) return existing.id;

  const id = crypto.randomUUID();
  params.db.db
    .prepare("INSERT INTO sessions (id, channel, channel_key, agent_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, params.channel, params.channelKey, params.agentId, params.nowMs);
  return id;
}

export function appendMessage(params: {
  db: NexusDatabase;
  sessionId: string;
  message: ChatMessage;
  nowMs: number;
}): void {
  if (params.message.role === "assistant") {
    // Persist assistant content even when it’s a tool-calling message (content may be null).
    const toolCallsJson = params.message.toolCalls ? JSON.stringify(params.message.toolCalls) : null;
    params.db.db
      .prepare(
        "INSERT INTO messages (session_id, role, content, name, tool_call_id, tool_calls_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(params.sessionId, "assistant", params.message.content ?? "", null, null, toolCallsJson, params.nowMs);
    return;
  }

  if (params.message.role === "tool") {
    params.db.db
      .prepare(
        "INSERT INTO messages (session_id, role, content, name, tool_call_id, tool_calls_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        params.sessionId,
        "tool",
        params.message.content,
        params.message.name,
        params.message.toolCallId,
        null,
        params.nowMs,
      );
    return;
  }

  params.db.db
    .prepare(
      "INSERT INTO messages (session_id, role, content, name, tool_call_id, tool_calls_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      params.sessionId,
      params.message.role,
      params.message.role === "user" ? renderUserContentForStorage(params.message.content) : params.message.content,
      null,
      null,
      null,
      params.nowMs,
    );
}

export function loadRecentHistory(params: {
  db: NexusDatabase;
  sessionId: string;
  maxMessages: number;
  nowMs?: number;
  anchorRolloverMessages?: number;
}): ChatMessage[] {
  const nowMs = params.nowMs ?? Date.now();
  const rolloverLimit = Math.max(
    params.maxMessages + 8,
    params.anchorRolloverMessages ?? params.maxMessages * ANCHOR_ROLLOVER_MULTIPLIER,
  );
  const fetchLimit = Math.max(rolloverLimit * ANCHOR_FETCH_MULTIPLIER, params.maxMessages + 120);

  const sessionRow = params.db.db
    .prepare("SELECT history_anchor_message_id FROM sessions WHERE id = ?")
    .get(params.sessionId) as { history_anchor_message_id: number | null } | undefined;
  let anchorId = sessionRow?.history_anchor_message_id ?? null;

  if (!anchorId) {
    const first = params.db.db
      .prepare("SELECT id FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT 1")
      .get(params.sessionId) as { id: number } | undefined;
    if (!first) return [];
    anchorId = first.id;
    params.db.db
      .prepare("UPDATE sessions SET history_anchor_message_id = ?, history_anchor_updated_at = ? WHERE id = ?")
      .run(anchorId, nowMs, params.sessionId);
  }

  let rows = params.db.db
    .prepare(
      "SELECT id, role, content, name, tool_call_id, tool_calls_json FROM messages WHERE session_id = ? AND id >= ? ORDER BY id ASC LIMIT ?",
    )
    .all(params.sessionId, anchorId, fetchLimit) as MessageRow[];

  if (rows.length === 0) {
    const fallbackRows = params.db.db
      .prepare(
        "SELECT id, role, content, name, tool_call_id, tool_calls_json FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(params.sessionId, fetchLimit) as MessageRow[];
    if (fallbackRows.length === 0) return [];
    rows = fallbackRows.reverse();
    const fallbackAnchorId = rows[0]?.id;
    if (typeof fallbackAnchorId === "number") {
      params.db.db
        .prepare("UPDATE sessions SET history_anchor_message_id = ?, history_anchor_updated_at = ? WHERE id = ?")
        .run(fallbackAnchorId, nowMs, params.sessionId);
      anchorId = fallbackAnchorId;
    }
  }

  const sanitized = sanitizeHistoryEntries(rows.map(rowToHistoryEntry));
  if (sanitized.length === 0) return [];

  if (sanitized.length > rolloverLimit) {
    const preferredStart = Math.max(0, sanitized.length - params.maxMessages);
    const start = findSliceStart(sanitized, preferredStart);
    const nextAnchorId = sanitized[start]?.id;
    if (typeof nextAnchorId === "number" && nextAnchorId !== anchorId) {
      params.db.db
        .prepare("UPDATE sessions SET history_anchor_message_id = ?, history_anchor_updated_at = ? WHERE id = ?")
        .run(nextAnchorId, nowMs, params.sessionId);
    }
    return sanitized.slice(start).map((entry) => entry.message);
  }

  return sanitized.map((entry) => entry.message);
}
