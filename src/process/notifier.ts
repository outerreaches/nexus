import type { AgentService } from "../core/agent-service.js";
import type { NexusDatabase } from "../storage/database.js";
import { isTelegramUserAllowed } from "../gateway/telegram-store.js";
import type { ProcessManager } from "./manager.js";

type NotifyMode = "never" | "on_failure" | "on_exit";

type TelegramCtx = {
  sendOutput: (chatId: number, output: string) => Promise<void>;
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

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function computeBackoffMs(attempts: number): number {
  // 60s, 120s, 240s... up to 60m.
  const minutes = Math.min(60, Math.max(1, 2 ** Math.max(0, attempts - 1)));
  return minutes * 60_000;
}

function asNotifyMode(value: unknown): NotifyMode {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "on_failure" || v === "on_exit" || v === "never") return v;
  return "never";
}

function formatTs(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "n/a";
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(ms);
  }
}

function isSuccess(row: any): boolean {
  const status = String(row.status ?? "");
  const exitCode = row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code);
  const signal = row.signal ? String(row.signal) : null;
  return status === "exited" && exitCode === 0 && !signal;
}

function buildAckMessage(row: any): string {
  const id = String(row.id ?? "");
  const status = String(row.status ?? "");
  const exitCode = row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code);
  const signal = row.signal ? String(row.signal) : null;
  const outcome = status === "stopped"
    ? "stopped"
    : isSuccess(row)
      ? "completed successfully"
      : `completed (status=${status || "unknown"}, code=${exitCode ?? "null"}, signal=${signal ?? "null"})`;
  return `Process ${id} ${outcome}. Generating summary...`;
}

function buildCallbackTask(row: any): string {
  const lines = [
    "PROCESS RUN COMPLETED",
    `process_id=${row.id}`,
    `status=${row.status}`,
    `exit_code=${row.exit_code ?? "null"}`,
    `signal=${row.signal ?? "null"}`,
    `started_at=${formatTs(row.started_at)}`,
    `ended_at=${formatTs(row.ended_at)}`,
    `cwd=${row.cwd}`,
    `command=${row.command}`,
    "",
    "Task:",
    "- Tail logs once via process_logs (maxChars=12000).",
    "- Write a concise Telegram-ready summary (<= 1500 chars).",
    "- If failure: include 2-4 likely root causes and the next 3 concrete troubleshooting steps.",
    "- If success: confirm completion and mention any notable warnings from logs.",
    "",
    "Output:",
    "- Return ONLY the message to send to the user. No additional sections.",
  ];
  return lines.join("\n");
}

export function startProcessNotifier(deps: {
  db: NexusDatabase;
  agent: AgentService;
  processManager: ProcessManager;
  telegram?: TelegramCtx;
  log: (msg: string) => void;
}): { stop: () => void } | null {
  const enabled = envBool("NEXUS_PROCESS_NOTIFIER") ?? true;
  if (!enabled) return null;

  const tickIntervalMs = clampInt(envInt("NEXUS_PROCESS_NOTIFIER_TICK_MS") ?? 15_000, 2_000, 120_000);
  const maxPerTick = clampInt(envInt("NEXUS_PROCESS_NOTIFIER_MAX_PER_TICK") ?? 3, 1, 25);
  const lockMs = clampInt(envInt("NEXUS_PROCESS_NOTIFIER_LOCK_MS") ?? 60_000, 5_000, 10 * 60_000);
  const sendAck = envBool("NEXUS_PROCESS_NOTIFIER_ACK") ?? true;

  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };

  const tick = async () => {
    if (stopped) return;
    if (running) return;
    running = true;
    try {
      await deps.processManager.reconcileDetachedRunning({ limit: 80 }).catch(() => ({ checked: 0, updated: 0 }));
      await notifyEnded();
    } finally {
      running = false;
    }
  };

  const notifyEnded = async () => {
    // Reconciliation is useful even when Telegram is disabled, but notifications
    // should only run when a Telegram sender is configured.
    if (!deps.telegram) return;

    const nowMs = Date.now();
    let rows: any[] = [];
    try {
      rows = deps.db.db
        .prepare(
          `
          SELECT
            id, status, command, cwd, pid, started_at, ended_at, exit_code, signal, log_path,
            notify_mode, notify_chat_id, notify_preset, notify_attempts, notify_last_error, notify_next_attempt_at, notified_at,
            request_channel, request_channel_key, request_agent_id, request_preset, request_session_id, request_run_id, request_parent_run_id
          FROM process_runs
          WHERE status != 'running'
            AND notify_mode != 'never'
            AND notified_at IS NULL
            AND (notify_next_attempt_at IS NULL OR notify_next_attempt_at <= ?)
          ORDER BY COALESCE(ended_at, started_at) ASC
          LIMIT ?
        `,
        )
        .all(nowMs, maxPerTick) as any[];
    } catch {
      return;
    }

    for (const row of rows) {
      const mode = asNotifyMode(row.notify_mode);
      if (mode === "never") continue;

      if (mode === "on_failure" && isSuccess(row)) {
        try {
          deps.db.db
            .prepare(
              `
              UPDATE process_runs
              SET notified_at = ?, notify_last_error = NULL, notify_next_attempt_at = NULL, updated_at = ?
              WHERE id = ? AND notified_at IS NULL
            `,
            )
            .run(nowMs, nowMs, row.id);
        } catch {
          // ignore
        }
        continue;
      }

      const chatIdRaw = row.notify_chat_id;
      const chatId = typeof chatIdRaw === "number" ? chatIdRaw : chatIdRaw === null ? null : Number(chatIdRaw) || null;
      if (!chatId || chatId <= 0) {
        try {
          deps.db.db
            .prepare(
              `
              UPDATE process_runs
              SET notified_at = ?, notify_last_error = ?, notify_next_attempt_at = NULL, updated_at = ?
              WHERE id = ? AND notified_at IS NULL
            `,
            )
            .run(nowMs, "skipped: missing or invalid notify_chat_id", nowMs, row.id);
        } catch {
          // ignore
        }
        continue;
      }

      const allowed = isTelegramUserAllowed(deps.db, {
        userId: chatId,
        staticAllowFrom: deps.telegram.allowFrom ?? [],
        allowAll: Boolean(deps.telegram.allowAll),
      });
      if (!allowed) {
        try {
          deps.db.db
            .prepare(
              `
              UPDATE process_runs
              SET notified_at = ?, notify_last_error = ?, notify_next_attempt_at = NULL, updated_at = ?
              WHERE id = ? AND notified_at IS NULL
            `,
            )
            .run(nowMs, `skipped: chatId ${chatId} not allowlisted`, nowMs, row.id);
        } catch {
          // ignore
        }
        continue;
      }

      // Claim with a short lock window to avoid duplicates if multiple instances race (best-effort).
      const claimUntil = nowMs + lockMs;
      let claimed = false;
      try {
        const res = deps.db.db
          .prepare(
            `
            UPDATE process_runs
            SET notify_attempts = notify_attempts + 1,
                notify_next_attempt_at = ?,
                updated_at = ?
            WHERE id = ?
              AND notified_at IS NULL
              AND (notify_next_attempt_at IS NULL OR notify_next_attempt_at <= ?)
          `,
          )
          .run(claimUntil, nowMs, row.id, nowMs);
        claimed = (res.changes ?? 0) > 0;
      } catch {
        claimed = false;
      }
      if (!claimed) continue;

      // Immediate acknowledgment so the user knows we detected completion; summary follows.
      if (sendAck && (row.notify_attempts ?? 0) <= 0) {
        try {
          await deps.telegram.sendOutput(chatId, buildAckMessage(row));
        } catch (err) {
          deps.log(`process_notifier: ack failed id=${row.id} err=${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const preset = (row.notify_preset && String(row.notify_preset).trim()) || "process-manager";
      const agentId = (row.request_agent_id && String(row.request_agent_id).trim()) || "main";
      const text = buildCallbackTask(row);

      try {
        const res = await deps.agent.handleUserMessage({
          channel: "process",
          channelKey: String(row.id),
          agentId,
          preset,
          text,
          executionLane: "background",
        });

        const output = (res.output ?? "").trim();
        if (!output) throw new Error("empty callback output");
        if (res.status !== "complete") throw new Error(`callback status=${res.status}`);

        await deps.telegram.sendOutput(chatId, output.length > 18_000 ? `${output.slice(0, 18_000)}…` : output);

        deps.db.db
          .prepare(
            `
            UPDATE process_runs
            SET notified_at = ?, notify_last_error = NULL, notify_next_attempt_at = NULL, updated_at = ?
            WHERE id = ?
          `,
          )
          .run(nowMs, nowMs, row.id);
      } catch (err) {
        const attempt = typeof row.notify_attempts === "number" ? row.notify_attempts + 1 : 1;
        const backoffMs = computeBackoffMs(attempt);
        const nextAttemptAt = nowMs + backoffMs;
        const msg = err instanceof Error ? err.message : String(err);
        deps.log(`process_notifier: notify failed id=${row.id} attempt=${attempt} backoffMs=${backoffMs} err=${msg}`);
        try {
          deps.db.db
            .prepare(
              `
              UPDATE process_runs
              SET notify_last_error = ?, notify_next_attempt_at = ?, updated_at = ?
              WHERE id = ?
            `,
            )
            .run(msg.slice(0, 800), nextAttemptAt, nowMs, row.id);
        } catch {
          // ignore
        }
      }
    }
  };

  timer = setInterval(() => void tick(), tickIntervalMs);
  // Kick once on start.
  void tick();

  deps.log(`process_notifier: started tickIntervalMs=${tickIntervalMs} maxPerTick=${maxPerTick}`);
  return { stop };
}
