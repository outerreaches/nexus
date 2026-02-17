import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Hono } from "hono";
import { Bot, Context, InputFile } from "grammy";

import type { NexusConfig } from "../state/config.js";
import type { AgentService } from "../core/agent-service.js";
import type { ChatUserContentPart } from "../core/types.js";
import type { NexusDatabase } from "../storage/database.js";
import { getOrCreateSessionId } from "../storage/sessions.js";
import { createPairingRequest, isTelegramUserAllowed } from "./telegram-store.js";
import { fulfillHumanAction } from "../storage/human-actions.js";
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

function sanitizeMessageText(raw: string, botUsername: string): string {
  return raw
    .replace(botUsername ? new RegExp(`@${botUsername}\\b`, "g") : /$^/, "")
    .replace(/^\/nexus\b\s*/i, "")
    .replace(/^\/n\b\s*/i, "")
    .trim();
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
  bot: Bot;
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
  };

  db.db
    .prepare(
      `INSERT INTO blackboard (id, session_scope, type, agent_id, agent_preset, title, content, attachments_json, metadata_json, created_at, last_accessed_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      sessionId,
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

export async function startTelegramBot(deps: {
  config: NexusConfig;
  agent: AgentService;
  configPath: string;
  db: NexusDatabase;
  app: Hono;
  log: (msg: string) => void;
}): Promise<{
  stop: () => Promise<void>;
  sendOutput: (chatId: number, output: string) => Promise<void>;
  sendFile: (chatId: number, filePath: string, options?: { caption?: string }) => Promise<void>;
} | null> {
  const tg = deps.config.channels.telegram;
  if (!tg.enabled) return null;
  const token = tg.token && !isEnvPlaceholder(tg.token) ? tg.token : process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("Telegram is enabled but no token is configured (set TELEGRAM_BOT_TOKEN).");
  }

  const bot = new Bot(token);
  const me = await bot.api.getMe();
  const botUsername = me.username ?? "";
  const allowAllUsers = process.env.NEXUS_TELEGRAM_ALLOW_ALL === "1";
  const allowFrom = tg.allowFrom ?? [];
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
    `telegram: file_io max_files_per_msg=${maxInboundFilesPerMessage} max_file_bytes=${maxInboundFileBytes} blackboard_ttl_ms=${fileBlackboardTtlMs}`,
  );
  deps.log(
    `telegram: llm_media max_inline_images=${maxInlineImagesForLlm} max_inline_image_bytes=${maxInlineImageBytesForLlm}`,
  );
  if (allowAllUsers) deps.log("telegram: WARN allow_all is enabled; any Telegram user can reach the agent.");
  if (allowFrom.length === 0 && !allowAllUsers && !tg.pairing.enabled) {
    deps.log("telegram: WARN no static allowlist and pairing is disabled; no users can authenticate.");
  }

  const sendFile = async (chatId: number, filePath: string, options?: { caption?: string }): Promise<void> => {
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
        await bot.api.sendPhoto(chatId, new InputFile(absolute), { caption: options?.caption });
        return;
      } catch (err) {
        // Some valid images still fail Telegram's photo pipeline (dimension/encoding quirks).
        // Fall back to sendDocument so the user still receives the file.
        deps.log(
          `telegram: sendPhoto failed chat_id=${chatId} path=${absolute} error=${err instanceof Error ? err.message : String(err)}; falling back to sendDocument`,
        );
      }
    }
    await bot.api.sendDocument(chatId, new InputFile(absolute), { caption: options?.caption });
  };

  const sendOutput = async (chatId: number, output: string): Promise<void> => {
    const extracted = await extractTelegramImageAttachments(output);
    const chunks = splitTelegramMessage(extracted.text);
    deps.log(`telegram: send chat_id=${chatId} chunks=${chunks.length} images=${extracted.imagePaths.length} chars=${output.length}`);
    for (const chunk of chunks) {
      if (chunk.trim().length === 0) continue;
      await bot.api.sendMessage(chatId, chunk);
    }
    for (const img of extracted.imagePaths) {
      try {
        await sendFile(chatId, img, { caption: path.basename(img) });
      } catch (err) {
        deps.log(`telegram: failed to send image ${img}: ${err instanceof Error ? err.message : String(err)}`);
        await bot.api.sendMessage(chatId, `(failed to attach image: ${path.basename(img)})`);
      }
    }
  };

  bot.on("message", async (ctx) => {
    try {
      const message = (ctx.message ?? {}) as unknown as Record<string, unknown>;
      const text = typeof (message as { text?: unknown }).text === "string" ? String((message as { text?: unknown }).text) : "";
      const caption =
        typeof (message as { caption?: unknown }).caption === "string" ? String((message as { caption?: unknown }).caption) : "";
      const rawInputText = text || caption;
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;
      const messageId = typeof (message as { message_id?: unknown }).message_id === "number"
        ? Number((message as { message_id?: unknown }).message_id)
        : Date.now();
      if (!userId || !chatId) return;
      deps.log(`telegram: msg user_id=${userId} chat_id=${chatId} kind=${ctx.chat?.type ?? "unknown"}`);

      const allowed = isTelegramUserAllowed(deps.db, {
        userId,
        staticAllowFrom: allowFrom,
        allowAll: allowAllUsers,
      });
      if (!allowed) {
        deps.log(`telegram: ignore user_id=${userId} reason=not_allowlisted pairing=${tg.pairing.enabled ? "on" : "off"}`);
        if (tg.pairing.enabled && !isGroupChat(ctx)) {
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
            await ctx.reply(
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
            await ctx.reply(
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
            await ctx.reply("Pairing queue is full right now. Please try again in a few minutes.");
          } else {
            deps.log(`telegram: pairing request not created user_id=${userId} reason=${req.reason}`);
            await ctx.reply("Unable to issue a pairing code right now. Please try again shortly.");
          }
          return;
        }

        if (tg.pairing.enabled && isGroupChat(ctx)) {
          deps.log(`telegram: pairing request rejected user_id=${userId} reason=group_chat`);
          await ctx.reply("Pairing is only supported in private chat. Please DM this bot and send /pair.");
        } else {
          await ctx.reply("You are not allowlisted for this bot.");
        }
        return;
      }

      if (/^\/(act|action)\b/i.test(text.trim())) {
        const parts = text.trim().split(/\s+/);
        const id = parts[1] ?? "";
        const response = parts.slice(2).join(" ").trim();
        if (!id || !response) {
          await ctx.reply("Usage: /act <ID> <response>");
          return;
        }

        deps.log(`telegram: act user_id=${userId} id=${id} response_chars=${response.length}`);
        const actionRes = fulfillHumanAction(deps.db, {
          id,
          responseText: response,
          respondedByChannel: "telegram",
          respondedByKey: String(userId),
          nowMs: Date.now(),
        });
        if (!actionRes.ok) {
          await ctx.reply(`ERROR: unable to record action (${actionRes.error ?? "unknown"})`);
          return;
        }

        await ctx.reply(`OK: recorded action ${id}`);
        const res = await deps.agent.handleUserMessage({
          channel: "telegram",
          channelKey: String(chatId),
          agentId: tg.agentId,
          text: `Human action ${id} is fulfilled.`,
        });
        await sendOutput(chatId, res.output);
        deps.agent.ackDeployIfPending({
          runId: res.runId,
          sessionId: res.sessionId,
          channel: "telegram",
          channelKey: String(chatId),
          agentId: tg.agentId,
        });
        return;
      }

      if (isGroupChat(ctx) && tg.requireMentionInGroups) {
        const mentioned = botUsername ? rawInputText.includes(`@${botUsername}`) : false;
        const invoked = rawInputText.startsWith("/nexus") || rawInputText.startsWith("/n");
        if (!mentioned && !invoked) {
          deps.log(`telegram: ignore user_id=${userId} chat_id=${chatId} reason=require_mention`);
          return;
        }
      }

      const cleanedText = sanitizeMessageText(rawInputText, botUsername);
      const incomingAttachments = collectIncomingAttachments(message);
      if (incomingAttachments.length > maxInboundFilesPerMessage) {
        await ctx.reply(`Too many attachments in one message. Max ${maxInboundFilesPerMessage} files per message.`);
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
          await ctx.reply(`Unable to ingest attached files: ${ingest.rejected.join("; ") || "unknown error"}`);
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
          userId,
          messageId,
          sessionId,
          agentId: tg.agentId,
          nowMs,
          ttlMs: fileBlackboardTtlMs,
          captionText: cleanedText,
          files: ingest.stored,
        });
        deps.log(
          `telegram: blackboard upload id=${blackboardId} user_id=${userId} chat_id=${chatId} files=${ingest.stored.length}`,
        );

        if (ingest.rejected.length > 0) {
          await ctx.reply(`Processed ${ingest.stored.length} file(s), skipped ${ingest.rejected.length}: ${ingest.rejected.join("; ")}`);
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
        deps.log(`telegram: ignore user_id=${userId} chat_id=${chatId} reason=empty_text`);
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
        `telegram: dispatch chat_id=${chatId} agent=${tg.agentId} chars=${dispatchText.length} media_parts=${contentParts ? contentParts.length : 0}`,
      );
      const res = await deps.agent.handleUserMessage({
        channel: "telegram",
        channelKey: String(chatId),
        agentId: tg.agentId,
        text: dispatchText,
        contentParts,
      });

      await sendOutput(chatId, res.output);
      deps.agent.ackDeployIfPending({
        runId: res.runId,
        sessionId: res.sessionId,
        channel: "telegram",
        channelKey: String(chatId),
        agentId: tg.agentId,
      });
    } catch (err) {
      deps.log(`telegram: handler_error ${err instanceof Error ? err.message : String(err)}`);
      try {
        await ctx.reply("ERROR: internal error (check gateway logs).");
      } catch {
        // ignore reply failures
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
        await bot.api.deleteWebhook({ drop_pending_updates: false } as any).catch(() => {});
      },
      sendOutput,
      sendFile,
    };
  }

  await bot.api.deleteWebhook({ drop_pending_updates: true } as any).catch(() => {});
  bot.start({ onStart: () => deps.log("telegram: polling") });

  return {
    stop: async () => {
      bot.stop();
    },
    sendOutput,
    sendFile,
  };
}
