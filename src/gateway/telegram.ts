import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Hono } from "hono";
import { Bot, Context, InputFile } from "grammy";


import type { NexusConfig } from "../state/config.js";
import { getSecret } from "../secrets/resolve-env.js";
import type { AgentService } from "../core/agent-service.js";
import { Semaphore } from "../core/semaphore.js";
import type { ChatUserContentPart } from "../core/types.js";
import type { NexusDatabase } from "../storage/database.js";
import { getOrCreateSessionId, setHomeSession, clearHomeSession } from "../storage/sessions.js";
import { createPairingRequest, isTelegramUserAllowed } from "./telegram-store.js";
import {
  decodeQuickResponseCallback,
  encodeQuickResponseCallback,
  fulfillHumanActionWithSync,
  listPendingConfirmActionsInText,
  quickResponsesForHumanAction,
} from "../control/human-action-responses.js";
import {
  detectMimeType,
  extensionFromMime,
  isImageMimeType,
  isOpenRouterInlineImageMimeType,
  sanitizeTelegramFilename,
} from "./telegram-files.js";

const DEFAULT_MAX_INBOUND_FILES_PER_MESSAGE = 5;
const DEFAULT_MAX_INBOUND_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_FILE_BLACKBOARD_TTL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_INLINE_IMAGES_FOR_LLM = 3;
const DEFAULT_MAX_INLINE_IMAGE_BYTES_FOR_LLM = 4 * 1024 * 1024;

type TelegramBotCommand = {
  command: string;
  description: string;
};

type TelegramCommandScope = {
  type: "default" | "all_private_chats" | "all_group_chats";
};

const TELEGRAM_DEFAULT_COMMANDS: readonly TelegramBotCommand[] = [
  { command: "help", description: "Show available commands" },
];

const TELEGRAM_GROUP_COMMANDS: readonly TelegramBotCommand[] = [
  { command: "nexus", description: "Talk to Nexus in group chats" },
  { command: "help", description: "Show available commands" },
];

const TELEGRAM_PRIVATE_COMMANDS_BASE: readonly TelegramBotCommand[] = [
  { command: "help", description: "Show available commands" },
  { command: "sethome", description: "Set this chat as home for background events" },
  { command: "unsethome", description: "Clear home chat assignment" },
  { command: "provider", description: "Show or set LLM provider routes" },
  { command: "model", description: "Show or set LLM model routes" },
  { command: "presets", description: "Show preset routing summary" },
  { command: "stop", description: "Stop current run in this chat" },
  { command: "stopall", description: "Stop all runs and workers" },
  { command: "tools", description: "List available tools" },
  { command: "nodes", description: "Show node status" },
  { command: "jobs", description: "Show scheduler jobs" },
  { command: "intakes", description: "Show data intake sources" },
  { command: "processes", description: "Show managed processes" },
  { command: "mcp", description: "Show MCP servers and profiles" },
  { command: "federation", description: "Show federation status" },
  { command: "blackboard", description: "Show blackboard inventory" },
  { command: "act", description: "Respond to a human action request" },
];

function buildTelegramPrivateCommands(pairingEnabled: boolean): TelegramBotCommand[] {
  const commands = [...TELEGRAM_PRIVATE_COMMANDS_BASE];
  if (pairingEnabled) {
    commands.push({ command: "pair", description: "Request a pairing code in this DM" });
  }
  return commands;
}

function commandScopeLabel(scope: TelegramCommandScope): string {
  return scope.type;
}

function areTelegramCommandsEqual(
  actual: readonly { command: string; description: string }[],
  expected: readonly TelegramBotCommand[],
): boolean {
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < actual.length; i += 1) {
    const left = actual[i];
    const right = expected[i];
    if (!left || !right) return false;
    if (left.command !== right.command || left.description !== right.description) return false;
  }
  return true;
}

async function syncTelegramCommands(params: {
  bot: Bot<Context>;
  pairingEnabled: boolean;
  log: (msg: string) => void;
}): Promise<void> {
  const syncPlan: Array<{ scope: TelegramCommandScope; commands: TelegramBotCommand[] }> = [
    { scope: { type: "default" }, commands: [...TELEGRAM_DEFAULT_COMMANDS] },
    { scope: { type: "all_group_chats" }, commands: [...TELEGRAM_GROUP_COMMANDS] },
    { scope: { type: "all_private_chats" }, commands: buildTelegramPrivateCommands(params.pairingEnabled) },
  ];

  for (const entry of syncPlan) {
    const label = commandScopeLabel(entry.scope);
    try {
      const current = await params.bot.api.getMyCommands({ scope: entry.scope });
      if (areTelegramCommandsEqual(current, entry.commands)) {
        params.log(`telegram: commands scope=${label} unchanged count=${entry.commands.length}`);
        continue;
      }
      await params.bot.api.setMyCommands(entry.commands, { scope: entry.scope });
      params.log(`telegram: commands scope=${label} synced count=${entry.commands.length}`);
    } catch (err) {
      params.log(`telegram: WARN commands scope=${label} sync_failed=${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

type IncomingAttachment = {
  kind: string;
  fileId: string;
  fileUniqueId?: string;
  mimeType?: string;
  originalName?: string;
  declaredSizeBytes?: number;
};

type StoredAttachment = {
  kind: string;
  absolutePath: string;
  statePath: string;
  mimeType: string;
  sizeBytes: number;
  originalName: string;
  fileId: string;
  fileUniqueId?: string;
};

function splitTelegramMessage(text: string, maxLen: number = 3900): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    const cut = rest.lastIndexOf("\n", maxLen);
    const idx = cut > 0 ? cut : maxLen;
    chunks.push(rest.slice(0, idx));
    rest = rest.slice(idx).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.length === 0 ? [""] : chunks;
}

function resolveTelegramMessageThreadId(message: unknown): number | undefined {
  const msg = message as { is_topic_message?: unknown; message_thread_id?: unknown } | null | undefined;
  if (!msg || !msg.is_topic_message) return undefined;
  return typeof msg.message_thread_id === "number" ? msg.message_thread_id : undefined;
}

function resolveMessageThreadId(ctx: Context): number | undefined {
  return resolveTelegramMessageThreadId(ctx.msg);
}

const TELEGRAM_STREAM_PREVIEW_MAX_CHARS = 4096;
const TELEGRAM_STREAM_PREVIEW_THROTTLE_MS = 2_500;
const TELEGRAM_STREAM_PREVIEW_MESSAGE_MIN_THROTTLE_MS = 2_500;
const TELEGRAM_STREAM_PREVIEW_DISABLE_RETRY_AFTER_MS = 15_000;
const TELEGRAM_RATE_LIMIT_GRACE_MS = 1_000;
const TELEGRAM_RATE_LIMIT_MAX_ATTEMPTS = 3;
const MESSAGE_NOT_MODIFIED_RE = /message is not modified/i;
const TELEGRAM_RETRY_AFTER_RE = /\bretry after\s+(\d+)\b/i;

function toErrorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err && "description" in err) {
    const description = (err as { description?: unknown }).description;
    if (typeof description === "string") return description;
  }
  return String(err);
}

function sanitizeTelegramErrorDetail(raw: string): string {
  return raw
    .replace(/\bbot\d+:[A-Za-z0-9_-]+\b/g, "bot[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[redacted-api-key]")
    .replace(/\b(api[-_ ]?key|token|password|secret|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

function compactTelegramErrorDetail(err: unknown, maxChars: number = 260): string {
  const compact = sanitizeTelegramErrorDetail(toErrorText(err)).replace(/\s+/g, " ").trim();
  if (!compact) return "unknown error";
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 3)}...`;
}

function formatTelegramRetryAfter(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function isTelegramApiError(err: unknown): boolean {
  const text = toErrorText(err);
  return /^Call to '[^']+' failed!/i.test(text)
    || /\b(telegram|bot api|message_thread_id)\b/i.test(text);
}

export function formatTelegramHandlerErrorMessage(err: unknown): string {
  const detail = compactTelegramErrorDetail(err);
  const retryAfterMs = getTelegramRetryAfterMs(err);
  if (retryAfterMs !== null) {
    return `ERROR: Telegram rate limit hit. Retry after about ${formatTelegramRetryAfter(retryAfterMs)}. Details: ${detail}`;
  }

  if (isTelegramApiError(err)) {
    return `ERROR: Telegram delivery failed: ${detail}`;
  }

  const text = toErrorText(err);
  if (/\b(401|403)\b|unauthorized|forbidden|invalid api key|authentication/i.test(text)) {
    return `ERROR: model/backend authentication failed: ${detail}`;
  }
  if (/\b429\b|too many requests|rate limit/i.test(text)) {
    return `ERROR: model/backend rate limited: ${detail}`;
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|socket hang up|network/i.test(text)) {
    return `ERROR: model/backend connection failed: ${detail}`;
  }
  if (/aborted|cancelled|canceled|interrupted/i.test(text)) {
    return `ERROR: request interrupted: ${detail}`;
  }
  return `ERROR: request failed: ${detail}`;
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function readRetryAfterSeconds(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const direct = readFiniteNumber(obj.retry_after) ?? readFiniteNumber(obj.retryAfter);
  if (direct !== null) return direct;
  const parameters = obj.parameters;
  if (parameters && typeof parameters === "object") {
    const params = parameters as Record<string, unknown>;
    const fromParams = readFiniteNumber(params.retry_after) ?? readFiniteNumber(params.retryAfter);
    if (fromParams !== null) return fromParams;
  }
  return null;
}

export function getTelegramRetryAfterMs(err: unknown): number | null {
  const structuredSeconds = readRetryAfterSeconds(err);
  if (structuredSeconds !== null) {
    return Math.max(0, Math.ceil(structuredSeconds * 1000)) + TELEGRAM_RATE_LIMIT_GRACE_MS;
  }

  const match = TELEGRAM_RETRY_AFTER_RE.exec(toErrorText(err));
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds)) return null;
  return Math.max(0, Math.ceil(seconds * 1000)) + TELEGRAM_RATE_LIMIT_GRACE_MS;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Per-chat rate-limit registry ────────────────────────────────────────────
//
// Telegram's "retry after N seconds" escalates fast when a bot keeps firing
// requests during the cooldown. To prevent independent callers (preview
// stream, finalizeMessage, deleteMessage, sendOutput, …) from each
// re-triggering the penalty, we record the cooldown deadline per chat in a
// shared module-level map and have every API helper consult it BEFORE
// issuing the request. One caller eating a 429 is enough — everyone else
// waits the same retry-after window in parallel instead of compounding it.
const telegramChatRateLimitUntilMs = new Map<number, number>();

/** Mark a chat as rate-limited until `Date.now() + retryAfterMs`. Idempotent;
 *  records only the strictest (latest) deadline. */
function recordTelegramRateLimit(chatId: number, retryAfterMs: number): void {
  if (!Number.isFinite(chatId) || retryAfterMs <= 0) return;
  const untilMs = Date.now() + retryAfterMs;
  const current = telegramChatRateLimitUntilMs.get(chatId);
  if (current === undefined || untilMs > current) {
    telegramChatRateLimitUntilMs.set(chatId, untilMs);
  }
}

/** Return ms remaining until the chat's rate-limit window ends, or 0 if not
 *  currently rate-limited. Cleans up stale entries as a side-effect. */
function telegramRateLimitWaitMs(chatId: number): number {
  const until = telegramChatRateLimitUntilMs.get(chatId);
  if (until === undefined) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    telegramChatRateLimitUntilMs.delete(chatId);
    return 0;
  }
  return remaining;
}

/** Block until any active per-chat rate-limit window has elapsed. */
async function waitForTelegramRateLimit(chatId: number, log?: (msg: string) => void, action?: string): Promise<void> {
  const waitMs = telegramRateLimitWaitMs(chatId);
  if (waitMs <= 0) return;
  log?.(`telegram: rate_limit_block chat_id=${chatId} action=${action ?? "unknown"} wait_ms=${waitMs}`);
  await delay(waitMs);
}

/** Test-only helper for resetting registry state between tests. */
export function __resetTelegramRateLimitRegistryForTests(): void {
  telegramChatRateLimitUntilMs.clear();
}

async function callTelegramApiWithRateLimit<T>(
  operation: () => Promise<T>,
  params: {
    chatId: number;
    action: string;
    log: (msg: string) => void;
    maxAttempts?: number;
  },
): Promise<T> {
  const maxAttempts = Math.max(1, Math.floor(params.maxAttempts ?? TELEGRAM_RATE_LIMIT_MAX_ATTEMPTS));
  for (let attempt = 1; ; attempt += 1) {
    // Pre-flight registry check so multiple callers cooperate on one cooldown.
    await waitForTelegramRateLimit(params.chatId, params.log, params.action);
    try {
      return await operation();
    } catch (err) {
      const retryAfterMs = getTelegramRetryAfterMs(err);
      if (retryAfterMs === null) {
        throw err;
      }
      // Record the cooldown so other concurrent callers also wait.
      recordTelegramRateLimit(params.chatId, retryAfterMs);
      if (attempt >= maxAttempts) {
        throw err;
      }
      params.log(
        `telegram: rate_limit_wait chat_id=${params.chatId} action=${params.action} retry_after_ms=${retryAfterMs} attempt=${attempt}`,
      );
      await delay(retryAfterMs);
    }
  }
}

function isMessageNotModifiedError(err: unknown): boolean {
  return MESSAGE_NOT_MODIFIED_RE.test(toErrorText(err));
}

function isGroupChat(ctx: Context): boolean {
  const type = ctx.chat?.type;
  return type === "group" || type === "supergroup";
}

function isEnvPlaceholder(value: string): boolean {
  return /^\$\{[A-Z0-9_]+\}$/.test(value);
}

function joinPublicUrl(publicUrl: string, pathValue: string): string {
  const base = publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`;
  const p = pathValue.startsWith("/") ? pathValue.slice(1) : pathValue;
  return new URL(p, base).toString();
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function envInt(name: string, fallback: number, opts: { min?: number; max?: number } = {}): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const intVal = Math.floor(parsed);
  if (typeof opts.min === "number" && intVal < opts.min) return opts.min;
  if (typeof opts.max === "number" && intVal > opts.max) return opts.max;
  return intVal;
}

type TelegramMessageEntity = {
  type?: unknown;
  offset?: unknown;
  length?: unknown;
  user?: { id?: unknown } | null;
};

type TelegramSenderChat = {
  id?: unknown;
  type?: unknown;
};

function parseTelegramNumericId(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTelegramUsername(value: string): string {
  return value.replace(/^@+/, "").trim().toLowerCase();
}

function firstTelegramToken(raw: string): string {
  const trimmed = raw.trimStart();
  if (!trimmed) return "";
  const match = trimmed.match(/^\S+/);
  return match ? match[0] : "";
}

function parseTelegramCommandToken(token: string): { command: string; target: string | null } | null {
  const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?$/.exec(token);
  if (!match) return null;
  return {
    command: (match[1] ?? "").toLowerCase(),
    target: match[2] ? match[2].toLowerCase() : null,
  };
}

function isTelegramCommandForBot(token: string, commands: string[], botUsername: string): boolean {
  const parsed = parseTelegramCommandToken(token);
  if (!parsed) return false;
  if (!commands.includes(parsed.command)) return false;
  if (!parsed.target) return true;
  const normalizedBot = normalizeTelegramUsername(botUsername);
  return normalizedBot.length > 0 && parsed.target === normalizedBot;
}

function isNexusInvocation(raw: string, botUsername: string): boolean {
  return isTelegramCommandForBot(firstTelegramToken(raw), ["nexus", "n"], botUsername);
}

function isPairInvocation(raw: string, botUsername: string): boolean {
  return isTelegramCommandForBot(firstTelegramToken(raw), ["pair"], botUsername);
}

function hasBotMentionText(raw: string, botUsername: string): boolean {
  const normalizedBot = normalizeTelegramUsername(botUsername);
  if (!normalizedBot) return false;
  return raw.toLowerCase().includes(`@${normalizedBot}`);
}

function hasBotMentionEntity(raw: string, entities: TelegramMessageEntity[], botUsername: string, botUserId: number): boolean {
  const normalizedBot = normalizeTelegramUsername(botUsername);
  for (const entity of entities) {
    const type = typeof entity.type === "string" ? entity.type : "";
    const offset = typeof entity.offset === "number" ? entity.offset : -1;
    const length = typeof entity.length === "number" ? entity.length : -1;
    if (!type || offset < 0 || length <= 0) continue;
    const token = raw.slice(offset, offset + length);
    if (!token) continue;

    if (type === "mention" && normalizedBot && token.toLowerCase() === `@${normalizedBot}`) return true;
    if (type === "text_mention" && typeof entity.user?.id === "number" && entity.user.id === botUserId) return true;
    if (type === "bot_command" && offset === 0 && isNexusInvocation(token, botUsername)) return true;
  }
  return false;
}

function stripLeadingNexusCommand(raw: string, botUsername: string): string {
  const trimmed = raw.trimStart();
  if (!trimmed) return "";
  const token = firstTelegramToken(trimmed);
  if (!token || !isTelegramCommandForBot(token, ["nexus", "n"], botUsername)) return raw;
  return trimmed.slice(token.length).trimStart();
}

function sanitizeMessageText(raw: string, botUsername: string): string {
  const normalizedBot = normalizeTelegramUsername(botUsername);
  const mentionPattern = normalizedBot ? new RegExp(`@${escapeRegExp(normalizedBot)}\\b`, "gi") : /$^/;
  const withoutMentions = raw.replace(mentionPattern, "");
  return stripLeadingNexusCommand(withoutMentions, botUsername).trim();
}

function normalizeInlineFilePath(line: string): string | null {
  let s = line.trim();
  if (!s) return null;
  s = s.replace(/^[-*]\s+/, "");
  s = s.replace(/^(screenshot|image|path)\s*:\s*/i, "");
  s = s.replace(/^`+/, "").replace(/`+$/, "");
  s = s.replace(/^"+/, "").replace(/"+$/, "");
  s = s.replace(/^'+/, "").replace(/'+$/, "");
  if (s.startsWith("sandbox:")) s = s.slice("sandbox:".length);
  if (s.startsWith("file://")) {
    try {
      s = new URL(s).pathname;
    } catch {
      // ignore malformed URL
    }
  }
  if (!s.startsWith("/")) return null;
  if (!/\.(png|jpg|jpeg|webp)$/i.test(s)) return null;
  return s;
}

async function extractTelegramImageAttachments(output: string): Promise<{ text: string; imagePaths: string[] }> {
  const stateDir = path.resolve(process.env.NEXUS_STATE_DIR ?? "/data/nexus");
  const lines = output.split(/\r?\n/);
  const kept: string[] = [];
  const images: string[] = [];

  for (const line of lines) {
    const candidate = normalizeInlineFilePath(line);
    if (!candidate) {
      kept.push(line);
      continue;
    }
    const full = path.resolve(candidate);
    if (!(full === stateDir || full.startsWith(`${stateDir}${path.sep}`))) {
      kept.push(line);
      continue;
    }
    try {
      const st = await fs.stat(full);
      if (st.isFile()) {
        images.push(full);
        continue;
      }
    } catch {
      // ignore missing files
    }
    kept.push(line);
  }

  return { text: kept.join("\n").trimEnd(), imagePaths: Array.from(new Set(images)) };
}

function collectIncomingAttachments(message: Record<string, unknown> | undefined): IncomingAttachment[] {
  if (!message) return [];
  const out: IncomingAttachment[] = [];
  const m = message as Record<string, any>;

  const doc = m.document as Record<string, unknown> | undefined;
  if (doc?.file_id && typeof doc.file_id === "string") {
    out.push({
      kind: "document",
      fileId: doc.file_id,
      fileUniqueId: typeof doc.file_unique_id === "string" ? doc.file_unique_id : undefined,
      mimeType: typeof doc.mime_type === "string" ? doc.mime_type : undefined,
      originalName: typeof doc.file_name === "string" ? doc.file_name : undefined,
      declaredSizeBytes: typeof doc.file_size === "number" ? doc.file_size : undefined,
    });
  }

  const photos = Array.isArray(m.photo) ? (m.photo as Record<string, unknown>[]) : [];
  if (photos.length > 0) {
    const chosen = photos[photos.length - 1] as Record<string, unknown>;
    if (chosen?.file_id && typeof chosen.file_id === "string") {
      out.push({
        kind: "photo",
        fileId: chosen.file_id,
        fileUniqueId: typeof chosen.file_unique_id === "string" ? chosen.file_unique_id : undefined,
        mimeType: "image/jpeg",
        originalName: undefined,
        declaredSizeBytes: typeof chosen.file_size === "number" ? chosen.file_size : undefined,
      });
    }
  }

  const video = m.video as Record<string, unknown> | undefined;
  if (video?.file_id && typeof video.file_id === "string") {
    out.push({
      kind: "video",
      fileId: video.file_id,
      fileUniqueId: typeof video.file_unique_id === "string" ? video.file_unique_id : undefined,
      mimeType: typeof video.mime_type === "string" ? video.mime_type : "video/mp4",
      originalName: typeof video.file_name === "string" ? video.file_name : undefined,
      declaredSizeBytes: typeof video.file_size === "number" ? video.file_size : undefined,
    });
  }

  const audio = m.audio as Record<string, unknown> | undefined;
  if (audio?.file_id && typeof audio.file_id === "string") {
    out.push({
      kind: "audio",
      fileId: audio.file_id,
      fileUniqueId: typeof audio.file_unique_id === "string" ? audio.file_unique_id : undefined,
      mimeType: typeof audio.mime_type === "string" ? audio.mime_type : "audio/mpeg",
      originalName: typeof audio.file_name === "string" ? audio.file_name : undefined,
      declaredSizeBytes: typeof audio.file_size === "number" ? audio.file_size : undefined,
    });
  }

  const voice = m.voice as Record<string, unknown> | undefined;
  if (voice?.file_id && typeof voice.file_id === "string") {
    out.push({
      kind: "voice",
      fileId: voice.file_id,
      fileUniqueId: typeof voice.file_unique_id === "string" ? voice.file_unique_id : undefined,
      mimeType: "audio/ogg",
      originalName: undefined,
      declaredSizeBytes: typeof voice.file_size === "number" ? voice.file_size : undefined,
    });
  }

  const animation = m.animation as Record<string, unknown> | undefined;
  if (animation?.file_id && typeof animation.file_id === "string") {
    out.push({
      kind: "animation",
      fileId: animation.file_id,
      fileUniqueId: typeof animation.file_unique_id === "string" ? animation.file_unique_id : undefined,
      mimeType: typeof animation.mime_type === "string" ? animation.mime_type : "video/mp4",
      originalName: typeof animation.file_name === "string" ? animation.file_name : undefined,
      declaredSizeBytes: typeof animation.file_size === "number" ? animation.file_size : undefined,
    });
  }

  const sticker = m.sticker as Record<string, unknown> | undefined;
  if (sticker?.file_id && typeof sticker.file_id === "string") {
    out.push({
      kind: "sticker",
      fileId: sticker.file_id,
      fileUniqueId: typeof sticker.file_unique_id === "string" ? sticker.file_unique_id : undefined,
      mimeType: typeof sticker.mime_type === "string" ? sticker.mime_type : "image/webp",
      originalName: undefined,
      declaredSizeBytes: typeof sticker.file_size === "number" ? sticker.file_size : undefined,
    });
  }

  return out;
}

async function ingestIncomingAttachments(params: {
  bot: { api: Bot["api"] };
  token: string;
  stateDir: string;
  chatId: number;
  messageId: number;
  nowMs: number;
  maxFileBytes: number;
  attachments: IncomingAttachment[];
  log: (msg: string) => void;
}): Promise<{ stored: StoredAttachment[]; rejected: string[] }> {
  const { bot, token, stateDir, chatId, messageId, nowMs, maxFileBytes, attachments, log } = params;
  const stored: StoredAttachment[] = [];
  const rejected: string[] = [];
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const relativeBaseDir = path.join("telegram-files", String(chatId), day, String(messageId));
  const absoluteBaseDir = path.join(stateDir, relativeBaseDir);
  await fs.mkdir(absoluteBaseDir, { recursive: true });

  for (let i = 0; i < attachments.length; i += 1) {
    const attachment = attachments[i]!;
    const label = attachment.originalName ?? `${attachment.kind}-${i + 1}`;
    if (attachment.declaredSizeBytes && attachment.declaredSizeBytes > maxFileBytes) {
      rejected.push(`${label}: exceeds ${formatBytes(maxFileBytes)}`);
      continue;
    }

    try {
      const file = await bot.api.getFile(attachment.fileId);
      if (typeof file.file_size === "number" && file.file_size > maxFileBytes) {
        rejected.push(`${label}: exceeds ${formatBytes(maxFileBytes)}`);
        continue;
      }
      const remotePath = file.file_path;
      if (!remotePath) {
        rejected.push(`${label}: Telegram did not return a downloadable path`);
        continue;
      }

      const downloadUrl = `https://api.telegram.org/file/bot${token}/${remotePath}`;
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        rejected.push(`${label}: download failed (${response.status})`);
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxFileBytes) {
        rejected.push(`${label}: exceeds ${formatBytes(maxFileBytes)} after download`);
        continue;
      }

      let fileName = attachment.originalName ? sanitizeTelegramFilename(attachment.originalName) : "";
      const fromRemoteExt = path.extname(remotePath);
      const fromMimeExt = extensionFromMime(attachment.mimeType);
      const inferredExt = fromRemoteExt || fromMimeExt || ".bin";
      if (!fileName) fileName = `${attachment.kind}-${i + 1}${inferredExt}`;
      if (!path.extname(fileName)) fileName = `${fileName}${inferredExt}`;
      const prefixedFileName = `${String(i + 1).padStart(2, "0")}-${fileName}`;

      const relativePath = path.join(relativeBaseDir, prefixedFileName);
      const absolutePath = path.join(stateDir, relativePath);
      await fs.writeFile(absolutePath, bytes);

      const detectedMimeType = detectMimeType(prefixedFileName, attachment.mimeType);
      stored.push({
        kind: attachment.kind,
        absolutePath,
        statePath: toPosixPath(relativePath),
        mimeType: detectedMimeType,
        sizeBytes: bytes.length,
        originalName: fileName,
        fileId: attachment.fileId,
        fileUniqueId: attachment.fileUniqueId,
      });
      log(
        `telegram: file_ingest chat_id=${chatId} message_id=${messageId} kind=${attachment.kind} bytes=${bytes.length} path=${absolutePath}`,
      );
    } catch (err) {
      rejected.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { stored, rejected };
}

function buildAttachmentDispatchText(params: {
  cleanedText: string;
  blackboardId: string;
  files: StoredAttachment[];
  rejected: string[];
}): string {
  const task = params.cleanedText || "Please analyze the attached file(s).";
  const lines = [
    "user attached file:",
    `blackboard entry id: ${params.blackboardId}`,
    ...params.files.map(
      (f, i) =>
        `${i + 1}. ${f.originalName} (${f.mimeType}, ${formatBytes(f.sizeBytes)}) at state/${f.statePath}`,
    ),
  ];
  if (params.rejected.length > 0) {
    lines.push(`skipped files: ${params.rejected.join("; ")}`);
  }
  return `${task}\n\n${lines.join("\n")}`;
}

async function buildUserContentPartsWithInlineImages(params: {
  dispatchText: string;
  files: StoredAttachment[];
  maxInlineImages: number;
  maxInlineImageBytes: number;
  log: (msg: string) => void;
}): Promise<{ parts: ChatUserContentPart[]; inlineImagesAdded: number; inlineImagesSkipped: number }> {
  const parts: ChatUserContentPart[] = [{ type: "text", text: params.dispatchText }];
  let inlineImagesAdded = 0;
  let inlineImagesSkipped = 0;
  if (params.maxInlineImages <= 0) return { parts, inlineImagesAdded, inlineImagesSkipped };

  for (const file of params.files) {
    if (!isImageMimeType(file.mimeType)) continue;
    if (!isOpenRouterInlineImageMimeType(file.mimeType)) {
      inlineImagesSkipped += 1;
      params.log(`telegram: inline_image_skip path=${file.absolutePath} reason=unsupported_mime mime=${file.mimeType}`);
      continue;
    }
    if (inlineImagesAdded >= params.maxInlineImages) {
      inlineImagesSkipped += 1;
      continue;
    }
    if (file.sizeBytes > params.maxInlineImageBytes) {
      inlineImagesSkipped += 1;
      continue;
    }

    try {
      const bytes = await fs.readFile(file.absolutePath);
      if (bytes.length > params.maxInlineImageBytes) {
        inlineImagesSkipped += 1;
        continue;
      }
      const dataUrl = `data:${file.mimeType};base64,${bytes.toString("base64")}`;
      parts.push({ type: "image_url", image_url: { url: dataUrl } });
      inlineImagesAdded += 1;
    } catch (err) {
      inlineImagesSkipped += 1;
      params.log(`telegram: inline_image_skip path=${file.absolutePath} reason=${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (inlineImagesSkipped > 0) {
    const summary = `\n\n[media note] ${inlineImagesSkipped} image(s) were not inlined due to limits; use file paths from blackboard if needed.`;
    const textPart = parts[0];
    if (textPart?.type === "text") {
      textPart.text += summary;
    } else {
      parts.unshift({ type: "text", text: summary.trim() });
    }
  }

  return { parts, inlineImagesAdded, inlineImagesSkipped };
}

function writeTelegramUploadBlackboardEntry(params: {
  db: NexusDatabase;
  chatId: number;
  userId: number;
  messageId: number;
  sessionId: string;
  agentId: string;
  nowMs: number;
  ttlMs: number;
  captionText: string;
  files: StoredAttachment[];
}): string {
  const {
    db, chatId, userId, messageId, sessionId, agentId, nowMs, ttlMs, captionText, files,
  } = params;
  const id = crypto.randomUUID();
  const expiresAt = nowMs + ttlMs;
  const title = `Telegram upload from ${userId} (${files.length} file${files.length === 1 ? "" : "s"})`;
  const contentLines = [
    `Telegram upload from user ${userId} in chat ${chatId}.`,
    captionText ? `Caption: ${captionText}` : "Caption: (none)",
    "Files:",
    ...files.map(
      (f, i) => `${i + 1}. ${f.originalName} (${f.mimeType}, ${formatBytes(f.sizeBytes)}) at state/${f.statePath}`,
    ),
  ];
  const attachments = files.map((f) => ({
    path: f.absolutePath,
    mimeType: f.mimeType,
    statePath: f.statePath,
    filename: f.originalName,
    sizeBytes: f.sizeBytes,
    kind: f.kind,
    telegramFileId: f.fileId,
    telegramFileUniqueId: f.fileUniqueId,
  }));
  const metadata = {
    source: "telegram_upload",
    chatId,
    userId,
    messageId,
    fileCount: files.length,
    ttlMs,
    origin: {
      sessionId,
      channel: "telegram",
      channelKey: String(chatId),
      agentId,
    },
  };

  db.db
    .prepare(
      `INSERT INTO blackboard (id, session_scope, type, agent_id, agent_preset, title, content, attachments_json, metadata_json, created_at, last_accessed_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      "global",
      "artifact",
      agentId,
      "telegram-upload",
      title,
      contentLines.join("\n"),
      JSON.stringify(attachments),
      JSON.stringify(metadata),
      nowMs,
      nowMs,
      expiresAt,
    );

  return id;
}

type TelegramStreamPreviewMode = "message";

type TelegramStreamPreviewState = {
  mode: TelegramStreamPreviewMode;
  failed: boolean;
  hadPreview: boolean;
  toolSummaryText: string;
  messageId?: number;
  rateLimitedUntilMs?: number;
  retryAfterMs?: number;
};

type TelegramStreamPreview = {
  onTextDelta: (delta: string) => void;
  onToolStart: (name: string, preview: string) => void;
  onToolEnd: (name: string) => void;
  flush: () => Promise<void>;
  finish: () => Promise<void>;
  clear: () => Promise<void>;
  state: () => TelegramStreamPreviewState;
};

const TELEGRAM_TOOL_SUMMARY_MAX_ENTRIES = 16;
const TELEGRAM_TOOL_SUMMARY_PREVIEW_MAX_CHARS = 160;

function compactTelegramToolPreview(preview: string): string {
  const compact = preview.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (compact.length <= TELEGRAM_TOOL_SUMMARY_PREVIEW_MAX_CHARS) return compact;
  return `${compact.slice(0, TELEGRAM_TOOL_SUMMARY_PREVIEW_MAX_CHARS - 12)}...(+${compact.length - (TELEGRAM_TOOL_SUMMARY_PREVIEW_MAX_CHARS - 12)} chars)`;
}

function buildTelegramToolSummaryText(entries: Array<{ name: string; preview: string }>, omittedCount: number): string {
  if (entries.length === 0) return "";
  const lines = ["Tool activity:"];
  for (const entry of entries) {
    lines.push(entry.preview ? `- ${entry.name}: ${entry.preview}` : `- ${entry.name}`);
  }
  if (omittedCount > 0) {
    lines.push(`- (+${omittedCount} more tool calls)`);
  }
  return lines.join("\n");
}

export function mergeTelegramFinalTextWithToolSummary(finalText: string, toolSummaryText: string): string {
  const summary = toolSummaryText.trim();
  const body = finalText.trim();
  if (!summary) return body;
  if (!body) return summary;
  return `${summary}\n\n${body}`;
}

export function createTelegramStreamPreview(params: {
  api: Bot["api"];
  chatId: number;
  messageThreadId?: number;
  throttleMs?: number;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}): TelegramStreamPreview {
  const configuredThrottleMs = Math.max(200, Math.floor(params.throttleMs ?? TELEGRAM_STREAM_PREVIEW_THROTTLE_MS));
  const threadParams =
    typeof params.messageThreadId === "number"
      ? ({ message_thread_id: params.messageThreadId } as const)
      : undefined;

  const mode: TelegramStreamPreviewMode = "message";

  let textBuffer = "";
  let lastSentText = "";
  let previewMessageId: number | undefined;
  let failed = false;
  let hadPreview = false;
  let rateLimitedUntilMs: number | undefined;
  let lastRateLimitRetryAfterMs: number | undefined;
  let pending = false;
  let ending = false;
  // True while we're deferred behind a rate-limit cooldown; the recovery
  // flushTimer will pick up the buffered text once it fires. We treat this
  // as "idle for the purposes of flush()" so a mid-stream flush() called
  // during cooldown doesn't hang — it just returns with pending still set,
  // and the cooldown timer takes care of delivery.
  let inCooldown = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;
  // Bounds how many times the mid-stream recovery path can re-fire and 429
  // again before we give up on the preview entirely. Prevents infinite
  // recovery loops when Telegram keeps the chat in flood-wait.
  const MAX_CONSECUTIVE_RATE_LIMIT_ATTEMPTS = 3;
  let consecutiveRateLimitedAttempts = 0;
  const toolSummaryEntries: Array<{ name: string; preview: string }> = [];
  let omittedToolSummaryEntries = 0;
  const idleWaiters: Array<() => void> = [];

  const resolveIdleWaiters = () => {
    if (flushing) return;
    if (pending && !inCooldown) return;
    const waiters = idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  };

  const sendViaMessageTransport = async (nextText: string) => {
    if (typeof previewMessageId === "number") {
      try {
        await callTelegramApiWithRateLimit(
          () => params.api.editMessageText(params.chatId, previewMessageId!, nextText),
          {
            chatId: params.chatId,
            action: "editMessageText",
            log: params.log,
            maxAttempts: 1,
          },
        );
      } catch (err) {
        if (!isMessageNotModifiedError(err)) {
          throw err;
        }
      }
      hadPreview = true;
      return;
    }

    const sent = await callTelegramApiWithRateLimit(
      () => (threadParams
        ? params.api.sendMessage(params.chatId, nextText, threadParams)
        : params.api.sendMessage(params.chatId, nextText)),
      {
        chatId: params.chatId,
        action: "sendMessage",
        log: params.log,
        maxAttempts: 1,
      },
    );
    const sentId = sent?.message_id;
    if (typeof sentId === "number" && Number.isFinite(sentId)) {
      previewMessageId = Math.trunc(sentId);
      hadPreview = true;
    }
  };

  const sendPreviewText = async (nextText: string) => {
    await sendViaMessageTransport(nextText);
  };

  const currentThrottleMs = () => {
    return Math.max(configuredThrottleMs, TELEGRAM_STREAM_PREVIEW_MESSAGE_MIN_THROTTLE_MS);
  };

  const runFlush = async () => {
    if (flushing) return;
    flushing = true;
    try {
      while (pending && !failed) {
        pending = false;
        const nextText = textBuffer.trimEnd();
        if (!nextText || nextText === lastSentText) continue;
        if (nextText.length > TELEGRAM_STREAM_PREVIEW_MAX_CHARS) {
          params.log(
            `telegram: stream_preview_skip chat_id=${params.chatId} reason=text_too_long chars=${nextText.length}`,
          );
          continue;
        }
        // If the chat is currently rate-limited by another caller, wait the
        // remainder of that window rather than firing a doomed edit.
        const preWaitMs = telegramRateLimitWaitMs(params.chatId);
        if (preWaitMs > 0) {
          lastRateLimitRetryAfterMs = preWaitMs;
          rateLimitedUntilMs = Date.now() + preWaitMs;
          if (ending || preWaitMs >= TELEGRAM_STREAM_PREVIEW_DISABLE_RETRY_AFTER_MS) {
            failed = true;
            params.warn(
              `telegram: stream_preview_rate_limit_suspended chat_id=${params.chatId} wait_ms=${preWaitMs} ` +
              `reason=${ending ? "finish" : "long_cooldown"}`,
            );
            break;
          }
          params.log(`telegram: stream_preview_rate_limit_block chat_id=${params.chatId} wait_ms=${preWaitMs}`);
          await delay(preWaitMs);
        }
        try {
          await sendPreviewText(nextText);
          lastSentText = nextText;
          // Reset the consecutive-failure counter on success, but retain
          // lastRateLimitRetryAfterMs / rateLimitedUntilMs so the stream
          // state still reflects the most recent rate-limit hit for
          // diagnostics (cleared at clear()/finish() time).
          consecutiveRateLimitedAttempts = 0;
        } catch (err) {
          const retryAfterMs = getTelegramRetryAfterMs(err);
          if (retryAfterMs !== null) {
            lastRateLimitRetryAfterMs = retryAfterMs;
            rateLimitedUntilMs = Date.now() + retryAfterMs;
            recordTelegramRateLimit(params.chatId, retryAfterMs);
            if (ending) {
              // At finish time, don't block on a long cooldown — give up on
              // the preview gracefully. The final message will be sent fresh
              // by finalizeTelegramStreamPreviewText, which itself consults
              // the registry and waits before editing.
              failed = true;
              params.warn(
                `telegram: stream_preview_rate_limited_at_finish chat_id=${params.chatId} retry_after_ms=${retryAfterMs}`,
              );
              break;
            }
            if (retryAfterMs >= TELEGRAM_STREAM_PREVIEW_DISABLE_RETRY_AFTER_MS) {
              failed = true;
              params.warn(
                `telegram: stream_preview_rate_limit_suspended chat_id=${params.chatId} ` +
                `retry_after_ms=${retryAfterMs} reason=long_cooldown`,
              );
              break;
            }
            // Mid-stream: survive the 429. Keep the stream alive, reschedule
            // a recovery flush after the cooldown so the next batch (and any
            // intervening deltas) go out once we're allowed back in.
            consecutiveRateLimitedAttempts += 1;
            if (consecutiveRateLimitedAttempts > MAX_CONSECUTIVE_RATE_LIMIT_ATTEMPTS) {
              // The chat is in sustained flood-wait. Give up rather than
              // keep firing doomed edits forever. Finalize path will deliver
              // the response fresh once the cooldown elapses.
              failed = true;
              params.warn(
                `telegram: stream_preview_rate_limit_persistent chat_id=${params.chatId} ` +
                `attempts=${consecutiveRateLimitedAttempts} giving_up`,
              );
              break;
            }
            params.warn(
              `telegram: stream_preview_rate_limited chat_id=${params.chatId} retry_after_ms=${retryAfterMs} ` +
              `attempt=${consecutiveRateLimitedAttempts}/${MAX_CONSECUTIVE_RATE_LIMIT_ATTEMPTS} ` +
              `(stream continues; resume after cooldown)`,
            );
            pending = true;
            inCooldown = true;
            if (!flushTimer) {
              flushTimer = setTimeout(() => {
                flushTimer = null;
                inCooldown = false;
                void runFlush();
              }, retryAfterMs);
            }
            break;
          }
          failed = true;
          params.warn(`telegram: stream_preview_error chat_id=${params.chatId} ${toErrorText(err)}`);
        }
      }
    } finally {
      flushing = false;
      resolveIdleWaiters();
    }
  };

  const scheduleFlush = () => {
    if (ending || failed) return;
    pending = true;
    if (flushTimer) return;
    // When the chat is rate-limited, defer the next flush to the END of the
    // cooldown so we don't burn a wakeup just to await delay() inside
    // runFlush. Adds a tiny grace on top of the configured throttle.
    const baseDelayMs = currentThrottleMs();
    const rateLimitWaitMs = telegramRateLimitWaitMs(params.chatId);
    const delayMs = Math.max(baseDelayMs, rateLimitWaitMs);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void runFlush();
    }, delayMs);
  };

  const appendText = (delta: string) => {
    if (!delta || ending || failed) return;
    textBuffer += delta;
    scheduleFlush();
  };

  const flush = async () => {
    if (failed) return;
    pending = true;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await runFlush();
    if (pending || flushing) {
      await new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    }
  };

  const finish = async () => {
    if (ending) {
      await flush();
      return;
    }
    ending = true;
    await flush();
  };

  const clear = async () => {
    await finish();
    if (typeof previewMessageId === "number") {
      const messageId = previewMessageId;
      try {
        await callTelegramApiWithRateLimit(
          () => params.api.deleteMessage(params.chatId, messageId),
          {
            chatId: params.chatId,
            action: "deleteMessage",
            log: params.log,
            maxAttempts: 2,
          },
        );
      } catch (err) {
        params.warn(
          `telegram: stream_preview_cleanup_failed chat_id=${params.chatId} message_id=${messageId} ${toErrorText(err)}`,
        );
      }
      previewMessageId = undefined;
    }
  };

  return {
    onTextDelta: (delta) => {
      appendText(delta);
    },
    onToolStart: (name, preview) => {
      const compactPreview = compactTelegramToolPreview(preview);
      if (toolSummaryEntries.length < TELEGRAM_TOOL_SUMMARY_MAX_ENTRIES) {
        toolSummaryEntries.push({ name, preview: compactPreview });
      } else {
        omittedToolSummaryEntries += 1;
      }
      const label = preview
        ? `\n[ ${name}: ${preview} ]`
        : `\n[ ${name} ]`;
      appendText(label);
    },
    onToolEnd: () => {
      appendText("\n");
    },
    flush,
    finish,
    clear,
    state: () => ({
      mode,
      failed,
      hadPreview,
      toolSummaryText: buildTelegramToolSummaryText(toolSummaryEntries, omittedToolSummaryEntries),
      ...(typeof previewMessageId === "number" ? { messageId: previewMessageId } : {}),
      ...(typeof rateLimitedUntilMs === "number" ? { rateLimitedUntilMs } : {}),
      ...(typeof lastRateLimitRetryAfterMs === "number" ? { retryAfterMs: lastRateLimitRetryAfterMs } : {}),
    }),
  };
}

async function finalizeTelegramStreamPreviewText(params: {
  api: Bot["api"];
  chatId: number;
  messageThreadId?: number;
  text: string;
  preview: TelegramStreamPreviewState;
  log: (msg: string) => void;
}): Promise<boolean> {
  const threadParams =
    typeof params.messageThreadId === "number"
      ? ({ message_thread_id: params.messageThreadId } as const)
      : undefined;

  const chunks = splitTelegramMessage(params.text).filter((chunk) => chunk.trim().length > 0);
  if (chunks.length === 0) {
    if (params.preview.mode === "message" && typeof params.preview.messageId === "number") {
      // Keep the last preview in-place when final text is empty. This avoids
      // visible disappearance during tool hand-offs that intentionally produce
      // no final text in the same turn.
      params.log(
        `telegram: stream_finalize_keep_preview chat_id=${params.chatId} message_id=${params.preview.messageId} reason=empty_final_text`,
      );
    }
    return true;
  }

  const sendChunk = async (chunk: string) => {
    await callTelegramApiWithRateLimit(
      () => (threadParams
        ? params.api.sendMessage(params.chatId, chunk, threadParams)
        : params.api.sendMessage(params.chatId, chunk)),
      {
        chatId: params.chatId,
        action: "sendMessage",
        log: params.log,
      },
    );
  };

  if (params.preview.mode === "message" && typeof params.preview.messageId === "number") {
    const previewMessageId = params.preview.messageId;
    const firstChunk = chunks[0]!;
    try {
      await callTelegramApiWithRateLimit(
        () => params.api.editMessageText(params.chatId, previewMessageId, firstChunk),
        {
          chatId: params.chatId,
          action: "editMessageText",
          log: params.log,
        },
      );
    } catch (err) {
      if (!isMessageNotModifiedError(err)) {
        params.log(
          `telegram: stream_finalize_edit_failed chat_id=${params.chatId} message_id=${previewMessageId} ${toErrorText(err)}; replacing preview`,
        );
        try {
          await callTelegramApiWithRateLimit(
            () => params.api.deleteMessage(params.chatId, previewMessageId),
            {
              chatId: params.chatId,
              action: "deleteMessage",
              log: params.log,
              maxAttempts: 2,
            },
          );
        } catch {
          // ignore delete failure
        }
        for (const chunk of chunks) {
          await sendChunk(chunk);
        }
        return true;
      }
    }

    for (const chunk of chunks.slice(1)) {
      await sendChunk(chunk);
    }
    return true;
  }

  try {
    for (const chunk of chunks) {
      await sendChunk(chunk);
    }
    return true;
  } catch (err) {
    params.log(`telegram: stream_finalize_send_failed chat_id=${params.chatId} ${toErrorText(err)}`);
    return false;
  }
}

export async function startTelegramBot(deps: {
  config: NexusConfig;
  agent: AgentService;
  configPath: string;
  stateDir: string;
  candidateRootDir: string;
  db: NexusDatabase;
  app: Hono;
  onPreDispatchCommand?: (params: {
    channel: "telegram";
    channelKey: string;
    agentId: string;
    sessionId: string;
    text: string;
    actorId: number;
    nowMs: number;
  }) => Promise<string | null>;
  log: (msg: string) => void;
}): Promise<{
  stop: () => Promise<void>;
  sendOutput: (chatId: number, output: string) => Promise<void>;
  sendFile: (chatId: number, filePath: string, options?: { caption?: string }) => Promise<void>;
} | null> {
  const tg = deps.config.channels.telegram;
  if (!tg.enabled) return null;
  const token = tg.token && !isEnvPlaceholder(tg.token) ? tg.token : getSecret("TELEGRAM_BOT_TOKEN");
  if (!token) {
    deps.log("WARN telegram enabled but no token available (TELEGRAM_BOT_TOKEN not resolved); skipping");
    return null;
  }

  const bot = new Bot<Context>(token);
  const me = await bot.api.getMe();
  const botUsername = me.username ?? "";
  const allowAllUsers = process.env.NEXUS_TELEGRAM_ALLOW_ALL === "1";
  const allowFrom = tg.allowFrom ?? [];
  const streamingEnabled = tg.streaming.enabled;
  const streamingSerializePerChat = tg.streaming.serializePerChat;
  const streamingMaxConcurrentPerChat = Math.max(1, Math.floor(tg.streaming.maxConcurrentPerChat));
  const streamingPreviewTransport = tg.streaming.previewTransport;
  const streamingFallbackToSendOutput = tg.streaming.fallbackToSendOutput;
  const streamingEmitFallbackNotice = tg.streaming.emitFallbackNotice;
  const streamSemaphores = new Map<number, Semaphore>();
  const withChatStreamLock = async <T>(chatId: number, fn: () => Promise<T>): Promise<T> => {
    if (!streamingSerializePerChat) return await fn();
    let sem = streamSemaphores.get(chatId);
    if (!sem) {
      sem = new Semaphore(streamingMaxConcurrentPerChat);
      streamSemaphores.set(chatId, sem);
    }
    return await sem.withLock(fn);
  };
  const stateDir = process.env.NEXUS_STATE_DIR ?? "/data/nexus";
  const maxInboundFilesPerMessage = envInt("NEXUS_TELEGRAM_MAX_INBOUND_FILES_PER_MESSAGE", DEFAULT_MAX_INBOUND_FILES_PER_MESSAGE, {
    min: 1,
    max: 20,
  });
  const maxInboundFileBytes = envInt("NEXUS_TELEGRAM_MAX_INBOUND_FILE_BYTES", DEFAULT_MAX_INBOUND_FILE_BYTES, {
    min: 256 * 1024,
    max: 200 * 1024 * 1024,
  });
  const fileBlackboardTtlMs = envInt("NEXUS_TELEGRAM_FILE_BLACKBOARD_TTL_MS", DEFAULT_FILE_BLACKBOARD_TTL_MS, {
    min: 60_000,
    max: 180 * 24 * 60 * 60_000,
  });
  const maxInlineImagesForLlm = envInt("NEXUS_TELEGRAM_LLM_MAX_INLINE_IMAGES", DEFAULT_MAX_INLINE_IMAGES_FOR_LLM, {
    min: 0,
    max: 12,
  });
  const maxInlineImageBytesForLlm = envInt(
    "NEXUS_TELEGRAM_LLM_MAX_INLINE_IMAGE_BYTES",
    DEFAULT_MAX_INLINE_IMAGE_BYTES_FOR_LLM,
    {
      min: 64 * 1024,
      max: 32 * 1024 * 1024,
    },
  );

  deps.log(`telegram: bot @${botUsername || me.id} starting`);
  deps.log(`telegram: auth allow_all=${allowAllUsers} allow_from_count=${allowFrom.length} pairing=${tg.pairing.enabled}`);
  deps.log(
    `telegram: streaming enabled=${streamingEnabled} serialize_per_chat=${streamingSerializePerChat} max_per_chat=${streamingMaxConcurrentPerChat} preview_transport=${streamingPreviewTransport} fallback_send_output=${streamingFallbackToSendOutput}`,
  );
  deps.log(
    `telegram: file_io max_files_per_msg=${maxInboundFilesPerMessage} max_file_bytes=${maxInboundFileBytes} blackboard_ttl_ms=${fileBlackboardTtlMs}`,
  );
  deps.log(
    `telegram: llm_media max_inline_images=${maxInlineImagesForLlm} max_inline_image_bytes=${maxInlineImageBytesForLlm}`,
  );
  if (allowAllUsers) deps.log("telegram: WARN allow_all is enabled; any Telegram user can reach the agent.");
  if (allowFrom.length === 0 && !allowAllUsers && !tg.pairing.enabled) {
    deps.log("telegram: WARN no static allowlist and pairing is disabled; no users can authenticate.");
  }
  await syncTelegramCommands({
    bot,
    pairingEnabled: tg.pairing.enabled,
    log: deps.log,
  });

  const sendFile = async (
    chatId: number,
    filePath: string,
    options?: { caption?: string; messageThreadId?: number },
  ): Promise<void> => {
    const absolute = path.resolve(filePath);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error(`not a file: ${absolute}`);
    const mimeType = detectMimeType(absolute);
    deps.log(`telegram: send_file chat_id=${chatId} mime=${mimeType} bytes=${stat.size} path=${absolute}`);
    // Telegram sendPhoto only supports JPEG, PNG, and GIF (≤10 MB).
    // Other image formats (SVG, WebP, BMP, TIFF, etc.) must go through
    // sendDocument so Telegram receives them as file attachments.
    const TELEGRAM_PHOTO_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif"]);
    if (TELEGRAM_PHOTO_MIME_TYPES.has(mimeType)) {
      try {
        await callTelegramApiWithRateLimit(
          () => bot.api.sendPhoto(chatId, new InputFile(absolute), {
            caption: options?.caption,
            ...(typeof options?.messageThreadId === "number" ? { message_thread_id: options.messageThreadId } : {}),
          }),
          {
            chatId,
            action: "sendPhoto",
            log: deps.log,
          },
        );
        return;
      } catch (err) {
        if (getTelegramRetryAfterMs(err) !== null) throw err;
        // Some valid images still fail Telegram's photo pipeline (dimension/encoding quirks).
        // Fall back to sendDocument so the user still receives the file.
        deps.log(
          `telegram: sendPhoto failed chat_id=${chatId} path=${absolute} error=${err instanceof Error ? err.message : String(err)}; falling back to sendDocument`,
        );
      }
    }
    await callTelegramApiWithRateLimit(
      () => bot.api.sendDocument(chatId, new InputFile(absolute), {
        caption: options?.caption,
        ...(typeof options?.messageThreadId === "number" ? { message_thread_id: options.messageThreadId } : {}),
      }),
      {
        chatId,
        action: "sendDocument",
        log: deps.log,
      },
    );
  };

  const sendOutput = async (chatId: number, output: string, options?: { messageThreadId?: number }): Promise<void> => {
    if (!output || output.trim().length === 0) {
      deps.log(`telegram: send chat_id=${chatId} skipped (empty output)`);
      return;
    }
    const extracted = await extractTelegramImageAttachments(output);
    const chunks = splitTelegramMessage(extracted.text);
    deps.log(`telegram: send chat_id=${chatId} chunks=${chunks.length} images=${extracted.imagePaths.length} chars=${output.length}`);

    // One-tap quick responses: when the outgoing text references pending
    // confirm-kind human actions (approvals etc.), attach an inline keyboard
    // to the final chunk so the user doesn't have to type /act <id> <answer>.
    let quickResponseKeyboard: { inline_keyboard: { text: string; callback_data: string }[][] } | null = null;
    try {
      const pendingActions = listPendingConfirmActionsInText(deps.db, extracted.text, Date.now());
      if (pendingActions.length > 0) {
        const keyboardRows: { text: string; callback_data: string }[][] = [];
        for (const action of pendingActions) {
          const responses = quickResponsesForHumanAction(action);
          if (!responses) continue;
          keyboardRows.push(responses.map((option) => ({
            text: pendingActions.length > 1 ? `${option.label} ${action.id}` : option.label,
            callback_data: encodeQuickResponseCallback(action.id, option.response),
          })));
        }
        if (keyboardRows.length > 0) quickResponseKeyboard = { inline_keyboard: keyboardRows };
      }
    } catch (err) {
      deps.log(`telegram: quick-response keyboard skipped: ${toErrorText(err)}`);
    }

    const lastChunkIndex = (() => {
      for (let i = chunks.length - 1; i >= 0; i -= 1) {
        if ((chunks[i] ?? "").trim().length > 0) return i;
      }
      return -1;
    })();
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i] ?? "";
      if (chunk.trim().length === 0) continue;
      const withKeyboard = i === lastChunkIndex && quickResponseKeyboard !== null;
      await callTelegramApiWithRateLimit(
        () => bot.api.sendMessage(chatId, chunk, {
          ...(typeof options?.messageThreadId === "number" ? { message_thread_id: options.messageThreadId } : {}),
          ...(withKeyboard ? { reply_markup: quickResponseKeyboard! } : {}),
        }),
        {
          chatId,
          action: "sendMessage",
          log: deps.log,
        },
      );
    }
    for (const img of extracted.imagePaths) {
      try {
        await sendFile(chatId, img, {
          caption: path.basename(img),
          messageThreadId: options?.messageThreadId,
        });
      } catch (err) {
        deps.log(`telegram: failed to send image ${img}: ${err instanceof Error ? err.message : String(err)}`);
        await callTelegramApiWithRateLimit(
          () => bot.api.sendMessage(chatId, `(failed to attach image: ${path.basename(img)})`, {
            ...(typeof options?.messageThreadId === "number" ? { message_thread_id: options.messageThreadId } : {}),
          }),
          {
            chatId,
            action: "sendMessage",
            log: deps.log,
          },
        );
      }
    }
  };

  const sendTypingAction = async (
    chatId: number,
    options?: { messageThreadId?: number },
  ): Promise<void> => {
    const waitMs = telegramRateLimitWaitMs(chatId);
    if (waitMs > 0) {
      deps.log(`telegram: chat_action_suppressed chat_id=${chatId} action=typing wait_ms=${waitMs}`);
      return;
    }
    try {
      await callTelegramApiWithRateLimit(
        () => bot.api.sendChatAction(chatId, "typing", {
          ...(typeof options?.messageThreadId === "number" ? { message_thread_id: options.messageThreadId } : {}),
        }),
        {
          chatId,
          action: "sendChatAction",
          log: deps.log,
          maxAttempts: 1,
        },
      );
    } catch (err) {
      const retryAfterMs = getTelegramRetryAfterMs(err);
      if (retryAfterMs !== null) {
        deps.log(`telegram: chat_action_rate_limited chat_id=${chatId} retry_after_ms=${retryAfterMs}`);
        return;
      }
      deps.log(`telegram: chat_action_failed chat_id=${chatId} ${toErrorText(err)}`);
    }
  };

  // One-tap quick responses for pending human actions (inline keyboard
  // attached by sendOutput). Same auth gate and fulfillment path as /act.
  bot.on("callback_query:data", async (ctx) => {
    try {
      const decoded = decodeQuickResponseCallback(ctx.callbackQuery.data ?? "");
      if (!decoded) {
        await ctx.answerCallbackQuery({ text: "Unsupported action." });
        return;
      }
      const userId = parseTelegramNumericId(ctx.from?.id);
      const chatId = parseTelegramNumericId(ctx.callbackQuery.message?.chat?.id);
      const messageThreadId = resolveTelegramMessageThreadId(ctx.callbackQuery.message);
      if (!userId || chatId === null) {
        await ctx.answerCallbackQuery({ text: "Cannot identify sender." });
        return;
      }
      const allowed = isTelegramUserAllowed(deps.db, {
        userId,
        staticAllowFrom: allowFrom,
        allowAll: allowAllUsers,
      });
      if (!allowed) {
        deps.log(`telegram: callback ignore user_id=${userId} reason=not_allowlisted`);
        await ctx.answerCallbackQuery({ text: "Not authorized." });
        return;
      }

      deps.log(`telegram: callback user_id=${userId} id=${decoded.id} response=${decoded.response}`);
      const actionRes = await fulfillHumanActionWithSync({
        db: deps.db,
        id: decoded.id,
        responseText: decoded.response,
        respondedByChannel: "telegram",
        respondedByKey: String(userId),
        candidateRootDir: deps.candidateRootDir,
        nowMs: Date.now(),
        log: deps.log,
      });
      if (!actionRes.ok) {
        await ctx.answerCallbackQuery({ text: `Unable to record (${actionRes.error ?? "unknown"}).` });
        return;
      }
      await ctx.answerCallbackQuery({ text: `Recorded: ${decoded.response}` });
      // Drop the keyboard so the choice can't be re-tapped; non-fatal if the
      // message is too old to edit.
      try {
        await ctx.editMessageReplyMarkup();
      } catch {
        // ignore
      }
      await sendOutput(chatId, `OK: recorded ${decoded.response} for ${decoded.id}.`, { messageThreadId });
      if (actionRes.deployFulfillmentMessage) {
        await sendOutput(chatId, actionRes.deployFulfillmentMessage, { messageThreadId });
        return;
      }
      const res = await deps.agent.handleUserMessage({
        channel: "telegram",
        channelKey: String(chatId),
        agentId: tg.agentId,
        text: `Human action ${decoded.id} is fulfilled.`,
      });
      await deps.agent.withTelegramDeliveryAck(
        { chatId, runId: res.runId, sessionId: res.sessionId, agentId: tg.agentId },
        () => sendOutput(chatId, res.output, { messageThreadId }),
      );
    } catch (err) {
      deps.log(`telegram: callback error ${toErrorText(err)}`);
      try {
        await ctx.answerCallbackQuery({ text: "Something went wrong recording the response." });
      } catch {
        // ignore
      }
    }
  });

  bot.on("message", async (ctx) => {
    try {
      const message = (ctx.message ?? {}) as unknown as Record<string, unknown>;
      const text = typeof (message as { text?: unknown }).text === "string" ? String((message as { text?: unknown }).text) : "";
      const caption =
        typeof (message as { caption?: unknown }).caption === "string" ? String((message as { caption?: unknown }).caption) : "";
      const rawInputText = text || caption;
      const entitiesRaw = text
        ? ((message as { entities?: unknown }).entities ?? [])
        : ((message as { caption_entities?: unknown }).caption_entities ?? []);
      const entities = Array.isArray(entitiesRaw) ? (entitiesRaw as TelegramMessageEntity[]) : [];
      const userId = parseTelegramNumericId(ctx.from?.id);
      const chatId = parseTelegramNumericId(ctx.chat?.id);
      const senderChatRaw = (message as { sender_chat?: unknown }).sender_chat;
      const senderChat = senderChatRaw && typeof senderChatRaw === "object" ? (senderChatRaw as TelegramSenderChat) : null;
      const senderChatId = parseTelegramNumericId(senderChat?.id);
      const senderChatType = typeof senderChat?.type === "string" ? senderChat.type : "unknown";
      const actorId = userId ?? senderChatId;
      const actorKind = userId ? "user" : senderChatId !== null ? `sender_chat:${senderChatType}` : "unknown";
      const mentioned = hasBotMentionEntity(rawInputText, entities, botUsername, me.id)
        || hasBotMentionText(rawInputText, botUsername);
      const invoked = isNexusInvocation(rawInputText, botUsername);
      const messageId = typeof (message as { message_id?: unknown }).message_id === "number"
        ? Number((message as { message_id?: unknown }).message_id)
        : Date.now();
      if (!chatId) return;
      const reply = (output: string) => sendOutput(chatId, output, { messageThreadId: resolveMessageThreadId(ctx) });
      if (actorId === null) {
        deps.log(`telegram: ignore chat_id=${chatId} reason=missing_sender_identity`);
        if (isGroupChat(ctx) && tg.requireMentionInGroups && (mentioned || invoked)) {
          await reply(
            "I can't identify this sender in the group message. Send as your personal account (not anonymous/send-as-chat) and try again.",
          );
        }
        return;
      }
      deps.log(`telegram: msg actor_id=${actorId} actor_kind=${actorKind} chat_id=${chatId} kind=${ctx.chat?.type ?? "unknown"}`);

      const allowed = isTelegramUserAllowed(deps.db, {
        userId: actorId,
        staticAllowFrom: allowFrom,
        allowAll: allowAllUsers,
      });
      if (!allowed) {
        deps.log(`telegram: ignore actor_id=${actorId} reason=not_allowlisted pairing=${tg.pairing.enabled ? "on" : "off"}`);
        if (!userId && senderChatId !== null && isGroupChat(ctx)) {
          await reply(
            [
              "I can't authenticate anonymous/send-as-chat group messages by user allowlist.",
              "Send as your personal account, or ask the operator to allowlist this group chat id:",
              String(chatId),
            ].join("\n"),
          );
          return;
        }
        if (!userId) {
          await reply("Unable to authenticate this Telegram sender. Please DM this bot from your personal account and send /pair.");
          return;
        }
        if (tg.pairing.enabled && !isGroupChat(ctx)) {
          if (!isPairInvocation(rawInputText, botUsername)) {
            await reply("Pairing required. Send /pair in this DM to request a pairing code.");
            return;
          }
          const nowMs = Date.now();
          const req = createPairingRequest(deps.db, {
            channel: "telegram",
            senderKey: String(userId),
            nowMs,
            ttlMs: tg.pairing.codeTtlMs,
            maxPending: tg.pairing.maxPending,
          });
          if (req.status === "created") {
            const ttlMinutes = Math.max(1, Math.ceil((req.expiresAt - nowMs) / 60_000));
            deps.log(`telegram: pairing request user_id=${userId} code=${req.code}`);
            await reply(
              [
                "Pairing required.",
                "",
                `Your pairing code: ${req.code}`,
                `Expires in about ${ttlMinutes} minute(s).`,
                "",
                "Ask the operator to approve it on the host running Nexus:",
                `nexus pairing approve telegram ${req.code}`,
                "",
                "Your messages will be ignored until approved.",
              ].join("\n"),
            );
          } else if (req.status === "already_pending") {
            const ttlMinutes = Math.max(1, Math.ceil((req.expiresAt - nowMs) / 60_000));
            deps.log(`telegram: pairing request already pending user_id=${userId} code=${req.code}`);
            await reply(
              [
                "Pairing is still pending.",
                "",
                `Your existing pairing code: ${req.code}`,
                `Expires in about ${ttlMinutes} minute(s).`,
                "",
                "Ask the operator to approve it on the host running Nexus:",
                `nexus pairing approve telegram ${req.code}`,
              ].join("\n"),
            );
          } else if (req.status === "max_pending") {
            deps.log(`telegram: pairing request not created user_id=${userId} reason=max_pending`);
            await reply("Pairing queue is full right now. Please try again in a few minutes.");
          } else {
            deps.log(`telegram: pairing request not created user_id=${userId} reason=${req.reason}`);
            await reply("Unable to issue a pairing code right now. Please try again shortly.");
          }
          return;
        }

        if (tg.pairing.enabled && isGroupChat(ctx)) {
          deps.log(`telegram: pairing request rejected user_id=${userId} reason=group_chat`);
          await reply("Pairing is only supported in private chat. Please DM this bot and send /pair.");
        } else {
          await reply("You are not allowlisted for this bot.");
        }
        return;
      }

      if (/^\/sethome\b/i.test(text.trim())) {
        setHomeSession({
          db: deps.db,
          agentId: tg.agentId,
          channel: "telegram",
          channelKey: String(chatId),
          nowMs: Date.now(),
        });
        deps.log(`telegram: sethome agent=${tg.agentId} chat_id=${chatId}`);
        await reply("OK: this chat is now the home session for background events.");
        return;
      }

      if (/^\/unsethome\b/i.test(text.trim())) {
        clearHomeSession({ db: deps.db, agentId: tg.agentId });
        deps.log(`telegram: unsethome agent=${tg.agentId}`);
        await reply("OK: home session cleared. Background events will target the most recent chat.");
        return;
      }

      if (/^\/(act|action)\b/i.test(text.trim())) {
        if (!userId) {
          await reply("Action responses must come from a personal Telegram account (not anonymous/send-as-chat).");
          return;
        }
        const parts = text.trim().split(/\s+/);
        const id = parts[1] ?? "";
        const response = parts.slice(2).join(" ").trim();
        if (!id || !response) {
          await reply("Usage: /act <ID> <response>");
          return;
        }

        deps.log(`telegram: act user_id=${userId} id=${id} response_chars=${response.length}`);
        const actionRes = await fulfillHumanActionWithSync({
          db: deps.db,
          id,
          responseText: response,
          respondedByChannel: "telegram",
          respondedByKey: String(userId),
          candidateRootDir: deps.candidateRootDir,
          nowMs: Date.now(),
          log: deps.log,
        });
        if (!actionRes.ok) {
          await reply(`ERROR: unable to record action (${actionRes.error ?? "unknown"})`);
          return;
        }

        await reply(`OK: recorded action ${id}`);
        const actionMessageThreadId = resolveMessageThreadId(ctx);
        if (actionRes.deployFulfillmentMessage) {
          await sendOutput(chatId, actionRes.deployFulfillmentMessage, { messageThreadId: actionMessageThreadId });
          return;
        }
        const res = await deps.agent.handleUserMessage({
          channel: "telegram",
          channelKey: String(chatId),
          agentId: tg.agentId,
          text: `Human action ${id} is fulfilled.`,
        });
        await deps.agent.withTelegramDeliveryAck(
          { chatId, runId: res.runId, sessionId: res.sessionId, agentId: tg.agentId },
          () => sendOutput(chatId, res.output, { messageThreadId: actionMessageThreadId }),
        );
        return;
      }

      if (isGroupChat(ctx) && tg.requireMentionInGroups) {
        if (!mentioned && !invoked) {
          deps.log(`telegram: ignore actor_id=${actorId} chat_id=${chatId} reason=require_mention`);
          return;
        }
      }

      if (deps.onPreDispatchCommand) {
        const nowMs = Date.now();
        const sessionId = getOrCreateSessionId({
          db: deps.db,
          channel: "telegram",
          channelKey: String(chatId),
          agentId: tg.agentId,
          nowMs,
        });
        const intercepted = await deps.onPreDispatchCommand({
          channel: "telegram",
          channelKey: String(chatId),
          agentId: tg.agentId,
          sessionId,
          text: rawInputText,
          actorId,
          nowMs,
        });
        if (intercepted !== null) {
          await sendOutput(chatId, intercepted);
          return;
        }
      }

      const cleanedText = sanitizeMessageText(rawInputText, botUsername);
      const incomingAttachments = collectIncomingAttachments(message);
      if (incomingAttachments.length > maxInboundFilesPerMessage) {
        await reply(`Too many attachments in one message. Max ${maxInboundFilesPerMessage} files per message.`);
        return;
      }

      let dispatchText = cleanedText;
      let storedFiles: StoredAttachment[] = [];
      if (incomingAttachments.length > 0) {
        const nowMs = Date.now();
        const ingest = await ingestIncomingAttachments({
          bot,
          token,
          stateDir,
          chatId,
          messageId,
          nowMs,
          maxFileBytes: maxInboundFileBytes,
          attachments: incomingAttachments,
          log: deps.log,
        });

        if (ingest.stored.length === 0) {
          await reply(`Unable to ingest attached files: ${ingest.rejected.join("; ") || "unknown error"}`);
          return;
        }

        const sessionId = getOrCreateSessionId({
          db: deps.db,
          channel: "telegram",
          channelKey: String(chatId),
          agentId: tg.agentId,
          nowMs,
        });
        const blackboardId = writeTelegramUploadBlackboardEntry({
          db: deps.db,
          chatId,
          userId: actorId,
          messageId,
          sessionId,
          agentId: tg.agentId,
          nowMs,
          ttlMs: fileBlackboardTtlMs,
          captionText: cleanedText,
          files: ingest.stored,
        });
        deps.log(
          `telegram: blackboard upload id=${blackboardId} actor_id=${actorId} chat_id=${chatId} files=${ingest.stored.length}`,
        );

        if (ingest.rejected.length > 0) {
          await reply(`Processed ${ingest.stored.length} file(s), skipped ${ingest.rejected.length}: ${ingest.rejected.join("; ")}`);
        }

        dispatchText = buildAttachmentDispatchText({
          cleanedText,
          blackboardId,
          files: ingest.stored,
          rejected: ingest.rejected,
        });
        storedFiles = ingest.stored;
      }

      if (!dispatchText.trim()) {
        deps.log(`telegram: ignore actor_id=${actorId} chat_id=${chatId} reason=empty_text`);
        return;
      }

      let contentParts: ChatUserContentPart[] | undefined;
      if (storedFiles.length > 0) {
        const media = await buildUserContentPartsWithInlineImages({
          dispatchText,
          files: storedFiles,
          maxInlineImages: maxInlineImagesForLlm,
          maxInlineImageBytes: maxInlineImageBytesForLlm,
          log: deps.log,
        });
        if (media.inlineImagesAdded > 0) {
          contentParts = media.parts;
          deps.log(
            `telegram: dispatch_media chat_id=${chatId} inline_images=${media.inlineImagesAdded} skipped=${media.inlineImagesSkipped}`,
          );
        } else if (media.inlineImagesSkipped > 0) {
          deps.log(`telegram: dispatch_media chat_id=${chatId} inline_images=0 skipped=${media.inlineImagesSkipped}`);
        }
      }

      deps.log(
        `telegram: dispatch chat_id=${chatId} actor_id=${actorId} agent=${tg.agentId} chars=${dispatchText.length} media_parts=${contentParts ? contentParts.length : 0}`,
      );

      const isPrivateChat = ctx.chat?.type === "private";
      const messageThreadId = resolveMessageThreadId(ctx);

      if (streamingEnabled && isPrivateChat) {
        await withChatStreamLock(chatId, async () => {
          // --- Streaming path: throttled message preview updates ---
          // Show typing while waiting for first tokens and during tool gaps.
          let typingTimer: ReturnType<typeof setInterval> | null = null;
          let lastTypingSentMs = 0;
          const TYPING_COALESCE_MS = 2_000;
          const sendTypingNow = () => {
            lastTypingSentMs = Date.now();
            void sendTypingAction(chatId, { messageThreadId });
          };
          const startTyping = () => {
            if (typingTimer) return;
            // Telegram's typing indicator persists ~5s after the last send.
            // If we just stopped less than TYPING_COALESCE_MS ago (e.g. tool
            // ended → text streamed → stopTyping → next tool call → startTyping),
            // skip the immediate send and let the 4s interval take over —
            // the user still sees an unbroken indicator. Without this, a
            // 50-tool-call run produces 50+ extra sendChatAction round-trips.
            if (Date.now() - lastTypingSentMs >= TYPING_COALESCE_MS) {
              sendTypingNow();
            }
            typingTimer = setInterval(sendTypingNow, 4_000);
          };
          const stopTyping = () => {
            if (!typingTimer) return;
            clearInterval(typingTimer);
            typingTimer = null;
          };
          startTyping();

          const streamPreview = createTelegramStreamPreview({
            api: bot.api,
            chatId,
            messageThreadId,
            throttleMs: tg.streaming.previewThrottleMs,
            log: deps.log,
            warn: deps.log,
          });

          deps.log(
            `telegram: stream_start chat_id=${chatId} preview_mode=${streamPreview.state().mode} thread_id=${typeof messageThreadId === "number" ? messageThreadId : "none"}`,
          );

          let res: Awaited<ReturnType<typeof deps.agent.handleUserMessage>>;
          try {
            res = await deps.agent.handleUserMessage({
              channel: "telegram",
              channelKey: String(chatId),
              agentId: tg.agentId,
              text: dispatchText,
              contentParts,
              onTextDelta: (delta) => { stopTyping(); streamPreview.onTextDelta(delta); },
              onToolStart: (name, preview) => { streamPreview.onToolStart(name, preview); startTyping(); },
              onToolEnd: streamPreview.onToolEnd,
            });
          } finally {
            stopTyping();
            await streamPreview.finish();
          }

          await deps.agent.withTelegramDeliveryAck(
            { chatId, runId: res.runId, sessionId: res.sessionId, agentId: tg.agentId },
            async () => {
              const previewState = streamPreview.state();
              if (previewState.failed) {
                deps.log(
                  `telegram: stream_error chat_id=${chatId} preview_transport=${previewState.mode}`,
                );
              }

              const extracted = await extractTelegramImageAttachments(res.output);
              const rateLimitedPreviewCanFinalize =
                previewState.failed
                && typeof previewState.rateLimitedUntilMs === "number"
                && previewState.mode === "message"
                && typeof previewState.messageId === "number";
              const shouldFallbackSend =
                (previewState.failed && streamingFallbackToSendOutput && !rateLimitedPreviewCanFinalize)
                || (!previewState.failed && !previewState.hadPreview && extracted.text.trim().length > 0);
              const finalText = mergeTelegramFinalTextWithToolSummary(extracted.text, previewState.toolSummaryText);
              if (shouldFallbackSend) {
                await streamPreview.clear();
                if (
                  previewState.failed
                  && streamingEmitFallbackNotice
                  && !previewState.hadPreview
                  && typeof previewState.rateLimitedUntilMs !== "number"
                ) {
                  await callTelegramApiWithRateLimit(
                    () => bot.api.sendMessage(chatId, "Streaming interrupted. Sending complete response.", {
                      ...(typeof messageThreadId === "number" ? { message_thread_id: messageThreadId } : {}),
                    }),
                    {
                      chatId,
                      action: "sendMessage",
                      log: deps.log,
                    },
                  );
                }
                deps.log(
                  `telegram: stream_fallback_send_output chat_id=${chatId} reason=${
                    previewState.failed ? "stream_error" : "no_preview_updates"
                  }`,
                );
                await sendOutput(chatId, mergeTelegramFinalTextWithToolSummary(res.output, previewState.toolSummaryText), { messageThreadId });
              } else {
                const textDelivered = await finalizeTelegramStreamPreviewText({
                  api: bot.api,
                  chatId,
                  messageThreadId,
                  text: finalText,
                  preview: previewState,
                  log: deps.log,
                });
                if (!textDelivered && finalText.trim().length > 0) {
                  deps.log(`telegram: stream_finalize_fallback_send_output chat_id=${chatId}`);
                  await sendOutput(chatId, finalText, { messageThreadId });
                }
                // Send images as follow-up messages (they can't be part of a text stream)
                for (const img of extracted.imagePaths) {
                  try {
                    await sendFile(chatId, img, {
                      caption: path.basename(img),
                      messageThreadId,
                    });
                  } catch (err) {
                    deps.log(`telegram: failed to send image ${img}: ${err instanceof Error ? err.message : String(err)}`);
                    await callTelegramApiWithRateLimit(
                      () => bot.api.sendMessage(chatId, `(failed to attach image: ${path.basename(img)})`, {
                        ...(typeof messageThreadId === "number" ? { message_thread_id: messageThreadId } : {}),
                      }),
                      {
                        chatId,
                        action: "sendMessage",
                        log: deps.log,
                      },
                    );
                  }
                }
              }
            },
          );
        });
      } else {
        // --- Non-streaming path for groups/channels: existing behavior ---
        void sendTypingAction(chatId, { messageThreadId });
        const typingInterval = setInterval(() => {
          void sendTypingAction(chatId, { messageThreadId });
        }, 4_000);
        let res: Awaited<ReturnType<typeof deps.agent.handleUserMessage>>;
        try {
          res = await deps.agent.handleUserMessage({
            channel: "telegram",
            channelKey: String(chatId),
            agentId: tg.agentId,
            text: dispatchText,
            contentParts,
          });
        } finally {
          clearInterval(typingInterval);
        }

        await deps.agent.withTelegramDeliveryAck(
          { chatId, runId: res.runId, sessionId: res.sessionId, agentId: tg.agentId },
          () => sendOutput(chatId, res.output, { messageThreadId }),
        );
      }
    } catch (err) {
      const userErrorMessage = formatTelegramHandlerErrorMessage(err);
      deps.log(`telegram: handler_error ${toErrorText(err)} user_message=${JSON.stringify(userErrorMessage)}`);
      try {
        const replyChatId = parseTelegramNumericId(ctx.chat?.id);
        const replyThreadId = resolveMessageThreadId(ctx);
        if (replyChatId !== null) {
          await callTelegramApiWithRateLimit(
            () => bot.api.sendMessage(replyChatId, userErrorMessage, {
              ...(typeof replyThreadId === "number" ? { message_thread_id: replyThreadId } : {}),
            }),
            {
              chatId: replyChatId,
              action: "sendMessage",
              log: deps.log,
              maxAttempts: 2,
            },
          );
        } else {
          deps.log("telegram: handler_error_reply_skipped reason=missing_chat_id");
        }
      } catch (replyErr) {
        deps.log(`telegram: handler_error_reply_failed ${toErrorText(replyErr)}`);
      }
    }
  });

  const mode = tg.mode ?? "polling";
  if (mode === "webhook") {
    const configuredUrl = tg.webhookUrl && !isEnvPlaceholder(tg.webhookUrl) ? tg.webhookUrl : undefined;
    const publicUrl = tg.webhookPublicUrl && !isEnvPlaceholder(tg.webhookPublicUrl) ? tg.webhookPublicUrl : undefined;
    const webhookUrl = configuredUrl ?? (publicUrl ? joinPublicUrl(publicUrl, tg.webhookPath) : null);
    if (!webhookUrl) {
      throw new Error("Telegram webhook mode requires channels.telegram.webhookUrl or channels.telegram.webhookPublicUrl.");
    }
    const secret = tg.webhookSecretToken && !isEnvPlaceholder(tg.webhookSecretToken) ? tg.webhookSecretToken : undefined;

    deps.app.post(tg.webhookPath, async (c) => {
      if (secret) {
        const header = c.req.header("x-telegram-bot-api-secret-token");
        if (header !== secret) return c.text("unauthorized", 401);
      }
      const update = await c.req.json();
      await bot.handleUpdate(update);
      return c.json({ ok: true });
    });

    await bot.api.setWebhook(webhookUrl, { secret_token: secret, drop_pending_updates: true } as any);
    deps.log(`telegram: webhook set to ${webhookUrl}`);

    return {
      stop: async () => {
        await bot.api.deleteWebhook({ drop_pending_updates: false } as any).catch(() => { });
      },
      sendOutput,
      sendFile,
    };
  }

  await bot.api.deleteWebhook({ drop_pending_updates: true } as any).catch(() => { });
  bot.start({ onStart: () => deps.log("telegram: polling") });

  return {
    stop: async () => {
      bot.stop();
    },
    sendOutput,
    sendFile,
  };
}
