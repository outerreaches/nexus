import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { defineTool, type ToolContext } from "../core/tools.js";
import { requestOpenAICompatChatCompletion, type OpenAICompatConfig } from "../llm/openai-compat.js";
import type { NexusDatabase } from "../storage/database.js";
import { isTelegramUserAllowed } from "../gateway/telegram-store.js";
import { resolveTelegramDestination } from "../gateway/telegram-destination.js";
import { resolveWithinRoots } from "./path-utils.js";
import { resolveLegacyImageDefaults, resolveOpenAiToolProviderConfig, resolveToolRoute } from "./tool-routing.js";

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

function resolveDefaultImageModel(
  ctx: Pick<ToolContext, "request" | "llmToolRouting">,
  llm: OpenAICompatConfig,
): { model: string; imageProvider?: string } {
  const configuredRoute = resolveToolRoute(ctx, "image_generate");
  const legacy = resolveLegacyImageDefaults(ctx, llm);
  return {
    model:
      (typeof configuredRoute?.target.model === "string" ? configuredRoute.target.model.trim() : "") ||
      legacy.model,
    imageProvider:
      (typeof configuredRoute?.target.provider === "string" ? configuredRoute.target.provider.trim() : "") ||
      legacy.provider,
  };
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

type NoImageOutputClassification = "policy_refusal" | "capability_mismatch" | "empty_output";

class NoImageOutputError extends Error {
  readonly classification: NoImageOutputClassification;
  readonly modelText: string | null;
  readonly finishReason: string | null;
  readonly responseId: string | null;

  constructor(params: {
    operation: string;
    classification: NoImageOutputClassification;
    modelText: string | null;
    finishReason: string | null;
    responseId: string | null;
  }) {
    const details = [
      `${params.operation} response did not include images`,
      `classification=${params.classification}`,
      ...(params.finishReason ? [`finish_reason=${params.finishReason}`] : []),
      ...(params.responseId ? [`response_id=${params.responseId}`] : []),
      ...(params.modelText ? [`model_text="${params.modelText}"`] : []),
    ];
    super(details.join("; "));
    this.name = "NoImageOutputError";
    this.classification = params.classification;
    this.modelText = params.modelText;
    this.finishReason = params.finishReason;
    this.responseId = params.responseId;
  }
}

function truncateForError(raw: string, maxChars = 240): string {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

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

function maybeString(raw: unknown): string | null {
  return typeof raw === "string" ? raw.trim() || null : null;
}

function detectImageMimeType(raw: unknown): string | null {
  const value = maybeString(raw);
  if (!value) return null;
  const normalized = value.toLowerCase().split(";")[0]?.trim() ?? "";
  if (normalized.startsWith("image/")) return normalized;
  return null;
}

function looksLikeBase64(raw: string): boolean {
  const compact = raw.replace(/\s+/g, "");
  if (compact.length < 256) return false;
  if (compact.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=]+$/.test(compact);
}

function toImageReference(raw: unknown, mimeTypeHint?: string | null): string | null {
  const value = maybeString(raw);
  if (!value) return null;
  if (value.startsWith("data:")) return value;
  if (/^https?:\/\//i.test(value)) return value;
  if (!looksLikeBase64(value)) return null;
  const mimeType = detectImageMimeType(mimeTypeHint) ?? "image/png";
  return `data:${mimeType};base64,${value.replace(/\s+/g, "")}`;
}

function extractImageUrls(message: unknown, responseJson?: Record<string, unknown>): string[] {
  const addFromObject = (obj: Record<string, unknown>, urls: string[]): void => {
    const mimeTypeHint = detectImageMimeType(obj.mime_type ?? obj.mimeType ?? obj.type);
    const imageUrlObj = (obj.image_url ?? obj.imageUrl) as Record<string, unknown> | undefined;
    const nestedImageObj = (obj.image ?? obj.output_image) as Record<string, unknown> | undefined;
    const candidates: unknown[] = [
      imageUrlObj?.url,
      obj.url,
      obj.b64_json,
      obj.base64,
      obj.image_base64,
      obj.data,
      nestedImageObj?.url,
      nestedImageObj?.b64_json,
      nestedImageObj?.base64,
      nestedImageObj?.data,
    ];
    for (const candidate of candidates) {
      const imageRef = toImageReference(candidate, mimeTypeHint);
      if (imageRef) urls.push(imageRef);
    }
  };

  const urls: string[] = [];
  if (message && typeof message === "object") {
    const msg = message as Record<string, unknown>;
    const images = Array.isArray(msg.images) ? msg.images : [];
    for (const image of images) {
      if (!image || typeof image !== "object") continue;
      addFromObject(image as Record<string, unknown>, urls);
    }

    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      addFromObject(part as Record<string, unknown>, urls);
    }
  }

  if (responseJson) {
    const output = Array.isArray(responseJson.output) ? responseJson.output : [];
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      addFromObject(obj, urls);
      const content = Array.isArray(obj.content) ? obj.content : [];
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        addFromObject(part as Record<string, unknown>, urls);
      }
    }
  }

  return Array.from(new Set(urls));
}

function classifyNoImageOutput(text: string | null, finishReason: string | null): NoImageOutputClassification {
  if (finishReason?.toLowerCase() === "content_filter") return "policy_refusal";
  const haystack = `${text ?? ""} ${finishReason ?? ""}`.toLowerCase();
  if (/(policy|safety|refus|cannot|can't|unable|disallow|not allowed|copyright|public figure)/i.test(haystack)) {
    return "policy_refusal";
  }
  if (/(modalit|unsupported|no endpoints|does not support|can't generate|text-only|tool use)/i.test(haystack)) {
    return "capability_mismatch";
  }
  return "empty_output";
}

function formatImageToolError(err: unknown): string {
  if (err instanceof NoImageOutputError) {
    if (err.classification === "policy_refusal") {
      return `${err.message}. Hint: request a policy-safe transformation or a non-protected style.`;
    }
    if (err.classification === "capability_mismatch") {
      return `${err.message}. Hint: try a different image model/provider route.`;
    }
    return `${err.message}. Hint: retry with a shorter, explicit image-output prompt.`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function generateImagesWithConfig(params: {
  llm: OpenAICompatConfig;
  prompt: string;
  model: string;
  size?: "1K" | "2K" | "4K";
  aspectRatio?: string;
  timeoutMs: number;
}): Promise<ImageGenerationResult> {
  const model = params.model.trim();
  const payload: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: params.prompt }],
    modalities: ["image", "text"],
  };
  const imageConfig: Record<string, unknown> = {};
  if (params.size) imageConfig.image_size = params.size;
  if (params.aspectRatio) imageConfig.aspect_ratio = params.aspectRatio;
  if (Object.keys(imageConfig).length > 0) payload.image_config = imageConfig;

  const json = await requestOpenAICompatChatCompletion({
    llm: params.llm,
    payload,
    timeoutMs: params.timeoutMs,
  });
  const choice = (json.choices as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  const text = normalizeTextContent((message as Record<string, unknown> | undefined)?.content);
  const finishReason = maybeString(choice?.finish_reason);
  const responseId = maybeString(json.id);
  const imageUrls = extractImageUrls(message, json);
  if (imageUrls.length === 0) {
    throw new NoImageOutputError({
      operation: "image generation",
      classification: classifyNoImageOutput(text, finishReason),
      modelText: text ? truncateForError(text) : null,
      finishReason,
      responseId,
    });
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
    sendToTelegram: z.boolean().default(false).describe("If true, send generated image files to Telegram. Routes to the active Telegram chat or the home session pinned via /sethome."),
    caption: z.string().max(1024).optional().describe("Optional Telegram caption."),
  }),
  execute: async (args, ctx) => {
    if (args.root === "code" && !ctx.allowCodeEdit) return "ERROR: code root is disabled by policy";
    if (!ctx.llmConfig) return "ERROR: llmConfig is not available";

    const timeoutMs = resolveTimeoutMs(args.timeoutMs);
    const resolved = args.model
      ? { model: args.model.trim(), imageProvider: resolveDefaultImageModel(ctx, ctx.llmConfig).imageProvider }
      : resolveDefaultImageModel(ctx, ctx.llmConfig);
    const selectedModel = resolved.model;

    let baseLlmConfig = ctx.llmConfig;
    let routeProvider = "default";
    if (resolved.imageProvider) {
      const routed = resolveOpenAiToolProviderConfig({
        ctx,
        provider: resolved.imageProvider,
        syntheticAgentId: "__image_tool__",
      });
      if ("error" in routed) {
        return `ERROR: ${routed.error}`;
      }
      baseLlmConfig = routed.config;
      routeProvider = routed.providerName;
    }

    const primary = {
      ...baseLlmConfig,
      model: selectedModel,
    };

    let generation: ImageGenerationResult;
    const routeUsed = `${routeProvider}:${primary.model}`;
    try {
      generation = await generateImagesWithConfig({
        llm: primary,
        prompt: args.prompt,
        model: selectedModel,
        size: args.size,
        aspectRatio: args.aspectRatio,
        timeoutMs,
      });
    } catch (primaryErr) {
      if (primaryErr instanceof NoImageOutputError) {
        ctx.log(
          `image_generate: no_image_output classification=${primaryErr.classification} model=${selectedModel}` +
          `${primaryErr.finishReason ? ` finish_reason=${primaryErr.finishReason}` : ""}` +
          `${primaryErr.responseId ? ` response_id=${primaryErr.responseId}` : ""}`,
        );
      }
      return `ERROR: image_generate route=${routeUsed} model=${selectedModel}: ${formatImageToolError(primaryErr)}`;
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
        model: selectedModel,
        routeUsed,
        count: savedFiles.length,
        size: args.size,
        aspectRatio: args.aspectRatio,
        origin: {
          sessionId: ctx.request?.sessionId ?? null,
          channel: ctx.request?.channel ?? null,
          channelKey: ctx.request?.channelKey ?? null,
          runId: ctx.request?.runId ?? null,
          agentId: ctx.request?.agentId ?? null,
        },
      };
      if (typeof args.blackboardTtlMs === "number") metadata.ttlMs = args.blackboardTtlMs;

      db.db
        .prepare(
          `INSERT INTO blackboard (id, session_scope, type, agent_id, agent_preset, title, content, attachments_json, metadata_json, created_at, last_accessed_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          blackboardId,
          "global",
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
      if (!ctx.request?.agentId) return "ERROR: missing agent context";

      const destination = resolveTelegramDestination({
        db,
        agentId: ctx.request.agentId,
        request: ctx.request,
      });
      if (!destination) {
        return "ERROR: no Telegram destination available (not in a Telegram session and no home pinned via /sethome)";
      }
      const chatId = destination.chatId;

      const allowed = isTelegramUserAllowed(db, {
        userId: chatId,
        staticAllowFrom: tg.allowFrom ?? [],
        allowAll: Boolean(tg.allowAll),
      });
      if (!allowed) {
        return `ERROR: resolved chat ${chatId} (source=${destination.source}) is not allowlisted`;
      }

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
        model: selectedModel,
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
