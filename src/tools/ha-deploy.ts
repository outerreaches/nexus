import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { defineTool } from "../core/tools.js";

/**
 * ha_deploy — writes a deploy-trigger file to the shared volume for the
 * host-side ha-deployer daemon. Returns immediately (the deploy will replace
 * this container, so polling is not possible).
 */
export const haDeploy = defineTool({
  name: "ha_deploy",
  description:
    "Trigger an HA deploy of the current code in /data/code. " +
    "action='apply' writes a deploy trigger for the host daemon (build candidate → health check → commit → failover → rebuild standby). " +
    "action='status' returns current deploy state.",
  parameters: z.object({
    action: z.enum(["apply", "status"]),
    commitMessage: z
      .string()
      .optional()
      .describe("Commit message for the deploy. If omitted, a timestamped message is used."),
    remote: z.string().default("host").describe("Git push remote"),
    branch: z.string().default("main").describe("Git push branch"),
  }),
  execute: async ({ action, commitMessage, remote, branch }, ctx) => {
    const stateDir = ctx.stateDir;
    const stateFile = path.join(stateDir, "deploy-state.env");
    const triggerFile = path.join(stateDir, "deploy-trigger.json");
    const processingFile = path.join(stateDir, "deploy-trigger.processing.json");

    if (action === "status") {
      const lines: string[] = [];
      if (existsSync(stateFile)) {
        lines.push(readFileSync(stateFile, "utf-8").trim());
      } else {
        lines.push("(no deploy-state.env found)");
      }
      if (existsSync(triggerFile)) lines.push("\ndeploy-trigger: pending");
      else if (existsSync(processingFile)) lines.push("\ndeploy-trigger: processing");
      else lines.push("\ndeploy-trigger: none");
      return lines.join("\n");
    }

    // action === "apply"
    if (existsSync(triggerFile) || existsSync(processingFile)) {
      return "ERROR: A deploy is already pending or in progress. Use action='status' to check.";
    }

    const msg =
      commitMessage?.trim() || `ha-rollout: apply local changes ${new Date(ctx.nowMs()).toISOString()}`;

    const trigger = {
      id: randomUUID(),
      commitMessage: msg,
      remote,
      branch,
      requestedAt: new Date(ctx.nowMs()).toISOString(),
    };

    mkdirSync(stateDir, { recursive: true });
    writeFileSync(triggerFile, JSON.stringify(trigger, null, 2) + "\n");
    ctx.log(`deploy trigger written: ${trigger.id}`);

    // Return immediately — do NOT poll. The deploy will rebuild this container,
    // so polling would be interrupted by SIGTERM. The host daemon handles the
    // rest (build → health check → commit → switchover → rebuild standby).
    return `OK: deploy trigger written (id=${trigger.id}). The host daemon will build, health-check, commit, and switch traffic. Use action='status' to check progress after restart.`;
  },
});
