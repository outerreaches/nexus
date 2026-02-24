import crypto from "node:crypto";

import type { ChatMessage, ToolCall } from "../core/types.js";
import { renderUserContentForStorage } from "../core/message-content.js";
import type { NexusDatabase } from "./database.js";

const ANCHOR_ROLLOVER_MULTIPLIER = 2;
const SHELL_INTERACTIVE_HISTORY_MAX_OUTPUT_CHARS = 1200;

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

function normalizeToolCallArguments(raw: unknown): string {
  const toObjectString = (value: unknown): string | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  };

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return "{}";
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return "{}";
    }
    if (typeof parsed === "string") {
      const nested = parsed.trim();
      if (!nested) return "{}";
      try {
        parsed = JSON.parse(nested);
      } catch {
        return "{}";
      }
    }
    return toObjectString(parsed) ?? "{}";
  }

  return toObjectString(raw) ?? "{}";
}

function normalizeToolCalls(raw: unknown): ToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ToolCall[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    const fn = typeof e.function === "object" && e.function ? (e.function as Record<string, unknown>) : null;
    const name = typeof e.name === "string"
      ? e.name.trim()
      : (fn && typeof fn.name === "string" ? fn.name.trim() : "");
    const argsRaw = e.arguments ?? (fn ? fn.arguments : undefined);
    if (!id || !name) continue;
    out.push({ id, name, arguments: normalizeToolCallArguments(argsRaw) });
  }
  return out.length > 0 ? out : undefined;
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const omitted = text.length - maxChars;
  return `${text.slice(0, half)}\n\n[...history-compacted ${omitted.toLocaleString()} chars...]\n\n${text.slice(-half)}`;
}

function compactShellInteractiveHistoryContent(raw: string): string {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("{")) return raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
  const obj = parsed as Record<string, unknown>;
  if (obj.action !== "read") {
    return JSON.stringify(obj);
  }

  if (typeof obj.output !== "string") {
    return JSON.stringify(obj);
  }

  const output = obj.output;
  const compacted = truncateMiddle(output, SHELL_INTERACTIVE_HISTORY_MAX_OUTPUT_CHARS);
  const out: Record<string, unknown> = {
    ...obj,
    output: compacted,
  };
  if (compacted !== output) {
    out.outputCompactedForHistory = true;
    out.outputOriginalChars = output.length;
  }
  return JSON.stringify(out);
}

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
        const normalizedToolCalls = normalizeToolCalls(toolCalls);
        return {
          id: row.id,
          message: {
            role: "assistant",
            content: row.content,
            toolCalls: normalizedToolCalls,
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

function findAnchorStart(entries: HistoryEntry[], preferredStart: number): number {
  const start = Math.max(0, preferredStart);
  for (let i = start; i < entries.length; i++) {
    if (entries[i]?.message.role === "user") return i;
  }
  return findSliceStart(entries, start);
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
    const normalizedToolCalls = normalizeToolCalls(params.message.toolCalls ?? null);
    const toolCallsJson = normalizedToolCalls ? JSON.stringify(normalizedToolCalls) : null;
    params.db.db
      .prepare(
        "INSERT INTO messages (session_id, role, content, name, tool_call_id, tool_calls_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(params.sessionId, "assistant", params.message.content ?? "", null, null, toolCallsJson, params.nowMs);
    return;
  }

  if (params.message.role === "tool") {
    const content = params.message.name === "shell_interactive"
      ? compactShellInteractiveHistoryContent(params.message.content)
      : params.message.content;
    params.db.db
      .prepare(
        "INSERT INTO messages (session_id, role, content, name, tool_call_id, tool_calls_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        params.sessionId,
        "tool",
        content,
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
  const activeWindow = Math.max(1, params.maxMessages);
  const rolloverLimit = Math.max(
    activeWindow + 1,
    params.anchorRolloverMessages ?? activeWindow * ANCHOR_ROLLOVER_MULTIPLIER,
  );

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
      "SELECT id, role, content, name, tool_call_id, tool_calls_json FROM messages WHERE session_id = ? AND id >= ? ORDER BY id ASC",
    )
    .all(params.sessionId, anchorId) as MessageRow[];

  if (rows.length === 0) {
    const fallbackLimit = Math.max(rolloverLimit + activeWindow + 8, activeWindow * 3);
    const fallbackRows = params.db.db
      .prepare(
        "SELECT id, role, content, name, tool_call_id, tool_calls_json FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(params.sessionId, fallbackLimit) as MessageRow[];
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

  let sanitized = sanitizeHistoryEntries(rows.map(rowToHistoryEntry));
  if (sanitized.length === 0) {
    return [];
  }
  // Ensure deterministic chronological order before windowing.
  sanitized = sanitized.sort((a, b) => a.id - b.id);

  let nextAnchorId = anchorId;
  // Rolling anchor policy:
  // - Keep an active window of latest `activeWindow` messages.
  // - Keep up to `rolloverLimit` messages from anchor.
  // - When exceeded, advance the anchor in `activeWindow` steps.
  while (sanitized.length > rolloverLimit) {
    const preferredAnchorStart = Math.min(sanitized.length - 1, activeWindow);
    const anchorStart = findAnchorStart(sanitized, preferredAnchorStart);
    const candidateAnchorId = sanitized[anchorStart]?.id;
    if (typeof candidateAnchorId !== "number") break;
    if (anchorStart <= 0) break;
    nextAnchorId = candidateAnchorId;
    sanitized = sanitized.slice(anchorStart);
  }

  if (typeof nextAnchorId === "number" && nextAnchorId !== anchorId) {
    params.db.db
      .prepare("UPDATE sessions SET history_anchor_message_id = ?, history_anchor_updated_at = ? WHERE id = ?")
      .run(nextAnchorId, nowMs, params.sessionId);
  }

  return sanitized.map((entry) => entry.message);
}
