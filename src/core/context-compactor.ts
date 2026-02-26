// ─────────────────────────────────────────────────────────────────────────────
// Context Compaction — keeps LLM context within token limits
// ─────────────────────────────────────────────────────────────────────────────
//
// When conversation history + system prompt + tool definitions approach the
// model's context limit, this module summarizes older messages into a compact
// summary and replaces them. Summaries are stored in the memory system for
// cross-session recall.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "node:crypto";

import type { ChatMessage } from "./types.js";
import type { Tool } from "./tools.js";
import type { LLMClient } from "../llm/openai-compat.js";
import type { NexusDatabase } from "../storage/database.js";
import { estimateUserContentPayloadChars, renderUserContentForText } from "./message-content.js";

const COMPACTION_SUMMARY_PREFIX = "## Conversation Summary (compacted)";
const PINNED_CONTEXT_PREFIX = "## Pinned Context (always keep)";

// ─── Token estimation ────────────────────────────────────────────────────────

export const CHARS_PER_TOKEN = 3.5; // mixed English/code content estimate

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

export type RetentionCandidate = {
  tier: "A" | "M" | "B" | "C";
  text: string;
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

  // Preferred boundary: start on a user turn.
  let count = 0;
  for (let i = messages.length - 1; i >= 1; i--) {
    if (messages[i]?.role !== "system") count++;
    if (count >= minRecentMessages && messages[i]?.role === "user") {
      if (i > 2) return i;
      break;
    }
  }

  // Fallback: allow assistant/tool boundary when a long tool chain has no
  // nearby user turn. Normalize to avoid splitting tool-call/result blocks.
  count = 0;
  let candidate = -1;
  for (let i = messages.length - 1; i >= 1; i--) {
    if (messages[i]?.role !== "system") count++;
    if (count >= minRecentMessages) {
      candidate = i;
      break;
    }
  }
  if (candidate <= 2) return -1;
  return normalizeBoundaryToTurn(messages, candidate);
}

function normalizeBoundaryToTurn(messages: ChatMessage[], boundary: number): number {
  let idx = boundary;
  // If boundary lands in tool results, keep the triggering assistant/tool block.
  while (idx > 1) {
    const current = messages[idx];
    if (!current || current.role !== "tool") break;
    idx -= 1;
  }
  // If this is a tool-calling assistant and there's an initiating user right
  // before it, keep that user with the block for coherence.
  const normalized = messages[idx];
  if (idx > 1 && normalized?.role === "assistant" && normalized.toolCalls?.length) {
    if (messages[idx - 1]?.role === "user") idx -= 1;
  }
  // Keep runtime system hints attached to the recent block.
  while (idx > 1 && messages[idx - 1]?.role === "system") idx -= 1;
  return idx > 2 ? idx : -1;
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

const ESC_CHAR = String.fromCharCode(27);
const BEL_CHAR = String.fromCharCode(7);
const ANSI_ESCAPE_RE = new RegExp(`${ESC_CHAR}\\[[0-?]*[ -/]*[@-~]`, "g");
const ANSI_OSC_RE = new RegExp(`${ESC_CHAR}\\][^${BEL_CHAR}]*(?:${BEL_CHAR}|${ESC_CHAR}\\\\)`, "g");

function stripAsciiControlChars(input: string): string {
  if (!input) return input;
  let out = "";
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if ((code >= 0 && code <= 8) || (code >= 11 && code <= 31) || code === 127) {
      continue;
    }
    out += input[i]!;
  }
  return out;
}

function sanitizeToolOutputForCompaction(raw: string): string {
  if (!raw) return raw;
  const sanitized = raw
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_ESCAPE_RE, "")
    .replace(/\r/g, "");
  return stripAsciiControlChars(sanitized).replace(/\n{4,}/g, "\n\n\n");
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
  const normalizedContent = sanitizeToolOutputForCompaction(content);
  if (name === "file_read") {
    const structure = extractCodeStructure(normalizedContent, 80);
    if (structure) {
      return `structural excerpt:\n${truncateStr(structure, 2_400)}`;
    }
    return truncateStr(normalizedContent, 1_600);
  }

  if (name === "code_search") {
    const parsed = parseJsonMaybe(normalizedContent) as { results?: Array<Record<string, unknown>> } | null;
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
    return truncateStr(normalizedContent, 1_400);
  }

  if (name === "file_glob") {
    const parsed = parseJsonMaybe(normalizedContent) as { files?: unknown[] } | null;
    const files = Array.isArray(parsed?.files) ? parsed?.files as string[] : [];
    if (files.length > 0) {
      const preview = files.slice(0, 80).join("\n");
      const overflow = files.length - Math.min(files.length, 80);
      return overflow > 0 ? `glob files:\n${preview}\n…(+${overflow} files)` : `glob files:\n${preview}`;
    }
    return truncateStr(normalizedContent, 1_200);
  }

  if (name === "code_diff") {
    const parsed = parseJsonMaybe(normalizedContent) as { changedFiles?: unknown[]; stat?: unknown } | null;
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
    return truncateStr(normalizedContent, 1_200);
  }

  if (name === "shell_exec" || name === "shell_interactive") {
    return truncateStr(normalizedContent, 1_000);
  }

  return truncateStr(normalizedContent, 800);
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

const RETENTION_SECTION_RE = /retention candidates\s*\(tiered\)/i;
const RETENTION_CANDIDATE_RE = /^\s*[-*]\s*(?:tier\s*)?([ambc])\s*(?:->|:|[-–—])\s*(.+?)\s*$/i;

function normalizeRetentionText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isLowSignalRetentionText(text: string): boolean {
  const normalized = normalizeRetentionText(text).toLowerCase();
  if (!normalized) return true;
  if (normalized === "none") return true;
  if (normalized === "- none") return true;
  if (normalized === "n/a") return true;
  if (normalized.includes("no retention candidates")) return true;
  return false;
}

function stableRetentionKey(sessionId: string, text: string): string {
  const hash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
  return `retention:${sessionId}:${hash}`;
}

/**
 * Parse tiered retention candidate bullets from a compaction summary.
 */
export function extractTieredRetentionCandidates(summary: string, maxCandidates: number = 24): RetentionCandidate[] {
  const text = summary.trim();
  if (!text) return [];

  const lines = text.split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => RETENTION_SECTION_RE.test(line));
  const candidateLines = sectionStart >= 0 ? lines.slice(sectionStart + 1) : lines;
  const out: RetentionCandidate[] = [];

  for (const line of candidateLines) {
    if (out.length >= maxCandidates) break;
    const m = line.match(RETENTION_CANDIDATE_RE);
    if (!m) continue;
    const tierRaw = (m[1] ?? "").trim().toUpperCase();
    const tier = tierRaw === "A" || tierRaw === "M" || tierRaw === "B" || tierRaw === "C" ? tierRaw : null;
    if (!tier) continue;
    const candidateText = normalizeRetentionText(m[2] ?? "");
    if (isLowSignalRetentionText(candidateText)) continue;
    out.push({ tier, text: candidateText });
  }

  return out;
}

function isCompactionSummaryMessage(message: ChatMessage): message is Extract<ChatMessage, { role: "system" }> {
  return message.role === "system" && message.content.startsWith(COMPACTION_SUMMARY_PREFIX);
}

function isPinnedContextMessage(message: ChatMessage): message is Extract<ChatMessage, { role: "system" }> {
  return message.role === "system" && message.content.startsWith(PINNED_CONTEXT_PREFIX);
}

function isAutoCompactionSystemMessage(message: ChatMessage): boolean {
  return isCompactionSummaryMessage(message) || isPinnedContextMessage(message);
}

function extractLatestPinnedContext(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 1; i--) {
    const msg = messages[i];
    if (!msg || !isPinnedContextMessage(msg)) continue;
    const content = msg.content.slice(PINNED_CONTEXT_PREFIX.length).trim();
    if (content) return content;
  }
  return null;
}

function extractSectionBullets(summary: string, headings: RegExp[]): string[] {
  const lines = summary.split(/\r?\n/);
  const out: string[] = [];
  let active = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}\s+/.test(line)) {
      active = headings.some((re) => re.test(line));
      continue;
    }
    if (!active) continue;
    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (!bulletMatch) {
      // Stop at plain text once section body ended.
      if (out.length > 0) break;
      continue;
    }
    const text = normalizeRetentionText(bulletMatch[1] ?? "");
    if (isLowSignalRetentionText(text)) continue;
    out.push(text);
    if (out.length >= 12) break;
  }
  return out;
}

function heuristicPinnedFromMessages(messages: ChatMessage[]): string {
  const userPrompts: string[] = [];
  const constraints = new Set<string>();
  const handles = new Set<string>();
  const decisions = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "user") {
      const text = renderUserContentForText(msg.content, { includeImageUrls: false }).trim();
      if (text) userPrompts.push(text);
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        if (/(must|do not|don't|never|without|required|no fallback|read[- ]only|sidecar)/i.test(line)) {
          constraints.add(normalizeRetentionText(line));
        }
        if (/^let'?s\s+/i.test(line)) decisions.add(normalizeRetentionText(line));
      }
      continue;
    }
    if (msg.role === "tool") {
      const normalized = sanitizeToolOutputForCompaction(msg.content);
      const handleLine = normalized.match(
        /\b(session|nextCursor|cursor|nodeId|jobId|processId|deliveryId)\b[^,\n]{0,120}/i,
      );
      if (handleLine?.[0]) handles.add(normalizeRetentionText(handleLine[0]));
      continue;
    }
    if (msg.role === "assistant" && typeof msg.content === "string") {
      for (const line of msg.content.split(/\r?\n/)) {
        if (/^(decision|chosen|selected|plan|next step)/i.test(line.trim())) {
          decisions.add(normalizeRetentionText(line));
        }
      }
    }
  }

  const latestGoal = userPrompts.length > 0 ? normalizeRetentionText(userPrompts[userPrompts.length - 1] ?? "") : "";
  const lines: string[] = [];
  if (latestGoal) lines.push(`- Goal: ${truncateStr(latestGoal, 280)}`);
  if (constraints.size > 0) {
    for (const item of Array.from(constraints).slice(0, 4)) {
      lines.push(`- Constraint: ${truncateStr(item, 220)}`);
    }
  }
  if (decisions.size > 0) {
    for (const item of Array.from(decisions).slice(0, 4)) {
      lines.push(`- Decision: ${truncateStr(item, 220)}`);
    }
  }
  if (handles.size > 0) {
    for (const item of Array.from(handles).slice(0, 4)) {
      lines.push(`- Active handle: ${truncateStr(item, 200)}`);
    }
  }
  if (lines.length === 0) {
    lines.push("- Goal: Continue current user task with the latest constraints and unresolved items.");
  }
  return truncateStr(lines.join("\n"), 1_800);
}

function buildPinnedContext(summary: string, oldMessages: ChatMessage[], priorPinned: string | null): string {
  const goalItems = extractSectionBullets(summary, [/goals?\b/i, /task\b/i]);
  const constraintItems = extractSectionBullets(summary, [/constraints?\b/i, /must keep\b/i, /non-negotiable\b/i]);
  const decisionItems = extractSectionBullets(summary, [/decisions?\b/i]);
  const stateItems = extractSectionBullets(summary, [/active execution state\b/i, /\bstate\b/i, /\bhandles?\b/i]);
  const openItems = extractSectionBullets(summary, [/open items?\b/i, /next steps?\b/i]);

  const lines: string[] = [];
  for (const item of goalItems.slice(0, 2)) lines.push(`- Goal: ${item}`);
  for (const item of constraintItems.slice(0, 4)) lines.push(`- Constraint: ${item}`);
  for (const item of decisionItems.slice(0, 4)) lines.push(`- Decision: ${item}`);
  for (const item of stateItems.slice(0, 4)) lines.push(`- Active state: ${item}`);
  for (const item of openItems.slice(0, 4)) lines.push(`- Open item: ${item}`);

  if (priorPinned) {
    const priorLines = priorPinned
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^-\s+/.test(line))
      .slice(0, 4);
    for (const line of priorLines) lines.push(line);
  }

  const deduped = Array.from(
    new Set(lines.map((line) => normalizeRetentionText(line)).filter((line) => !isLowSignalRetentionText(line))),
  ).slice(0, 14);

  if (deduped.length === 0) return heuristicPinnedFromMessages(oldMessages);
  return truncateStr(deduped.join("\n"), 1_900);
}

function normalizeEstimationFactor(factor: number | undefined): number {
  if (typeof factor !== "number" || !Number.isFinite(factor)) return 1;
  return Math.min(2.5, Math.max(0.8, factor));
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
  mode?: "soft" | "hard";
  estimationFactor?: number;
  /** Minimum recent messages to preserve (default: 10) */
  minRecentMessages?: number;
  onLog?: (msg: string) => void;
}): Promise<CompactionResult> {
  const { messages, tools, llm, maxContextTokens } = params;
  const minRecent = params.minRecentMessages ?? 10;
  const mode = params.mode ?? "soft";
  const estimationFactor = normalizeEstimationFactor(params.estimationFactor);
  const estimateTotal = (msgs: ChatMessage[]): number => Math.ceil(estimateTotalTokens(msgs, tools) * estimationFactor);
  const estimateMessages = (msgs: ChatMessage[]): number => Math.ceil(estimateMessageTokens(msgs) * estimationFactor);
  const toolTokens = Math.ceil(estimateToolTokens(tools) * estimationFactor);
  const tokensBefore = estimateTotal(messages);

  // Hard mode leaves more response headroom to avoid repeated near-limit retries.
  const targetHeadroom = mode === "hard" ? 0.7 : 0.75;
  const targetMessageTokens = Math.max(64, Math.floor(maxContextTokens * targetHeadroom) - toolTokens);

  if (estimateMessages(messages) <= targetMessageTokens) {
    return { messages, compacted: false, summary: null, messagesRemoved: 0, tokensBefore, tokensAfter: tokensBefore };
  }

  params.onLog?.(
    `compaction: triggered (estimated ${tokensBefore} tokens, limit ${maxContextTokens}, mode=${mode}, factor=${estimationFactor.toFixed(2)})`,
  );

  const boundary = findCompactionBoundary(messages, minRecent);
  if (boundary < 0) {
    // Can't compact further — try aggressive truncation of tool results instead
    params.onLog?.("compaction: cannot find boundary, using aggressive truncation");
    const truncated = aggressiveTruncate(messages, targetMessageTokens);
    const tokensAfter = estimateTotal(truncated);
    return { messages: truncated, compacted: true, summary: null, messagesRemoved: 0, tokensBefore, tokensAfter };
  }

  const systemMessage = messages[0]!; // system prompt
  const priorPinned = extractLatestPinnedContext(messages);
  const oldMessagesRaw = messages.slice(1, boundary);
  const recentMessages = messages.slice(boundary).filter((m) => !isAutoCompactionSystemMessage(m));
  const oldMessages = oldMessagesRaw.filter((m) => !isAutoCompactionSystemMessage(m));

  params.onLog?.(`compaction: summarizing ${oldMessages.length} old messages, keeping ${recentMessages.length} recent`);

  // Generate summary
  let summary: string;
  try {
    summary = await generateSummary(llm, oldMessages, priorPinned);
  } catch (err) {
    params.onLog?.(`compaction: LLM summary failed (${err instanceof Error ? err.message : String(err)}), using heuristic`);
    summary = heuristicSummary(oldMessages);
  }

  const pinnedContext = buildPinnedContext(summary, oldMessages, priorPinned);
  const pinnedMessage: ChatMessage = {
    role: "system",
    content: `${PINNED_CONTEXT_PREFIX}\n\n${pinnedContext}`,
  };

  // Build compacted message array
  const summaryMessage: ChatMessage = {
    role: "system",
    content: `${COMPACTION_SUMMARY_PREFIX}\n\nThe following is a summary of earlier conversation that was compacted to save context space:\n\n${summary}`,
  };

  const compactedMessages: ChatMessage[] = [systemMessage, pinnedMessage, summaryMessage, ...recentMessages];
  let tokensAfter = estimateTotal(compactedMessages);

  const reductionRatio = tokensAfter / Math.max(tokensBefore, 1);
  const overBudgetThreshold = mode === "hard" ? 0.72 : 0.85;
  const weakReduction = mode === "hard" ? reductionRatio > 0.9 : false;

  // If still over budget (or in hard mode reduction is weak), truncate recent payload.
  if (tokensAfter > maxContextTokens * overBudgetThreshold || weakReduction) {
    params.onLog?.(
      weakReduction
        ? "compaction: weak reduction after summary in hard mode, truncating recent payload"
        : "compaction: still over budget after summary, truncating tool results",
    );
    const fixedTokens = estimateMessages([systemMessage, pinnedMessage, summaryMessage]);
    const availableRecentTokens = Math.max(320, targetMessageTokens - fixedTokens);
    const truncatedRecent = aggressiveTruncate(recentMessages, availableRecentTokens);
    const result = [systemMessage, pinnedMessage, summaryMessage, ...truncatedRecent];
    tokensAfter = estimateTotal(result);
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
async function generateSummary(llm: LLMClient, messages: ChatMessage[], priorPinned: string | null): Promise<string> {
  const conversationText = messagesToText(messages, 1_100);

  // Cap the text we send for summarization to ~30k chars (~8k tokens)
  const maxSummarizationChars = 30_000;
  const textForSummary = conversationText.length > maxSummarizationChars
    ? conversationText.slice(0, maxSummarizationChars) + "\n\n…(earlier messages truncated)"
    : conversationText;
  const priorPinnedText = priorPinned ? truncateStr(priorPinned, 2_000) : "";

  const result = await llm.completeChat({
    messages: [
      {
        role: "system",
        content: [
          "You are a context compaction assistant. Your job is to create a concise summary of a conversation.",
          "Output MUST use markdown sections in this order:",
          "## Goals and task",
          "## Constraints (must keep)",
          "## Decisions",
          "## Active execution state",
          "## Open items and next steps",
          "## Retention candidates (tiered)",
          "",
          "Each section should contain bullet points. If unknown, write \"- none\".",
          "Focus on concrete details, not narration.",
          "- Durable memory-retention candidates using this tiered model:",
          "  - Tier A -> AGENTS.md (critical, frequently used concrete execution facts)",
          "  - Tier M -> MEMORY.md (verified concrete facts with timestamps/source, lower-frequency)",
          "  - Tier B -> memory_store (durable but lower-risk context like preferences/defaults)",
          "  - Tier C -> NOTES.md (working scratch, temporary plans/investigation state)",
          "",
          "Carry forward relevant facts from prior pinned context only if still consistent.",
          "Do not duplicate stale/contradictory items.",
          "",
          "Be concise but preserve critical information.",
          "Do NOT include pleasantries, repetitive information, or tool call details unless the result was important.",
          "Keep your summary under 1500 words.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          "Summarize this conversation history.",
          "",
          priorPinnedText ? `Prior pinned context (carry forward if still true):\n${priorPinnedText}\n` : "",
          `Conversation:\n${textForSummary}`,
        ]
          .filter(Boolean)
          .join("\n"),
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
  const userPoints: string[] = [];
  const assistantPoints: string[] = [];

  for (const m of messages) {
    if (m.role === "user") {
      const text = renderUserContentForText(m.content, { includeImageUrls: false });
      if (text.length <= 10) continue;
      const preview = text.slice(0, 200).replace(/\n/g, " ").trim();
      userPoints.push(preview);
    } else if (m.role === "assistant" && m.content && !m.toolCalls?.length) {
      // Only include final assistant messages (not tool-calling ones)
      const preview = m.content.slice(0, 300).replace(/\n/g, " ").trim();
      if (preview.length > 20) {
        assistantPoints.push(preview);
      }
    }
  }

  const latestUser = userPoints.length > 0 ? userPoints[userPoints.length - 1] : "";
  const latestAssistant = assistantPoints.length > 0 ? assistantPoints[assistantPoints.length - 1] : "";

  const lines: string[] = [
    "## Goals and task",
    latestUser ? `- ${latestUser}` : "- none",
    "## Constraints (must keep)",
    "- none",
    "## Decisions",
    latestAssistant ? `- ${latestAssistant}` : "- none",
    "## Active execution state",
    "- none",
    "## Open items and next steps",
    "- none",
    "## Retention candidates (tiered)",
    "- none",
  ];

  return lines.join("\n");
}

/**
 * Aggressively truncate tool results in messages to fit within a token budget.
 * Preserves message structure but shortens tool output content.
 */
function aggressiveTruncate(messages: ChatMessage[], targetTokens: number): ChatMessage[] {
  const current = estimateMessageTokens(messages);
  if (current <= targetTokens) return messages;

  const ratio = Math.max(0.05, targetTokens / current);
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
      const normalized = sanitizeToolOutputForCompaction(m.content);
      return {
        ...m,
        content: normalized.slice(0, maxToolResultChars) + `\n…(truncated, original ${m.content.length} chars)`,
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

/**
 * Parse and persist Tier B retention candidates from compaction summaries.
 * Tier A/M/C are intentionally excluded from auto-write because they target files
 * or higher-trust memory layers that should remain explicit/manual.
 */
export function storeCompactionRetentionCandidates(params: {
  db: NexusDatabase;
  agentId: string;
  sessionId: string;
  summary: string;
  nowMs: number;
  onLog?: (line: string) => void;
}): { detected: number; stored: number } {
  const candidates = extractTieredRetentionCandidates(params.summary);
  if (candidates.length === 0) return { detected: 0, stored: 0 };

  const tierB = candidates.filter((candidate) => candidate.tier === "B");
  if (tierB.length === 0) return { detected: candidates.length, stored: 0 };

  let stored = 0;
  const upsert = params.db.db.prepare(
    `INSERT INTO memories (agent_id, key, value, category, tags_json, created_at, updated_at, accessed_at, access_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(agent_id, key) DO UPDATE SET
       value = excluded.value,
       category = excluded.category,
       tags_json = excluded.tags_json,
       updated_at = excluded.updated_at`,
  );
  const tagsJson = JSON.stringify(["retention-pass", "tier-b", "source:compaction"]);

  for (const candidate of tierB) {
    const value = candidate.text.trim();
    if (isLowSignalRetentionText(value)) continue;
    const key = stableRetentionKey(params.sessionId, value.toLowerCase());
    try {
      upsert.run(
        params.agentId,
        key,
        value,
        "observation",
        tagsJson,
        params.nowMs,
        params.nowMs,
        params.nowMs,
      );
      stored += 1;
    } catch (err) {
      params.onLog?.(`retention_pass_store_failed key=${key} err=${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    detected: candidates.length,
    stored,
  };
}
