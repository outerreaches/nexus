import { HEARTBEAT_FILENAME, readPersonalizationFile } from "../state/personalization.js";
import type { NexusConfig } from "../state/config.js";
import type { AgentService } from "../core/agent-service.js";
import type { NexusDatabase } from "../storage/database.js";

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
  return upper === "IDLE" || upper === "NOOP" || upper === "NO-OP";
}

async function listTelegramRecipients(db: NexusDatabase, config: NexusConfig): Promise<number[]> {
  const set = new Set<number>();
  for (const id of config.channels.telegram.allowFrom ?? []) {
    if (Number.isFinite(id)) set.add(id);
  }
  try {
    const rows = db.db.prepare("SELECT user_id FROM telegram_allowlist").all() as { user_id: number }[];
    for (const r of rows) {
      const id = Number(r.user_id);
      if (Number.isFinite(id)) set.add(id);
    }
  } catch {
    // ignore
  }
  return [...set];
}

function detectActiveTelegramContext(
  db: NexusDatabase,
  params: { agentId: string; nowMs: number; quietMs: number },
): { active: boolean; hasRunning: boolean; lastUserMessageAt: number | null } {
  const running = db.db
    .prepare(
      `SELECT 1 AS running
       FROM agent_runs
       WHERE agent_id = ? AND channel = 'telegram' AND status = 'running'
       LIMIT 1`,
    )
    .get(params.agentId) as { running: number } | undefined;
  if (running) {
    return { active: true, hasRunning: true, lastUserMessageAt: null };
  }

  const row = db.db
    .prepare(
      `SELECT MAX(m.created_at) AS last_user_message_at
       FROM sessions s
       JOIN messages m ON m.session_id = s.id
       WHERE s.channel = 'telegram' AND s.agent_id = ? AND m.role = 'user'`,
    )
    .get(params.agentId) as { last_user_message_at: number | null } | undefined;
  const lastUserMessageAt = typeof row?.last_user_message_at === "number" && Number.isFinite(row.last_user_message_at)
    ? Math.floor(row.last_user_message_at)
    : null;
  const active = Boolean(lastUserMessageAt && params.quietMs > 0 && params.nowMs - lastUserMessageAt < params.quietMs);
  return { active, hasRunning: false, lastUserMessageAt };
}

export function startProactiveHeartbeat(
  deps: ProactiveDeps,
): { stop: () => void; pause: () => void; resume: () => void; getStatus: () => ProactiveStatus } | null {
  const enabled = envBool("NEXUS_PROACTIVE") ?? deps.config.proactive.enabled;
  if (!enabled) {
    return {
      stop: () => {},
      pause: () => {},
      resume: () => {},
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

  let stopped = false;
  let paused = false;
  let running = false;
  let timer: NodeJS.Timeout | null = null;
  let nextDelayMs = intervalMs;
  let nextTickAt: number | null = null;
  let lastTickAt: number | null = null;
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
        const activity = detectActiveTelegramContext(deps.db, { agentId, nowMs: startMs, quietMs: activeTelegramQuietMs });
        if (activity.active) {
          nextDelayMs = intervalMs;
          const ageMs = activity.lastUserMessageAt ? Math.max(0, startMs - activity.lastUserMessageAt) : null;
          deps.log(
            `proactive: tick_skip id=${tickId} reason=active_telegram hasRunning=${activity.hasRunning} lastUserAgeMs=${ageMs ?? "n/a"} next=${Math.round(nextDelayMs / 1000)}s`,
          );
          lastTickAt = startMs;
          lastStatus = "skipped_active_telegram";
          return;
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
        lastStatus = "no_heartbeat";
        return;
      }

      const text = [
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
      ].join("\n");

      deps.log(`proactive: dispatch id=${tickId} channel=heartbeat key=gateway agent=${agentId}`);
      const res = await deps.agent.handleUserMessage({
        channel: "heartbeat",
        channelKey: "gateway",
        agentId,
        text,
        executionLane: "background",
        historyScope: { mode: "latest_telegram_for_agent" },
      });

      const idle = isIdleOutput(res.output);
      const tookMs = Date.now() - startMs;

      if (idle) {
        nextDelayMs = Math.min(maxIntervalMs, Math.floor(nextDelayMs * 1.4 + 1_000));
        deps.log(
          `proactive: tick_result id=${tickId} status=idle tookMs=${tookMs} outputChars=${res.output.length} next=${Math.round(nextDelayMs / 1000)}s`,
        );
        lastTickAt = startMs;
        lastStatus = "idle";
        return;
      }

      nextDelayMs = intervalMs;
      deps.log(`proactive: tick_result id=${tickId} status=ran tookMs=${tookMs} outputChars=${res.output.length}`);
      lastTickAt = startMs;
      lastStatus = "ran";

      if (notifyTelegram && deps.telegram && deps.config.channels.telegram.enabled) {
        const recipients = await listTelegramRecipients(deps.db, deps.config);
        if (recipients.length === 0) {
          deps.log(`proactive: notify id=${tickId} recipients=0 (allowFrom/allowlist empty)`);
        } else {
          deps.log(`proactive: notify id=${tickId} recipients=${recipients.length}`);
          for (const chatId of recipients) {
            await deps.telegram.sendOutput(chatId, res.output);
          }
        }
      }
    } catch (e) {
      deps.log(`proactive: tick_result id=${tickId} status=error err=${e instanceof Error ? e.message : String(e)}`);
      nextDelayMs = Math.min(maxIntervalMs, Math.floor(nextDelayMs * 1.6 + 2_000));
      lastTickAt = startMs;
      lastStatus = "error";
    } finally {
      running = false;
      scheduleNext(nextDelayMs);
    }
  };

  deps.log(
    `proactive: enabled agent=${agentId} intervalMs=${intervalMs} maxIntervalMs=${maxIntervalMs} notifyTelegram=${notifyTelegram} pauseOnActiveTelegram=${pauseOnActiveTelegram} activeTelegramQuietMs=${activeTelegramQuietMs}`,
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
