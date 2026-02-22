import { HEARTBEAT_FILENAME, readPersonalizationFile } from "../state/personalization.js";
import type { NexusConfig } from "../state/config.js";
import type { AgentService } from "../core/agent-service.js";
import { buildTelegramDelta } from "../core/telegram-delta.js";
import type { NexusDatabase } from "../storage/database.js";
import { getContextCursor, upsertContextCursor } from "../storage/context-cursors.js";
import { enqueueRunReport } from "../storage/run-reports.js";

export type ProactiveDeps = {
  config: NexusConfig;
  stateDir: string;
  agent: AgentService;
  db: NexusDatabase;
  telegram?: {
    sendOutput: (chatId: number, text: string) => Promise<void>;
  } | null;
  log: (msg: string) => void;
};

export type ProactiveStatus = {
  enabled: boolean;
  paused?: boolean;
  agentId?: string;
  intervalMs?: number;
  maxIntervalMs?: number;
  jitterMs?: number;
  notifyTelegram?: boolean;
  lastTickAt?: number | null;
  lastStatus?: "idle" | "ran" | "error" | "no_heartbeat" | "skipped" | "skipped_active_telegram";
  nextTickAt?: number | null;
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

function computeJitter(jitterMs: number): number {
  if (jitterMs <= 0) return 0;
  return Math.floor(Math.random() * (jitterMs + 1));
}

function isIdleOutput(output: string): boolean {
  const t = output.trim();
  if (!t) return true;
  const upper = t.toUpperCase();
  if (upper === "IDLE" || upper === "NOOP" || upper === "NO-OP") return true;
  const lines = t.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines.length > 0 ? lines[lines.length - 1]!.toUpperCase() : "";
  return last === "IDLE" || last === "NOOP" || last === "NO-OP";
}

function detectActiveTelegramContext(
  db: NexusDatabase,
  params: { agentId: string; nowMs: number; quietMs: number; runningMaxAgeMs: number },
): {
  active: boolean;
  hasRunning: boolean;
  runningStartedAt: number | null;
  lastUserMessageAt: number | null;
  lastAssistantMessageAt: number | null;
} {
  const running = db.db
    .prepare(
      `SELECT MAX(started_at) AS running_started_at
       FROM agent_runs
       WHERE agent_id = ? AND channel = 'telegram' AND status = 'running'`,
    )
    .get(params.agentId) as { running_started_at: number | null } | undefined;
  const runningStartedAt = typeof running?.running_started_at === "number" && Number.isFinite(running.running_started_at)
    ? Math.floor(running.running_started_at)
    : null;
  const hasRunning = Boolean(
    runningStartedAt &&
    params.runningMaxAgeMs > 0 &&
    params.nowMs - runningStartedAt <= params.runningMaxAgeMs,
  );

  const row = db.db
    .prepare(
      `SELECT
         MAX(CASE WHEN m.role = 'user' THEN m.created_at END) AS last_user_message_at,
         MAX(CASE WHEN m.role = 'assistant' THEN m.created_at END) AS last_assistant_message_at
       FROM sessions s
       JOIN messages m ON m.session_id = s.id
       WHERE s.channel = 'telegram' AND s.agent_id = ?`,
    )
    .get(params.agentId) as {
      last_user_message_at: number | null;
      last_assistant_message_at: number | null;
    } | undefined;
  const lastUserMessageAt = typeof row?.last_user_message_at === "number" && Number.isFinite(row.last_user_message_at)
    ? Math.floor(row.last_user_message_at)
    : null;
  const lastAssistantMessageAt = typeof row?.last_assistant_message_at === "number" && Number.isFinite(row.last_assistant_message_at)
    ? Math.floor(row.last_assistant_message_at)
    : null;
  const userWaitingForResponse = Boolean(
    lastUserMessageAt &&
    params.quietMs > 0 &&
    params.nowMs - lastUserMessageAt < params.quietMs &&
    (!lastAssistantMessageAt || lastAssistantMessageAt < lastUserMessageAt),
  );
  return {
    active: hasRunning || userWaitingForResponse,
    hasRunning,
    runningStartedAt,
    lastUserMessageAt,
    lastAssistantMessageAt,
  };
}

export function startProactiveHeartbeat(
  deps: ProactiveDeps,
): { stop: () => void; pause: () => void; resume: () => void; getStatus: () => ProactiveStatus } | null {
  const enabled = envBool("NEXUS_PROACTIVE") ?? deps.config.proactive.enabled;
  if (!enabled) {
    return {
      stop: () => { },
      pause: () => { },
      resume: () => { },
      getStatus: () => ({ enabled: false, lastTickAt: null, nextTickAt: null }),
    };
  }

  const agentId = (process.env.NEXUS_PROACTIVE_AGENT_ID ?? deps.config.proactive.agentId ?? "main").trim() || "main";
  const intervalMs = Math.max(5_000, envInt("NEXUS_PROACTIVE_INTERVAL_MS") ?? deps.config.proactive.intervalMs);
  const maxIntervalMs = Math.max(intervalMs, envInt("NEXUS_PROACTIVE_MAX_INTERVAL_MS") ?? deps.config.proactive.maxIntervalMs);
  const jitterMs = Math.max(0, envInt("NEXUS_PROACTIVE_JITTER_MS") ?? deps.config.proactive.jitterMs);
  const notifyTelegram = envBool("NEXUS_PROACTIVE_NOTIFY_TELEGRAM") ?? deps.config.proactive.notifyTelegram;
  const pauseOnActiveTelegram = envBool("NEXUS_PROACTIVE_PAUSE_ON_ACTIVE_TELEGRAM")
    ?? deps.config.proactive.pauseOnActiveTelegram;
  const activeTelegramQuietMs = Math.max(
    0,
    envInt("NEXUS_PROACTIVE_ACTIVE_TELEGRAM_QUIET_MS") ?? deps.config.proactive.activeTelegramQuietMs,
  );
  const activeTelegramRunningMaxAgeMs = Math.max(
    0,
    envInt("NEXUS_PROACTIVE_ACTIVE_TELEGRAM_INFLIGHT_MAX_MS") ?? 2 * 60_000,
  );
  const maxSkipActiveTelegramMs = Math.max(
    0,
    envInt("NEXUS_PROACTIVE_MAX_SKIP_ACTIVE_TELEGRAM_MS") ?? 5 * 60_000,
  );
  const deltaMaxMessages = Math.max(1, envInt("NEXUS_PROACTIVE_DELTA_MAX_MESSAGES") ?? 20);
  const deltaMaxChars = Math.max(800, envInt("NEXUS_PROACTIVE_DELTA_MAX_CHARS") ?? 12_000);
  const deltaBootstrapMessages = Math.max(1, envInt("NEXUS_PROACTIVE_DELTA_BOOTSTRAP_MESSAGES") ?? deltaMaxMessages);

  let stopped = false;
  let paused = false;
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let nextDelayMs = intervalMs;
  let nextTickAt: number | null = null;
  let lastTickAt: number | null = null;
  let lastExecutedAt: number | null = null;
  let lastStatus: ProactiveStatus["lastStatus"] = undefined;

  const scheduleNext = (delayMs: number) => {
    if (stopped) return;
    const delay = Math.max(1_000, delayMs) + computeJitter(jitterMs);
    nextTickAt = Date.now() + delay;
    timer = setTimeout(() => void tick(), delay);
  };

  const tick = async () => {
    if (stopped) return;
    if (paused) {
      deps.log(`proactive: tick_skip reason=paused next=${Math.round(nextDelayMs / 1000)}s`);
      scheduleNext(nextDelayMs);
      return;
    }
    if (running) {
      deps.log(`proactive: skip tick (still running) next=${Math.round(nextDelayMs / 1000)}s`);
      lastStatus = "skipped";
      scheduleNext(nextDelayMs);
      return;
    }
    running = true;

    const startMs = Date.now();
    const tickId = startMs.toString(36);
    deps.log(`proactive: tick_start id=${tickId} agent=${agentId} lane=background`);
    try {
      if (pauseOnActiveTelegram) {
        const activity = detectActiveTelegramContext(deps.db, {
          agentId,
          nowMs: startMs,
          quietMs: activeTelegramQuietMs,
          runningMaxAgeMs: activeTelegramRunningMaxAgeMs,
        });
        const forcedByMaxSkip = Boolean(
          maxSkipActiveTelegramMs > 0 &&
          lastExecutedAt &&
          startMs - lastExecutedAt >= maxSkipActiveTelegramMs,
        );
        if (activity.active && !forcedByMaxSkip) {
          nextDelayMs = intervalMs;
          const userAgeMs = activity.lastUserMessageAt ? Math.max(0, startMs - activity.lastUserMessageAt) : null;
          const assistantAgeMs = activity.lastAssistantMessageAt
            ? Math.max(0, startMs - activity.lastAssistantMessageAt)
            : null;
          const runningAgeMs = activity.runningStartedAt ? Math.max(0, startMs - activity.runningStartedAt) : null;
          deps.log(
            `proactive: tick_skip id=${tickId} reason=active_telegram hasRunning=${activity.hasRunning} runningAgeMs=${runningAgeMs ?? "n/a"} lastUserAgeMs=${userAgeMs ?? "n/a"} lastAssistantAgeMs=${assistantAgeMs ?? "n/a"} next=${Math.round(nextDelayMs / 1000)}s`,
          );
          lastTickAt = startMs;
          lastStatus = "skipped_active_telegram";
          return;
        }
        if (activity.active && forcedByMaxSkip) {
          deps.log(
            `proactive: tick_bypass id=${tickId} reason=max_skip_elapsed elapsedMs=${startMs - (lastExecutedAt ?? startMs)} maxSkipMs=${maxSkipActiveTelegramMs}`,
          );
        }
      }

      const hb = await readPersonalizationFile(deps.stateDir, HEARTBEAT_FILENAME, agentId);
      const hasHeartbeat = Boolean(hb && hb.trim().length > 50);
      deps.log(
        `proactive: heartbeat_load id=${tickId} file=${deps.stateDir}/${HEARTBEAT_FILENAME} chars=${hb?.length ?? 0} hasContent=${hasHeartbeat}`,
      );

      if (!hasHeartbeat) {
        // No heartbeat content; back off quietly to avoid burning tokens.
        nextDelayMs = Math.min(maxIntervalMs, Math.floor(nextDelayMs * 1.5 + 1_000));
        deps.log(
          `proactive: tick_result id=${tickId} status=no_heartbeat next=${Math.round(nextDelayMs / 1000)}s`,
        );
        lastTickAt = startMs;
        lastExecutedAt = startMs;
        lastStatus = "no_heartbeat";
        return;
      }

      const cursor = getContextCursor(deps.db, {
        flowType: "heartbeat",
        flowKey: "gateway",
        agentId,
      });
      const delta = buildTelegramDelta(deps.db, {
        agentId,
        cursor: cursor
          ? {
              telegramSessionId: cursor.telegramSessionId,
              lastMessageId: cursor.lastMessageId,
            }
          : null,
        options: {
          maxMessages: deltaMaxMessages,
          maxChars: deltaMaxChars,
          bootstrapMessages: deltaBootstrapMessages,
        },
      });
      const deltaBlock = delta.block;
      deps.log(
        `proactive: context_delta id=${tickId} source=${delta.stats.source} included=${delta.stats.includedMessages} omitted=${delta.stats.omittedMessages} hasMore=${delta.stats.hasMore} bytes=${delta.stats.bytes}`,
      );

      const textParts = [
        "HEARTBEAT TICK",
        "",
        "Review HEARTBEAT.md and current state. If there is nothing meaningful to do right now, respond with exactly: IDLE",
        "",
        "Rules:",
        "- It is OK to idle if there is nothing going on.",
        "- Avoid long research loops. Prefer one small, high-value action per tick.",
        "- Only ask the operator for action if you are blocked on a specific step (OTP/MFA/CAPTCHA/etc).",
        "- If you do ask, use `human_request` with a short, specific prompt and then stop.",
        "- Do NOT write to the blackboard during heartbeat ticks unless you discovered a new issue, made a change, or created a durable artifact that must persist. Never write \"reviewed\" or confirmation-only notes; if nothing substantive, respond with IDLE.",
        `- When given new standing instructions about heartbeat behavior, append them to \`${deps.stateDir}/HEARTBEAT.md\` using absolute paths.`,
        `- For \`HEARTBEAT.md\`, \`NOTES.md\`, \`AGENTS.md\`, \`SOUL.md\`, \`USER.md\`, and \`CODEGUIDE.md\`, always call file tools with absolute paths under \`${deps.stateDir}\`. Example: \`file_read({ path: "${deps.stateDir}/NOTES.md", limit: 200 })\`.`,
      ];
      if (deltaBlock) {
        textParts.push("", deltaBlock);
      }
      const text = textParts.join("\n");

      deps.log(`proactive: dispatch id=${tickId} channel=heartbeat key=gateway agent=${agentId}`);
      const res = await deps.agent.handleUserMessage({
        channel: "heartbeat",
        channelKey: "gateway",
        agentId,
        text,
        executionLane: "background",
        ephemeralSessionSave: "unless_action",
      });
      if (delta.nextCursor) {
        upsertContextCursor(deps.db, {
          flowType: "heartbeat",
          flowKey: "gateway",
          agentId,
          telegramSessionId: delta.nextCursor.telegramSessionId,
          lastMessageId: delta.nextCursor.lastMessageId,
          updatedAt: Date.now(),
        });
      }

      const idle = isIdleOutput(res.output);
      const hadToolActivity = (res.toolCallsUsed ?? 0) > 0;
      const tookMs = Date.now() - startMs;

      if (idle || !hadToolActivity) {
        nextDelayMs = Math.min(maxIntervalMs, Math.floor(nextDelayMs * 1.4 + 1_000));
        deps.log(
          `proactive: tick_result id=${tickId} status=idle tookMs=${tookMs} outputChars=${res.output.length} toolCallsUsed=${res.toolCallsUsed} next=${Math.round(nextDelayMs / 1000)}s`,
        );
        lastTickAt = startMs;
        lastExecutedAt = startMs;
        lastStatus = "idle";
        return;
      }

      nextDelayMs = intervalMs;
      deps.log(`proactive: tick_result id=${tickId} status=ran tookMs=${tookMs} outputChars=${res.output.length}`);
      lastTickAt = startMs;
      lastExecutedAt = startMs;
      lastStatus = "ran";

      if (notifyTelegram && deps.config.channels.telegram.enabled) {
        const message = [
          "HEARTBEAT REPORT",
          `tick_id=${tickId}`,
          `agent_id=${agentId}`,
          `run_id=${res.runId ?? "n/a"}`,
          `status=${res.status}`,
          "",
          res.output,
        ].join("\n");
        enqueueRunReport(deps.db, {
          kind: "heartbeat",
          title: "HEARTBEAT REPORT",
          body: message,
          sourceRunId: res.runId,
          sourceAgentId: agentId,
          sourceChannel: "heartbeat",
          sourceChannelKey: "gateway",
          targetAgentId: agentId,
          targetChannel: "telegram",
          metadata: { tickId, status: res.status },
          nowMs: Date.now(),
        });
        deps.log(`proactive: report_queued id=${tickId} kind=heartbeat runId=${res.runId ?? "n/a"}`);
      }
    } catch (e) {
      deps.log(`proactive: tick_result id=${tickId} status=error err=${e instanceof Error ? e.message : String(e)}`);
      nextDelayMs = Math.min(maxIntervalMs, Math.floor(nextDelayMs * 1.6 + 2_000));
      lastTickAt = startMs;
      lastExecutedAt = startMs;
      lastStatus = "error";
      if (notifyTelegram && deps.config.channels.telegram.enabled) {
        const message = `HEARTBEAT ERROR (${tickId}): ${e instanceof Error ? e.message : String(e)}`;
        enqueueRunReport(deps.db, {
          kind: "heartbeat",
          title: "HEARTBEAT ERROR",
          body: truncateHeartbeatError(message),
          sourceAgentId: agentId,
          sourceChannel: "heartbeat",
          sourceChannelKey: "gateway",
          targetAgentId: agentId,
          targetChannel: "telegram",
          metadata: { tickId },
          nowMs: Date.now(),
        });
        deps.log(`proactive: report_queued id=${tickId} kind=heartbeat_error`);
      }
    } finally {
      running = false;
      scheduleNext(nextDelayMs);
    }
  };

  deps.log(
    `proactive: enabled agent=${agentId} intervalMs=${intervalMs} maxIntervalMs=${maxIntervalMs} notifyTelegram=${notifyTelegram} pauseOnActiveTelegram=${pauseOnActiveTelegram} activeTelegramQuietMs=${activeTelegramQuietMs} inflightMaxAgeMs=${activeTelegramRunningMaxAgeMs} maxSkipActiveMs=${maxSkipActiveTelegramMs} deltaMaxMessages=${deltaMaxMessages} deltaMaxChars=${deltaMaxChars}`,
  );

  // Start shortly after boot.
  scheduleNext(Math.min(10_000, intervalMs));

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    pause: () => {
      paused = true;
      deps.log("proactive: paused");
    },
    resume: () => {
      paused = false;
      deps.log("proactive: resumed");
    },
    getStatus: () => ({
      enabled: true,
      paused,
      agentId,
      intervalMs,
      maxIntervalMs,
      jitterMs,
      notifyTelegram,
      lastTickAt,
      lastStatus,
      nextTickAt,
    }),
  };
}

function truncateHeartbeatError(message: string): string {
  const maxChars = 1500;
  if (message.length <= maxChars) return message;
  return `${message.slice(0, maxChars)}…(+${message.length - maxChars} chars)`;
}
