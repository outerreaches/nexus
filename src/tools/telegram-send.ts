import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";
import { isTelegramUserAllowed } from "../gateway/telegram-store.js";
import { resolveTelegramDestination } from "../gateway/telegram-destination.js";

type TelegramCtx = {
  sendOutput: (chatId: number, output: string) => Promise<void>;
  sendFile: (chatId: number, filePath: string, options?: { caption?: string }) => Promise<void>;
  allowFrom: number[];
  allowAll: boolean;
};

type ToolCtx = {
  db?: unknown;
  telegram?: unknown;
  request?: { channel: string; channelKey: string; agentId: string };
  stateDir: string;
  workspaceDir: string;
  codeDir: string;
};

function isWithinPath(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

async function resolveTelegramFilePath(requestedPath: string, ctx: ToolCtx): Promise<string> {
  const raw = requestedPath.trim();
  if (!raw) throw new Error("path is required");

  const candidates: string[] = [];
  if (path.isAbsolute(raw)) {
    candidates.push(path.resolve(raw));
  } else {
    if (raw.startsWith("state/")) {
      candidates.push(path.resolve(path.join(ctx.stateDir, raw.slice("state/".length))));
    } else if (raw.startsWith("workspace/")) {
      candidates.push(path.resolve(path.join(ctx.workspaceDir, raw.slice("workspace/".length))));
    } else if (raw.startsWith("code/")) {
      candidates.push(path.resolve(path.join(ctx.codeDir, raw.slice("code/".length))));
    }
    candidates.push(
      path.resolve(path.join(ctx.stateDir, raw)),
      path.resolve(path.join(ctx.workspaceDir, raw)),
      path.resolve(path.join(ctx.codeDir, raw)),
      path.resolve(raw),
    );
  }

  const allowAnyPath = process.env.NEXUS_TELEGRAM_SEND_FILE_ALLOW_ANY === "1";
  const allowedRoots = [path.resolve(ctx.stateDir), path.resolve(ctx.workspaceDir), path.resolve(ctx.codeDir)];

  for (const candidate of uniqueStrings(candidates)) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }

    if (!allowAnyPath && !allowedRoots.some((root) => isWithinPath(candidate, root))) {
      throw new Error("file path is outside allowed roots (set NEXUS_TELEGRAM_SEND_FILE_ALLOW_ANY=1 to override)");
    }
    return candidate;
  }

  throw new Error(`file not found: ${requestedPath}`);
}

export const telegramSend = defineTool({
  name: "telegram_send",
  description:
    "Send Telegram output (text or file) to the user. Routes to the active Telegram chat when invoked from one, otherwise to the home session pinned via /sethome. The destination is determined by the system and cannot be overridden.",
  parameters: z.object({
    text: z.string().min(1).max(20_000).optional().describe("Text message to send, or caption when path is set"),
    path: z.string().min(1).optional().describe("Optional file path to send (absolute or repo-relative)"),
    caption: z.string().max(1024).optional().describe("Optional file caption (used only when path is set)"),
  }).superRefine((value, issueCtx) => {
    if (value.text || value.path) return;
    issueCtx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Either text or path is required",
      path: ["text"],
    });
  }),
  execute: async (args, ctx) => {
    const toolCtx = ctx as ToolCtx;
    const db = toolCtx.db as NexusDatabase | undefined;
    if (!db) return "ERROR: database is not available";

    const tg = toolCtx.telegram as TelegramCtx | undefined;
    if (!tg) return "ERROR: telegram is not configured";

    if (!toolCtx.request?.agentId) return "ERROR: missing agent context";

    const destination = resolveTelegramDestination({
      db,
      agentId: toolCtx.request.agentId,
      request: toolCtx.request,
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
      return `ERROR: resolved chat ${chatId} (source=${destination.source}) is not allowlisted; ask the user to /sethome from an allowlisted chat`;
    }

    const normalizedText = typeof args.text === "string" ? args.text.trim() : "";
    if (!args.path && normalizedText.length === 0) {
      return "ERROR: telegram_send text is blank. Provide a concise user-facing update before sending.";
    }

    if (args.path) {
      let filePath: string;
      try {
        filePath = await resolveTelegramFilePath(args.path, toolCtx);
      } catch (err) {
        return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }

      const textCaption = normalizedText && normalizedText.length > 1024 ? normalizedText.slice(0, 1024) : normalizedText || undefined;
      const caption = args.caption ?? textCaption;
      const captionNote = normalizedText && normalizedText.length > 1024 && !args.caption
        ? " (caption truncated from text)"
        : "";

      try {
        if (caption) {
          await tg.sendFile(chatId, filePath, { caption });
        } else {
          await tg.sendFile(chatId, filePath);
        }
        return `OK: sent ${path.basename(filePath)} to chat ${chatId}${captionNote}`;
      } catch (err) {
        return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    try {
      await tg.sendOutput(chatId, normalizedText);
      return "OK";
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});
