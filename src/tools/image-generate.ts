import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { OpenAICompatConfig } from "../llm/openai-compat.js";
import type { NexusDatabase } from "../storage/database.js";
import { isTelegramUserAllowed } from "../gateway/telegram-store.js";
import { resolveWithinRoots } from "./path-utils.js";

const FILE_ROOTS = ["workspace", "state", "code"] as const;
type FileRoot = (typeof FILE_ROOTS)[number];

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

type TelegramCtx = {
  sendFile: (chatId: number, filePath: string, options?: { caption?: string }) => Promise<void>;
  allowFrom: number[];
  allowAll: boolean;
};

function requireDb(ctx: { db?: unknown }): NexusDatabase | null {
  return (ctx.db as NexusDatabase | undefined) ?? null;
}

function joinUrl(baseUrl: string, suffix: string): string {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(suffix, normalized).toString();
}

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function rootDir(ctx: { workspaceDir: string; stateDir: string; codeDir: string }, root: FileRoot): string {
  if (root === "workspace") return ctx.workspaceDir;
  if (root === "state") return ctx.stateDir;
  return ctx.codeDir;
}

function allowedRoots(ctx: { workspaceDir: string; stateDir: string; codeDir: string; allowCodeEdit?: boolean }): string[] {
  return [ctx.workspaceDir, ctx.stateDir, ...(ctx.allowCodeEdit ? [ctx.codeDir] : [])];
}

function extensionFromMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "image/png") return ".png";
  return ".png";
}

function inferMimeFromFilename(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function sanitizeFileStem(raw: string): string {
  const base = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!base) return "image";
  return base.slice(0, 80);
}

function resolveTimeoutMs(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return Math.max(10_000, envInt("NEXUS_LLM_IMAGE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));
}

function shouldFallbackFromError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/request timed out|abort/i.test(message)) return true;
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(message)) return true;
  const statusMatch = message.match(/LLM request failed:\s*(\d{3})\b/);
  if (!statusMatch) return false;
  const status = Number(statusMatch[1]);
  if (!Number.isFinite(status)) return false;
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`LLM request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

type GeneratedImage = {
  url: string;
};

type ImageGenerationResult = {
  text: string | null;
  images: GeneratedImage[];
};

function normalizeTextContent(raw: unknown): string | null {
  if (typeof raw === "string") return raw.trim() || null;
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const part of raw) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (typeof p.text === "string") out.push(p.text);
    else if (typeof p.content === "string") out.push(p.content);
    else if (p.type === "text" && p.text && typeof p.text === "object") {
      const t = p.text as Record<string, unknown>;
      if (typeof t.value === "string") out.push(t.value);
    }
  }
  const joined = out.join("\n").trim();
  return joined || null;
}

function extractImageUrls(message: unknown): string[] {
  if (!message || typeof message !== "object") return [];
  const msg = message as Record<string, unknown>;
  const urls: string[] = [];
  const add = (val: unknown) => {
    if (typeof val === "string" && val.trim().length > 0) urls.push(val.trim());
  };

  const images = Array.isArray(msg.images) ? msg.images : [];
  for (const image of images) {
    if (!image || typeof image !== "object") continue;
    const item = image as Record<string, unknown>;
    const imageUrlObj = (item.image_url ?? item.imageUrl) as Record<string, unknown> | undefined;
    add(imageUrlObj?.url);
    add(item.url);
  }

  const content = Array.isArray(msg.content) ? msg.content : [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "image_url") {
      const imageUrlObj = (p.image_url ?? p.imageUrl) as Record<string, unknown> | undefined;
      add(imageUrlObj?.url);
    }
  }

  return Array.from(new Set(urls));
}

async function generateImagesWithConfig(params: {
  llm: OpenAICompatConfig;
  prompt: string;
  modelOverride?: string;
  size?: "1K" | "2K" | "4K";
  aspectRatio?: string;
  timeoutMs: number;
}): Promise<ImageGenerationResult> {
  const url = joinUrl(params.llm.baseUrl, "chat/completions");
  const model = (params.modelOverride ?? params.llm.model).trim();
  const payload: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: params.prompt }],
    modalities: ["image", "text"],
    tool_choice: "none",
  };
  const imageConfig: Record<string, unknown> = {};
  if (params.size) imageConfig.size = params.size;
  if (params.aspectRatio) imageConfig.aspect_ratio = params.aspectRatio;
  if (Object.keys(imageConfig).length > 0) payload.image_config = imageConfig;

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        ...(params.llm.apiKey ? { Authorization: `Bearer ${params.llm.apiKey}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    params.timeoutMs,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM request failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  const message = ((json.choices as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined)?.message;
  const text = normalizeTextContent((message as Record<string, unknown> | undefined)?.content);
  const imageUrls = extractImageUrls(message);
  if (imageUrls.length === 0) {
    throw new Error("image generation response did not include images");
  }
  return {
    text,
    images: imageUrls.map((url) => ({ url })),
  };
}

function parseDataUrl(dataUrl: string): { mimeType: string; bytes: Buffer } | null {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
  if (!match) return null;
  const mimeType = (match[1] ?? "image/png").toLowerCase();
  const encoded = match[3] ?? "";
  const isBase64 = Boolean(match[2]);
  try {
    const bytes = isBase64 ? Buffer.from(encoded, "base64") : Buffer.from(decodeURIComponent(encoded), "utf8");
    return { mimeType, bytes };
  } catch {
    return null;
  }
}

async function downloadImageBytes(url: string, timeoutMs: number): Promise<{ mimeType: string; bytes: Buffer }> {
  const data = parseDataUrl(url);
  if (data) return data;
  const res = await fetchWithTimeout(url, { method: "GET" }, timeoutMs);
  if (!res.ok) throw new Error(`image download failed (${res.status} ${res.statusText})`);
  const mimeType = (res.headers.get("content-type") ?? "image/png").split(";")[0]?.trim().toLowerCase() || "image/png";
  const bytes = Buffer.from(await res.arrayBuffer());
  return { mimeType, bytes };
}

async function resolveDefaultTelegramChatId(db: NexusDatabase, agentId: string): Promise<number | null> {
  try {
    const row = db.db
      .prepare(
        `
        SELECT s.channel_key as chat_id
        FROM sessions s
        JOIN messages m ON m.session_id = s.id
        WHERE s.channel = 'telegram' AND s.agent_id = ?
        ORDER BY m.created_at DESC
        LIMIT 1
      `,
      )
      .get(agentId) as { chat_id: string } | undefined;
    if (!row?.chat_id) return null;
    const id = Number(row.chat_id);
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

async function resolveTelegramChatId(argsChatId: number | undefined, ctx: {
  db?: unknown;
  request?: { channel: string; channelKey: string; agentId: string };
}): Promise<number | null> {
  const db = requireDb(ctx);
  if (!db) return null;
  let chatId: number | null = argsChatId ?? null;
  if (!chatId && ctx.request?.channel === "telegram") {
    const id = Number(ctx.request.channelKey);
    if (Number.isFinite(id)) chatId = id;
  }
  if (!chatId && ctx.request?.agentId) {
    chatId = await resolveDefaultTelegramChatId(db, ctx.request.agentId);
  }
  return chatId;
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

export const imageGenerate = defineTool({
  name: "image_generate",
  description:
    "Generate image(s) with the active model route, save files to disk, optionally write as a blackboard artifact, and optionally send to Telegram.",
  parameters: z.object({
    prompt: z.string().min(1).max(8000).describe("Image generation prompt."),
    model: z.string().min(1).optional().describe("Optional model override. Defaults to active route model."),
    root: z.enum(FILE_ROOTS).default("workspace").describe("Output root for image files."),
    path: z
      .string()
      .optional()
      .describe("Output file path (relative to root or absolute in allowed roots). For multiple images, numeric suffixes are appended."),
    fileStem: z
      .string()
      .max(120)
      .optional()
      .describe("Base filename when path is not provided. Defaults to a timestamped `image-*` name."),
    count: z.number().int().min(1).max(4).default(1).describe("Maximum images to persist from model output."),
    size: z.enum(["1K", "2K", "4K"]).optional().describe("Optional image size hint for compatible models."),
    aspectRatio: z
      .string()
      .max(32)
      .optional()
      .describe("Optional aspect ratio hint (for example `1:1`, `16:9`, `9:16`) for compatible models."),
    timeoutMs: z.number().int().min(10_000).max(600_000).optional().describe("Request timeout override in milliseconds."),
    maxImageBytes: z
      .number()
      .int()
      .min(64 * 1024)
      .max(40 * 1024 * 1024)
      .default(DEFAULT_MAX_IMAGE_BYTES)
      .describe("Maximum size per generated image file in bytes."),
    writeToBlackboard: z.boolean().default(true).describe("If true, store generated images as blackboard attachments."),
    blackboardTitle: z.string().max(200).optional().describe("Optional blackboard artifact title."),
    blackboardTtlMs: z
      .number()
      .int()
      .min(60_000)
      .max(30 * 24 * 60 * 60_000)
      .optional()
      .describe("Optional blackboard TTL in ms."),
    sendToTelegram: z.boolean().default(false).describe("If true, send generated image files to Telegram."),
    chatId: z.number().int().positive().optional().describe("Optional Telegram chat id. Defaults to current/recent chat."),
    caption: z.string().max(1024).optional().describe("Optional Telegram caption."),
  }),
  execute: async (args, ctx) => {
    if (args.root === "code" && !ctx.allowCodeEdit) return "ERROR: code root is disabled by policy";
    if (!ctx.llmConfig) return "ERROR: llmConfig is not available";

    const timeoutMs = resolveTimeoutMs(args.timeoutMs);
    const primary = {
      ...ctx.llmConfig,
      model: args.model ?? ctx.llmConfig.model,
    };
    const fallback = ctx.fallbackLlmConfig
      ? {
          ...ctx.fallbackLlmConfig,
          model: args.model ?? ctx.fallbackLlmConfig.model,
        }
      : undefined;

    let generation: ImageGenerationResult;
    let routeUsed = `primary:${primary.model}`;
    try {
      generation = await generateImagesWithConfig({
        llm: primary,
        prompt: args.prompt,
        modelOverride: args.model,
        size: args.size,
        aspectRatio: args.aspectRatio,
        timeoutMs,
      });
    } catch (primaryErr) {
      if (!fallback || !shouldFallbackFromError(primaryErr)) {
        return `ERROR: ${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}`;
      }
      ctx.log(`image_generate: primary failed, falling back (${primary.model} -> ${fallback.model})`);
      try {
        generation = await generateImagesWithConfig({
          llm: fallback,
          prompt: args.prompt,
          modelOverride: args.model,
          size: args.size,
          aspectRatio: args.aspectRatio,
          timeoutMs,
        });
        routeUsed = `fallback:${fallback.model}`;
      } catch (fallbackErr) {
        return `ERROR: primary and fallback image generation failed: ${
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
        }`;
      }
    }

    const defaultRoot = rootDir(ctx, args.root);
    const roots = allowedRoots(ctx);
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const stem = sanitizeFileStem(args.fileStem ?? `image-${stamp}`);
    const requestedCount = Math.min(args.count, generation.images.length);

    const savedFiles: Array<{
      path: string;
      mimeType: string;
      sizeBytes: number;
      relativePath: string | null;
    }> = [];

    for (let i = 0; i < requestedCount; i += 1) {
      const image = generation.images[i]!;
      const downloaded = await downloadImageBytes(image.url, timeoutMs);
      if (!downloaded.mimeType.startsWith("image/")) {
        return `ERROR: generated output is not an image (mime=${downloaded.mimeType})`;
      }
      if (downloaded.bytes.length > args.maxImageBytes) {
        return `ERROR: generated image ${i + 1} exceeds maxImageBytes (${downloaded.bytes.length} > ${args.maxImageBytes})`;
      }

      const ext = extensionFromMime(downloaded.mimeType);
      let outputPathInput: string;
      if (args.path?.trim()) {
        const raw = args.path.trim();
        if (requestedCount === 1) {
          outputPathInput = path.extname(raw) ? raw : `${raw}${ext}`;
        } else {
          const parsed = path.parse(raw);
          const baseName = parsed.name || "image";
          const outExt = parsed.ext || ext;
          outputPathInput = path.join(parsed.dir, `${baseName}-${String(i + 1).padStart(2, "0")}${outExt}`);
        }
      } else {
        outputPathInput = path.join(
          "generated-images",
          day,
          `${stem}-${String(i + 1).padStart(2, "0")}${ext}`,
        );
      }

      const absolutePath = resolveWithinRoots({
        inputPath: outputPathInput,
        defaultRoot,
        roots,
      });
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, downloaded.bytes);

      const resolvedRoot = path.resolve(defaultRoot);
      const relativePath = absolutePath.startsWith(`${resolvedRoot}${path.sep}`)
        ? path.relative(resolvedRoot, absolutePath).split(path.sep).join("/")
        : null;

      savedFiles.push({
        path: absolutePath,
        mimeType: downloaded.mimeType || inferMimeFromFilename(absolutePath),
        sizeBytes: downloaded.bytes.length,
        relativePath,
      });
    }

    let blackboardId: string | null = null;
    if (args.writeToBlackboard) {
      const db = requireDb(ctx);
      if (!db) return "ERROR: database is not available for blackboard persistence";
      const nowMs = ctx.nowMs();
      blackboardId = crypto.randomUUID();
      const expiresAt = typeof args.blackboardTtlMs === "number" ? nowMs + args.blackboardTtlMs : null;
      const attachments = savedFiles.map((file) => ({
        path: file.path,
        mimeType: file.mimeType,
        relativePath: file.relativePath ?? undefined,
        sizeBytes: file.sizeBytes,
      }));
      const lines = [
        "Generated image artifact.",
        `Model route: ${routeUsed}`,
        `Prompt: ${args.prompt}`,
        "",
        "Files:",
        ...savedFiles.map((file, idx) => `- ${idx + 1}. ${file.path} (${file.mimeType}, ${formatBytes(file.sizeBytes)})`),
      ];
      const metadata: Record<string, unknown> = {
        source: "image_generate",
        model: args.model ?? primary.model,
        routeUsed,
        count: savedFiles.length,
        size: args.size,
        aspectRatio: args.aspectRatio,
      };
      if (typeof args.blackboardTtlMs === "number") metadata.ttlMs = args.blackboardTtlMs;

      db.db
        .prepare(
          `INSERT INTO blackboard (id, session_scope, type, agent_id, agent_preset, title, content, attachments_json, metadata_json, created_at, last_accessed_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          blackboardId,
          ctx.request?.sessionId ?? "global",
          "artifact",
          ctx.request?.agentId ?? "main",
          "unknown",
          args.blackboardTitle?.trim() || `Generated image (${savedFiles.length})`,
          lines.join("\n"),
          JSON.stringify(attachments),
          JSON.stringify(metadata),
          nowMs,
          nowMs,
          expiresAt,
        );
    }

    const telegramResults: string[] = [];
    if (args.sendToTelegram) {
      const tg = ctx.telegram as TelegramCtx | undefined;
      if (!tg) return "ERROR: telegram is not configured";
      const db = requireDb(ctx);
      if (!db) return "ERROR: database is not available for telegram auth checks";

      const chatId = await resolveTelegramChatId(args.chatId, ctx);
      if (!chatId) return "ERROR: missing chatId (no active/recent telegram chat found)";
      if (chatId <= 0) return "ERROR: only private-chat chatIds are supported for image_generate telegram send";

      const allowed = isTelegramUserAllowed(db, {
        userId: chatId,
        staticAllowFrom: tg.allowFrom ?? [],
        allowAll: Boolean(tg.allowAll),
      });
      if (!allowed) return "ERROR: chatId is not allowlisted";

      for (let i = 0; i < savedFiles.length; i += 1) {
        const file = savedFiles[i]!;
        const caption = savedFiles.length === 1
          ? args.caption
          : (args.caption ? `${args.caption} (${i + 1}/${savedFiles.length})` : `Generated image ${i + 1}/${savedFiles.length}`);
        await tg.sendFile(chatId, file.path, { caption });
        telegramResults.push(`sent:${path.basename(file.path)}=>${chatId}`);
      }
    }

    return JSON.stringify(
      {
        status: "ok",
        model: args.model ?? primary.model,
        routeUsed,
        prompt: args.prompt,
        text: generation.text,
        files: savedFiles,
        blackboardId,
        telegram: {
          sent: telegramResults.length,
          results: telegramResults,
        },
      },
      null,
      2,
    );
  },
});
