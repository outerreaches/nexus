import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";
import { isTelegramUserAllowed } from "../gateway/telegram-store.js";

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

async function resolveTelegramChatId(argsChatId: number | undefined, ctx: ToolCtx, db: NexusDatabase): Promise<number | null> {
  let chatId: number | null = argsChatId ?? null;
  if (!chatId && ctx.request?.channel === "telegram") {
    const id = Number(ctx.request.channelKey);
    if (Number.isFinite(id) && id > 0) chatId = Math.trunc(id);
  }
  if (!chatId && ctx.request?.agentId) {
    chatId = await resolveDefaultTelegramChatId(db, ctx.request.agentId);
  }
  return chatId;
}

export const telegramSend = defineTool({
  name: "telegram_send",
  description:
    "Send Telegram output (text or file). If chatId is omitted, uses the current telegram chat (if applicable) or the most recent telegram chat for this agent. Only sends to allowlisted user ids.",
  parameters: z.object({
    text: z.string().min(1).max(20_000).optional().describe("Text message to send, or caption when path is set"),
    path: z.string().min(1).optional().describe("Optional file path to send (absolute or repo-relative)"),
    caption: z.string().max(1024).optional().describe("Optional file caption (used only when path is set)"),
    chatId: z.number().int().positive().optional().describe("Telegram chat id (private chats are positive integers)"),
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

    const chatId = await resolveTelegramChatId(args.chatId, toolCtx, db);

    if (!chatId) return "ERROR: missing chatId (no active/recent telegram chat found)";
    if (chatId <= 0) return "ERROR: only private-chat chatIds are supported for telegram_send";

    const allowed = isTelegramUserAllowed(db, { userId: chatId, staticAllowFrom: tg.allowFrom ?? [], allowAll: Boolean(tg.allowAll) });
    if (!allowed) return "ERROR: chatId is not allowlisted";

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

export const telegramSendFile = defineTool({
  name: "telegram_send_file",
  description:
    "Deprecated compatibility alias for telegram_send(path=...). Sends a file to Telegram.",
  parameters: z.object({
    path: z.string().min(1).describe("Absolute or repo-relative path to a file"),
    caption: z.string().max(1024).optional().describe("Optional Telegram caption"),
    chatId: z.number().int().positive().optional().describe("Telegram chat id (private chats are positive integers)"),
  }),
  execute: async (args, ctx) => {
    return telegramSend.execute(
      {
        path: args.path,
        ...(args.caption ? { caption: args.caption } : {}),
        ...(args.chatId ? { chatId: args.chatId } : {}),
      },
      ctx,
    );
  },
});
