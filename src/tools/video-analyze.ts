import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { defineTool, type ToolContext } from "../core/tools.js";
import { requestOpenAICompatChatCompletion, type OpenAICompatConfig } from "../llm/openai-compat.js";
import type { NexusDatabase } from "../storage/database.js";
import { resolveWithinRoots } from "./path-utils.js";
import { resolveLegacyVideoDefaults, resolveOpenAiToolProviderConfig, resolveToolRoute } from "./tool-routing.js";

const FILE_ROOTS = ["workspace", "state", "code"] as const;
type FileRoot = (typeof FILE_ROOTS)[number];

const DEFAULT_MAX_VIDEO_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes — video analysis is slow

const SUPPORTED_VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/mpeg",
  "video/mov",
  "video/webm",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function detectVideoMimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mpeg" || ext === ".mpg") return "video/mpeg";
  if (ext === ".mov") return "video/mov";
  if (ext === ".webm") return "video/webm";
  return "application/octet-stream";
}

function resolveTimeoutMs(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return Math.max(10_000, envInt("NEXUS_LLM_VIDEO_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));
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

// ---------------------------------------------------------------------------
// Blackboard resolution (mirrors image-analyze.ts pattern)
// ---------------------------------------------------------------------------

type BlackboardRow = {
  id: string;
  session_scope: string;
  title: string | null;
  attachments_json: string | null;
};

type BlackboardAttachment = {
  path?: string;
  statePath?: string;
  mimeType?: string;
  filename?: string;
};

function requireDb(ctx: { db?: unknown }): NexusDatabase | null {
  return (ctx.db as NexusDatabase | undefined) ?? null;
}

function parseAttachments(raw: string | null): BlackboardAttachment[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry && typeof entry === "object") as BlackboardAttachment[];
  } catch {
    return [];
  }
}

function normalizeRootPathPrefix(rawPath: string): { root: FileRoot; path: string } | null {
  const trimmed = rawPath.trim().replace(/^[\\/]+/, "");
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[\\]+/g, "/");
  for (const root of FILE_ROOTS) {
    const prefix = `${root}/`;
    if (normalized.startsWith(prefix)) {
      return { root, path: normalized.slice(prefix.length) };
    }
  }
  return null;
}

async function resolveVideoFromBlackboard(params: {
  ctx: {
    db?: unknown;
    request?: { sessionId: string };
    workspaceDir: string;
    stateDir: string;
    codeDir: string;
    allowCodeEdit?: boolean;
  };
  blackboardId: string;
  attachmentIndex: number;
}): Promise<{ absolutePath: string; sourceLabel: string; declaredMimeType?: string }> {
  const db = requireDb(params.ctx);
  if (!db) throw new Error("database is not available");

  const row = db.db
    .prepare("SELECT id, session_scope, title, attachments_json FROM blackboard WHERE id = ?")
    .get(params.blackboardId) as BlackboardRow | undefined;
  if (!row) throw new Error(`blackboard entry not found: ${params.blackboardId}`);

  const sessionId = params.ctx.request?.sessionId;
  if (sessionId && row.session_scope !== sessionId && row.session_scope !== "global") {
    throw new Error("blackboard entry is outside current session scope");
  }

  const attachments = parseAttachments(row.attachments_json);
  if (attachments.length === 0) {
    throw new Error(`blackboard entry has no attachments: ${params.blackboardId}`);
  }

  const index = params.attachmentIndex - 1;
  if (index < 0 || index >= attachments.length) {
    throw new Error(`attachment index out of range (requested=${params.attachmentIndex}, available=${attachments.length})`);
  }

  const attachment = attachments[index]!;
  let rawPath = attachment.path?.trim() ?? "";
  if (!rawPath) rawPath = attachment.statePath?.trim() ?? "";
  if (!rawPath) throw new Error(`attachment ${params.attachmentIndex} has no path`);

  const prefixed = normalizeRootPathPrefix(rawPath);
  const defaultRoot = prefixed ? rootDir(params.ctx, prefixed.root) : params.ctx.stateDir;
  const inputPath = prefixed ? prefixed.path : rawPath;
  const absolutePath = resolveWithinRoots({
    inputPath,
    defaultRoot,
    roots: allowedRoots(params.ctx),
  });

  const entryTitle = row.title ? ` (${row.title})` : "";
  return {
    absolutePath,
    declaredMimeType: attachment.mimeType?.trim() || undefined,
    sourceLabel: `blackboard:${params.blackboardId}${entryTitle}#${params.attachmentIndex}`,
  };
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

function resolveDefaultVideoModel(
  ctx: Pick<ToolContext, "request" | "llmToolRouting">,
  llm: OpenAICompatConfig,
): { model: string; videoProvider?: string; videoProviderOrder?: string[] } {
  const configuredRoute = resolveToolRoute(ctx, "video_analyze");
  const legacy = resolveLegacyVideoDefaults(ctx, llm);
  const routeOrder = Array.isArray(configuredRoute?.target.providerOrder)
    ? configuredRoute.target.providerOrder.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : undefined;
  return {
    model:
      (typeof configuredRoute?.target.model === "string" ? configuredRoute.target.model.trim() : "") ||
      legacy.model,
    videoProvider:
      (typeof configuredRoute?.target.provider === "string" ? configuredRoute.target.provider.trim() : "") ||
      legacy.provider,
    videoProviderOrder: routeOrder && routeOrder.length > 0 ? routeOrder : legacy.providerOrder,
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const videoAnalyze = defineTool({
  name: "video_analyze",
  description:
    "Analyze a video file or URL using a video-capable multimodal LLM. " +
    "Accepts a local file path, a public video URL (HTTP/HTTPS/YouTube), or a blackboard attachment reference. " +
    "Local files are base64-encoded and sent inline (keep files small, <=10 MB default). " +
    "URL support varies by provider: Vertex AI supports HTTP URLs; AI Studio supports YouTube URLs. " +
    "Default model: google/gemini-2.5-flash-lite via OpenRouter.",
  parameters: z.object({
    root: z.enum(FILE_ROOTS).default("state").describe("Root for `path` resolution (ignored when using url or blackboardId)."),
    path: z.string().optional().describe("Local video file path (relative to root, or absolute inside allowed roots)."),
    url: z.string().optional().describe("Public video URL (HTTP/HTTPS or YouTube link). Passed directly to the model."),
    blackboardId: z.string().optional().describe("Blackboard entry ID to analyze a video attachment from."),
    attachmentIndex: z.number().int().positive().default(1).describe("1-based attachment index when using blackboardId."),
    prompt: z.string().max(4000).default("Analyze this video in detail. Describe key visual elements, actions, speech, and any visible text.").describe("What to analyze in the video."),
    model: z.string().min(1).optional().describe("Optional model override. Defaults to preset videoModel or NEXUS_VIDEO_MODEL env."),
    providerOrder: z.array(z.string()).optional().describe("OpenRouter provider slug ordering (e.g. ['google-ai-studio']). Overrides preset videoProviderOrder."),
    maxVideoBytes: z.number().int().min(64 * 1024).max(20 * 1024 * 1024).default(DEFAULT_MAX_VIDEO_BYTES).describe("Maximum allowed video file size in bytes (for local files only)."),
    timeoutMs: z.number().int().min(10_000).max(600_000).optional().describe("Request timeout override in milliseconds."),
  }).refine(
    (args) => {
      const sources = [args.path, args.url, args.blackboardId].filter(Boolean).length;
      return sources === 1;
    },
    { message: "Provide exactly one of `path`, `url`, or `blackboardId`." },
  ),
  execute: async (args, ctx) => {
    if (!ctx.llmConfig) return "ERROR: llmConfig is not available";
    if (args.root === "code" && !ctx.allowCodeEdit) return "ERROR: code root is disabled by policy";

    const timeoutMs = resolveTimeoutMs(args.timeoutMs);

    try {
      // ── Resolve video model & provider ──────────────────────────────
      const resolved = args.model
        ? { model: args.model.trim(), videoProvider: resolveDefaultVideoModel(ctx, ctx.llmConfig).videoProvider }
        : resolveDefaultVideoModel(ctx, ctx.llmConfig);

      let baseLlmConfig = ctx.llmConfig;
      let routeProvider = "default";
      if (resolved.videoProvider) {
        const routed = resolveOpenAiToolProviderConfig({
          ctx,
          provider: resolved.videoProvider,
          syntheticAgentId: "__video_tool__",
        });
        if ("error" in routed) {
          return `ERROR: ${routed.error}`;
        }
        baseLlmConfig = routed.config;
        routeProvider = routed.providerName;
      }

      const llm: OpenAICompatConfig = { ...baseLlmConfig, model: resolved.model };
      const routeUsed = `${routeProvider}:${llm.model}`;

      // Provider order: explicit param > preset config
      const providerOrder = args.providerOrder ?? resolved.videoProviderOrder;

      // ── Resolve video input ─────────────────────────────────────────
      let videoUrl: string;
      let sourceLabel: string;
      let fileSize: string | null = null;

      if (args.url) {
        // Direct URL — pass through to model
        const trimmed = args.url.trim();
        if (!/^https?:\/\//i.test(trimmed)) {
          return "ERROR: url must be a valid HTTP or HTTPS URL";
        }
        videoUrl = trimmed;
        sourceLabel = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
      } else if (args.blackboardId) {
        // Blackboard attachment
        const bb = await resolveVideoFromBlackboard({
          ctx,
          blackboardId: args.blackboardId,
          attachmentIndex: args.attachmentIndex,
        });
        const stat = await fs.stat(bb.absolutePath);
        if (!stat.isFile()) return `ERROR: not a file: ${bb.absolutePath}`;
        if (stat.size > args.maxVideoBytes) {
          return `ERROR: video too large (${formatBytes(stat.size)}). maxVideoBytes=${formatBytes(args.maxVideoBytes)}`;
        }
        const bytes = await fs.readFile(bb.absolutePath);
        const mimeType = bb.declaredMimeType?.split(";")[0]?.trim().toLowerCase() || detectVideoMimeFromPath(bb.absolutePath);
        if (!SUPPORTED_VIDEO_MIME_TYPES.has(mimeType)) {
          return `ERROR: unsupported video mime type (${mimeType}). Supported: ${[...SUPPORTED_VIDEO_MIME_TYPES].join(", ")}`;
        }
        videoUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
        sourceLabel = bb.sourceLabel;
        fileSize = formatBytes(bytes.length);
      } else {
        // Local file path
        const absolutePath = resolveWithinRoots({
          inputPath: args.path ?? "",
          defaultRoot: rootDir(ctx, args.root),
          roots: allowedRoots(ctx),
        });
        const stat = await fs.stat(absolutePath);
        if (!stat.isFile()) return `ERROR: not a file: ${absolutePath}`;
        if (stat.size > args.maxVideoBytes) {
          return `ERROR: video too large (${formatBytes(stat.size)}). maxVideoBytes=${formatBytes(args.maxVideoBytes)}`;
        }
        const bytes = await fs.readFile(absolutePath);
        const mimeType = detectVideoMimeFromPath(absolutePath);
        if (!SUPPORTED_VIDEO_MIME_TYPES.has(mimeType)) {
          return `ERROR: unsupported video mime type (${mimeType}). Supported: ${[...SUPPORTED_VIDEO_MIME_TYPES].join(", ")}`;
        }
        videoUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
        sourceLabel = args.path ?? absolutePath;
        fileSize = formatBytes(bytes.length);
      }

      // ── Send to LLM ────────────────────────────────────────────────
      const payload: Record<string, unknown> = {
        model: llm.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: args.prompt.trim() || "Analyze this video." },
              { type: "video_url", video_url: { url: videoUrl } },
            ],
          },
        ],
      };
      // OpenRouter provider routing preferences
      if (providerOrder && providerOrder.length > 0) {
        payload.provider = { order: providerOrder };
      }

      const json = await requestOpenAICompatChatCompletion({
        llm,
        payload,
        timeoutMs,
      });
      const choice = (json.choices as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
      const message = choice?.message as Record<string, unknown> | undefined;

      // Extract text content from response
      let analysis: string | null = null;
      const content = message?.content;
      if (typeof content === "string") {
        analysis = content.trim() || null;
      } else if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const part of content) {
          if (part && typeof part === "object") {
            const p = part as Record<string, unknown>;
            if (typeof p.text === "string") parts.push(p.text);
          }
        }
        analysis = parts.join("\n").trim() || null;
      }

      if (!analysis) return "ERROR: video analysis returned empty output";

      const lines = [
        "Video analysis complete.",
        `Source: ${sourceLabel}`,
        `Route: ${routeUsed}`,
        ...(fileSize ? [`Size: ${fileSize}`] : []),
        "",
        analysis,
      ];
      return lines.join("\n");
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
