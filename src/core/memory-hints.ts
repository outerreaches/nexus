import type { NexusDatabase } from "../storage/database.js";
import type { ChatMessage } from "./types.js";

// ── Keyword extraction ──────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "that", "this", "was", "are",
  "be", "has", "had", "have", "do", "does", "did", "will", "would", "can",
  "could", "should", "may", "might", "not", "no", "so", "if", "then",
  "than", "too", "very", "just", "about", "up", "out", "all", "also",
  "how", "what", "when", "where", "who", "which", "why", "been", "being",
  "each", "other", "some", "such", "into", "over", "after", "before",
  "between", "under", "again", "here", "there", "any", "both", "more",
  "most", "own", "same", "few", "those", "these", "my", "your", "his",
  "her", "its", "our", "their", "me", "him", "them", "we", "you", "i",
  "he", "she", "they", "us", "as", "like", "get", "got", "go", "going",
  "make", "made", "know", "think", "want", "need", "use", "using", "used",
  "let", "say", "said", "see", "look", "come", "take", "give", "tell",
  "new", "old", "good", "bad", "right", "still", "way", "back", "well",
  "even", "now", "because", "please", "thanks", "okay", "yeah", "yes",
  "hey", "hello", "hi", "sure", "maybe", "really", "actually", "already",
  "much", "many", "only", "one", "two", "first", "last", "next", "thing",
  "something", "anything", "everything", "nothing", "time", "work",
  "try", "help", "check", "run", "set", "add", "update", "change",
  "file", "code", "done", "able",
]);

const MIN_KEYWORD_LENGTH = 3;
const MAX_KEYWORDS = 8;

/**
 * Extract meaningful keywords from user message text.
 * Targets: capitalized words, quoted strings, technical terms (dotted, hyphenated, camelCase).
 */
export function extractKeywords(text: string): string[] {
  const keywords = new Set<string>();

  // Quoted strings (single or double)
  for (const m of text.matchAll(/["']([^"']{2,40})["']/g)) {
    keywords.add(m[1].trim().toLowerCase());
  }

  // Backtick-wrapped terms (e.g. `docker`, `haproxy`)
  for (const m of text.matchAll(/`([^`]{2,40})`/g)) {
    keywords.add(m[1].trim().toLowerCase());
  }

  // File paths (e.g. /data/nexus, ~/scripts/deploy)
  for (const m of text.matchAll(/(?:~|\/)[a-zA-Z][\w./-]{2,}/g)) {
    keywords.add(m[0].toLowerCase());
  }

  // Dotted identifiers (e.g. octoprint.local, node.js)
  for (const m of text.matchAll(/\b([a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+)\b/g)) {
    keywords.add(m[1].toLowerCase());
  }

  // Hyphenated terms (e.g. ha-rollout, docker-compose)
  for (const m of text.matchAll(/\b([a-zA-Z][\w]*(?:-[a-zA-Z][\w]*)+)\b/g)) {
    keywords.add(m[1].toLowerCase());
  }

  // Capitalized words (likely proper nouns / product names)
  for (const m of text.matchAll(/\b([A-Z][a-zA-Z]{2,})\b/g)) {
    const lower = m[1].toLowerCase();
    if (!STOPWORDS.has(lower)) keywords.add(lower);
  }

  // camelCase / PascalCase compound words (e.g. OctoPrint, startGateway)
  for (const m of text.matchAll(/\b([a-z]+[A-Z][a-zA-Z]*|[A-Z][a-z]+[A-Z][a-zA-Z]*)\b/g)) {
    keywords.add(m[1].toLowerCase());
  }

  // Remaining standalone words ≥ MIN_KEYWORD_LENGTH, filtered by stopwords
  for (const m of text.matchAll(/\b([a-zA-Z][\w]{2,})\b/g)) {
    const lower = m[1].toLowerCase();
    if (!STOPWORDS.has(lower) && lower.length >= MIN_KEYWORD_LENGTH) {
      keywords.add(lower);
    }
  }

  // Return top keywords, preferring longer / more specific terms
  return [...keywords]
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_KEYWORDS);
}

// ── Memory hint generation ──────────────────────────────────────────

const MAX_HINTS_PER_MESSAGE = 3;

// Cache memory keys for a short period to avoid repeated DB queries within a burst of messages.
let _memoryKeysCache: { agentId: string; keys: string[]; ts: number } | null = null;
const MEMORY_KEYS_CACHE_TTL_MS = 60_000;

function loadMemoryKeys(db: NexusDatabase, agentId: string): string[] {
  const now = Date.now();
  if (_memoryKeysCache && _memoryKeysCache.agentId === agentId && now - _memoryKeysCache.ts < MEMORY_KEYS_CACHE_TTL_MS) {
    return _memoryKeysCache.keys;
  }
  const rows = db.db.prepare("SELECT key FROM memories WHERE agent_id = ?").all(agentId) as { key: string }[];
  const keys = rows.map((r) => r.key.toLowerCase());
  _memoryKeysCache = { agentId, keys, ts: now };
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
      const words = messageText.toLowerCase().match(/\b[a-z][\w]{2,}\b/g) ?? [];
      for (const word of words) {
        if (STOPWORDS.has(word) || boosted.has(word) || seenKeywords.has(word)) continue;
        if (memoryKeys.some((k) => k.includes(word))) {
          boosted.add(word);
        }
      }
    }
  }

  const newKeywords = [...boosted].filter((k) => !seenKeywords.has(k));
  if (newKeywords.length === 0) return null;

  const countStmt = db.db.prepare(
    `SELECT COUNT(*) as cnt FROM memories
     WHERE agent_id = ? AND (key LIKE ? OR value LIKE ? OR tags_json LIKE ?)`,
  );

  const matches: MemoryHintMatch[] = [];

  for (const keyword of newKeywords) {
    seenKeywords.add(keyword);
    const pattern = `%${keyword}%`;
    const row = countStmt.get(agentId, pattern, pattern, pattern) as { cnt: number } | undefined;
    if (row && row.cnt > 0) {
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
 * Check if memory_search was called in the last N assistant turns of history.
 */
export function hasRecentMemorySearch(history: ChatMessage[], lookback = RECENT_TURNS_THRESHOLD): boolean {
  let assistantTurnsSeen = 0;
  for (let i = history.length - 1; i >= 0 && assistantTurnsSeen < lookback; i--) {
    const msg = history[i];
    if (msg.role === "assistant") {
      assistantTurnsSeen++;
      if (msg.toolCalls?.some((tc) => tc.name === "memory_search")) {
        return true;
      }
    }
  }
  return false;
}
