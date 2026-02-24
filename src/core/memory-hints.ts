import type { NexusDatabase } from "../storage/database.js";
import type { ChatMessage } from "./types.js";

// ── Keyword extraction ──────────────────────────────────────────────

const STOPWORDS = new Set([
  // Determiners, conjunctions, prepositions
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "like", "into", "over", "after",
  "before", "between", "under", "about", "than",
  // Pronouns
  "my", "your", "his", "her", "its", "our", "their", "me", "him", "them",
  "we", "you", "i", "he", "she", "they", "us", "it", "that", "this",
  "those", "these", "which", "who", "what", "each", "other", "some",
  "such", "any", "both", "few", "own", "same",
  // Common verbs
  "is", "was", "are", "be", "has", "had", "have", "do", "does", "did",
  "been", "being", "will", "would", "can", "could", "should", "may",
  "might", "get", "got", "go", "going", "make", "made", "know", "think",
  "want", "need", "use", "using", "used", "let", "say", "said", "see",
  "look", "come", "take", "give", "tell", "keep", "put", "turn", "move",
  "start", "stop", "show", "open", "close", "read", "write", "pull",
  "push", "call", "send", "left", "leave", "find", "found", "feel",
  "seem", "become", "bring", "hold", "carry", "pass", "pick", "end",
  // Adverbs & modifiers
  "not", "no", "so", "if", "then", "too", "very", "just", "also", "how",
  "when", "where", "why", "more", "most", "here", "there", "again",
  "even", "now", "still", "well", "back", "up", "out", "all",
  "really", "actually", "already", "much", "many", "only",
  // Conversational fillers
  "please", "thanks", "okay", "yeah", "yes", "hey", "hello", "hi",
  "sure", "maybe", "because", "right",
  // Numbers & ordinals
  "one", "two", "three", "four", "five", "first", "last", "next",
  // Generic nouns (appear in nearly every conversation)
  "thing", "something", "anything", "everything", "nothing", "time",
  "work", "way", "part", "point", "place", "case", "kind", "sort",
  "type", "lot", "bit", "stuff", "issue", "problem", "question",
  "answer", "result", "output", "input", "value", "data", "info",
  "information", "example", "list", "name", "number", "line", "step",
  "state", "status", "error", "message", "request", "response",
  // Generic action words (too common to be meaningful hints)
  "try", "help", "check", "run", "set", "add", "update", "change",
  "file", "code", "done", "able", "create", "delete", "remove",
  "move", "copy", "save", "load", "handle", "manage", "process",
  "build", "test", "fix", "debug", "deploy", "install", "configure",
  "enable", "disable", "connect", "disconnect",
  // Generic adjectives
  "new", "old", "good", "bad", "different", "same", "current",
  "recent", "latest", "previous", "specific", "general", "relevant",
  "important", "available", "possible", "successful", "complete",
  "simple", "basic", "main", "full", "local", "remote",
]);

const MIN_KEYWORD_LENGTH = 4;
const MAX_KEYWORDS = 5;
const MAX_KEYWORD_LENGTH = 80;
const MAX_SEEN_KEYWORDS = 120;

function rememberSeenKeyword(seenKeywords: Set<string>, keyword: string): void {
  seenKeywords.add(keyword);
  while (seenKeywords.size > MAX_SEEN_KEYWORDS) {
    const oldest = seenKeywords.values().next().value;
    if (!oldest) break;
    seenKeywords.delete(oldest);
  }
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function looksLikeMachineToken(keyword: string): boolean {
  const k = keyword.trim().toLowerCase();
  if (!k) return true;
  if (k.length < MIN_KEYWORD_LENGTH || k.length > MAX_KEYWORD_LENGTH) return true;
  if (/[\r\n\t]/.test(k)) return true;
  if (/[|;&<>]/.test(k)) return true;
  if (k.includes("/") || k.includes("\\")) return true;
  if (/\s/.test(k)) return true;
  if (k.includes("_")) return true;
  if (looksLikeUuid(k)) return true;
  if (/^[0-9a-f]{16,}$/i.test(k)) return true;
  if (/^(rr[bc]|proc)_[0-9a-f-]{8,}$/i.test(k)) return true;
  if (k.includes("internal_callback_not_user_message")) return true;
  if (k.includes("source_run_id") || k.includes("parent_run_id") || k.includes("source_agent_id")) return true;
  if (/^\/home\/[^/]+\/\.nexus-node(?:\/|$)/.test(k)) return true;

  const digits = (k.match(/\d/g) ?? []).length;
  const letters = (k.match(/[a-z]/g) ?? []).length;
  if (digits >= 6) return true;
  if (digits >= 4 && digits >= letters) return true;

  const underscoreCount = (k.match(/_/g) ?? []).length;
  if (underscoreCount >= 3) return true;

  return false;
}

function addKeywordCandidate(out: Set<string>, raw: string): void {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return;
  if (STOPWORDS.has(normalized)) return;
  if (looksLikeMachineToken(normalized)) return;
  out.add(normalized);
}

/**
 * Extract meaningful keywords from user message text.
 * Targets: capitalized words, quoted strings, technical terms (dotted, hyphenated, camelCase).
 */
export function extractKeywords(text: string): string[] {
  const keywords = new Set<string>();

  // Quoted strings (double only to avoid apostrophe issues)
  for (const m of text.matchAll(/"([^"]{2,40})"/g)) {
    addKeywordCandidate(keywords, m[1]);
  }

  // Backtick-wrapped terms (e.g. `docker`, `haproxy`)
  for (const m of text.matchAll(/`([^`]{2,40})`/g)) {
    addKeywordCandidate(keywords, m[1]);
  }

  // File paths (e.g. /data/nexus, ~/scripts/deploy)
  for (const m of text.matchAll(/(?:~|\/)[a-zA-Z][\w./-]{2,}/g)) {
    addKeywordCandidate(keywords, m[0]);
  }

  // Dotted identifiers (e.g. octoprint.local, node.js)
  for (const m of text.matchAll(/\b([a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+)\b/g)) {
    addKeywordCandidate(keywords, m[1]);
  }

  // Hyphenated terms (e.g. ha-rollout, docker-compose)
  for (const m of text.matchAll(/\b([a-zA-Z][\w]*(?:-[a-zA-Z][\w]*)+)\b/g)) {
    addKeywordCandidate(keywords, m[1]);
  }

  // Capitalized words (likely proper nouns / product names)
  for (const m of text.matchAll(/\b([A-Z][a-zA-Z]{2,})\b/g)) {
    addKeywordCandidate(keywords, m[1]);
  }

  // camelCase / PascalCase compound words (e.g. OctoPrint, startGateway)
  for (const m of text.matchAll(/\b([a-z]+[A-Z][a-zA-Z]*|[A-Z][a-z]+[A-Z][a-zA-Z]*)\b/g)) {
    addKeywordCandidate(keywords, m[1]);
  }

  // Remaining standalone words ≥ MIN_KEYWORD_LENGTH (letters/digits only, no underscores)
  for (const m of text.matchAll(/\b([a-zA-Z][a-zA-Z0-9]{2,})\b/g)) {
    addKeywordCandidate(keywords, m[1]);
  }

  // Return top keywords, preferring longer / more specific terms
  return [...keywords]
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_KEYWORDS);
}

// ── Memory hint generation ──────────────────────────────────────────

const MAX_HINTS_PER_MESSAGE = 3;
const MAX_MATCH_THRESHOLD = 5; // Skip keywords matching too many memories (too generic to be useful)
const EXCLUDE_SYSTEM_MEMORIES_SQL =
  "key NOT LIKE 'compaction:%' " +
  "AND tags_json NOT LIKE '%\"compaction\"%' " +
  "AND tags_json NOT LIKE '%\"context-summary\"%'";

// Cache memory keys for a short period to avoid repeated DB queries within a burst of messages.
let _memoryKeysCache: Map<string, { keys: string[]; ts: number }> | null = null;
const MEMORY_KEYS_CACHE_TTL_MS = 60_000;

function loadMemoryKeys(db: NexusDatabase, agentId: string): string[] {
  const now = Date.now();
  if (!_memoryKeysCache) _memoryKeysCache = new Map();
  const cached = _memoryKeysCache.get(agentId);
  if (cached && now - cached.ts < MEMORY_KEYS_CACHE_TTL_MS) {
    return cached.keys;
  }
  const rows = db.db
    .prepare(`SELECT key FROM memories WHERE agent_id = ? AND ${EXCLUDE_SYSTEM_MEMORIES_SQL}`)
    .all(agentId) as { key: string }[];
  const keys = rows.map((r) => r.key.toLowerCase());
  _memoryKeysCache.set(agentId, { keys, ts: now });
  return keys;
}

interface MemoryHintMatch {
  keyword: string;
  count: number;
}

/**
 * Query the memories table for keyword matches, skipping already-seen keywords.
 * Also discovers lowercase words from the message that match known memory keys
 * (memory-aware boosting), so terms like "docker" or "host" get caught even
 * without capitalization or special formatting.
 *
 * Returns a formatted hint string or null if no matches.
 * Mutates seenKeywords to include newly checked keywords.
 */
export function generateMemoryHints(opts: {
  db: NexusDatabase;
  agentId: string;
  keywords: string[];
  seenKeywords: Set<string>;
  messageText?: string;
}): string | null {
  const { db, agentId, keywords, seenKeywords, messageText } = opts;

  // Memory-aware boosting: extract all lowercase words from the raw message
  // and check which ones appear as substrings in existing memory keys.
  // This catches terms like "docker", "host", "redis" that regex heuristics miss.
  const boosted = new Set(keywords);
  if (messageText) {
    const memoryKeys = loadMemoryKeys(db, agentId);
    if (memoryKeys.length > 0) {
      const words = messageText.toLowerCase().match(/\b[a-z][a-z0-9]{2,}\b/g) ?? [];
      for (const word of words) {
        if (word.length < MIN_KEYWORD_LENGTH) continue;
        if (looksLikeMachineToken(word)) continue;
        if (STOPWORDS.has(word) || boosted.has(word) || seenKeywords.has(word)) continue;
        const wordRegex = new RegExp(`\\b${word}\\b`, "i");
        if (memoryKeys.some((k) => wordRegex.test(k))) {
          boosted.add(word);
        }
      }
    }
  }

  const newKeywords = [...boosted].filter((k) => !seenKeywords.has(k));
  if (newKeywords.length === 0) return null;

  // Use space-delimited patterns for better word-boundary matching.
  // For keys: check common delimiters (space, hyphen, underscore, start/end).
  // For value: require spaces around keyword to reduce substring noise.
  // For tags_json: keep plain substring (tags are short identifiers).
  const countStmt = db.db.prepare(
    `SELECT COUNT(*) as cnt FROM memories
     WHERE agent_id = ?
       AND ${EXCLUDE_SYSTEM_MEMORIES_SQL}
       AND (
       key = ? OR
       key LIKE ? ESCAPE '\\' OR
       key LIKE ? ESCAPE '\\' OR
       key LIKE ? ESCAPE '\\' OR
       key LIKE ? ESCAPE '\\' OR
       key LIKE ? ESCAPE '\\' OR
       (' ' || value || ' ') LIKE ? ESCAPE '\\' OR
       tags_json LIKE ? ESCAPE '\\'
     )`,
  );

  const matches: MemoryHintMatch[] = [];

  for (const keyword of newKeywords) {
    const esc = keyword.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const row = countStmt.get(
      agentId,
      keyword,            // exact key match
      `${esc} %`,         // key starts with keyword + space
      `% ${esc}`,         // key ends with space + keyword
      `% ${esc} %`,       // keyword delimited by spaces in key
      `%-${esc}%`,        // hyphenated in key (e.g. "ha-rollout")
      `%${esc}-%`,        // hyphenated in key (e.g. "docker-compose")
      `% ${esc} %`,       // space-delimited in value
      `%${esc}%`,         // substring in tags (tags are short)
    ) as { cnt: number } | undefined;
    if (row && row.cnt > 0) {
      rememberSeenKeyword(seenKeywords, keyword);
    }
    if (row && row.cnt > 0 && row.cnt <= MAX_MATCH_THRESHOLD) {
      matches.push({ keyword, count: row.cnt });
    }
  }

  if (matches.length === 0) return null;

  // Sort by count descending, take top N
  matches.sort((a, b) => b.count - a.count);
  const top = matches.slice(0, MAX_HINTS_PER_MESSAGE);

  const parts = top.map((m) =>
    m.count === 1
      ? `1 entry matches "${m.keyword}"`
      : `${m.count} entries match "${m.keyword}"`,
  );

  return `[Memory hints: ${parts.join(", ")} — use memory_search if relevant]`;
}

// ── Recent memory_search detection ──────────────────────────────────

const RECENT_TURNS_THRESHOLD = 3;

/**
 * Check if memory_search was called in recent user→assistant exchanges,
 * excluding heartbeat ticks (which share the same session via
 * latest_telegram_for_agent and frequently call memory_search).
 */
export function hasRecentMemorySearch(history: ChatMessage[], lookback = RECENT_TURNS_THRESHOLD): boolean {
  const exchangeHasMemorySearch: boolean[] = [];
  let activeExchangeIndex = -1;

  for (const msg of history) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : "";
      // Skip heartbeat tick exchanges entirely — they are synthetic background activity.
      if (text.startsWith("HEARTBEAT TICK")) {
        activeExchangeIndex = -1;
        continue;
      }
      exchangeHasMemorySearch.push(false);
      activeExchangeIndex = exchangeHasMemorySearch.length - 1;
      continue;
    }

    if (msg.role !== "assistant" || activeExchangeIndex < 0) continue;
    if (msg.toolCalls?.some((tc) => tc.name === "memory_search")) {
      exchangeHasMemorySearch[activeExchangeIndex] = true;
    }
  }

  return exchangeHasMemorySearch.slice(-lookback).some(Boolean);
}
