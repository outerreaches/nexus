import type { NexusDatabase } from "../storage/database.js";
import {
  claimRunReport,
  listRunnableRunReports,
  markRunReportFailed,
  markRunReportSent,
  type RunReportRecord,
} from "../storage/run-reports.js";
import { findNearestTelegramAncestorRun } from "../storage/run-reports.js";
import { getLatestTelegramSessionForAgent } from "./telegram-delta.js";
import { isTelegramUserAllowed } from "../gateway/telegram-store.js";

type TelegramCtx = {
  sendOutput: (chatId: number, text: string) => Promise<void>;
  allowFrom: number[];
  allowAll: boolean;
};

function envBool(name: string): boolean | null {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v === "1" || v === "true" || v === "yes" || v === "y") return true;
  if (v === "0" || v === "false" || v === "no" || v === "n") return false;
  return null;
}

function envInt(name: string): number | null {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function computeBackoffMs(attempt: number): number {
  const seconds = Math.min(30 * 60, Math.max(5, 5 * (2 ** Math.max(0, attempt - 1))));
  return seconds * 1000;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…(+${text.length - maxChars} chars)`;
}

function parseChatId(value: string | null | undefined): number | null {
  if (!value) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const asInt = Math.trunc(num);
  return asInt !== 0 ? asInt : null;
}

function resolveTargetChatId(db: NexusDatabase, row: RunReportRecord): number | null {
  const targetChannel = row.targetChannel.trim().toLowerCase();
  if (targetChannel !== "telegram") return null;

  const directChat = parseChatId(row.targetChannelKey);
  if (directChat) return directChat;

  if (row.targetAgentId) {
    const latest = getLatestTelegramSessionForAgent(db, row.targetAgentId);
    const latestChat = parseChatId(latest?.channelKey ?? null);
    if (latestChat) return latestChat;
  }

  if (row.parentRunId) {
    const ancestor = findNearestTelegramAncestorRun(db, row.parentRunId);
    const ancestorChat = parseChatId(ancestor?.channelKey ?? null);
    if (ancestorChat) return ancestorChat;
  }

  if (row.sourceRunId) {
    const ancestor = findNearestTelegramAncestorRun(db, row.sourceRunId);
    const ancestorChat = parseChatId(ancestor?.channelKey ?? null);
    if (ancestorChat) return ancestorChat;
  }

  return null;
}

function formatReportMessage(row: RunReportRecord): string {
  const metadata = [
    `kind=${row.kind}`,
    row.sourceRunId ? `source_run_id=${row.sourceRunId}` : null,
    row.parentRunId ? `parent_run_id=${row.parentRunId}` : null,
    row.sourceAgentId ? `source_agent_id=${row.sourceAgentId}` : null,
  ].filter(Boolean);

  const lines = [row.title.trim() || "Run Report"];
  if (metadata.length > 0) {
    lines.push(metadata.join(" "));
  }
  lines.push("", row.body.trim() || "(empty)");
  return truncate(lines.join("\n"), 18_000);
}

export type RunReportBroker = {
  stop: () => void;
  tick: () => Promise<number>;
};

export function startRunReportBroker(deps: {
  db: NexusDatabase;
  telegram?: TelegramCtx | null;
  log: (msg: string) => void;
}): RunReportBroker | null {
  const enabled = envBool("NEXUS_RUN_REPORT_BROKER") ?? true;
  if (!enabled) return null;

  const tickIntervalMs = clamp(envInt("NEXUS_RUN_REPORT_BROKER_TICK_MS") ?? 10_000, 1_000, 120_000);
  const maxPerTick = clamp(envInt("NEXUS_RUN_REPORT_BROKER_MAX_PER_TICK") ?? 12, 1, 100);
  const lockMs = clamp(envInt("NEXUS_RUN_REPORT_BROKER_LOCK_MS") ?? 60_000, 5_000, 15 * 60_000);
  const maxAttempts = clamp(envInt("NEXUS_RUN_REPORT_BROKER_MAX_ATTEMPTS") ?? 8, 1, 50);

  let stopped = false;
  let running = false;

  const tick = async (): Promise<number> => {
    if (stopped || running) return 0;
    if (!deps.telegram) return 0;
    running = true;
    try {
      const nowMs = Date.now();
      const rows = listRunnableRunReports(deps.db, { nowMs, limit: maxPerTick });
      let processed = 0;

      for (const row of rows) {
        const claimed = claimRunReport(deps.db, {
          id: row.id,
          nowMs,
          lockUntilMs: nowMs + lockMs,
        });
        if (!claimed) continue;

        const attempt = row.attempts + 1;
        try {
          const chatId = resolveTargetChatId(deps.db, row);
          if (!chatId) {
            throw new Error("no_telegram_target");
          }
          const allowed = isTelegramUserAllowed(deps.db, {
            userId: chatId,
            staticAllowFrom: deps.telegram.allowFrom ?? [],
            allowAll: Boolean(deps.telegram.allowAll),
          });
          if (!allowed) {
            throw new Error(`chat_not_allowlisted:${chatId}`);
          }
          const message = formatReportMessage(row);
          await deps.telegram.sendOutput(chatId, message);
          markRunReportSent(deps.db, { id: row.id, nowMs: Date.now() });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const terminal = msg.startsWith("chat_not_allowlisted:") || attempt >= maxAttempts;
          if (terminal) {
            markRunReportFailed(deps.db, {
              id: row.id,
              status: "dead_letter",
              nowMs: Date.now(),
              nextAttemptAt: null,
              error: msg,
            });
          } else {
            const retryAt = Date.now() + computeBackoffMs(attempt);
            markRunReportFailed(deps.db, {
              id: row.id,
              status: "failed",
              nowMs: Date.now(),
              nextAttemptAt: retryAt,
              error: msg,
            });
          }
          deps.log(
            `run_report_broker: delivery_failed id=${row.id} attempt=${attempt} terminal=${terminal ? "yes" : "no"} err=${msg}`,
          );
        }
        processed += 1;
      }

      if (processed > 0) {
        deps.log(`run_report_broker: processed=${processed}`);
      }
      return processed;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, tickIntervalMs);
  if (typeof timer.unref === "function") timer.unref();

  deps.log(`run_report_broker: started tickIntervalMs=${tickIntervalMs} maxPerTick=${maxPerTick}`);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
}
