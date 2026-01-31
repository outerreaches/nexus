import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { ProcessManager } from "../process/manager.js";

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export const processStart = defineTool({
  name: "process_start",
  description:
    "Start a long-running process in the background and return an id. Use this instead of shell_exec for daemons/schedulers/servers.",
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
        const hint = `HINT: The process exited immediately. Inspect logs with process_logs and fix the underlying error before restarting.`;
        return `ERROR: process exited (status=${current.status}, code=${current.exitCode ?? "null"}, signal=${current.signal ?? "null"})\n${hint}\n\n${JSON.stringify(current, null, 2)}\n\nLOGS:\n${logs}`;
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
