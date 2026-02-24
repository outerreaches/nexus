// ─────────────────────────────────────────────────────────────────────────────
// Context Compaction — keeps LLM context within token limits
// ─────────────────────────────────────────────────────────────────────────────
//
// When conversation history + system prompt + tool definitions approach the
// model's context limit, this module summarizes older messages into a compact
// summary and replaces them. Summaries are stored in the memory system for
// cross-session recall.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChatMessage } from "./types.js";
import type { Tool } from "./tools.js";
import type { LLMClient } from "../llm/openai-compat.js";
import type { NexusDatabase } from "../storage/database.js";
import { estimateUserContentPayloadChars, renderUserContentForText } from "./message-content.js";

// ─── Token estimation ────────────────────────────────────────────────────────

export const CHARS_PER_TOKEN = 3.5; // mixed English/code content estimate

/** Estimate token count for a single string. */
function estimateStringTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimate tokens for the tool definitions (JSON schemas + descriptions). */
export function estimateToolTokens(tools: Tool[]): number {
  let chars = 0;
  for (const t of tools) {
    chars += t.name.length + t.description.length;
    chars += JSON.stringify(t.jsonSchema).length;
    chars += 40; // overhead per tool definition
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Estimate tokens for a message array. */
export function estimateMessageTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += 10; // role + structural overhead
    if (m.role === "assistant") {
      chars += (m.content ?? "").length;
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          chars += tc.name.length + tc.arguments.length + tc.id.length + 30;
        }
      }
    } else if (m.role === "tool") {
      chars += m.content.length + (m.name?.length ?? 0) + (m.toolCallId?.length ?? 0) + 20;
    } else if (m.role === "user") {
      chars += estimateUserContentPayloadChars(m.content);
    } else {
      chars += m.content.length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** Estimate total token count for a chat completion request. */
export function estimateTotalTokens(messages: ChatMessage[], tools: Tool[]): number {
  return estimateMessageTokens(messages) + estimateToolTokens(tools);
}

// ─── Compaction ──────────────────────────────────────────────────────────────

export type CompactionResult = {
  messages: ChatMessage[];
  compacted: boolean;
  summary: string | null;
  messagesRemoved: number;
  tokensBefore: number;
  tokensAfter: number;
};

/**
 * Find the boundary between "old" and "recent" messages.
 * We keep at least `minRecentMessages` recent non-system messages,
 * and compact everything before that boundary.
 *
 * The boundary always falls on a clean user message to avoid splitting
 * assistant/tool call sequences.
 */
function findCompactionBoundary(messages: ChatMessage[], minRecentMessages: number): number {
  // messages[0] is always the system prompt
  if (messages.length <= minRecentMessages + 1) return -1;

  // Walk backwards from end, counting non-system messages
  let count = 0;
  let boundary = messages.length;
  for (let i = messages.length - 1; i >= 1; i--) {
    if (messages[i]?.role !== "system") count++;
    if (count >= minRecentMessages && messages[i]?.role === "user") {
      boundary = i;
      break;
    }
  }

  // Nothing to compact if boundary is at or near the start
  if (boundary <= 2) return -1;
  return boundary;
}

function parseJsonMaybe(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function extractCodeStructure(raw: string, maxLines: number = 60): string {
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const normalized = line.replace(/^\d+\s*:\s*/, "").trim();
    if (!normalized) continue;
    if (/^(import|export)\s+/.test(normalized)) {
      out.push(normalized);
      continue;
    }
    if (/^(async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(normalized)) {
      out.push(normalized);
      continue;
    }
    if (/^(class|interface|type|enum)\s+[A-Za-z_$][\w$]*/.test(normalized)) {
      out.push(normalized);
      continue;
    }
    if (/^(const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(async\s*)?\(/.test(normalized)) {
      out.push(normalized);
      continue;
    }
    if (/^(const|let|var)\s+[A-Za-z_$][\w$]*\s*=/.test(normalized) && normalized.length < 140) {
      out.push(normalized);
      continue;
    }
    if (normalized.startsWith("return ") && normalized.length < 160) {
      out.push(normalized);
      continue;
    }
    if (normalized.startsWith("if (") || normalized.startsWith("switch (")) {
      out.push(normalized);
      continue;
    }
  }
  if (out.length === 0) return "";
  const compacted = out.slice(0, maxLines);
  const overflow = out.length - compacted.length;
  return overflow > 0 ? `${compacted.join("\n")}\n…(+${overflow} structural lines)` : compacted.join("\n");
}

function summarizeStructuredToolOutput(name: string, content: string): string {
  if (name === "file_read") {
    const structure = extractCodeStructure(content, 80);
    if (structure) {
      return `structural excerpt:\n${truncateStr(structure, 2_400)}`;
    }
    return truncateStr(content, 1_600);
  }

  if (name === "code_search") {
    const parsed = parseJsonMaybe(content) as { results?: Array<Record<string, unknown>> } | null;
    const rows = Array.isArray(parsed?.results) ? parsed?.results ?? [] : [];
    if (rows.length > 0) {
      const preview = rows.slice(0, 30).map((row) => {
        const file = typeof row.file === "string" ? row.file : "?";
        const line = typeof row.line === "number" ? row.line : "?";
        const kind = typeof row.kind === "string" ? row.kind : "match";
        const text = typeof row.text === "string" ? row.text.trim() : "";
        return `${file}:${line} [${kind}] ${truncateStr(text, 160)}`;
      });
      return `search hits:\n${preview.join("\n")}`;
    }
    return truncateStr(content, 1_400);
  }

  if (name === "code_symbols") {
    const parsed = parseJsonMaybe(content) as { symbols?: unknown[]; results?: unknown[] } | null;
    const rows = Array.isArray(parsed?.symbols) ? parsed?.symbols : Array.isArray(parsed?.results) ? parsed?.results : [];
    if (rows.length > 0) {
      const preview = rows.slice(0, 40).map((row) => {
        const item = row as Record<string, unknown>;
        const symbol = typeof item.symbol === "string" ? item.symbol : "?";
        const file = typeof item.file === "string" ? item.file : "?";
        const line = typeof item.line === "number" ? item.line : "?";
        const kind = typeof item.kind === "string" ? item.kind : "symbol";
        return `${symbol} (${kind}) @ ${file}:${line}`;
      });
      return `symbols:\n${preview.join("\n")}`;
    }
    return truncateStr(content, 1_400);
  }

  if (name === "file_glob") {
    const parsed = parseJsonMaybe(content) as { files?: unknown[] } | null;
    const files = Array.isArray(parsed?.files) ? parsed?.files as string[] : [];
    if (files.length > 0) {
      const preview = files.slice(0, 80).join("\n");
      const overflow = files.length - Math.min(files.length, 80);
      return overflow > 0 ? `glob files:\n${preview}\n…(+${overflow} files)` : `glob files:\n${preview}`;
    }
    return truncateStr(content, 1_200);
  }

  if (name === "code_diff") {
    const parsed = parseJsonMaybe(content) as { changedFiles?: unknown[]; stat?: unknown } | null;
    const changed = Array.isArray(parsed?.changedFiles) ? parsed?.changedFiles as string[] : [];
    const stat = typeof parsed?.stat === "string" ? parsed.stat : "";
    const lines: string[] = [];
    if (changed.length > 0) {
      lines.push(`changed files (${changed.length}): ${changed.slice(0, 30).join(", ")}`);
    }
    if (stat.trim()) {
      lines.push(`stat: ${truncateStr(stat.replace(/\r?\n/g, " | "), 600)}`);
    }
    if (lines.length > 0) return lines.join("\n");
    return truncateStr(content, 1_200);
  }

  if (name === "shell_exec" || name === "shell_interactive") {
    return truncateStr(content, 1_000);
  }

  return truncateStr(content, 800);
}

/**
 * Build a text representation of messages for summarization.
 * Truncates very long tool results while preserving code navigation structure.
 */
function messagesToText(messages: ChatMessage[], maxCharsPerMessage: number = 1_500): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = renderUserContentForText(m.content, { includeImageUrls: false });
      lines.push(`[User]: ${truncateStr(text, maxCharsPerMessage)}`);
    } else if (m.role === "assistant") {
      const text = m.content ?? "";
      if (m.toolCalls && m.toolCalls.length > 0) {
        const calls = m.toolCalls.map((tc) => tc.name).join(", ");
        lines.push(`[Assistant]: ${truncateStr(text, 700)} (called tools: ${calls})`);
      } else if (text) {
        lines.push(`[Assistant]: ${truncateStr(text, maxCharsPerMessage)}`);
      }
    } else if (m.role === "tool") {
      const preview = summarizeStructuredToolOutput(m.name, m.content);
      lines.push(`[Tool:${m.name}]: ${preview}`);
    }
  }
  return lines.join("\n");
}

function truncateStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `…(+${s.length - max} chars)`;
}

/**
 * Compact messages using the LLM to generate a summary of older messages.
 * Falls back to heuristic compaction if the LLM call fails.
 */
export async function compactContext(params: {
  messages: ChatMessage[];
  tools: Tool[];
  llm: LLMClient;
  maxContextTokens: number;
  /** Minimum recent messages to preserve (default: 10) */
  minRecentMessages?: number;
  onLog?: (msg: string) => void;
}): Promise<CompactionResult> {
  const { messages, tools, llm, maxContextTokens } = params;
  const minRecent = params.minRecentMessages ?? 10;
  const tokensBefore = estimateTotalTokens(messages, tools);
  const toolTokens = estimateToolTokens(tools);

  // Target: leave 20% headroom for the model's response
  const targetMessageTokens = Math.floor(maxContextTokens * 0.75) - toolTokens;

  if (estimateMessageTokens(messages) <= targetMessageTokens) {
    return { messages, compacted: false, summary: null, messagesRemoved: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  params.onLog?.(`compaction: triggered (estimated ${tokensBefore} tokens, limit ${maxContextTokens})`);

  const boundary = findCompactionBoundary(messages, minRecent);
  if (boundary < 0) {
    // Can't compact further — try aggressive truncation of tool results instead
    params.onLog?.("compaction: cannot find boundary, using aggressive truncation");
    const truncated = aggressiveTruncate(messages, targetMessageTokens);
    const tokensAfter = estimateTotalTokens(truncated, tools);
    return { messages: truncated, compacted: true, summary: null, messagesRemoved: 0, tokensBefore, tokensAfter };
  }

  const systemMessage = messages[0]!; // system prompt
  const oldMessages = messages.slice(1, boundary);
  const recentMessages = messages.slice(boundary);

  params.onLog?.(`compaction: summarizing ${oldMessages.length} old messages, keeping ${recentMessages.length} recent`);

  // Generate summary
  let summary: string;
  try {
    summary = await generateSummary(llm, oldMessages);
  } catch (err) {
    params.onLog?.(`compaction: LLM summary failed (${err instanceof Error ? err.message : String(err)}), using heuristic`);
    summary = heuristicSummary(oldMessages);
  }

  // Build compacted message array
  const summaryMessage: ChatMessage = {
    role: "system",
    content: `## Conversation Summary (compacted)\n\nThe following is a summary of earlier conversation that was compacted to save context space:\n\n${summary}`,
  };

  const compactedMessages: ChatMessage[] = [systemMessage, summaryMessage, ...recentMessages];
  let tokensAfter = estimateTotalTokens(compactedMessages, tools);

  // If still over budget, do aggressive truncation on recent messages
  if (tokensAfter > maxContextTokens * 0.85) {
    params.onLog?.("compaction: still over budget after summary, truncating tool results");
    const truncatedRecent = aggressiveTruncate(recentMessages, targetMessageTokens - estimateMessageTokens([systemMessage, summaryMessage]));
    const result = [systemMessage, summaryMessage, ...truncatedRecent];
    tokensAfter = estimateTotalTokens(result, tools);
    return { messages: result, compacted: true, summary, messagesRemoved: oldMessages.length, tokensBefore, tokensAfter };
  }

  return {
    messages: compactedMessages,
    compacted: true,
    summary,
    messagesRemoved: oldMessages.length,
    tokensBefore,
    tokensAfter,
  };
}

/**
 * Use the LLM to generate a concise summary of conversation messages.
 * Uses a minimal context (no tools) to keep the summarization call small.
 */
async function generateSummary(llm: LLMClient, messages: ChatMessage[]): Promise<string> {
  const conversationText = messagesToText(messages, 1_100);

  // Cap the text we send for summarization to ~30k chars (~8k tokens)
  const maxSummarizationChars = 30_000;
  const textForSummary = conversationText.length > maxSummarizationChars
    ? conversationText.slice(0, maxSummarizationChars) + "\n\n…(earlier messages truncated)"
    : conversationText;

  const result = await llm.completeChat({
    messages: [
      {
        role: "system",
        content: [
          "You are a context compaction assistant. Your job is to create a concise summary of a conversation.",
          "Focus on:",
          "- Key decisions made and their reasoning",
          "- Important facts, data, or findings discovered",
          "- Current state of any ongoing tasks",
          "- Action items or next steps mentioned",
          "- User preferences or instructions that should persist",
          "- Durable memory-retention candidates using this tiered model:",
          "  - Tier A -> AGENTS.md (critical, frequently used concrete execution facts)",
          "  - Tier M -> MEMORY.md (verified concrete facts with timestamps/source, lower-frequency)",
          "  - Tier B -> memory_store (durable but lower-risk context like preferences/defaults)",
          "  - Tier C -> NOTES.md (working scratch, temporary plans/investigation state)",
          "",
          "Be concise but preserve critical information. Use bullet points.",
          "Do NOT include pleasantries, repetitive information, or tool call details unless the result was important.",
          "End with a short section titled \"Retention candidates (tiered)\". If none, write \"- none\".",
          "Keep your summary under 1500 words.",
        ].join("\n"),
      },
      {
        role: "user",
        content: `Summarize this conversation:\n\n${textForSummary}`,
      },
    ],
    tools: [],
    temperature: 0.1,
  });

  return result.content ?? "No summary generated.";
}

/**
 * Fast heuristic summary when LLM summarization is unavailable.
 * Extracts user messages and assistant conclusions.
 */
function heuristicSummary(messages: ChatMessage[]): string {
  const points: string[] = [];

  for (const m of messages) {
    if (m.role === "user") {
      const text = renderUserContentForText(m.content, { includeImageUrls: false });
      if (text.length <= 10) continue;
      const preview = text.slice(0, 200).replace(/\n/g, " ").trim();
      points.push(`- User: ${preview}`);
    } else if (m.role === "assistant" && m.content && !m.toolCalls?.length) {
      // Only include final assistant messages (not tool-calling ones)
      const preview = m.content.slice(0, 300).replace(/\n/g, " ").trim();
      if (preview.length > 20) {
        points.push(`- Assistant: ${preview}`);
      }
    }
  }

  // Cap at ~20 points
  const capped = points.slice(0, 20);
  return capped.length > 0
    ? capped.join("\n")
    : "Earlier conversation was compacted. No significant content extracted.";
}

/**
 * Aggressively truncate tool results in messages to fit within a token budget.
 * Preserves message structure but shortens tool output content.
 */
function aggressiveTruncate(messages: ChatMessage[], targetTokens: number): ChatMessage[] {
  const current = estimateMessageTokens(messages);
  if (current <= targetTokens) return messages;

  const ratio = targetTokens / current;
  // Calculate max chars per tool result based on how much we need to shrink
  const maxToolResultChars = Math.max(200, Math.floor(2000 * ratio));
  const maxUserPayloadChars = Math.max(240, Math.floor(1800 * ratio));
  const maxUserRenderedChars = Math.max(200, Math.floor(maxUserPayloadChars * 0.9));

  return messages.map((m): ChatMessage => {
    if (m.role === "user") {
      const payloadChars = estimateUserContentPayloadChars(m.content);
      if (payloadChars > maxUserPayloadChars) {
        const rendered = renderUserContentForText(m.content, { includeImageUrls: false });
        const compacted =
          rendered.length > maxUserRenderedChars
            ? rendered.slice(0, maxUserRenderedChars) + `\n…(truncated, original ${rendered.length} chars)`
            : rendered;
        return {
          ...m,
          content:
            `${compacted}\n` +
            `…(user content compacted for context, original payload ${payloadChars} chars)`,
        };
      }
    }
    if (m.role === "tool" && m.content.length > maxToolResultChars) {
      return {
        ...m,
        content: m.content.slice(0, maxToolResultChars) + `\n…(truncated, original ${m.content.length} chars)`,
      };
    }
    if (m.role === "assistant" && m.content && m.content.length > 4000) {
      return {
        ...m,
        content: m.content.slice(0, 4000) + `\n…(truncated)`,
      };
    }
    return m;
  });
}

// ─── Memory integration ──────────────────────────────────────────────────────

/**
 * Store a compaction summary in the memory system for cross-session recall.
 */
export function storeCompactionSummary(params: {
  db: NexusDatabase;
  agentId: string;
  sessionId: string;
  summary: string;
  nowMs: number;
}): void {
  const key = `compaction:${params.sessionId}:${params.nowMs}`;
  try {
    params.db.db
      .prepare(
        `INSERT INTO memories (agent_id, key, value, category, tags_json, created_at, updated_at, accessed_at, access_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(agent_id, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(
        params.agentId,
        key,
        params.summary,
        "observation",
        JSON.stringify(["compaction", "context-summary"]),
        params.nowMs,
        params.nowMs,
        params.nowMs,
      );
  } catch {
    // Non-critical — don't fail the run if memory store fails
  }
}
