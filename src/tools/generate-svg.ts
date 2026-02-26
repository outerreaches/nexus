import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";
import { getSecret } from "../secrets/resolve-env.js";
import { resolveWithinRoots } from "./path-utils.js";

const FILE_ROOTS = ["workspace", "state", "code"] as const;
type FileRoot = (typeof FILE_ROOTS)[number];

const QUIVER_SVG_ENDPOINT = "https://api.quiver.ai/v1/svgs/generations";
const DEFAULT_MODEL = "arrow-preview";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_SVG_BYTES = 2 * 1024 * 1024;

type GeneratedSvg = {
  svg: string;
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
  if (!base) return "svg";
  return base.slice(0, 80);
}

function resolveTimeoutMs(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return Math.max(10_000, envInt("NEXUS_SVG_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));
}

function truncateForError(raw: string, maxChars = 240): string {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function unwrapMarkdownCodeFence(raw: string): string {
  const match = raw.match(/^```(?:svg|xml)?\s*([\s\S]*?)```$/i);
  if (!match) return raw;
  return (match[1] ?? "").trim();
}

function normalizeSvg(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = unwrapMarkdownCodeFence(raw.trim());
  if (!trimmed) return null;
  if (!/<svg(?:\s|>)/i.test(trimmed)) return null;
  return trimmed;
}

function extractGeneratedSvgs(json: unknown): GeneratedSvg[] {
  if (!json || typeof json !== "object") return [];
  const record = json as Record<string, unknown>;
  const data = Array.isArray(record.data) ? record.data : [];
  const out: GeneratedSvg[] = [];

  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const svg = normalizeSvg(obj.svg);
    if (!svg) continue;
    out.push({ svg });
  }

  if (out.length > 0) return out;

  // Tolerate single-object responses to avoid hard failures on minor API shape changes.
  const topLevelSvg = normalizeSvg(record.svg);
  if (topLevelSvg) return [{ svg: topLevelSvg }];

  return [];
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

async function generateSvgsWithQuiver(params: {
  apiKey: string;
  prompt: string;
  model: string;
  n: number;
  timeoutMs: number;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  instructions?: string;
}): Promise<{ svgs: GeneratedSvg[]; responseId: string | null }> {
  const payload: Record<string, unknown> = {
    prompt: params.prompt,
    model: params.model,
    n: params.n,
    stream: false,
  };
  if (typeof params.maxOutputTokens === "number") payload.max_output_tokens = params.maxOutputTokens;
  if (typeof params.temperature === "number") payload.temperature = params.temperature;
  if (typeof params.topP === "number") payload.top_p = params.topP;
  if (typeof params.presencePenalty === "number") payload.presence_penalty = params.presencePenalty;
  if (typeof params.instructions === "string" && params.instructions.trim()) payload.instructions = params.instructions.trim();

  const res = await fetchWithTimeout({
    url: QUIVER_SVG_ENDPOINT,
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
    throw new Error(`Quiver SVG API error (${res.status}): ${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw new Error(`Quiver SVG API returned non-JSON output: ${truncateForError(bodyText)}`);
  }

  const svgs = extractGeneratedSvgs(parsed);
  if (svgs.length === 0) {
    throw new Error(`Quiver SVG API response did not include SVG output: ${truncateForError(bodyText)}`);
  }

  const responseId =
    parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).id === "string"
      ? ((parsed as Record<string, unknown>).id as string)
      : null;

  return {
    svgs,
    responseId,
  };
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

export const generateSvg = defineTool({
  name: "generate_svg",
  description:
    "Generate SVG assets from text prompts using Quiver, save files to disk, and optionally write a blackboard artifact.",
  parameters: z.object({
    prompt: z.string().min(1).max(8000).describe("Text prompt describing the SVG to generate."),
    instructions: z.string().max(4000).optional().describe("Optional system-style guidance passed to Quiver."),
    model: z.string().min(1).optional().describe(`Optional model override. Defaults to ${DEFAULT_MODEL} or NEXUS_SVG_MODEL.`),
    n: z.number().int().min(1).max(4).default(1).describe("Number of SVG variants to request."),
    maxOutputTokens: z.number().int().min(64).max(32_768).optional().describe("Optional max output token limit for SVG generation."),
    temperature: z.number().min(0).max(2).optional().describe("Optional sampling temperature."),
    topP: z.number().min(0).max(1).optional().describe("Optional nucleus sampling value."),
    presencePenalty: z.number().min(-2).max(2).optional().describe("Optional presence penalty."),
    timeoutMs: z.number().int().min(10_000).max(600_000).optional().describe("Request timeout override in milliseconds."),
    root: z.enum(FILE_ROOTS).default("workspace").describe("Output root for generated SVG files."),
    path: z
      .string()
      .optional()
      .describe("Output file path (relative to root or absolute in allowed roots). For multiple SVGs, numeric suffixes are appended."),
    fileStem: z
      .string()
      .max(120)
      .optional()
      .describe("Base filename when path is not provided. Defaults to a timestamped `svg-*` name."),
    maxSvgBytes: z
      .number()
      .int()
      .min(1024)
      .max(10 * 1024 * 1024)
      .default(DEFAULT_MAX_SVG_BYTES)
      .describe("Maximum size per SVG file in bytes."),
    writeToBlackboard: z.boolean().default(true).describe("If true, store generated SVG files as blackboard attachments."),
    blackboardTitle: z.string().max(200).optional().describe("Optional blackboard artifact title."),
    blackboardTtlMs: z
      .number()
      .int()
      .min(60_000)
      .max(30 * 24 * 60 * 60_000)
      .optional()
      .describe("Optional blackboard TTL in ms."),
  }),
  execute: async (args, ctx) => {
    if (args.root === "code" && !ctx.allowCodeEdit) return "ERROR: code root is disabled by policy";

    const apiKey = (getSecret("QUIVER_SVG_API_KEY") ?? "").trim();
    if (!apiKey) {
      return [
        "ERROR: missing QUIVER_SVG_API_KEY.",
        "Configure config.secrets.env.QUIVER_SVG_API_KEY with your sidecar secret reference.",
      ].join(" ");
    }

    const timeoutMs = resolveTimeoutMs(args.timeoutMs);
    const selectedModel = args.model?.trim() || (process.env.NEXUS_SVG_MODEL ?? "").trim() || DEFAULT_MODEL;

    let generation: { svgs: GeneratedSvg[]; responseId: string | null };
    try {
      generation = await generateSvgsWithQuiver({
        apiKey,
        prompt: args.prompt,
        instructions: args.instructions,
        model: selectedModel,
        n: args.n,
        timeoutMs,
        maxOutputTokens: args.maxOutputTokens,
        temperature: args.temperature,
        topP: args.topP,
        presencePenalty: args.presencePenalty,
      });
    } catch (err) {
      return `ERROR: generate_svg model=${selectedModel}: ${err instanceof Error ? err.message : String(err)}`;
    }

    const requestedCount = Math.min(args.n, generation.svgs.length);
    const defaultRoot = rootDir(ctx, args.root);
    const roots = allowedRoots(ctx);
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const stem = sanitizeFileStem(args.fileStem ?? `svg-${stamp}`);

    const savedFiles: Array<{
      path: string;
      mimeType: string;
      sizeBytes: number;
      relativePath: string | null;
    }> = [];

    for (let i = 0; i < requestedCount; i += 1) {
      const output = generation.svgs[i]!;
      const bytes = Buffer.from(output.svg, "utf8");
      if (bytes.length > args.maxSvgBytes) {
        return `ERROR: generated SVG ${i + 1} exceeds maxSvgBytes (${bytes.length} > ${args.maxSvgBytes})`;
      }

      let outputPathInput: string;
      if (args.path?.trim()) {
        const raw = args.path.trim();
        if (requestedCount === 1) {
          outputPathInput = path.extname(raw) ? raw : `${raw}.svg`;
        } else {
          const parsed = path.parse(raw);
          const baseName = parsed.name || "svg";
          const outExt = parsed.ext || ".svg";
          outputPathInput = path.join(parsed.dir, `${baseName}-${String(i + 1).padStart(2, "0")}${outExt}`);
        }
      } else {
        outputPathInput = path.join("generated-svgs", day, `${stem}-${String(i + 1).padStart(2, "0")}.svg`);
      }

      const absolutePath = resolveWithinRoots({
        inputPath: outputPathInput,
        defaultRoot,
        roots,
      });
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, output.svg, "utf8");

      const resolvedRoot = path.resolve(defaultRoot);
      const relativePath = absolutePath.startsWith(`${resolvedRoot}${path.sep}`)
        ? path.relative(resolvedRoot, absolutePath).split(path.sep).join("/")
        : null;

      savedFiles.push({
        path: absolutePath,
        mimeType: "image/svg+xml",
        sizeBytes: bytes.length,
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
        "Generated SVG artifact.",
        `Provider route: quiver:${selectedModel}`,
        ...(generation.responseId ? [`Response ID: ${generation.responseId}`] : []),
        `Prompt: ${args.prompt}`,
        ...(args.instructions?.trim() ? [`Instructions: ${args.instructions.trim()}`] : []),
        "",
        "Files:",
        ...savedFiles.map((file, idx) => `- ${idx + 1}. ${file.path} (${file.mimeType}, ${formatBytes(file.sizeBytes)})`),
      ];

      const metadata: Record<string, unknown> = {
        source: "generate_svg",
        provider: "quiver",
        model: selectedModel,
        count: savedFiles.length,
        responseId: generation.responseId,
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
          args.blackboardTitle?.trim() || `Generated SVG (${savedFiles.length})`,
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
        responseId: generation.responseId,
        prompt: args.prompt,
        files: savedFiles,
        blackboardId,
      },
      null,
      2,
    );
  },
});
