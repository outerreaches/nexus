import { exec } from "node:child_process";

import { z } from "zod";

import { defineTool } from "../core/tools.js";

/** Hard cap on tool-result size to prevent context blow-up (chars, not bytes). */
const MAX_OUTPUT_CHARS = 60_000;

export function truncateShellOutput(text: string, max: number = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const omitted = text.length - max;
  return `${text.slice(0, half)}\n\n[…truncated ${omitted.toLocaleString()} chars…]\n\n${text.slice(-half)}`;
}

export const shellExec = defineTool({
  name: "shell_exec",
  description:
    "Run a short-lived shell command (guarded; may be disabled). For long-running jobs/daemons use process_start.",
  parameters: z.object({
    command: z.string(),
    timeoutMs: z.number().int().positive().default(60_000),
  }),
  execute: async ({ command, timeoutMs }, ctx) => {
    if (!ctx.allowShellExec) return "ERROR: shell_exec is disabled by policy";
    return await new Promise((resolve) => {
      exec(command, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const anyErr = err as any;
          const isTimeout =
            Boolean(anyErr?.killed) &&
            typeof timeoutMs === "number" &&
            (String(err.message).toLowerCase().includes("timed out") || anyErr?.code === "ETIMEDOUT");
          const hint = isTimeout
            ? `\n\nHINT: This command exceeded ${timeoutMs}ms. If it should keep running (server/scheduler), start it with process_start and inspect with process_logs.`
            : "\n\nHINT: If this keeps failing with the same command, stop retrying and inspect STDERR (or switch approach).";
          resolve(truncateShellOutput(`ERROR: ${err.message}${hint}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`));
        }
        else resolve(truncateShellOutput([stdout, stderr].filter(Boolean).join("\n")));
      });
    });
  },
});
