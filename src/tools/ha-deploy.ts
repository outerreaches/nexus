import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { defineTool } from "../core/tools.js";

function parseStateValue(content: string, key: string): string | undefined {
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0 && line.slice(0, eq) === key) return line.slice(eq + 1);
  }
}

function fileAgeMs(file: string): number | null {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * ha_deploy — writes a deploy-trigger file to the shared volume for the
 * host-side ha-deployer daemon, then polls deploy-state.env for completion.
 *
 * Only the standby is rebuilt during deploy; this container (old active)
 * stays alive until the orchestrator's full request cycle completes. The
 * orchestrator (agent-service) writes deploy-ack when done, which tells
 * ha-deployer it's safe to rebuild the old primary via finalize.
 */
export const haDeploy = defineTool({
  name: "ha_deploy",
  description:
    "Trigger an HA deploy of the current code in /data/code. " +
    "action='apply' writes a deploy trigger, then polls until the host daemon completes " +
    "(build candidate → health check → commit → switch traffic). " +
    "action='status' returns current deploy state. " +
    "Important: after action='apply' succeeds, this run still executes in the pre-deploy process image; " +
    "defer post-deploy runtime/schema validation to a fresh follow-up run.",
  parameters: z.object({
    action: z.enum(["apply", "status"]),
    commitMessage: z
      .string()
      .optional()
      .describe("Commit message for the deploy. If omitted, a timestamped message is used."),
    remote: z.string().default("host").describe("Git push remote"),
    branch: z.string().default("main").describe("Git push branch"),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .default(600_000)
      .describe("Max time to wait for deploy completion (ms)"),
  }),
  execute: async ({ action, commitMessage, remote, branch, timeoutMs }, ctx) => {
    const stateDir = ctx.stateDir;
    const stateFile = path.join(stateDir, "deploy-state.env");
    const triggerFile = path.join(stateDir, "deploy-trigger.json");
    const processingFile = path.join(stateDir, "deploy-trigger.processing.json");
    const lockDir = path.join(stateDir, "ha-rollout.lock");
    const postDeployNote =
      "NOTE: This request cycle can still run in the old process image. " +
      "Do not validate newly deployed runtime behavior/schemas until a fresh follow-up run.";

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
    // Recovery guard: if processing file is stale and no rollout lock exists,
    // clear it so deploys are not blocked forever after interrupted daemon runs.
    if (!existsSync(triggerFile) && existsSync(processingFile) && !existsSync(lockDir)) {
      const ageMs = fileAgeMs(processingFile);
      if (ageMs !== null && ageMs > 120_000) {
        rmSync(processingFile, { force: true });
        ctx.log(`removed stale processing trigger (${Math.round(ageMs / 1000)}s old)`);
      }
    }

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
      request: ctx.request
        ? {
            channel: ctx.request.channel,
            channelKey: ctx.request.channelKey,
            agentId: ctx.request.agentId,
            sessionId: ctx.request.sessionId,
            runId: ctx.request.runId ?? null,
            parentRunId: ctx.request.parentRunId ?? null,
          }
        : undefined,
    };

    mkdirSync(stateDir, { recursive: true });
    writeFileSync(triggerFile, JSON.stringify(trigger, null, 2) + "\n");
    ctx.log(`deploy trigger written: ${trigger.id}`);

    // Read initial state for comparison
    const initialState = existsSync(stateFile) ? readFileSync(stateFile, "utf-8") : "";

    // Poll for completion. This container (old active) is never rebuilt during
    // the deploy cycle — only the standby gets rebuilt with new code.
    const deadline = Date.now() + timeoutMs;
    const pollMs = 5_000;
    let emptyPollsWithNoStateChange = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));

      // If trigger file is gone and state changed, deploy completed (or failed)
      if (!existsSync(triggerFile) && !existsSync(processingFile)) {
        const newState = existsSync(stateFile) ? readFileSync(stateFile, "utf-8") : "";
        if (newState !== initialState) {
          const status = parseStateValue(newState, "LAST_STATUS");
          if (status && status.startsWith("applied_local")) {
            return `OK: deploy completed (status=${status})\n\n${newState.trim()}\n\n${postDeployNote}`;
          }
          if (status && (status.includes("fail") || status.includes("rollback"))) {
            return `ERROR: deploy failed (status=${status})\n\n${newState.trim()}`;
          }
          return `OK: deploy state changed (status=${status})\n\n${newState.trim()}\n\n${postDeployNote}`;
        }
        emptyPollsWithNoStateChange += 1;
        if (emptyPollsWithNoStateChange >= 2) {
          return (
            "ERROR: deploy trigger was cleared but deploy state did not change. " +
            "Deploy likely failed before state write; check ha-deployer logs."
          );
        }
      } else {
        emptyPollsWithNoStateChange = 0;
      }
    }

    return "ERROR: deploy timed out waiting for host daemon. Is ha-deployer.service running?";
  },
});
