import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";
import { getSecret } from "../secrets/resolve-env.js";
import { resolveWithinRoots } from "./path-utils.js";
import { resolveToolRoute } from "./tool-routing.js";

const FILE_ROOTS = ["workspace", "state", "code"] as const;
type FileRoot = (typeof FILE_ROOTS)[number];

const QUIVER_VECTORIZE_ENDPOINT = "https://api.quiver.ai/v1/svgs/vectorizations";
const DEFAULT_MODEL = "arrow-preview";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_SVG_BYTES = 2 * 1024 * 1024;

const SUPPORTED_INPUT_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

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

function sanitizeFileStem(raw: string): string {
  const base = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!base) return "vectorized";
  return base.slice(0, 80);
}

function resolveTimeoutMs(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return Math.max(10_000, envInt("NEXUS_VECTORIZE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));
}

function truncateForError(raw: string, maxChars = 240): string {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
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
      return {
        root,
        path: normalized.slice(prefix.length),
      };
    }
  }
  return null;
}

async function resolveInputImageFromBlackboard(params: {
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
}): Promise<{ absolutePath: string; declaredMimeType?: string; sourceLabel: string }> {
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
  if (!rawPath) {
    throw new Error(`attachment ${params.attachmentIndex} has no path`);
  }

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

function detectMimeTypeFromPath(filePath: string, declared?: string): string {
  const declaredMime = declared?.split(";")[0]?.trim().toLowerCase();
  if (declaredMime && declaredMime.startsWith("image/")) return declaredMime;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function normalizeSvg(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/<svg(?:\s|>)/i.test(trimmed)) return null;
  return trimmed;
}

function extractVectorizedSvg(json: unknown): { svg: string; responseId: string | null } | null {
  if (!json || typeof json !== "object") return null;
  const record = json as Record<string, unknown>;
  const data = Array.isArray(record.data) ? record.data : [];

  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const svg = normalizeSvg(obj.svg);
    if (!svg) continue;
    return {
      svg,
      responseId: typeof record.id === "string" ? record.id : null,
    };
  }

  const topLevelSvg = normalizeSvg(record.svg);
  if (!topLevelSvg) return null;
  return {
    svg: topLevelSvg,
    responseId: typeof record.id === "string" ? record.id : null,
  };
}

async function fetchWithTimeout(params: {
  url: string;
  init: RequestInit;
  timeoutMs: number;
}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    return await fetch(params.url, { ...params.init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`request timed out after ${params.timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function vectorizeWithQuiver(params: {
  apiKey: string;
  endpoint: string;
  model: string;
  prompt: string;
  image: { url: string } | { base64: string };
  timeoutMs: number;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  instructions?: string;
}): Promise<{ svg: string; responseId: string | null }> {
  const basePayload: Record<string, unknown> = {
    model: params.model,
    prompt: params.prompt,
    stream: false,
  };
  if (typeof params.maxOutputTokens === "number") basePayload.max_output_tokens = params.maxOutputTokens;
  if (typeof params.temperature === "number") basePayload.temperature = params.temperature;
  if (typeof params.topP === "number") basePayload.top_p = params.topP;
  if (typeof params.presencePenalty === "number") basePayload.presence_penalty = params.presencePenalty;
  if (typeof params.instructions === "string" && params.instructions.trim()) basePayload.instructions = params.instructions.trim();

  const payload: Record<string, unknown> = {
    ...basePayload,
    image: params.image,
  };

  const res = await fetchWithTimeout({
    url: params.endpoint,
    timeoutMs: params.timeoutMs,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  });

  const bodyText = await res.text();
  if (!res.ok) {
    const detail = truncateForError(bodyText || `${res.status} ${res.statusText}`);
    throw new Error(`Quiver vectorization API error (${res.status}): ${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw new Error(`Quiver vectorization API returned non-JSON output: ${truncateForError(bodyText)}`);
  }

  const extracted = extractVectorizedSvg(parsed);
  if (extracted) return extracted;
  throw new Error(`Quiver vectorization API response did not include SVG output: ${truncateForError(bodyText)}`);
}

export const vectorize = defineTool({
  name: "vectorize",
  description:
    "Convert a raster image into SVG using Quiver image-to-SVG, save the output file, and optionally persist as a blackboard artifact.",
  parameters: z
    .object({
      inputRoot: z.enum(FILE_ROOTS).default("state").describe("Input root for inputPath resolution."),
      inputPath: z.string().optional().describe("Input image path (relative to inputRoot, or absolute in allowed roots)."),
      inputUrl: z.string().optional().describe("Optional public HTTP(S) image URL to vectorize."),
      inputBlackboardId: z.string().optional().describe("Blackboard entry ID to load input image attachment from."),
      inputAttachmentIndex: z
        .number()
        .int()
        .positive()
        .default(1)
        .describe("1-based attachment index when using inputBlackboardId."),
      prompt: z
        .string()
        .max(4000)
        .default("Vectorize this image into a clean, high-quality SVG while preserving core shapes and colors.")
        .describe("Vectorization guidance prompt."),
      instructions: z.string().max(4000).optional().describe("Optional system-style guidance passed to Quiver."),
      model: z.string().min(1).optional().describe(`Optional model override. Defaults to ${DEFAULT_MODEL} or NEXUS_VECTORIZE_MODEL.`),
      maxOutputTokens: z.number().int().min(64).max(32_768).optional().describe("Optional max output token limit for SVG generation."),
      temperature: z.number().min(0).max(2).optional().describe("Optional sampling temperature."),
      topP: z.number().min(0).max(1).optional().describe("Optional nucleus sampling value."),
      presencePenalty: z.number().min(-2).max(2).optional().describe("Optional presence penalty."),
      timeoutMs: z.number().int().min(10_000).max(600_000).optional().describe("Request timeout override in milliseconds."),
      maxInputImageBytes: z
        .number()
        .int()
        .min(64 * 1024)
        .max(40 * 1024 * 1024)
        .default(DEFAULT_MAX_INPUT_IMAGE_BYTES)
        .describe("Maximum allowed input image size in bytes when reading local files."),
      root: z.enum(FILE_ROOTS).default("workspace").describe("Output root for vectorized SVG files."),
      path: z.string().optional().describe("Output file path (relative to root or absolute in allowed roots)."),
      fileStem: z
        .string()
        .max(120)
        .optional()
        .describe("Base filename when path is not provided. Defaults to a timestamped `vectorized-*` name."),
      maxSvgBytes: z
        .number()
        .int()
        .min(1024)
        .max(10 * 1024 * 1024)
        .default(DEFAULT_MAX_SVG_BYTES)
        .describe("Maximum size for the generated SVG file in bytes."),
      writeToBlackboard: z.boolean().default(true).describe("If true, store the vectorized SVG as a blackboard attachment."),
      blackboardTitle: z.string().max(200).optional().describe("Optional blackboard artifact title."),
      blackboardTtlMs: z
        .number()
        .int()
        .min(60_000)
        .max(30 * 24 * 60 * 60_000)
        .optional()
        .describe("Optional blackboard TTL in ms."),
    })
    .refine(
      (args) => {
        const sources = [args.inputPath, args.inputUrl, args.inputBlackboardId].filter(Boolean).length;
        return sources === 1;
      },
      { message: "Provide exactly one of `inputPath`, `inputUrl`, or `inputBlackboardId`." },
    ),
  execute: async (args, ctx) => {
    if (args.root === "code" && !ctx.allowCodeEdit) return "ERROR: code root is disabled by policy";
    if (args.inputRoot === "code" && !ctx.allowCodeEdit) return "ERROR: code root is disabled by policy for inputPath";

    const apiKey = (getSecret("QUIVER_SVG_API_KEY") ?? "").trim();
    if (!apiKey) {
      return [
        "ERROR: missing QUIVER_SVG_API_KEY.",
        "Configure config.secrets.env.QUIVER_SVG_API_KEY with your sidecar secret reference.",
      ].join(" ");
    }

    const configuredRoute = resolveToolRoute(ctx, "vectorize");
    const configuredProvider = typeof configuredRoute?.target.provider === "string"
      ? configuredRoute.target.provider.trim().toLowerCase()
      : "";
    if (configuredProvider && configuredProvider !== "quiver") {
      return `ERROR: vectorize only supports provider='quiver' (received '${configuredProvider}')`;
    }
    const configuredEndpoint = typeof configuredRoute?.target.endpoint === "string"
      ? configuredRoute.target.endpoint.trim()
      : "";
    const endpoint = configuredEndpoint || (process.env.NEXUS_QUIVER_VECTORIZE_ENDPOINT ?? "").trim() || QUIVER_VECTORIZE_ENDPOINT;
    const selectedModel =
      args.model?.trim() ||
      (typeof configuredRoute?.target.model === "string" ? configuredRoute.target.model.trim() : "") ||
      (process.env.NEXUS_VECTORIZE_MODEL ?? "").trim() ||
      DEFAULT_MODEL;
    const timeoutMs = resolveTimeoutMs(args.timeoutMs);

    let image: { url: string } | { base64: string };
    let sourceLabel: string;
    let inputSizeBytes: number | null = null;

    try {
      if (args.inputUrl) {
        const trimmed = args.inputUrl.trim();
        if (!/^https?:\/\//i.test(trimmed)) {
          return "ERROR: inputUrl must be a valid HTTP or HTTPS URL";
        }
        image = { url: trimmed };
        sourceLabel = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
      } else {
        let absolutePath: string;
        let declaredMime: string | undefined;

        if (args.inputBlackboardId) {
          const fromBlackboard = await resolveInputImageFromBlackboard({
            ctx,
            blackboardId: args.inputBlackboardId,
            attachmentIndex: args.inputAttachmentIndex,
          });
          absolutePath = fromBlackboard.absolutePath;
          declaredMime = fromBlackboard.declaredMimeType;
          sourceLabel = fromBlackboard.sourceLabel;
        } else {
          absolutePath = resolveWithinRoots({
            inputPath: args.inputPath ?? "",
            defaultRoot: rootDir(ctx, args.inputRoot),
            roots: allowedRoots(ctx),
          });
          sourceLabel = args.inputPath ?? absolutePath;
        }

        const stat = await fs.stat(absolutePath);
        if (!stat.isFile()) return `ERROR: input image is not a file: ${absolutePath}`;
        if (stat.size > args.maxInputImageBytes) {
          return `ERROR: input image too large (${stat.size} bytes). maxInputImageBytes=${args.maxInputImageBytes}`;
        }

        const bytes = await fs.readFile(absolutePath);
        if (bytes.length > args.maxInputImageBytes) {
          return `ERROR: input image too large (${bytes.length} bytes). maxInputImageBytes=${args.maxInputImageBytes}`;
        }

        const mimeType = detectMimeTypeFromPath(absolutePath, declaredMime);
        if (!SUPPORTED_INPUT_MIME_TYPES.has(mimeType)) {
          return `ERROR: unsupported input image mime (${mimeType}). Supported: ${[...SUPPORTED_INPUT_MIME_TYPES].join(", ")}`;
        }

        image = { base64: bytes.toString("base64") };
        inputSizeBytes = bytes.length;
      }
    } catch (err) {
      return `ERROR: failed to resolve input image: ${err instanceof Error ? err.message : String(err)}`;
    }

    let vectorized: { svg: string; responseId: string | null };
    try {
      vectorized = await vectorizeWithQuiver({
        apiKey,
        endpoint,
        model: selectedModel,
        prompt: args.prompt,
        image,
        timeoutMs,
        maxOutputTokens: args.maxOutputTokens,
        temperature: args.temperature,
        topP: args.topP,
        presencePenalty: args.presencePenalty,
        instructions: args.instructions,
      });
    } catch (err) {
      return `ERROR: vectorize model=${selectedModel}: ${err instanceof Error ? err.message : String(err)}`;
    }

    const svgBytes = Buffer.from(vectorized.svg, "utf8");
    if (svgBytes.length > args.maxSvgBytes) {
      return `ERROR: vectorized SVG exceeds maxSvgBytes (${svgBytes.length} > ${args.maxSvgBytes})`;
    }

    const defaultRoot = rootDir(ctx, args.root);
    const roots = allowedRoots(ctx);
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const stem = sanitizeFileStem(args.fileStem ?? `vectorized-${stamp}`);

    const outputPathInput = args.path?.trim()
      ? (path.extname(args.path.trim()) ? args.path.trim() : `${args.path.trim()}.svg`)
      : path.join("vectorized-images", day, `${stem}.svg`);

    const absolutePath = resolveWithinRoots({
      inputPath: outputPathInput,
      defaultRoot,
      roots,
    });
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, vectorized.svg, "utf8");

    const resolvedRoot = path.resolve(defaultRoot);
    const relativePath = absolutePath.startsWith(`${resolvedRoot}${path.sep}`)
      ? path.relative(resolvedRoot, absolutePath).split(path.sep).join("/")
      : null;

    let blackboardId: string | null = null;
    if (args.writeToBlackboard) {
      const db = requireDb(ctx);
      if (!db) return "ERROR: database is not available for blackboard persistence";

      const nowMs = ctx.nowMs();
      blackboardId = crypto.randomUUID();
      const expiresAt = typeof args.blackboardTtlMs === "number" ? nowMs + args.blackboardTtlMs : null;
      const attachments = [
        {
          path: absolutePath,
          mimeType: "image/svg+xml",
          relativePath: relativePath ?? undefined,
          sizeBytes: svgBytes.length,
        },
      ];
      const lines = [
        "Vectorization artifact.",
        `Provider route: quiver:${selectedModel}`,
        ...(vectorized.responseId ? [`Response ID: ${vectorized.responseId}`] : []),
        `Source: ${sourceLabel}`,
        `Prompt: ${args.prompt}`,
        ...(args.instructions?.trim() ? [`Instructions: ${args.instructions.trim()}`] : []),
        "",
        `Output: ${absolutePath} (image/svg+xml, ${formatBytes(svgBytes.length)})`,
      ];

      const metadata: Record<string, unknown> = {
        source: "vectorize",
        provider: "quiver",
        model: selectedModel,
        responseId: vectorized.responseId,
        input: {
          source: sourceLabel,
          bytes: inputSizeBytes,
        },
        output: {
          path: absolutePath,
          relativePath,
          sizeBytes: svgBytes.length,
        },
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
          ctx.request?.preset ?? "unknown",
          args.blackboardTitle?.trim() || "Vectorized SVG",
          lines.join("\n"),
          JSON.stringify(attachments),
          JSON.stringify(metadata),
          nowMs,
          nowMs,
          expiresAt,
        );
    }

    return JSON.stringify(
      {
        status: "ok",
        provider: "quiver",
        model: selectedModel,
        responseId: vectorized.responseId,
        source: sourceLabel,
        inputSizeBytes,
        output: {
          path: absolutePath,
          relativePath,
          mimeType: "image/svg+xml",
          sizeBytes: svgBytes.length,
        },
        blackboardId,
      },
      null,
      2,
    );
  },
});
