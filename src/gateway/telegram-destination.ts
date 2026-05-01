import type { NexusDatabase } from "../storage/database.js";
import { getHomeSession } from "../storage/sessions.js";

export type TelegramDestination = {
  chatId: number;
  source: "request" | "home";
};

/**
 * Resolves the Telegram chat an agent should send to.
 *
 * Precedence:
 *  1. The current request channel — only when the agent is responding
 *     in an active Telegram session, the user is on the other end.
 *  2. The home session — the explicit pin set via /sethome, used by
 *     background flows (scheduled jobs, process notifications, etc.).
 *
 * No "latest message" fallback: agents must not implicitly route to
 * chats the user did not pin. Returns null if neither source applies.
 *
 * Only returns positive (private) chat ids. Group chats (negative ids)
 * are not supported for outbound agent sends.
 */
export function resolveTelegramDestination(params: {
  db: NexusDatabase;
  agentId: string;
  request?: { channel: string; channelKey: string };
}): TelegramDestination | null {
  if (params.request?.channel === "telegram") {
    const id = parsePositiveChatId(params.request.channelKey);
    if (id) return { chatId: id, source: "request" };
  }

  const home = getHomeSession({ db: params.db, agentId: params.agentId });
  if (home?.channel === "telegram") {
    const id = parsePositiveChatId(home.channelKey);
    if (id) return { chatId: id, source: "home" };
  }

  return null;
}

function parsePositiveChatId(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}
