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
import type { AgentService } from "./agent-service.js";

type TelegramCtx = {
  sendOutput: (chatId: number, text: string) => Promise<void>;
  allowFrom: number[];
  allowAll: boolean;
};

type ClaimedReport = {
  row: RunReportRecord;
  attempt: number;
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

function formatTelegramBatchMessage(rows: ClaimedReport[]): string {
  if (rows.length === 1) return formatReportMessage(rows[0].row);
  const lines: string[] = [
    "RUN REPORT BATCH",
    `report_count=${rows.length}`,
    "",
  ];
  rows.forEach((item, index) => {
    lines.push(`REPORT ${index + 1}/${rows.length}`, formatReportMessage(item.row), "");
  });
  return truncate(lines.join("\n"), 18_000);
}

function parseMetadata(row: RunReportRecord): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.metadataJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed metadata
  }
  return {};
}

function latestPresetForAgent(db: NexusDatabase, agentId: string): string | null {
  const row = db.db
    .prepare(
      `SELECT preset
       FROM agent_runs
       WHERE agent_id = ?
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .get(agentId) as { preset: string } | undefined;
  const preset = row?.preset?.trim();
  return preset ? preset : null;
}

function resolveTargetPreset(db: NexusDatabase, rows: ClaimedReport[], targetAgentId: string): string | null {
  for (const item of rows) {
    const metadata = parseMetadata(item.row);
    const preset = typeof metadata.targetPreset === "string" ? metadata.targetPreset.trim() : "";
    if (preset) return preset;
  }
  return latestPresetForAgent(db, targetAgentId);
}

function formatAgentBatchMessage(rows: ClaimedReport[]): string {
  const lines: string[] = [
    "RUN REPORT BATCH",
    `report_count=${rows.length}`,
    "",
    "These are completion reports from background/child runs.",
    "If all reports are routine and require no follow-up, respond with exactly: IDLE",
    "Only inform the user when there is a meaningful update or action required.",
    "",
  ];

  rows.forEach((item, index) => {
    const row = item.row;
    lines.push(
      `REPORT ${index + 1}/${rows.length}`,
      `report_id=${row.id}`,
      `kind=${row.kind}`,
      row.sourceRunId ? `source_run_id=${row.sourceRunId}` : "source_run_id=n/a",
      row.parentRunId ? `parent_run_id=${row.parentRunId}` : "parent_run_id=n/a",
      row.sourceAgentId ? `source_agent_id=${row.sourceAgentId}` : "source_agent_id=n/a",
      "",
      row.title.trim() || "Run Report",
      "",
      truncate(row.body.trim() || "(empty)", 5000),
      "",
    );
  });

  return truncate(lines.join("\n"), 24_000);
}

function deliveryKey(row: RunReportRecord): string {
  const channel = row.targetChannel.trim().toLowerCase() || "telegram";
  const targetAgent = (row.targetAgentId ?? row.sourceAgentId ?? "").trim().toLowerCase();
  const targetKey = (row.targetChannelKey ?? "").trim() || targetAgent;
  return `${channel}::${targetAgent}::${targetKey}`;
}

function isTerminalDeliveryError(msg: string, attempt: number, maxAttempts: number): boolean {
  if (attempt >= maxAttempts) return true;
  if (msg === "no_telegram_target" || msg === "no_target_agent") return true;
  if (msg.startsWith("chat_not_allowlisted:")) return true;
  if (msg.startsWith("unsupported_target_channel:")) return true;
  return false;
}

async function deliverTelegramGroup(
  deps: { db: NexusDatabase; telegram?: TelegramCtx | null },
  group: ClaimedReport[],
): Promise<void> {
  if (!deps.telegram) throw new Error("telegram_unavailable");
  const first = group[0]?.row;
  if (!first) return;
  const chatId = resolveTargetChatId(deps.db, first);
  if (!chatId) throw new Error("no_telegram_target");
  const allowed = isTelegramUserAllowed(deps.db, {
    userId: chatId,
    staticAllowFrom: deps.telegram.allowFrom ?? [],
    allowAll: Boolean(deps.telegram.allowAll),
  });
  if (!allowed) throw new Error(`chat_not_allowlisted:${chatId}`);
  await deps.telegram.sendOutput(chatId, formatTelegramBatchMessage(group));
}

async function deliverAgentGroup(
  deps: { db: NexusDatabase; agent?: AgentService | null },
  group: ClaimedReport[],
): Promise<void> {
  if (!deps.agent) throw new Error("agent_unavailable");
  const first = group[0]?.row;
  if (!first) return;
  const targetAgentId = (first.targetAgentId ?? first.sourceAgentId ?? "").trim();
  if (!targetAgentId) throw new Error("no_target_agent");
  const targetPreset = resolveTargetPreset(deps.db, group, targetAgentId) ?? undefined;
  await deps.agent.handleUserMessage({
    channel: "run_report",
    channelKey: first.targetChannelKey?.trim() || targetAgentId,
    agentId: targetAgentId,
    preset: targetPreset,
    text: formatAgentBatchMessage(group),
    executionLane: "background",
    historyScope: { mode: "latest_telegram_for_agent" },
    ephemeralSessionSave: "unless_action",
  });
}

export type RunReportBroker = {
  stop: () => void;
  tick: () => Promise<number>;
};

export function startRunReportBroker(deps: {
  db: NexusDatabase;
  telegram?: TelegramCtx | null;
  agent?: AgentService | null;
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
    running = true;
    try {
      const nowMs = Date.now();
      const rows = listRunnableRunReports(deps.db, { nowMs, limit: maxPerTick });
      if (rows.length === 0) return 0;

      const claimedRows: ClaimedReport[] = [];
      for (const row of rows) {
        const claimed = claimRunReport(deps.db, {
          id: row.id,
          nowMs,
          lockUntilMs: nowMs + lockMs,
        });
        if (!claimed) continue;
        claimedRows.push({ row, attempt: row.attempts + 1 });
      }
      if (claimedRows.length === 0) return 0;

      const groups = new Map<string, ClaimedReport[]>();
      for (const item of claimedRows) {
        const key = deliveryKey(item.row);
        const existing = groups.get(key);
        if (existing) existing.push(item);
        else groups.set(key, [item]);
      }

      for (const group of groups.values()) {
        const first = group[0]?.row;
        if (!first) continue;
        const targetChannel = first.targetChannel.trim().toLowerCase();
        try {
          if (targetChannel === "telegram") {
            await deliverTelegramGroup(deps, group);
          } else if (targetChannel === "agent") {
            await deliverAgentGroup(deps, group);
          } else {
            throw new Error(`unsupported_target_channel:${targetChannel || "empty"}`);
          }

          for (const item of group) {
            markRunReportSent(deps.db, { id: item.row.id, nowMs: Date.now() });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          for (const item of group) {
            const terminal = isTerminalDeliveryError(msg, item.attempt, maxAttempts);
            if (terminal) {
              markRunReportFailed(deps.db, {
                id: item.row.id,
                status: "dead_letter",
                nowMs: Date.now(),
                nextAttemptAt: null,
                error: msg,
              });
            } else {
              markRunReportFailed(deps.db, {
                id: item.row.id,
                status: "failed",
                nowMs: Date.now(),
                nextAttemptAt: Date.now() + computeBackoffMs(item.attempt),
                error: msg,
              });
            }
            deps.log(
              `run_report_broker: delivery_failed id=${item.row.id} attempt=${item.attempt} terminal=${terminal ? "yes" : "no"} err=${msg}`,
            );
          }
        }
      }

      deps.log(`run_report_broker: processed=${claimedRows.length}`);
      return claimedRows.length;
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
