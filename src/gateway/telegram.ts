import type { Hono } from "hono";
import { Bot, Context } from "grammy";

import type { NexusConfig } from "../state/config.js";
import type { AgentService } from "../core/agent-service.js";
import type { NexusDatabase } from "../storage/database.js";
import { createPairingRequest, isTelegramUserAllowed } from "./telegram-store.js";

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

function joinPublicUrl(publicUrl: string, path: string): string {
  const base = publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`;
  const p = path.startsWith("/") ? path.slice(1) : path;
  return new URL(p, base).toString();
}

export async function startTelegramBot(deps: {
  config: NexusConfig;
  agent: AgentService;
  configPath: string;
  db: NexusDatabase;
  app: Hono;
  log: (msg: string) => void;
}): Promise<{ stop: () => Promise<void> } | null> {
  const tg = deps.config.channels.telegram;
  if (!tg.enabled) return null;
  const token = tg.token && !isEnvPlaceholder(tg.token) ? tg.token : process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("Telegram is enabled but no token is configured (set TELEGRAM_BOT_TOKEN).");
  }

  const bot = new Bot(token);
  const me = await bot.api.getMe();
  const botUsername = me.username ?? "";

  deps.log(`telegram: bot @${botUsername || me.id} starting`);

  bot.on("message:text", async (ctx) => {
    try {
      const text = ctx.message?.text ?? "";
      const userId = ctx.from?.id;
      const chatId = ctx.chat?.id;
      if (!userId || !chatId) return;
      deps.log(`telegram: msg user_id=${userId} chat_id=${chatId} kind=${ctx.chat?.type ?? "unknown"}`);

      const allowAll = process.env.NEXUS_TELEGRAM_ALLOW_ALL === "1";
      const allowFrom = tg.allowFrom ?? [];
      const allowed = isTelegramUserAllowed(deps.db, {
        userId,
        staticAllowFrom: allowFrom,
        allowAll,
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
          if (req.created && req.code) {
            deps.log(`telegram: pairing request user_id=${userId} code=${req.code}`);
            await ctx.reply(
              [
                "Pairing required.",
                "",
                `Your pairing code: ${req.code}`,
                "",
                "Ask the operator to approve it on the host running Nexus:",
                `nexus pairing approve telegram ${req.code}`,
                "",
                "Your messages will be ignored until approved.",
              ].join("\n"),
            );
          } else if (req.code) {
            deps.log(`telegram: pairing request already pending user_id=${userId} code=${req.code}`);
          } else {
            deps.log(`telegram: pairing request not created user_id=${userId} reason=max_pending`);
          }
          return;
        }

        return;
      }

      if (isGroupChat(ctx) && tg.requireMentionInGroups) {
        const mentioned = botUsername ? text.includes(`@${botUsername}`) : false;
        const invoked = text.startsWith("/nexus") || text.startsWith("/n");
        if (!mentioned && !invoked) {
          deps.log(`telegram: ignore user_id=${userId} chat_id=${chatId} reason=require_mention`);
          return;
        }
      }

      const cleaned = text
        .replace(botUsername ? new RegExp(`@${botUsername}\\b`, "g") : /$^/, "")
        .replace(/^\/nexus\b\s*/i, "")
        .replace(/^\/n\b\s*/i, "")
        .trim();

      if (!cleaned) {
        deps.log(`telegram: ignore user_id=${userId} chat_id=${chatId} reason=empty_text`);
        return;
      }

      deps.log(`telegram: dispatch chat_id=${chatId} agent=${tg.agentId} chars=${cleaned.length}`);
      const { output } = await deps.agent.handleUserMessage({
        channel: "telegram",
        channelKey: String(chatId),
        agentId: tg.agentId,
        text: cleaned,
      });

      const chunks = splitTelegramMessage(output);
      deps.log(`telegram: reply chat_id=${chatId} chunks=${chunks.length} chars=${output.length}`);
      for (const chunk of chunks) {
        await ctx.reply(chunk);
      }
    } catch (err) {
      deps.log(`telegram: handler_error ${err instanceof Error ? err.message : String(err)}`);
      try {
        await ctx.reply("ERROR: internal error (check gateway logs).");
      } catch {
        // ignore
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
    };
  }

  await bot.api.deleteWebhook({ drop_pending_updates: true } as any).catch(() => {});
  await bot.start({ onStart: () => deps.log("telegram: polling") });

  return {
    stop: async () => {
      bot.stop();
    },
  };
}
