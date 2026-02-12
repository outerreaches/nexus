// ─────────────────────────────────────────────────────────────────────────────
// Context Compaction — keeps LLM context within token limits
// ─────────────────────────────────────────────────────────────────────────────
//
// When conversation history + system prompt + tool definitions approach the
// model's context limit, this module summarizes older messages into a compact
// summary and replaces them. Summaries are stored in the memory system for
// cross-session recall.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChatMessage, ToolCall } from "./types.js";
import type { Tool } from "./tools.js";
import type { OpenAICompatClient } from "../llm/openai-compat.js";
import type { NexusDatabase } from "../storage/database.js";
import { estimateUserContentPayloadChars, renderUserContentForText } from "./message-content.js";

// ─── Token estimation ────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 3.8; // conservative estimate for mixed content

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
    count++;
    if (count >= minRecentMessages && messages[i]?.role === "user") {
      boundary = i;
      break;
    }
  }

  // Nothing to compact if boundary is at or near the start
  if (boundary <= 2) return -1;
  return boundary;
}

/**
 * Build a text representation of messages for summarization.
 * Truncates very long tool results to keep the summarization request small.
 */
function messagesToText(messages: ChatMessage[], maxCharsPerMessage: number = 1500): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = renderUserContentForText(m.content, { includeImageUrls: false });
      lines.push(`[User]: ${truncateStr(text, maxCharsPerMessage)}`);
    } else if (m.role === "assistant") {
      const text = m.content ?? "";
      if (m.toolCalls && m.toolCalls.length > 0) {
        const calls = m.toolCalls.map((tc) => tc.name).join(", ");
        lines.push(`[Assistant]: ${truncateStr(text, 500)} (called tools: ${calls})`);
      } else if (text) {
        lines.push(`[Assistant]: ${truncateStr(text, maxCharsPerMessage)}`);
      }
    } else if (m.role === "tool") {
      const preview = truncateStr(m.content, 400);
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
  llm: OpenAICompatClient;
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
async function generateSummary(llm: OpenAICompatClient, messages: ChatMessage[]): Promise<string> {
  const conversationText = messagesToText(messages, 800);

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
          "",
          "Be concise but preserve critical information. Use bullet points.",
          "Do NOT include pleasantries, repetitive information, or tool call details unless the result was important.",
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

  return messages.map((m): ChatMessage => {
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
