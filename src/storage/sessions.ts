import crypto from "node:crypto";

import type { ChatMessage } from "../core/types.js";
import type { NexusDatabase } from "./database.js";

function sanitizeHistory(history: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let openToolCallIds = new Set<string>();

  for (const msg of history) {
    if (msg.role === "assistant") {
      out.push(msg);
      openToolCallIds = new Set((msg.toolCalls ?? []).map((tc) => tc.id).filter(Boolean));
      continue;
    }

    if (msg.role === "tool") {
      if (msg.toolCallId && openToolCallIds.has(msg.toolCallId)) {
        out.push(msg);
        openToolCallIds.delete(msg.toolCallId);
      }
      continue;
    }

    out.push(msg);
    openToolCallIds.clear();
  }

  return out;
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
    .run(params.sessionId, params.message.role, params.message.content, null, null, null, params.nowMs);
}

export function loadRecentHistory(params: {
  db: NexusDatabase;
  sessionId: string;
  maxMessages: number;
}): ChatMessage[] {
  const fetchLimit = Math.max(params.maxMessages * 3, params.maxMessages + 50);
  const rows = params.db.db
    .prepare(
      "SELECT role, content, name, tool_call_id, tool_calls_json FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?",
    )
    .all(params.sessionId, fetchLimit) as {
    role: string;
    content: string;
    name: string | null;
    tool_call_id: string | null;
    tool_calls_json: string | null;
  }[];

  const history: ChatMessage[] = rows
    .reverse()
    .map((r): ChatMessage => {
      if (r.role === "tool") {
        return { role: "tool", content: r.content, name: r.name ?? "", toolCallId: r.tool_call_id ?? "" };
      }
      if (r.role === "assistant") {
        if (r.tool_calls_json) {
          try {
            const toolCalls = JSON.parse(r.tool_calls_json) as unknown;
            return {
              role: "assistant",
              content: r.content,
              toolCalls: Array.isArray(toolCalls) ? (toolCalls as any) : undefined,
            };
          } catch {
            return { role: "assistant", content: r.content };
          }
        }
        return { role: "assistant", content: r.content };
      }
      if (r.role === "system") {
        return { role: "system", content: r.content };
      }
      return { role: "user", content: r.content };
    });

  const sanitized = sanitizeHistory(history);
  if (sanitized.length <= params.maxMessages) return sanitized;

  let start = sanitized.length - params.maxMessages;
  while (start < sanitized.length && sanitized[start]?.role === "tool") start += 1;
  return sanitized.slice(start);
}
