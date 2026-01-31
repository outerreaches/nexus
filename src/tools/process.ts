import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { ProcessManager } from "../process/manager.js";

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export const processStart = defineTool({
  name: "process_start",
  description:
    "Start a persistent background daemon (server, watcher) and return an id. For periodic/scheduled tasks, use job_create instead.",
  parameters: z.object({
    command: z.string().min(1).max(4000),
    cwd: z.string().max(2000).optional().describe("Working directory (defaults to stateDir)"),
  }),
  execute: async (args, ctx) => {
    if (!ctx.allowShellExec) return "ERROR: process_start is disabled by policy (enable NEXUS_ALLOW_SHELL_EXEC=1)";
    const mgr = ctx.processManager as ProcessManager | undefined;
    if (!mgr) return "ERROR: process manager unavailable";
    try {
      const info = await mgr.start({ command: args.command, cwd: args.cwd });

      // If the process dies immediately, surface it as an error so the agent doesn't assume it's running.
      await sleep(250);
      const current = mgr.get(info.id) ?? info;
      if (current.status !== "running") {
        const logs = await mgr.tailLogs({ id: info.id, maxChars: 4000 }).catch(() => "");
        const baseHint = `HINT: The process exited immediately. Inspect logs with process_logs and fix the underlying error before restarting.`;
        const isSchedulerPattern = /schedul|cron|periodic|interval|every\s*\d|while\s*(true|True)|time\.sleep|sleep\(/i.test(
          args.command + "\n" + logs,
        );
        const schedulerHint = isSchedulerPattern
          ? `\nHINT: This looks like a scheduled/periodic task. Use job_create (built-in cron scheduler) instead of process_start with a script. ` +
            `No pip packages or Python scripts needed. ` +
            `Example: job_create({ name: "my-task", cron: "*/5 * * * *", task: "Describe what the job should do each run" })`
          : "";
        return `ERROR: process exited (status=${current.status}, code=${current.exitCode ?? "null"}, signal=${current.signal ?? "null"})\n${baseHint}${schedulerHint}\n\n${JSON.stringify(current, null, 2)}\n\nLOGS:\n${logs}`;
      }

      return JSON.stringify(current, null, 2);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

export const processList = defineTool({
  name: "process_list",
  description: "List processes started via process_start.",
  parameters: z.object({}),
  execute: async (_args, ctx) => {
    const mgr = ctx.processManager as ProcessManager | undefined;
    if (!mgr) return "ERROR: process manager unavailable";
    return JSON.stringify(mgr.list(), null, 2);
  },
});

export const processStatus = defineTool({
  name: "process_status",
  description: "Get status for a process started via process_start.",
  parameters: z.object({
    id: z.string().min(1).max(32),
  }),
  execute: async (args, ctx) => {
    const mgr = ctx.processManager as ProcessManager | undefined;
    if (!mgr) return "ERROR: process manager unavailable";
    const info = mgr.get(args.id);
    if (!info) return "ERROR: not found";
    return JSON.stringify(info, null, 2);
  },
});

export const processStop = defineTool({
  name: "process_stop",
  description: "Stop a running process started via process_start.",
  parameters: z.object({
    id: z.string().min(1).max(32),
    signal: z.enum(["SIGTERM", "SIGINT", "SIGKILL"]).default("SIGTERM"),
    killAfterMs: z.number().int().min(0).max(60_000).default(5000),
  }),
  execute: async (args, ctx) => {
    if (!ctx.allowShellExec) return "ERROR: process_stop is disabled by policy (enable NEXUS_ALLOW_SHELL_EXEC=1)";
    const mgr = ctx.processManager as ProcessManager | undefined;
    if (!mgr) return "ERROR: process manager unavailable";
    try {
      const info = await mgr.stop({ id: args.id, signal: args.signal as any, killAfterMs: args.killAfterMs });
      return JSON.stringify(info, null, 2);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

export const processLogs = defineTool({
  name: "process_logs",
  description: "Tail logs for a process started via process_start.",
  parameters: z.object({
    id: z.string().min(1).max(32),
    maxChars: z.number().int().min(200).max(50_000).default(8000),
  }),
  execute: async (args, ctx) => {
    const mgr = ctx.processManager as ProcessManager | undefined;
    if (!mgr) return "ERROR: process manager unavailable";
    try {
      const text = await mgr.tailLogs({ id: args.id, maxChars: args.maxChars });
      return text;
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});
