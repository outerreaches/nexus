import crypto from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

import type { NexusConfig } from "../state/config.js";
import type { AgentService } from "../core/agent-service.js";
import type { NexusDatabase } from "../storage/database.js";
import type { Tool, ToolContext } from "../core/tools.js";
import { nextCronTimeMs, parseCron, validateTimeZone } from "./cron.js";

const execAsync = promisify(exec);

const AgentTaskSpec = z.object({
  mode: z.literal("agent_task"),
  task: z.string(),
});

const ScriptSpec = z.object({
  mode: z.literal("script"),
  command: z.string(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(1000).optional(),
});

const ToolCallSpec = z.object({
  mode: z.literal("tool_call"),
  tool: z.string(),
  args: z.record(z.any()),
});

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

function randomId(prefix: string): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(10);
  let out = prefix;
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…(+${text.length - maxChars} chars)`;
}

function computeFailureBackoffMs(consecutiveFailures: number): number {
  const minutes = Math.min(60, Math.max(1, 2 ** Math.max(0, consecutiveFailures - 1)));
  return minutes * 60_000;
}

export type JobSchedulerDeps = {
  config: NexusConfig;
  agent: AgentService;
  db: NexusDatabase;
  log: (msg: string) => void;
  getTools: () => Tool[];
  toolContext: ToolContext;
  workspaceDir: string;
};

type JobRow = {
  id: string;
  owner_agent_id: string;
  name: string;
  cron: string;
  timezone: string;
  enabled: number;
  spec_json: string;
  next_run_at: number | null;
  consecutive_failures: number;
  last_failure_at: number | null;
  last_notified_at: number | null;
};

export function startJobScheduler(deps: JobSchedulerDeps): { stop: () => void } | null {
  const enabled = envBool("NEXUS_SCHEDULER") ?? deps.config.scheduler.enabled;
  if (!enabled) return null;

  const tickIntervalMs = Math.max(2_000, envInt("NEXUS_SCHEDULER_TICK_MS") ?? deps.config.scheduler.tickIntervalMs);
  const maxRunsPerTick = Math.max(1, envInt("NEXUS_SCHEDULER_MAX_RUNS_PER_TICK") ?? deps.config.scheduler.maxRunsPerTick);
  const leaseTtlMs = Math.max(5_000, envInt("NEXUS_SCHEDULER_LEASE_TTL_MS") ?? deps.config.scheduler.leaseTtlMs);
  const maxConsecutiveFailures = Math.max(
    1,
    envInt("NEXUS_SCHEDULER_MAX_CONSECUTIVE_FAILURES") ?? deps.config.scheduler.maxConsecutiveFailures,
  );
  const notifyAgentOnFailure = envBool("NEXUS_SCHEDULER_NOTIFY_AGENT_ON_FAILURE") ?? deps.config.scheduler.notifyAgentOnFailure;
  const notifyCooldownMs = Math.max(0, envInt("NEXUS_SCHEDULER_NOTIFY_COOLDOWN_MS") ?? deps.config.scheduler.notifyCooldownMs);

  const leaseId = `${process.pid}:${randomId("L")}`;
  const scheduleCache = new Map<string, { schedule: ReturnType<typeof parseCron>; timeZone: string }>();

  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  const scheduleNext = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), Math.max(250, delayMs));
  };

  const getSchedule = (cron: string, timeZone: string) => {
    const tz = validateTimeZone(timeZone);
    const key = `${cron}@@${tz}`;
    const cached = scheduleCache.get(key);
    if (cached) return cached;
    const schedule = parseCron(cron);
    const rec = { schedule, timeZone: tz };
    scheduleCache.set(key, rec);
    return rec;
  };

  const acquireLease = (jobId: string, nowMs: number): boolean => {
    const until = nowMs + leaseTtlMs;
    const stmt = deps.db.db.prepare(`
      INSERT INTO job_leases(job_id, lease_id, leased_until, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        lease_id=excluded.lease_id,
        leased_until=excluded.leased_until,
        updated_at=excluded.updated_at
      WHERE job_leases.leased_until < ? OR job_leases.lease_id = ?
    `);
    const res = stmt.run(jobId, leaseId, until, nowMs, nowMs, leaseId);
    return res.changes > 0;
  };

  const releaseLease = (jobId: string) => {
    try {
      deps.db.db.prepare("DELETE FROM job_leases WHERE job_id = ? AND lease_id = ?").run(jobId, leaseId);
    } catch {
      // ignore
    }
  };

  const ensureNextRunAt = (job: JobRow, nowMs: number): number | null => {
    if (!job.enabled) return null;
    try {
      const { schedule, timeZone } = getSchedule(job.cron, job.timezone);
      return nextCronTimeMs({ schedule, afterMs: nowMs, timeZone });
    } catch (e) {
      deps.log(`scheduler: invalid cron job=${job.id} err=${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  const insertEvent = (params: { jobId: string; runId?: string | null; ownerAgentId: string; kind: string; payload: unknown; nowMs: number }) => {
    const id = randomId("JE");
    deps.db.db
      .prepare(
        "INSERT INTO job_events (id, job_id, run_id, owner_agent_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, params.jobId, params.runId ?? null, params.ownerAgentId, params.kind, JSON.stringify(params.payload ?? {}), params.nowMs);
  };

  const notifyAgent = async (
    job: JobRow,
    runId: string,
    failure: { status: string; output: string; paused: boolean },
    nowMs: number,
  ) => {
    if (!notifyAgentOnFailure) return;
    if (notifyCooldownMs > 0 && job.last_notified_at && nowMs - job.last_notified_at < notifyCooldownMs) return;

    const text = [
      "JOB FAILURE DETECTED",
      `job_id=${job.id}`,
      `job_name=${job.name}`,
      `run_id=${runId}`,
      `cron=${job.cron}`,
      `timezone=${job.timezone}`,
      `consecutive_failures=${job.consecutive_failures}`,
      ...(failure.paused ? ["", `NOTE: This job was auto-paused after ${maxConsecutiveFailures} consecutive failures.`] : []),
      "",
      "Last run status:",
      failure.status,
      "",
      "Last output (truncated):",
      truncate(failure.output, 6000),
      "",
      "Instructions:",
      "- Diagnose root cause and fix the job (use job_get/job_update/job_pause/job_runs).",
      "- Prefer small, reversible changes.",
      "- If you are blocked on OTP/MFA/CAPTCHA/etc, use human_request.",
      "- If the job is unsafe to retry automatically, pause it.",
    ].join("\n");

    const res = await deps.agent.handleUserMessage({
      channel: "job",
      channelKey: job.id,
      agentId: job.owner_agent_id,
      text,
    });

    insertEvent({
      jobId: job.id,
      runId,
      ownerAgentId: job.owner_agent_id,
      kind: "agent_notified",
      payload: { output: res.output, status: (res as any).status ?? null },
      nowMs,
    });

    deps.db.db.prepare("UPDATE jobs SET last_notified_at = ?, updated_at = ? WHERE id = ?").run(nowMs, nowMs, job.id);
  };

  const executeJobLogic = async (
    job: JobRow,
    runId: string,
    scheduledFor: number,
  ): Promise<{ status: string; output: string; error: string | null; toolCalls: number | null; iterations: number | null }> => {
    const raw = safeJsonParse(job.spec_json) as any;
    const mode = raw?.mode || "agent_task";

    if (mode === "agent_task") {
      const task = (raw && typeof raw === "object" && raw.task ? String(raw.task) : "").trim();
      const userText = [
        "SCHEDULED JOB RUN",
        `job_id=${job.id}`,
        `job_name=${job.name}`,
        `run_id=${runId}`,
        `scheduled_for=${new Date(scheduledFor).toISOString()}`,
        `cron=${job.cron}`,
        `timezone=${job.timezone}`,
        "",
        "Task:",
        task || "(no task specified)",
        "",
        "When you finish, end your response with exactly one line:",
        "JOB_STATUS: ok",
        "or",
        "JOB_STATUS: error",
      ].join("\n");

      const res = await deps.agent.handleUserMessage({
        channel: "job",
        channelKey: job.id,
        agentId: job.owner_agent_id,
        text: userText,
      });

      const ok = res.status === "complete";
      return {
        status: ok ? "success" : "failed",
        output: res.output,
        error: ok ? null : res.output,
        toolCalls: res.toolCallsUsed ?? null,
        iterations: res.iterationsUsed ?? null,
      };
    }

    if (mode === "script") {
      if (!deps.toolContext.allowShellExec) throw new Error("shell execution disabled");
      const spec = ScriptSpec.parse(raw);
      const { stdout, stderr } = await execAsync(spec.command, {
        cwd: spec.cwd || deps.workspaceDir,
        timeout: spec.timeoutMs || 60_000,
      });
      const output = (stdout || "") + (stderr ? `\nSTDERR:\n${stderr}` : "");
      return {
        status: "success",
        output,
        error: null,
        toolCalls: 0,
        iterations: 0,
      };
    }

    if (mode === "tool_call") {
      const spec = ToolCallSpec.parse(raw);
      const tool = deps.getTools().find((t) => t.name === spec.tool);
      if (!tool) throw new Error(`tool '${spec.tool}' not found`);

      const toolCtx = {
        ...deps.toolContext,
        request: {
          channel: "job",
          channelKey: job.id,
          agentId: job.owner_agent_id,
          sessionId: runId,
          runId,
        },
      };
      const output = await tool.execute(spec.args, toolCtx);
      // If the tool output implies failure (by convention starting with ERROR:), we mark it as failed?
      // Let's stick to "success" for the RUN, even if the tool returned an error string,
      // because the job *ran* correctly. The output log will show the error.
      return {
        status: "success",
        output,
        error: null,
        toolCalls: 1,
        iterations: 0,
      };
    }

    throw new Error(`unknown mode: ${mode}`);
  };

  const runJob = async (job: JobRow, nowMs: number) => {
    const runId = randomId("JR");
    const scheduledFor = job.next_run_at ?? nowMs;
    const startedAt = Date.now();

    deps.db.db
      .prepare(
        "INSERT INTO job_runs (id, job_id, owner_agent_id, scheduled_for, started_at, status) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(runId, job.id, job.owner_agent_id, scheduledFor, startedAt, "running");

    insertEvent({
      jobId: job.id,
      runId,
      ownerAgentId: job.owner_agent_id,
      kind: "run_started",
      payload: { scheduledFor, startedAt },
      nowMs: startedAt,
    });

    try {
      const res = await executeJobLogic(job, runId, scheduledFor);

      const endedAt = Date.now();
      const ok = res.status === "success";
      const errText = ok ? null : truncate(res.output.trim(), 800);

      deps.db.db
        .prepare(
          "UPDATE job_runs SET ended_at = ?, status = ?, error = ?, output = ?, tool_calls_used = ?, iterations_used = ? WHERE id = ?",
        )
        .run(endedAt, res.status, errText, res.output, res.toolCalls, res.iterations, runId);

      if (ok) {
        const { schedule, timeZone } = getSchedule(job.cron, job.timezone);
        const nextRunAt = nextCronTimeMs({ schedule, afterMs: endedAt, timeZone });
        deps.db.db
          .prepare(
            "UPDATE jobs SET last_run_at = ?, next_run_at = ?, consecutive_failures = 0, last_failure_at = NULL, updated_at = ? WHERE id = ?",
          )
          .run(endedAt, nextRunAt, endedAt, job.id);

        insertEvent({
          jobId: job.id,
          runId,
          ownerAgentId: job.owner_agent_id,
          kind: "run_succeeded",
          payload: { endedAt, nextRunAt },
          nowMs: endedAt,
        });
        return;
      }

      // Handle application-level failure (e.g. LLM said "JOB_STATUS: error")
      const consecutiveFailures = (job.consecutive_failures ?? 0) + 1;
      const backoffMs = computeFailureBackoffMs(consecutiveFailures);
      const { schedule, timeZone } = getSchedule(job.cron, job.timezone);
      const nextScheduled = nextCronTimeMs({ schedule, afterMs: endedAt, timeZone });
      const nextRunAt = Math.max(nextScheduled, endedAt + backoffMs);

      const shouldPause = consecutiveFailures >= maxConsecutiveFailures;

      deps.db.db
        .prepare(
          "UPDATE jobs SET consecutive_failures = ?, last_failure_at = ?, next_run_at = ?, enabled = ?, updated_at = ? WHERE id = ?",
        )
        .run(consecutiveFailures, endedAt, shouldPause ? null : nextRunAt, shouldPause ? 0 : job.enabled, endedAt, job.id);

      insertEvent({
        jobId: job.id,
        runId,
        ownerAgentId: job.owner_agent_id,
        kind: shouldPause ? "run_failed_paused" : "run_failed",
        payload: {
          endedAt,
          nextScheduled,
          nextRunAt: shouldPause ? null : nextRunAt,
          backoffMs,
          runnerStatus: res.status,
          error: errText,
        },
        nowMs: endedAt,
      });

      await notifyAgent(
        { ...job, consecutive_failures: consecutiveFailures, enabled: shouldPause ? 0 : job.enabled },
        runId,
        { status: res.status, output: res.output, paused: shouldPause },
        endedAt,
      );
    } catch (e) {
      // Handle system/execution exception
      const endedAt = Date.now();
      const output = `ERROR: scheduler exception while running job: ${e instanceof Error ? e.message : String(e)}`;
      deps.db.db
        .prepare("UPDATE job_runs SET ended_at = ?, status = ?, error = ?, output = ? WHERE id = ?")
        .run(endedAt, "failed", truncate(output, 800), output, runId);

      const consecutiveFailures = (job.consecutive_failures ?? 0) + 1;
      const shouldPause = consecutiveFailures >= maxConsecutiveFailures;
      let nextRunAt: number | null = null;
      let nextScheduled: number | null = null;
      try {
        const backoffMs = computeFailureBackoffMs(consecutiveFailures);
        const { schedule, timeZone } = getSchedule(job.cron, job.timezone);
        nextScheduled = nextCronTimeMs({ schedule, afterMs: endedAt, timeZone });
        nextRunAt = Math.max(nextScheduled, endedAt + backoffMs);
      } catch {
        // leave nextRunAt null
      }

      deps.db.db
        .prepare(
          "UPDATE jobs SET consecutive_failures = ?, last_failure_at = ?, next_run_at = ?, enabled = ?, updated_at = ? WHERE id = ?",
        )
        .run(consecutiveFailures, endedAt, shouldPause ? null : nextRunAt, shouldPause ? 0 : job.enabled, endedAt, job.id);

      insertEvent({
        jobId: job.id,
        runId,
        ownerAgentId: job.owner_agent_id,
        kind: shouldPause ? "run_exception_paused" : "run_exception",
        payload: { endedAt, nextScheduled, nextRunAt, error: output },
        nowMs: endedAt,
      });

      await notifyAgent(
        { ...job, consecutive_failures: consecutiveFailures, enabled: shouldPause ? 0 : job.enabled },
        runId,
        { status: "exception", output, paused: shouldPause },
        endedAt,
      );
    }
  };

  const tick = async () => {
    if (stopped) return;
    if (running) {
      deps.log("scheduler: skip tick (still running)");
      scheduleNext(tickIntervalMs);
      return;
    }
    running = true;

    const startMs = Date.now();
    try {
      const nowMs = Date.now();

      // Backfill next_run_at for enabled jobs if missing.
      const missing = deps.db.db
        .prepare("SELECT id, owner_agent_id, name, cron, timezone, enabled, spec_json, next_run_at, consecutive_failures, last_failure_at, last_notified_at FROM jobs WHERE enabled = 1 AND next_run_at IS NULL LIMIT 50")
        .all() as JobRow[];
      for (const job of missing) {
        const nextRunAt = ensureNextRunAt(job, nowMs);
        if (nextRunAt) {
          deps.db.db.prepare("UPDATE jobs SET next_run_at = ?, updated_at = ? WHERE id = ?").run(nextRunAt, nowMs, job.id);
        } else {
          // Disable invalid jobs; agent can fix via job_update.
          deps.db.db.prepare("UPDATE jobs SET enabled = 0, updated_at = ? WHERE id = ?").run(nowMs, job.id);
          insertEvent({
            jobId: job.id,
            ownerAgentId: job.owner_agent_id,
            kind: "disabled_invalid_cron",
            payload: { cron: job.cron, timezone: job.timezone },
            nowMs,
          });
        }
      }

      const due = deps.db.db
        .prepare(
          "SELECT id, owner_agent_id, name, cron, timezone, enabled, spec_json, next_run_at, consecutive_failures, last_failure_at, last_notified_at FROM jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?",
        )
        .all(nowMs, maxRunsPerTick) as JobRow[];

      for (const job of due) {
        if (!acquireLease(job.id, nowMs)) continue;
        try {
          await runJob(job, nowMs);
        } catch (e) {
          deps.log(`scheduler: run error job=${job.id} err=${e instanceof Error ? e.message : String(e)}`);
        } finally {
          releaseLease(job.id);
        }
      }
    } catch (e) {
      deps.log(`scheduler: tick error ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      const tookMs = Date.now() - startMs;
      if (tookMs > tickIntervalMs) deps.log(`scheduler: slow tick tookMs=${tookMs}`);
      running = false;
      scheduleNext(tickIntervalMs);
    }
  };

  deps.log(
    `scheduler: enabled tickIntervalMs=${tickIntervalMs} maxRunsPerTick=${maxRunsPerTick} leaseTtlMs=${leaseTtlMs} notifyAgentOnFailure=${notifyAgentOnFailure}`,
  );

  // Start shortly after boot.
  scheduleNext(Math.min(2000, tickIntervalMs));

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
