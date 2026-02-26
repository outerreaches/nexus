import crypto from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import { z } from "zod";

import type { NexusConfig } from "../state/config.js";
import type { AgentService } from "../core/agent-service.js";
import type { NexusDatabase } from "../storage/database.js";
import { archiveAndDeleteJob } from "../storage/job-archive.js";
import { enqueueRunReport } from "../storage/run-reports.js";
import type { Tool, ToolContext } from "../core/tools.js";
import { nextCronTimeMs, parseCron, validateTimeZone } from "./cron.js";

const execAsync = promisify(exec);
const ONE_SHOT_CRON = "@once";

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

function parseJobStatusMarker(output: string): "ok" | "error" | null {
  const matches = [...output.matchAll(/^\s*JOB_STATUS:\s*(ok|error)\s*$/gim)];
  if (matches.length === 0) return null;
  const marker = matches[matches.length - 1]?.[1]?.toLowerCase();
  return marker === "ok" || marker === "error" ? marker : null;
}

function parseJobReportMarker(output: string): "none" | "update" | "urgent" | null {
  const matches = [...output.matchAll(/^\s*JOB_REPORT:\s*(none|update|urgent)\s*$/gim)];
  if (matches.length === 0) return null;
  const marker = matches[matches.length - 1]?.[1]?.toLowerCase();
  return marker === "none" || marker === "update" || marker === "urgent" ? marker : null;
}

function isIdleOutput(output: string): boolean {
  const t = output.trim();
  if (!t) return true;
  const upper = t.toUpperCase();
  return upper === "IDLE" || upper === "NOOP" || upper === "NO-OP";
}

function computeFailureBackoffMs(consecutiveFailures: number): number {
  const minutes = Math.min(60, Math.max(1, 2 ** Math.max(0, consecutiveFailures - 1)));
  return minutes * 60_000;
}

function isOneShotJob(job: JobRow): boolean {
  return job.cron.trim() === ONE_SHOT_CRON;
}

function getOneShotAtMs(specJson: string): number | null {
  const raw = safeJsonParse(specJson) as { oneShotAtMs?: unknown } | null;
  const value = raw?.oneShotAtMs;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

export type JobSchedulerDeps = {
  config: NexusConfig;
  agent: AgentService;
  db: NexusDatabase;
  log: (msg: string) => void;
  getTickSuppression?: () => {
    suppressed: boolean;
    reason?: string;
    retryAfterMs?: number;
  };
  getTools: () => Tool[];
  toolContext: ToolContext;
  workspaceDir: string;
};

type JobRow = {
  id: string;
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
  const runConcurrency = Math.max(
    1,
    envInt("NEXUS_SCHEDULER_CONCURRENCY") ?? deps.config.scheduler.concurrency ?? maxRunsPerTick,
  );
  const notifyAgentOnFailure = envBool("NEXUS_SCHEDULER_NOTIFY_AGENT_ON_FAILURE") ?? deps.config.scheduler.notifyAgentOnFailure;
  const notifyCooldownMs = Math.max(0, envInt("NEXUS_SCHEDULER_NOTIFY_COOLDOWN_MS") ?? deps.config.scheduler.notifyCooldownMs);
  const schedulerAgentId = (process.env.NEXUS_SCHEDULER_AGENT_ID ?? "main").trim() || "main";
  const notifyRunReports = envBool("NEXUS_SCHEDULER_NOTIFY_RUN_REPORTS")
    ?? envBool("NEXUS_SCHEDULER_NOTIFY_TELEGRAM_REPORTS")
    ?? true;
  const reportOutputMaxChars = Math.max(600, envInt("NEXUS_SCHEDULER_REPORT_MAX_OUTPUT_CHARS") ?? 3_200);

  const leaseId = `${process.pid}:${randomId("L")}`;
  const scheduleCache = new Map<string, { schedule: ReturnType<typeof parseCron>; timeZone: string }>();

  // On-boot sweep: mark any job_runs left as 'running' from a previous instance as failed.
  // These are orphans from a crash/restart that will never complete.
  {
    const nowMs = Date.now();
    const swept = deps.db.db
      .prepare("UPDATE job_runs SET status = 'failed', ended_at = ?, error = 'orphaned: gateway restarted' WHERE status = 'running'")
      .run(nowMs);
    if (swept.changes > 0) {
      deps.log(`scheduler: swept ${swept.changes} orphaned job_run(s) from previous instance`);
    }
  }

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
    if (isOneShotJob(job)) {
      const atMs = getOneShotAtMs(job.spec_json);
      if (atMs === null) return null;
      return Math.max(atMs, nowMs);
    }
    try {
      const { schedule, timeZone } = getSchedule(job.cron, job.timezone);
      return nextCronTimeMs({ schedule, afterMs: nowMs, timeZone });
    } catch (e) {
      deps.log(`scheduler: invalid cron job=${job.id} err=${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  const insertEvent = (params: { jobId: string; runId?: string | null; agentId: string; kind: string; payload: unknown; nowMs: number }) => {
    const id = randomId("JE");
    deps.db.db
      .prepare(
        "INSERT INTO job_events (id, job_id, run_id, owner_agent_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, params.jobId, params.runId ?? null, params.agentId, params.kind, JSON.stringify(params.payload ?? {}), params.nowMs);
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
      "- Diagnose root cause and fix the job.",
      "- If scheduling tools are needed, use `job_manage` with the appropriate action (`list`, `get`, `update`, etc.).",
      "- Prefer small, reversible changes.",
      "- If you are blocked on OTP/MFA/CAPTCHA/etc, use human_action with action=\"request\".",
      "- If the job is unsafe to retry automatically, pause it.",
    ].join("\n");

    const res = await deps.agent.handleUserMessage({
      channel: "job",
      channelKey: job.id,
      agentId: schedulerAgentId,
      preset: "orchestrator",
      text,
      executionLane: "background",
    });

    insertEvent({
      jobId: job.id,
      runId,
      agentId: schedulerAgentId,
      kind: "agent_notified",
      payload: { output: res.output, status: (res as any).status ?? null },
      nowMs,
    });

    deps.db.db.prepare("UPDATE jobs SET last_notified_at = ?, updated_at = ? WHERE id = ?").run(nowMs, nowMs, job.id);
  };

  const queueAgentTaskReport = async (params: {
    job: JobRow;
    runId: string;
    agentRunId: string | null;
    scheduledFor: number;
    endedAt: number;
    status: "success" | "failed";
    output: string;
    idle: boolean;
    reportMarker: "none" | "update" | "urgent" | null;
  }) => {
    if (!notifyRunReports) return;
    const shouldQueue = params.status === "failed"
      || params.reportMarker === "update"
      || params.reportMarker === "urgent";
    if (!shouldQueue) return;

    const statusLabel = params.status === "success" ? "ok" : "error";
    const message = [
      "SCHEDULED AGENT TASK REPORT",
      `job_id=${params.job.id}`,
      `job_name=${params.job.name}`,
      `run_id=${params.runId}`,
      `agent_run_id=${params.agentRunId ?? "n/a"}`,
      `status=${statusLabel}`,
      `report=${params.reportMarker ?? "unspecified"}`,
      `scheduled_for=${new Date(params.scheduledFor).toISOString()}`,
      `ended_at=${new Date(params.endedAt).toISOString()}`,
      "",
      "Output:",
      truncate(params.output, reportOutputMaxChars),
    ].join("\n");

    try {
      const reportId = enqueueRunReport(deps.db, {
        kind: "agent_task",
        title: "SCHEDULED AGENT TASK REPORT",
        body: message,
        sourceRunId: params.agentRunId,
        sourceAgentId: schedulerAgentId,
        sourceChannel: "job",
        sourceChannelKey: params.job.id,
        targetAgentId: schedulerAgentId,
        targetChannel: "agent",
        targetChannelKey: `job:${params.job.id}`,
        metadata: {
          jobId: params.job.id,
          runId: params.runId,
          status: params.status,
          idle: params.idle,
          report: params.reportMarker,
          targetPreset: "orchestrator",
        },
        nowMs: params.endedAt,
      });
      insertEvent({
        jobId: params.job.id,
        runId: params.runId,
        agentId: schedulerAgentId,
        kind: "report_queued",
        payload: { reportId, status: params.status, idle: params.idle },
        nowMs: params.endedAt,
      });
    } catch (err) {
      deps.log(
        `scheduler: report queue failed job=${params.job.id} run=${params.runId} err=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const executeJobLogic = async (
    job: JobRow,
    runId: string,
    scheduledFor: number,
  ): Promise<{
    status: string;
    output: string;
    error: string | null;
    toolCalls: number | null;
    iterations: number | null;
    mode: "agent_task" | "script" | "tool_call";
    idle: boolean;
    agentRunId: string | null;
    reportMarker: "none" | "update" | "urgent" | null;
  }> => {
    const raw = safeJsonParse(job.spec_json) as any;
    const mode = raw?.mode || "agent_task";

    if (mode === "agent_task") {
      const parsed = AgentTaskSpec.safeParse(raw);
      const task = parsed.success
        ? parsed.data.task.trim()
        : (raw && typeof raw === "object" && raw.task ? String(raw.task) : "").trim();
      deps.log(`scheduler: context_disabled job=${job.id} mode=agent_task`);

      const userTextParts = [
        "SCHEDULED JOB RUN",
        `job_id=${job.id}`,
        `job_name=${job.name}`,
        `run_id=${runId}`,
        `scheduled_for=${new Date(scheduledFor).toISOString()}`,
        `cron=${job.cron}`,
        `timezone=${job.timezone}`,
        "context_mode=disabled",
        "",
        "Task:",
        task || "(no task specified)",
      ];
      userTextParts.push(
        "",
        "When you finish, end your response with exactly two lines:",
        "JOB_STATUS: ok|error",
        "JOB_REPORT: none|update|urgent",
        "Use JOB_REPORT:none when there is nothing meaningful to surface to the orchestrator.",
      );
      const userText = userTextParts.join("\n");

      const res = await deps.agent.handleUserMessage({
        channel: "job",
        channelKey: job.id,
        agentId: schedulerAgentId,
        preset: "orchestrator",
        text: userText,
        executionLane: "background",
      });

      const marker = parseJobStatusMarker(res.output);
      const ok = marker ? marker === "ok" : res.status === "complete";
      const reportMarker = parseJobReportMarker(res.output);
      return {
        status: ok ? "success" : "failed",
        output: res.output,
        error: ok ? null : res.output,
        toolCalls: res.toolCallsUsed ?? null,
        iterations: res.iterationsUsed ?? null,
        mode: "agent_task",
        idle: isIdleOutput(res.output),
        agentRunId: res.runId ?? null,
        reportMarker,
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
        mode: "script",
        idle: false,
        agentRunId: null,
        reportMarker: null,
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
          agentId: schedulerAgentId,
          sessionId: runId,
          runId,
        },
      };
      const output = await tool.execute(spec.args, toolCtx);
      const outputTrimmed = output.trimStart();
      const isToolError = outputTrimmed.startsWith("ERROR:");
      return {
        status: isToolError ? "failed" : "success",
        output,
        error: isToolError ? outputTrimmed : null,
        toolCalls: 1,
        iterations: 0,
        mode: "tool_call",
        idle: false,
        agentRunId: null,
        reportMarker: null,
      };
    }

    throw new Error(`unknown mode: ${mode}`);
  };

  const runJob = async (job: JobRow, nowMs: number) => {
    const runId = randomId("JR");
    const scheduledFor = job.next_run_at ?? nowMs;
    const startedAt = Date.now();
    const oneShot = isOneShotJob(job);
    const archiveOneShot = (params: {
      endedAt: number;
      runId: string;
      outcome: "success" | "failed" | "exception";
      output: string | null;
    }): boolean => {
      try {
        const archived = archiveAndDeleteJob({
          db: deps.db,
          jobId: job.id,
          archivedAtMs: params.endedAt,
          archiveReason: `one_shot_${params.outcome}`,
          archivedBy: "scheduler",
          metadata: {
            runId: params.runId,
            outcome: params.outcome,
            output: params.output ? truncate(params.output, 4000) : null,
          },
        });
        if (!archived.found) return true;
        deps.log(
          `scheduler: one-shot archived+deleted job=${job.id} run=${params.runId} status=${params.outcome} archiveId=${archived.jobArchiveId ?? "n/a"} runs=${archived.archivedRuns} events=${archived.archivedEvents}`,
        );
        return true;
      } catch (e) {
        deps.log(
          `scheduler: one-shot archive failed job=${job.id} run=${params.runId} err=${e instanceof Error ? e.message : String(e)}`,
        );
        // Prevent repeated execution if archival path is broken.
        deps.db.db.prepare("UPDATE jobs SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ?").run(params.endedAt, job.id);
        return false;
      }
    };

    deps.db.db
      .prepare(
        "INSERT INTO job_runs (id, job_id, owner_agent_id, scheduled_for, started_at, status) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(runId, job.id, schedulerAgentId, scheduledFor, startedAt, "running");

    insertEvent({
      jobId: job.id,
      runId,
      agentId: schedulerAgentId,
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

      if (res.mode === "agent_task") {
        await queueAgentTaskReport({
          job,
          runId,
          agentRunId: res.agentRunId,
          scheduledFor,
          endedAt,
          status: res.status === "success" ? "success" : "failed",
          output: res.output,
          idle: res.idle,
          reportMarker: res.reportMarker,
        });
      }

      if (ok) {
        if (oneShot) {
          archiveOneShot({ endedAt, runId, outcome: "success", output: res.output });
        } else {
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
            agentId: schedulerAgentId,
            kind: "run_succeeded",
            payload: { endedAt, nextRunAt },
            nowMs: endedAt,
          });
        }
        return;
      }

      // Handle application-level failure (e.g. LLM said "JOB_STATUS: error")
      const consecutiveFailures = (job.consecutive_failures ?? 0) + 1;
      if (oneShot) {
        await notifyAgent(
          { ...job, consecutive_failures: consecutiveFailures, enabled: 0 },
          runId,
          { status: res.status, output: res.output, paused: false },
          endedAt,
        );
        archiveOneShot({ endedAt, runId, outcome: "failed", output: res.output });
        return;
      }
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
        agentId: schedulerAgentId,
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
      if (oneShot) {
        await notifyAgent(
          { ...job, consecutive_failures: consecutiveFailures, enabled: 0 },
          runId,
          { status: "exception", output, paused: false },
          endedAt,
        );
        archiveOneShot({ endedAt, runId, outcome: "exception", output });
        return;
      }
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
        agentId: schedulerAgentId,
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
    const suppression = deps.getTickSuppression?.();
    if (suppression?.suppressed) {
      const retryAfterMs = Math.max(
        1_000,
        Math.floor(suppression.retryAfterMs ?? tickIntervalMs),
      );
      deps.log(
        `scheduler: skip tick reason=${suppression.reason ?? "suppressed"} next=${Math.round(retryAfterMs / 1000)}s`,
      );
      scheduleNext(retryAfterMs);
      return;
    }
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
        .prepare("SELECT id, name, cron, timezone, enabled, spec_json, next_run_at, consecutive_failures, last_failure_at, last_notified_at FROM jobs WHERE enabled = 1 AND next_run_at IS NULL LIMIT 50")
        .all() as JobRow[];
      for (const job of missing) {
        const nextRunAt = ensureNextRunAt(job, nowMs);
        if (nextRunAt) {
          deps.db.db.prepare("UPDATE jobs SET next_run_at = ?, updated_at = ? WHERE id = ?").run(nextRunAt, nowMs, job.id);
        } else {
          // Disable invalid jobs; agent can fix via job_manage(action='update').
          deps.db.db.prepare("UPDATE jobs SET enabled = 0, updated_at = ? WHERE id = ?").run(nowMs, job.id);
          insertEvent({
            jobId: job.id,
            agentId: schedulerAgentId,
            kind: "disabled_invalid_cron",
            payload: { cron: job.cron, timezone: job.timezone },
            nowMs,
          });
        }
      }

      const due = deps.db.db
        .prepare(
          "SELECT id, name, cron, timezone, enabled, spec_json, next_run_at, consecutive_failures, last_failure_at, last_notified_at FROM jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?",
        )
        .all(nowMs, maxRunsPerTick) as JobRow[];

      let nextIndex = 0;
      const workerCount = Math.min(runConcurrency, due.length);
      const workers = Array.from({ length: workerCount }, async () => {
        for (;;) {
          const idx = nextIndex;
          nextIndex += 1;
          if (idx >= due.length) return;
          const job = due[idx];
          if (!job) return;
          if (!acquireLease(job.id, nowMs)) continue;
          try {
            await runJob(job, nowMs);
          } catch (e) {
            deps.log(`scheduler: run error job=${job.id} err=${e instanceof Error ? e.message : String(e)}`);
          } finally {
            releaseLease(job.id);
          }
        }
      });
      await Promise.all(workers);
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
    `scheduler: enabled tickIntervalMs=${tickIntervalMs} maxRunsPerTick=${maxRunsPerTick} concurrency=${runConcurrency} leaseTtlMs=${leaseTtlMs} notifyAgentOnFailure=${notifyAgentOnFailure} notifyRunReports=${notifyRunReports} schedulerAgentId=${schedulerAgentId} contextMode=disabled`,
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
