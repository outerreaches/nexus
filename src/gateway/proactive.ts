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
  lastStatus?: "idle" | "ran" | "error" | "no_heartbeat" | "skipped";
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
    try {
      const hb = await readPersonalizationFile(deps.stateDir, HEARTBEAT_FILENAME, agentId);
      const hasHeartbeat = Boolean(hb && hb.trim().length > 50);

      if (!hasHeartbeat) {
        // No heartbeat content; back off quietly to avoid burning tokens.
        nextDelayMs = Math.min(maxIntervalMs, Math.floor(nextDelayMs * 1.5 + 1_000));
        deps.log(`proactive: no HEARTBEAT.md content; backing off next=${Math.round(nextDelayMs / 1000)}s`);
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
        "- When given new standing instructions about heartbeat behavior, append them to HEARTBEAT.md using `file_write` with `mode: \"append\"` and `root: \"state\"`. Only edit or replace existing items if the user explicitly requests a change.",
      ].join("\n");

      const res = await deps.agent.handleUserMessage({
        channel: "heartbeat",
        channelKey: "gateway",
        agentId,
        text,
      });

      const idle = isIdleOutput(res.output);
      const tookMs = Date.now() - startMs;

      if (idle) {
        nextDelayMs = Math.min(maxIntervalMs, Math.floor(nextDelayMs * 1.4 + 1_000));
        deps.log(`proactive: idle tookMs=${tookMs} next=${Math.round(nextDelayMs / 1000)}s`);
        lastTickAt = startMs;
        lastStatus = "idle";
        return;
      }

      nextDelayMs = intervalMs;
      deps.log(`proactive: ran tookMs=${tookMs} outputChars=${res.output.length}`);
      lastTickAt = startMs;
      lastStatus = "ran";

      if (notifyTelegram && deps.telegram && deps.config.channels.telegram.enabled) {
        const recipients = await listTelegramRecipients(deps.db, deps.config);
        if (recipients.length === 0) {
          deps.log("proactive: no telegram recipients (allowFrom/allowlist empty)");
        } else {
          for (const chatId of recipients) {
            await deps.telegram.sendOutput(chatId, res.output);
          }
        }
      }
    } catch (e) {
      deps.log(`proactive: error ${e instanceof Error ? e.message : String(e)}`);
      nextDelayMs = Math.min(maxIntervalMs, Math.floor(nextDelayMs * 1.6 + 2_000));
      lastTickAt = startMs;
      lastStatus = "error";
    } finally {
      running = false;
      scheduleNext(nextDelayMs);
    }
  };

  deps.log(
    `proactive: enabled agent=${agentId} intervalMs=${intervalMs} maxIntervalMs=${maxIntervalMs} notifyTelegram=${notifyTelegram}`,
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
