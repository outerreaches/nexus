import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";
import { isTelegramUserAllowed } from "../gateway/telegram-store.js";

type TelegramCtx = {
  sendOutput: (chatId: number, output: string) => Promise<void>;
  allowFrom: number[];
  allowAll: boolean;
};

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

export const telegramSend = defineTool({
  name: "telegram_send",
  description:
    "Send a Telegram message proactively. If chatId is omitted, uses the current telegram chat (if applicable) or the most recent telegram chat for this agent. Only sends to allowlisted user ids.",
  parameters: z.object({
    text: z.string().min(1).max(20_000),
    chatId: z.number().int().positive().optional().describe("Telegram chat id (private chats are positive integers)"),
  }),
  execute: async (args, ctx) => {
    const db = ctx.db as NexusDatabase | undefined;
    if (!db) return "ERROR: database is not available";

    const tg = ctx.telegram as TelegramCtx | undefined;
    if (!tg) return "ERROR: telegram is not configured";

    let chatId: number | null = args.chatId ?? null;
    if (!chatId && ctx.request?.channel === "telegram") {
      const id = Number(ctx.request.channelKey);
      if (Number.isFinite(id)) chatId = id;
    }
    if (!chatId && ctx.request?.agentId) {
      chatId = await resolveDefaultTelegramChatId(db, ctx.request.agentId);
    }

    if (!chatId) return "ERROR: missing chatId (no active/recent telegram chat found)";
    if (chatId <= 0) return "ERROR: only private-chat chatIds are supported for telegram_send";

    const allowed = isTelegramUserAllowed(db, { userId: chatId, staticAllowFrom: tg.allowFrom ?? [], allowAll: Boolean(tg.allowAll) });
    if (!allowed) return "ERROR: chatId is not allowlisted";

    try {
      await tg.sendOutput(chatId, args.text);
      return "OK";
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

