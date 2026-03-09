import { z } from "zod";

import { defineTool, type ToolContext } from "../core/tools.js";
import type { ProcessManager } from "../process/manager.js";
import type { NexusDatabase } from "../storage/database.js";
import { nodeProcessLogs, nodeProcessStart, nodeProcessStatus, nodeProcessStop } from "./nodes.js";

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const remoteSecuritySchema = z
  .object({
    requireNexusBackend: z
      .boolean()
      .optional()
      .describe("Require routing to a Nexus backend node; fail if unmet."),
    requireHermesMode: z
      .boolean()
      .optional()
      .describe("Require routing to a Nexus node advertising hermes.mode.hermes; fail if unmet."),
  })
  .optional();

const notifySchema = z
  .object({
    mode: z.enum(["never", "on_failure", "on_exit"]).optional(),
    chatId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Telegram chat id for notifications (private chats only)"),
    preset: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("Preset to use for callback summarization (default: orchestrator)"),
  })
  .optional()
  .describe("Optional notification callback settings (best-effort).");

const processManageParams = z.object({
  action: z.enum(["start", "list", "status", "logs", "stop"]),
  target: z.enum(["local", "node"]).optional(),
  nodeId: z.string().min(1).max(128).optional(),
  command: z.string().min(1).max(4000).optional(),
  cwd: z.string().max(2000).optional().describe("Working directory (local defaults to stateDir)"),
  processId: z.string().min(1).max(128).optional(),
  maxChars: z.number().int().min(200).max(50_000).optional(),
  signal: z.enum(["SIGTERM", "SIGINT", "SIGKILL"]).optional(),
  killAfterMs: z.number().int().min(0).max(60_000).optional(),
  reason: z.string().min(1).max(200).optional(),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
  security: remoteSecuritySchema,
  notify: notifySchema,
}).superRefine((value, issueCtx) => {
  if (value.action === "start" && !value.command) {
    issueCtx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "command is required when action='start'",
      path: ["command"],
    });
  }
  if ((value.action === "status" || value.action === "logs" || value.action === "stop") && !value.processId) {
    issueCtx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `processId is required when action='${value.action}'`,
      path: ["processId"],
    });
  }
});

type ProcessManageArgs = z.infer<typeof processManageParams>;
type ResolvedTarget =
  | { target: "local" }
  | { target: "node"; nodeId: string };

function getProcessManager(ctx: { processManager?: unknown }): ProcessManager | null {
  const mgr = ctx.processManager as ProcessManager | undefined;
  return mgr ?? null;
}

function getPinnedExecutionNode(ctx: { executionNode?: string }): string | null {
  const nodeId = typeof ctx.executionNode === "string" ? ctx.executionNode.trim() : "";
  return nodeId.length > 0 ? nodeId : null;
}

function resolveTarget(args: ProcessManageArgs, ctx: { executionNode?: string }): { ok: true; value: ResolvedTarget } | { ok: false; error: string } {
  const pinnedNodeId = getPinnedExecutionNode(ctx);
  const requestedTarget = args.target ?? (pinnedNodeId ? "node" : "local");

  if (requestedTarget === "local") {
    if (pinnedNodeId) {
      return {
        ok: false,
        error: `ERROR: node-pinned run requires process_manage target=node (nodeId=${pinnedNodeId}).`,
      };
    }
    if (typeof args.nodeId === "string" && args.nodeId.trim()) {
      return {
        ok: false,
        error: "ERROR: nodeId is only valid when target='node'.",
      };
    }
    return { ok: true, value: { target: "local" } };
  }

  const explicitNodeId = typeof args.nodeId === "string" ? args.nodeId.trim() : "";
  if (pinnedNodeId && explicitNodeId && explicitNodeId !== pinnedNodeId) {
    return {
      ok: false,
      error:
        `ERROR: node-pinned run (${pinnedNodeId}) cannot target node "${explicitNodeId}". ` +
        `Use nodeId="${pinnedNodeId}" or omit nodeId.`,
    };
  }
  const nodeId = explicitNodeId || pinnedNodeId;
  if (!nodeId) {
    return {
      ok: false,
      error: "ERROR: nodeId is required when target='node'.",
    };
  }
  return { ok: true, value: { target: "node", nodeId } };
}

function validateLocalOnlyArgs(args: ProcessManageArgs): string | null {
  if (args.timeoutMs !== undefined) {
    return "ERROR: timeoutMs is only supported when target='node'.";
  }
  if (args.security) {
    return "ERROR: security is only supported when target='node'.";
  }
  return null;
}

async function startLocalProcess(args: ProcessManageArgs, ctx: {
  allowShellExec?: boolean;
  processManager?: unknown;
  db?: unknown;
  request?: {
    channel: string;
    channelKey: string;
    agentId: string;
    preset?: string;
    sessionId: string;
    runId?: string;
    parentRunId?: string;
  };
  nowMs: () => number;
}): Promise<string> {
  if (!ctx.allowShellExec) return "ERROR: process_manage is disabled by policy (enable NEXUS_ALLOW_SHELL_EXEC=1)";
  const mgr = getProcessManager(ctx);
  if (!mgr) return "ERROR: process manager unavailable";

  try {
    const db = ctx.db as NexusDatabase | undefined;
    const request = ctx.request
      ? {
          channel: ctx.request.channel,
          channelKey: ctx.request.channelKey,
          agentId: ctx.request.agentId,
          preset: ctx.request.preset,
          sessionId: ctx.request.sessionId,
          runId: ctx.request.runId,
          parentRunId: ctx.request.parentRunId,
        }
      : undefined;
    const info = await mgr.start({ command: args.command ?? "", cwd: args.cwd, request });

    if (db) {
      const requestedMode = args.notify?.mode;
      const defaultMode = ctx.request?.channel === "telegram" ? "on_failure" : "never";
      const mode = requestedMode ?? defaultMode;
      const chatIdRaw = args.notify?.chatId ?? (ctx.request?.channel === "telegram" ? Number(ctx.request.channelKey) : null);
      const chatId = typeof chatIdRaw === "number" && Number.isFinite(chatIdRaw) && chatIdRaw > 0 ? Math.floor(chatIdRaw) : null;
      const preset = args.notify?.preset?.trim() ? args.notify.preset.trim() : "orchestrator";
      try {
        db.db
          .prepare(
            `
            UPDATE process_runs
            SET notify_mode = ?,
                notify_chat_id = ?,
                notify_preset = ?,
                updated_at = ?
            WHERE id = ?
          `,
          )
          .run(mode, chatId, preset, ctx.nowMs(), info.id);
      } catch {
        // ignore
      }
    }

    await sleep(250);
    const current = mgr.get(info.id) ?? info;
    if (current.status !== "running") {
      const logs = await mgr.tailLogs({ id: info.id, maxChars: 4000 }).catch(() => "");
      const baseHint =
        `HINT: The process exited immediately. Inspect logs with ` +
        `process_manage(action='logs', processId='${info.id}', maxChars=4000) before restarting.`;
      const isSchedulerPattern = /schedul|cron|periodic|interval|every\s*\d|while\s*(true|True)|time\.sleep|sleep\(/i.test(
        (args.command ?? "") + "\n" + logs,
      );
      const schedulerHint = isSchedulerPattern
        ? "\nHINT: This looks like a scheduled/periodic task. Use job_manage (built-in cron scheduler) instead of process_manage(action='start') with a script. " +
          "No pip packages or Python scripts needed. " +
          `Example: job_manage({ action: "create", name: "my-task", cron: "*/5 * * * *", task: "Describe what the job should do each run" })`
        : "";

      if (db) {
        const nowMs = ctx.nowMs();
        try {
          db.db
            .prepare(
              `
              UPDATE process_runs
              SET notified_at = ?, notify_last_error = ?, notify_next_attempt_at = NULL, updated_at = ?
              WHERE id = ? AND notified_at IS NULL
            `,
            )
            .run(nowMs, "suppressed: immediate exit surfaced to caller", nowMs, info.id);
        } catch {
          // ignore
        }
      }

      return `ERROR: process exited (status=${current.status}, code=${current.exitCode ?? "null"}, signal=${current.signal ?? "null"})\n${baseHint}${schedulerHint}\n\n${JSON.stringify(current)}\n\nLOGS:\n${logs}`;
    }

    return JSON.stringify(current);
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function listLocalProcesses(ctx: { processManager?: unknown }): Promise<string> {
  const mgr = getProcessManager(ctx);
  if (!mgr) return "ERROR: process manager unavailable";
  return JSON.stringify(mgr.list());
}

async function statusLocalProcess(processId: string, ctx: { processManager?: unknown }): Promise<string> {
  const mgr = getProcessManager(ctx);
  if (!mgr) return "ERROR: process manager unavailable";
  const info = mgr.get(processId);
  if (!info) return "ERROR: not found";
  return JSON.stringify(info);
}

async function logsLocalProcess(processId: string, maxChars: number | undefined, ctx: { processManager?: unknown }): Promise<string> {
  const mgr = getProcessManager(ctx);
  if (!mgr) return "ERROR: process manager unavailable";
  try {
    return await mgr.tailLogs({ id: processId, maxChars: maxChars ?? 8000 });
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function stopLocalProcess(args: ProcessManageArgs, ctx: { allowShellExec?: boolean; processManager?: unknown }): Promise<string> {
  if (!ctx.allowShellExec) return "ERROR: process_manage is disabled by policy (enable NEXUS_ALLOW_SHELL_EXEC=1)";
  const mgr = getProcessManager(ctx);
  if (!mgr) return "ERROR: process manager unavailable";
  try {
    const info = await mgr.stop({
      id: args.processId ?? "",
      signal: args.signal ?? "SIGTERM",
      killAfterMs: args.killAfterMs ?? 5000,
    });
    return JSON.stringify(info);
  } catch (e) {
    return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function executeLocalAction(args: ProcessManageArgs, ctx: {
  allowShellExec?: boolean;
  processManager?: unknown;
  db?: unknown;
  request?: {
    channel: string;
    channelKey: string;
    agentId: string;
    preset?: string;
    sessionId: string;
    runId?: string;
    parentRunId?: string;
  };
  nowMs: () => number;
}): Promise<string> {
  const localOnlyError = validateLocalOnlyArgs(args);
  if (localOnlyError) return localOnlyError;
  switch (args.action) {
    case "start":
      return await startLocalProcess(args, ctx);
    case "list":
      return await listLocalProcesses(ctx);
    case "status":
      return await statusLocalProcess(args.processId ?? "", ctx);
    case "logs":
      return await logsLocalProcess(args.processId ?? "", args.maxChars, ctx);
    case "stop":
      return await stopLocalProcess(args, ctx);
  }
}

async function executeNodeAction(args: ProcessManageArgs, nodeId: string, ctx: ToolContext): Promise<string> {
  switch (args.action) {
    case "start":
      return await nodeProcessStart.execute(
        {
          id: nodeId,
          command: args.command ?? "",
          ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
          ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          ...(args.notify ? { notify: args.notify } : {}),
          ...(args.security ? { security: args.security } : {}),
        },
        ctx,
      );
    case "list":
      return "ERROR: remote process listing is not implemented yet; use action='status', 'logs', or 'stop' with a known processId.";
    case "status":
      return await nodeProcessStatus.execute({ id: nodeId, processId: args.processId ?? "" }, ctx);
    case "logs":
      return await nodeProcessLogs.execute(
        {
          id: nodeId,
          processId: args.processId ?? "",
          ...(args.maxChars !== undefined ? { maxChars: args.maxChars } : {}),
        },
        ctx,
      );
    case "stop":
      return await nodeProcessStop.execute(
        {
          id: nodeId,
          processId: args.processId ?? "",
          ...(args.signal !== undefined ? { signal: args.signal } : {}),
          ...(args.killAfterMs !== undefined ? { killAfterMs: args.killAfterMs } : {}),
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        },
        ctx,
      );
  }
}

export const processManage = defineTool({
  name: "process_manage",
  description:
    "Manage long-running local or node-backed processes. Use target='local' for gateway processes and target='node' for remote nodes. In node-pinned runs, target defaults to the pinned node.",
  parameters: processManageParams,
  execute: async (args, ctx) => {
    const resolved = resolveTarget(args, ctx);
    if (!resolved.ok) return resolved.error;
    if (resolved.value.target === "local") {
      return await executeLocalAction(args, ctx);
    }
    return await executeNodeAction(args, resolved.value.nodeId, ctx);
  },
});
