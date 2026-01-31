import { exec } from "node:child_process";

import { z } from "zod";

import { defineTool } from "../core/tools.js";

export const shellExec = defineTool({
  name: "shell_exec",
  description: "Run a shell command on the host (guarded; may be disabled).",
  parameters: z.object({
    command: z.string(),
    timeoutMs: z.number().int().positive().default(60_000),
  }),
  execute: async ({ command, timeoutMs }, ctx) => {
    if (!ctx.allowShellExec) return "ERROR: shell_exec is disabled by policy";
    return await new Promise((resolve) => {
      exec(command, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) resolve(`ERROR: ${err.message}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`);
        else resolve([stdout, stderr].filter(Boolean).join("\n"));
      });
    });
  },
});

