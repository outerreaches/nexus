import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";
import { resolveWithinRoots } from "./path-utils.js";

const FILE_ROOTS = ["workspace", "state", "code"] as const;
type FileRoot = (typeof FILE_ROOTS)[number];

const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SUPPORTED_INLINE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
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

function detectMimeFromPath(filePath: string, fallbackMimeType?: string): string {
  const baseFallback = fallbackMimeType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (baseFallback) return baseFallback;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".tiff" || ext === ".tif") return "image/tiff";
  return "application/octet-stream";
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

function allowedRoots(ctx: { workspaceDir: string; stateDir: string; codeDir: string; allowCodeEdit?: boolean }): string[] {
  return [ctx.workspaceDir, ctx.stateDir, ...(ctx.allowCodeEdit ? [ctx.codeDir] : [])];
}

function rootDir(ctx: { workspaceDir: string; stateDir: string; codeDir: string }, root: FileRoot): string {
  if (root === "workspace") return ctx.workspaceDir;
  if (root === "state") return ctx.stateDir;
  return ctx.codeDir;
}

async function resolveImageFromBlackboard(params: {
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
  if (!row) {
    throw new Error(`blackboard entry not found: ${params.blackboardId}`);
  }

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
    throw new Error(
      `attachment index out of range (requested=${params.attachmentIndex}, available=${attachments.length})`,
    );
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

export const imageAnalyze = defineTool({
  name: "image_analyze",
  description:
    "Analyze an existing image file using the configured multimodal LLM. " +
    "You can pass a direct file path or a blackboard entry attachment reference.",
  parameters: z.object({
    root: z.enum(FILE_ROOTS).default("state").describe("Root for `path` resolution (ignored when using blackboardId)"),
    path: z
      .string()
      .optional()
      .describe("Image file path (relative to root, or absolute inside allowed roots)."),
    blackboardId: z.string().optional().describe("Blackboard entry ID to analyze an attachment from."),
    attachmentIndex: z
      .number()
      .int()
      .positive()
      .default(1)
      .describe("1-based attachment index when using blackboardId."),
    prompt: z
      .string()
      .max(4000)
      .default("Analyze this image in detail. Describe key visual elements and any visible text.")
      .describe("What to analyze in the image."),
    maxImageBytes: z
      .number()
      .int()
      .min(64 * 1024)
      .max(20 * 1024 * 1024)
      .default(DEFAULT_MAX_IMAGE_BYTES)
      .describe("Maximum allowed image size in bytes."),
  }).refine((args) => Boolean(args.path) || Boolean(args.blackboardId), {
    message: "Provide either `path` or `blackboardId`.",
  }),
  execute: async (args, ctx) => {
    if (!ctx.llm) return "ERROR: llm is not available";
    if (args.root === "code" && !ctx.allowCodeEdit) return "ERROR: code root is disabled by policy";

    try {
      const resolved = args.blackboardId
        ? await resolveImageFromBlackboard({
          ctx,
          blackboardId: args.blackboardId,
          attachmentIndex: args.attachmentIndex,
        })
        : {
          absolutePath: resolveWithinRoots({
            inputPath: args.path ?? "",
            defaultRoot: rootDir(ctx, args.root),
            roots: allowedRoots(ctx),
          }),
          sourceLabel: args.path ?? "(unknown path)",
          declaredMimeType: undefined,
        };

      const stat = await fs.stat(resolved.absolutePath);
      if (!stat.isFile()) return `ERROR: not a file: ${resolved.absolutePath}`;
      if (stat.size > args.maxImageBytes) {
        return `ERROR: image too large (${stat.size} bytes). maxImageBytes=${args.maxImageBytes}`;
      }

      const bytes = await fs.readFile(resolved.absolutePath);
      if (bytes.length > args.maxImageBytes) {
        return `ERROR: image too large (${bytes.length} bytes). maxImageBytes=${args.maxImageBytes}`;
      }

      const mimeType = detectMimeFromPath(resolved.absolutePath, resolved.declaredMimeType);
      if (!mimeType.startsWith("image/")) {
        return `ERROR: file is not an image (mime=${mimeType})`;
      }
      if (!SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(mimeType)) {
        return `ERROR: unsupported image mime for LLM inline analysis (${mimeType}). Supported: image/png, image/jpeg, image/webp, image/gif`;
      }

      const dataUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
      const result = await ctx.llm.completeChat({
        messages: [
          {
            role: "system",
            content:
              "You are an image analyst. Be factual and concise. If details are uncertain, say so clearly.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: args.prompt.trim() || "Analyze this image." },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        tools: [],
        temperature: 0.1,
        timeoutMode: "extended",
        allowImageFallback: false,
      });

      const analysis = result.content?.trim();
      if (!analysis) return "ERROR: image analysis returned empty output";
      return [
        `Image analysis complete.`,
        `Source: ${resolved.sourceLabel}`,
        `File: ${resolved.absolutePath}`,
        `MIME: ${mimeType}`,
        `Bytes: ${bytes.length}`,
        "",
        analysis,
      ].join("\n");
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
