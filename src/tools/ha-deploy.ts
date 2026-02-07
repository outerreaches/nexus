import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import { truncateShellOutput } from "./system.js";

export const haDeploy = defineTool({
  name: "ha_deploy",
  description:
    "Run HA rollout operations through infra/scripts/ha-rollout.sh. " +
    "Use action='apply_local' after code changes; use action='status' to inspect slots/state.",
  parameters: z.object({
    action: z.enum(["status", "deploy", "apply_local", "rollback", "finalize"]),
    targetRef: z
      .string()
      .optional()
      .describe("Git ref/commit for deploy/finalize/rollback. Defaults: deploy/finalize=HEAD, rollback=last-good"),
    commitMessage: z
      .string()
      .optional()
      .describe("Commit message for apply_local. If omitted, a timestamped message is used."),
    remote: z.string().default("host").describe("Push remote for apply_local"),
    branch: z.string().default("main").describe("Push branch for apply_local"),
    timeoutMs: z.number().int().positive().max(3_600_000).default(900_000),
  }),
  execute: async ({ action, targetRef, commitMessage, remote, branch, timeoutMs }, ctx) => {
    if (!ctx.allowShellExec) return "ERROR: ha_deploy is disabled by policy (shell_exec unavailable)";

    const scriptPath = path.join(ctx.codeDir, "infra", "scripts", "ha-rollout.sh");
    if (!existsSync(scriptPath)) {
      return `ERROR: rollout script not found at ${scriptPath}`;
    }

    const args: string[] = [];
    switch (action) {
      case "status":
        args.push("status");
        break;
      case "deploy":
        args.push("deploy", targetRef?.trim() || "HEAD");
        break;
      case "finalize":
        args.push("finalize", targetRef?.trim() || "HEAD");
        break;
      case "rollback":
        args.push("rollback");
        if (targetRef?.trim()) args.push(targetRef.trim());
        break;
      case "apply_local": {
        const msg = commitMessage?.trim() || `ha-rollout: apply local changes ${new Date(ctx.nowMs()).toISOString()}`;
        args.push("apply-local", msg, remote, branch);
        break;
      }
    }

    return await new Promise((resolve) => {
      execFile(scriptPath, args, { cwd: ctx.codeDir, timeout: timeoutMs, maxBuffer: 12 * 1024 * 1024 }, (err, stdout, stderr) => {
        const combined = [stdout, stderr].filter(Boolean).join("\n");
        if (err) {
          const hint =
            action === "apply_local"
              ? "\n\nHINT: Check git cleanliness, Docker availability, and rollout lock/state (`ha_deploy` action=`status`)."
              : "\n\nHINT: Use action=`status` to inspect active slot and rollout state.";
          resolve(
            truncateShellOutput(
              `ERROR: ha_deploy ${action} failed: ${err.message}${hint}\n\nOutput:\n${combined}`,
            ),
          );
          return;
        }
        resolve(truncateShellOutput(`OK: ha_deploy ${action} completed\n\n${combined}`));
      });
    });
  },
});
