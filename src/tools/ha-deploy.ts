import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  buildDeployApprovalMetadata,
  isAffirmativeApprovalResponse,
  isNegativeApprovalResponse,
  metadataMatchesApproval,
  parseMetadataJson,
  syncCandidateForDeployApproval,
  type DeployApprovalMetadata,
} from "../core/deploy-approval.js";
import { defineTool } from "../core/tools.js";
import { inspectDeployWorktree, type DeployChangeInspection } from "../core/deploy-policy.js";
import type { NexusDatabase } from "../storage/database.js";
import { createHumanAction, getHumanAction, listHumanActions } from "../storage/human-actions.js";
import { enqueueRunReport } from "../storage/run-reports.js";
import { loadCandidate, updateCandidate } from "../state/candidates.js";

function parseStateValue(content: string, key: string): string | undefined {
  for (const line of content.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0 && line.slice(0, eq) === key) return line.slice(eq + 1);
  }
}

type DeployStateSnapshot = {
  status?: string;
  updatedAt?: number;
  lastGoodSha?: string;
  effectiveSha?: string;
  failureReason?: string;
};

function parseDeployStateSnapshot(content: string): DeployStateSnapshot {
  const status = parseStateValue(content, "LAST_STATUS");
  const updatedAtRaw = parseStateValue(content, "LAST_UPDATED_AT");
  const updatedAt = updatedAtRaw ? Number.parseInt(updatedAtRaw, 10) : Number.NaN;
  return {
    status,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : undefined,
    lastGoodSha: parseStateValue(content, "LAST_GOOD_SHA"),
    effectiveSha: parseStateValue(content, "LAST_EFFECTIVE_SHA"),
    failureReason: parseStateValue(content, "LAST_FAILURE_REASON"),
  };
}

function formatDeployFailureSuffix(snapshot: DeployStateSnapshot): string {
  const lines: string[] = [];
  if (snapshot.failureReason) lines.push(`reason=${snapshot.failureReason}`);
  if (snapshot.effectiveSha) lines.push(`effective_sha=${snapshot.effectiveSha}`);
  if (snapshot.lastGoodSha) lines.push(`last_good_sha=${snapshot.lastGoodSha}`);
  if (lines.length === 0) return "";
  return `\n\n${lines.join("\n")}`;
}

function fileAgeMs(file: string): number | null {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function remoteExists(codeDir: string, remote: string): boolean {
  if (!remote) return false;
  try {
    execFileSync("git", ["remote", "get-url", remote], {
      cwd: codeDir,
      stdio: "ignore",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

function detectUpstreamTarget(codeDir: string): { remote: string; branch: string } | null {
  try {
    const upstream = execFileSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
      cwd: codeDir,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
    const slash = upstream.indexOf("/");
    if (slash <= 0 || slash >= upstream.length - 1) return null;
    return {
      remote: upstream.slice(0, slash),
      branch: upstream.slice(slash + 1),
    };
  } catch {
    return null;
  }
}

function resolveDeployGitTarget(
  codeDir: string,
  requestedRemote: string,
  requestedBranch: string,
): { remote: string; branch: string; notes: string[] } {
  let remote = requestedRemote.trim();
  const branch = requestedBranch.trim() || "main";
  const notes: string[] = [];

  if (!remoteExists(codeDir, remote)) {
    const upstream = detectUpstreamTarget(codeDir);
    if (upstream && remoteExists(codeDir, upstream.remote)) {
      notes.push(
        `push remote '${remote}' not found; falling back to branch upstream '${upstream.remote}/${upstream.branch}'`,
      );
      remote = upstream.remote;
    }
  }

  return { remote: remote || requestedRemote, branch, notes };
}

async function updateBoundCandidateState(
  ctx: {
    candidateRootDir?: string;
    candidate?: { candidateId: string };
    nowMs: () => number;
    log: (msg: string) => void;
  },
  patch: Parameters<typeof updateCandidate>[2],
): Promise<void> {
  if (!ctx.candidateRootDir || !ctx.candidate) return;
  try {
    await updateCandidate(ctx.candidateRootDir, ctx.candidate.candidateId, {
      ...patch,
      nowMs: patch.nowMs ?? ctx.nowMs(),
    });
  } catch (err) {
    ctx.log(
      `candidate metadata update failed for ${ctx.candidate.candidateId}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const DEPLOY_APPROVAL_TTL_MS = 24 * 60 * 60_000;

function summarizeItems(items: string[], maxItems: number = 6): string {
  if (items.length === 0) return "(none)";
  const rendered = items.slice(0, maxItems);
  if (items.length > maxItems) {
    rendered.push(`(+${items.length - maxItems} more)`);
  }
  return rendered.join(", ");
}

function truncateDetail(text: string, maxChars: number = 2_000): string {
  const compact = text.trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars)}\n...(+${compact.length - maxChars} chars)`;
}

function formatCommandFailure(command: string, err: unknown): string {
  const stdout =
    typeof err === "object" && err !== null && "stdout" in err && typeof (err as { stdout?: unknown }).stdout === "string"
      ? (err as { stdout: string }).stdout
      : "";
  const stderr =
    typeof err === "object" && err !== null && "stderr" in err && typeof (err as { stderr?: unknown }).stderr === "string"
      ? (err as { stderr: string }).stderr
      : "";
  const detail = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n");
  const base = err instanceof Error ? err.message : String(err);
  return detail ? `${base}\n\n${truncateDetail(detail)}` : base;
}

function runVerificationCommand(codeDir: string, args: string[]): void {
  execFileSync(args[0]!, args.slice(1), {
    cwd: codeDir,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function verifyDeployCandidate(params: {
  changes: DeployChangeInspection;
  ctx: {
    codeDir: string;
    candidateRootDir?: string;
    candidate?: { candidateId: string };
    nowMs: () => number;
    log: (msg: string) => void;
  };
}): Promise<string | null> {
  const candidateStateCtx = {
    candidateRootDir: params.ctx.candidateRootDir,
    candidate: params.ctx.candidate,
    nowMs: params.ctx.nowMs,
    log: params.ctx.log,
  };

  if (params.ctx.candidateRootDir && params.ctx.candidate) {
    try {
      const existing = await loadCandidate(params.ctx.candidateRootDir, params.ctx.candidate.candidateId);
      if (
        existing.verificationStatus === "passed" &&
        existing.verificationFingerprint &&
        existing.verificationFingerprint === params.changes.fingerprint
      ) {
        params.ctx.log(`deploy verification reused for candidate ${existing.candidateId}`);
        return null;
      }
    } catch (err) {
      params.ctx.log(
        `deploy verification cache lookup failed for ${params.ctx.candidate.candidateId}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const commands: Array<{ label: string; args: string[] }> = [
    { label: "typecheck", args: ["npm", "run", "typecheck"] },
    { label: "build", args: ["npm", "run", "build"] },
  ];

  for (const command of commands) {
    params.ctx.log(`deploy verification: running ${command.args.join(" ")}`);
    try {
      runVerificationCommand(params.ctx.codeDir, command.args);
    } catch (err) {
      const detail = formatCommandFailure(command.args.join(" "), err);
      await updateBoundCandidateState(candidateStateCtx, {
        status: "failed",
        verificationStatus: "failed",
        verificationFingerprint: params.changes.fingerprint ?? null,
        verifiedAt: null,
        lastError: `verification failed during ${command.label}: ${detail}`,
      });
      return `ERROR: deploy verification failed during ${command.label}.\n\n${detail}`;
    }
  }

  await updateBoundCandidateState(candidateStateCtx, {
    verificationStatus: "passed",
    verificationFingerprint: params.changes.fingerprint ?? null,
    verifiedAt: params.ctx.nowMs(),
    lastError: null,
  });
  return null;
}


function formatApprovalRequiredMessage(params: {
  approvalId: string;
  changes: DeployChangeInspection;
  created: boolean;
  notes?: string[];
}): string {
  const heading = params.created
    ? `APPROVAL REQUIRED: created deploy approval request ${params.approvalId}.`
    : `APPROVAL REQUIRED: deploy approval request ${params.approvalId} is still pending.`;
  const lines = [
    heading,
    ...(params.notes && params.notes.length > 0 ? ["", ...params.notes] : []),
    "",
    "Approval-gated deployable paths:",
    ...(params.changes.approvalRequired.length > 0
      ? params.changes.approvalRequired.map((entry) => `- ${entry}`)
      : ["- (none)"]),
  ];
  if (params.changes.intakeDeployable.length > 0) {
    lines.push(
      "",
      "Intake-only deployable paths in the same candidate:",
      ...params.changes.intakeDeployable.map((entry) => `- ${entry}`),
    );
  }
  if (params.changes.intakeCompatibilityIssues.length > 0) {
    lines.push(
      "",
      "Compatibility issues forcing approval:",
      ...params.changes.intakeCompatibilityIssues.map((entry) => `- ${entry}`),
    );
  }
  lines.push(
    "",
    `Approve via CLI: nexus actions respond ${params.approvalId} approve`,
    `Approve via Telegram: /act ${params.approvalId} approve`,
    "There is no dashboard approval UI for deploy approvals.",
    `After approval, rerun ha_deploy with action='apply' and approvalId='${params.approvalId}'.`,
  );
  return lines.join("\n");
}

type DeployApprovalNotificationContext = {
  db: NexusDatabase;
  agentId?: string;
  homeAgentId?: string;
  request?: {
    runId?: string;
    parentRunId?: string;
    channel?: string;
    channelKey?: string;
  };
  changes: DeployChangeInspection;
  approvalId: string;
  log: (msg: string) => void;
};

function buildDeployApprovalNotificationBody(params: {
  approvalId: string;
  changes: DeployChangeInspection;
}): string {
  const lines = [
    "Deploy approval required.",
    `ID: ${params.approvalId}`,
    "",
    "Approval-gated paths:",
    ...(params.changes.approvalRequired.length > 0
      ? params.changes.approvalRequired.slice(0, 10).map((entry) => `- ${entry}`)
      : ["- (none)"]),
  ];
  if (params.changes.approvalRequired.length > 10) {
    lines.push(`- (+${params.changes.approvalRequired.length - 10} more)`);
  }
  if (params.changes.intakeCompatibilityIssues.length > 0) {
    lines.push(
      "",
      "Compatibility issues forcing approval:",
      ...params.changes.intakeCompatibilityIssues.slice(0, 8).map((entry) => `- ${entry}`),
    );
  }
  lines.push(
    "",
    `Approve: /act ${params.approvalId} approve`,
    `Reject: /act ${params.approvalId} reject`,
  );
  return lines.join("\n");
}

async function queueDeployApprovalNotification(params: DeployApprovalNotificationContext): Promise<string> {
  const targetAgentId = params.homeAgentId ?? params.agentId;
  if (!targetAgentId) return "Operator notification: missing agent context for home-channel delivery.";

  try {
    enqueueRunReport(params.db, {
      kind: "deploy_approval",
      title: `Deploy approval required: ${params.approvalId}`,
      body: buildDeployApprovalNotificationBody({
        approvalId: params.approvalId,
        changes: params.changes,
      }),
      sourceRunId: params.request?.runId ?? null,
      parentRunId: params.request?.parentRunId ?? null,
      sourceAgentId: params.agentId,
      sourceChannel: params.request?.channel ?? null,
      sourceChannelKey: params.request?.channelKey ?? null,
      targetAgentId,
      targetChannel: "home_channel",
      metadata: {
        approvalId: params.approvalId,
        deliveryKind: "deploy_approval",
      },
    });
    params.log(`deploy approval notification queued id=${params.approvalId} target=home_channel`);
    return "Operator notification: queued for home-channel delivery.";
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    params.log(`deploy approval notification queue failed id=${params.approvalId}: ${detail}`);
    return `Operator notification: failed to queue home-channel notification (${detail}).`;
  }
}

function findReusablePendingApproval(
  db: NexusDatabase,
  sessionId: string | undefined,
  nowMs: number,
  expected: DeployApprovalMetadata,
): { id: string } | null {
  if (!sessionId) return null;
  const pending = listHumanActions(db, {
    nowMs,
    status: "pending",
    sessionId,
    limit: 50,
  });
  for (const row of pending) {
    if (row.kind !== "confirm") continue;
    if (metadataMatchesApproval(parseMetadataJson(row.metadataJson), expected)) {
      return { id: row.id };
    }
  }
  return null;
}

async function ensureDeployApproval(params: {
  approvalId?: string;
  changes: DeployChangeInspection;
  ctx: {
    db?: unknown;
    request?: {
      sessionId: string;
      channel: string;
      channelKey: string;
      agentId: string;
      homeAgentId?: string;
      runId?: string;
      parentRunId?: string;
    };
    codeDir: string;
    liveCodeDir?: string;
    candidateRootDir?: string;
    candidate?: { candidateId: string; baseSha: string };
    nowMs: () => number;
    log: (msg: string) => void;
  };
}): Promise<string | null> {
  const db = params.ctx.db as NexusDatabase | undefined;
  const expected = buildDeployApprovalMetadata({
    policy: params.changes.policy,
    changeFingerprint: params.changes.fingerprint,
    candidate: params.ctx.candidate,
  });
  const nowMs = params.ctx.nowMs();
  const requestedApprovalId = params.approvalId?.trim();
  const notes: string[] = [];

  if (requestedApprovalId) {
    if (!db) {
      await updateBoundCandidateState(params.ctx, {
        status: "failed",
        classification: "approval_required",
        lastError: "deploy approval could not be validated because the database is unavailable",
      });
      return "ERROR: deploy approval cannot be validated because the database is unavailable.";
    }
    const row = getHumanAction(db, { id: requestedApprovalId, nowMs });
    if (!row) {
      notes.push(
        `Provided approvalId '${requestedApprovalId}' was not found; creating or reusing the correct approval request instead.`,
      );
      params.ctx.log(`deploy approval '${requestedApprovalId}' not found; falling back to fresh approval request`);
    } else {
      if (row.kind !== "confirm") {
        await updateBoundCandidateState(params.ctx, {
          status: "failed",
          classification: "approval_required",
          approvalId: row.id,
          lastError: `human action '${requestedApprovalId}' is not a deploy approval confirmation`,
        });
        return `ERROR: human action '${requestedApprovalId}' is not a deploy approval confirmation.`;
      }
      if (!metadataMatchesApproval(parseMetadataJson(row.metadataJson), expected)) {
        await updateBoundCandidateState(params.ctx, {
          status: "failed",
          classification: "approval_required",
          approvalId: row.id,
          lastError: `deploy approval '${requestedApprovalId}' no longer matches the current code changes`,
        });
        return (
          `ERROR: deploy approval '${requestedApprovalId}' no longer matches the current code changes. ` +
          "Request a fresh approval for this candidate snapshot."
        );
      }
      await syncCandidateForDeployApproval({
        candidateRootDir: params.ctx.candidateRootDir,
        approvalId: row.id,
        metadataJson: row.metadataJson,
        status: row.status,
        responseText: row.responseText,
        nowMs,
        log: params.ctx.log,
      });
      if (row.status === "pending") {
        return formatApprovalRequiredMessage({
          approvalId: row.id,
          changes: params.changes,
          created: false,
          notes,
        });
      }
      if (row.status !== "fulfilled") {
        return `ERROR: deploy approval '${requestedApprovalId}' is ${row.status}. Request a fresh approval.`;
      }

      const responseText = row.responseText ?? "";
      if (isAffirmativeApprovalResponse(responseText)) {
        return null;
      }
      if (isNegativeApprovalResponse(responseText)) {
        return `ERROR: deploy approval '${requestedApprovalId}' was denied.`;
      }
      return (
        `ERROR: deploy approval '${requestedApprovalId}' has an unrecognized response ` +
        `(${JSON.stringify(responseText)}). Use an explicit approval like 'approve'.`
      );
    }
  }

  if (!db) {
    await updateBoundCandidateState(params.ctx, {
      status: "failed",
      classification: "approval_required",
      lastError: "deploy changes require human approval, but the database is unavailable",
    });
    return (
      "ERROR: deploy changes require human approval, but the database is unavailable to create a request."
    );
  }

  const reusable = findReusablePendingApproval(db, params.ctx.request?.sessionId, nowMs, expected);
  if (reusable) {
    await updateBoundCandidateState(params.ctx, {
      status: "pending_approval",
      classification: "approval_required",
      approvalStatus: "pending",
      approvalId: reusable.id,
      lastError: null,
    });
    return formatApprovalRequiredMessage({
      approvalId: reusable.id,
      changes: params.changes,
      created: false,
      notes,
    });
  }

  const prompt = [
    "Approve deployment of approval-gated Nexus code changes.",
    `Approval-gated paths: ${summarizeItems(params.changes.approvalRequired)}`,
    params.changes.intakeDeployable.length > 0
      ? `Intake-only paths in same candidate: ${summarizeItems(params.changes.intakeDeployable)}`
      : undefined,
    params.changes.intakeCompatibilityIssues.length > 0
      ? `Compatibility issues: ${summarizeItems(params.changes.intakeCompatibilityIssues)}`
      : undefined,
    "Reply with 'approve' to allow deploy, or 'reject' to block it.",
  ].filter((line): line is string => typeof line === "string").join("\n");

  const row = createHumanAction(db, {
    nowMs,
    ttlMs: DEPLOY_APPROVAL_TTL_MS,
    sessionId: params.ctx.request?.sessionId,
    channel: params.ctx.request?.channel,
    channelKey: params.ctx.request?.channelKey,
    agentId: params.ctx.request?.agentId,
    kind: "confirm",
    prompt,
    metadata: expected,
  });

  await updateBoundCandidateState(params.ctx, {
    status: "pending_approval",
    classification: "approval_required",
    approvalStatus: "pending",
    approvalId: row.id,
    lastError: null,
  });

  const notificationNote = await queueDeployApprovalNotification({
    db,
    agentId: params.ctx.request?.agentId,
    homeAgentId: params.ctx.request?.homeAgentId,
    request: params.ctx.request,
    changes: params.changes,
    approvalId: row.id,
    log: params.ctx.log,
  });
  notes.push(notificationNote);

  return formatApprovalRequiredMessage({
    approvalId: row.id,
    changes: params.changes,
    created: true,
    notes,
  });
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
    "Trigger an HA deploy of the current run's code directory (live checkout or candidate workspace). " +
    "action='apply' writes a deploy trigger, then polls until the host daemon completes " +
    "(build candidate → health check → commit → switch traffic). " +
    "action='rollback' rolls traffic back to the last known good SHA or a requested target ref. " +
    "action='status' returns current deploy state. " +
    "Only triggers if deployable changes exist (code/config); doc-only changes (.md, images) are rejected — " +
    "commit and push those directly instead of deploying. " +
    "Important: after action='apply' succeeds, this run still executes in the pre-deploy process image; " +
    "defer post-deploy runtime/schema validation to a fresh follow-up run.",
  parameters: z.object({
    action: z.enum(["apply", "status", "rollback"]),
    commitMessage: z
      .string()
      .optional()
      .describe("Commit message for the deploy. If omitted, a timestamped message is used."),
    targetRef: z
      .string()
      .min(1)
      .optional()
      .describe("Optional rollback target ref for action='rollback'. Defaults to the last good SHA."),
    approvalId: z
      .string()
      .min(1)
      .optional()
      .describe("Human approval ID required for approval-gated changes (tools/core/shared paths)."),
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
  execute: async ({ action, commitMessage, targetRef, approvalId, remote, branch, timeoutMs }, ctx) => {
    const stateDir = ctx.stateDir;
    const stateFile = path.join(stateDir, "deploy-state.env");
    const triggerFile = path.join(stateDir, "deploy-trigger.json");
    const processingFile = path.join(stateDir, "deploy-trigger.processing.json");
    const lockDir = path.join(stateDir, "ha-rollout.lock");
    const postDeployNote =
      "NOTE: This request cycle can still run in the old process image. " +
      "Do not validate newly deployed runtime behavior/schemas until a fresh follow-up run.";
    const returnWithCandidateState = async (
      message: string,
      patch?: Parameters<typeof updateBoundCandidateState>[1],
    ): Promise<string> => {
      if (patch) {
        await updateBoundCandidateState(
          {
            candidateRootDir: ctx.candidateRootDir,
            candidate: ctx.candidate,
            nowMs: ctx.nowMs,
            log: ctx.log,
          },
          patch,
        );
      }
      return message;
    };

    const interpretTerminalState = async (stateContent: string, snapshot: DeployStateSnapshot): Promise<string | null> => {
      const status = snapshot.status;
      const failureSuffix = formatDeployFailureSuffix(snapshot);
      if (action === "rollback") {
        if (status === "rolled_back") {
          return `OK: rollback completed (status=${status})\n\n${stateContent.trim()}`;
        }
        if (status && status.includes("fail")) {
          return await returnWithCandidateState(
            `ERROR: rollback failed (status=${status})\n\n${stateContent.trim()}${failureSuffix}`,
            {
              status: "failed",
              lastError: snapshot.failureReason ?? `rollback failed (status=${status})`,
            },
          );
        }
        return null;
      }
      if (status === "applied_local_push_failed") {
        return await returnWithCandidateState(
          "ERROR: deploy applied locally but push to remote failed " +
            "(status=applied_local_push_failed). Resolve git divergence on host and push manually.\n\n" +
            `${stateContent.trim()}${failureSuffix}`,
          {
            status: "deployed",
            lastError: snapshot.failureReason ?? "deploy applied locally but push to remote failed",
          },
        );
      }
      if (status && status.startsWith("applied_local")) {
        return await returnWithCandidateState(
          `OK: deploy completed (status=${status})\n\n${stateContent.trim()}\n\n${postDeployNote}`,
          {
            status: "deployed",
            lastError: null,
          },
        );
      }
      if (status && (status.includes("fail") || status.includes("rollback"))) {
        return await returnWithCandidateState(
          `ERROR: deploy failed (status=${status})\n\n${stateContent.trim()}${failureSuffix}`,
          {
            status: "failed",
            lastError: snapshot.failureReason ?? `deploy failed (status=${status})`,
          },
        );
      }
      return await returnWithCandidateState(
        `OK: deploy state changed (status=${status})\n\n${stateContent.trim()}\n\n${postDeployNote}`,
        {
          status: "deployed",
          lastError: null,
        },
      );
    };

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

    let trigger: Record<string, unknown>;
    if (action === "rollback") {
      trigger = {
        id: randomUUID(),
        action: "rollback",
        targetRef: targetRef?.trim() || null,
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
    } else {
      const changes = inspectDeployWorktree(ctx.codeDir);
      if (changes.all.length === 0) {
        return "SKIP: No uncommitted changes detected in the code directory. Nothing to deploy.";
      }
      if (changes.deployable.length === 0) {
        return (
          `SKIP: All ${changes.all.length} changed file(s) are non-deployable (docs/assets only):\n` +
          changes.skipped.map((f) => `  - ${f}`).join("\n") +
          "\nThese changes do not require a container rebuild. Commit and push them directly instead."
        );
      }
      ctx.log(
        `deploy policy=${changes.policy} deployable=${changes.deployable.length} ` +
          `approval_required=${changes.approvalRequired.length} ` +
          `compatibility_issues=${changes.intakeCompatibilityIssues.length} skipped=${changes.skipped.length}`,
      );
      if (changes.gitStatusError) {
        ctx.log(`deploy policy fallback: ${changes.gitStatusError}`);
        return await returnWithCandidateState(
          `ERROR: failed to inspect deployable changes in ${ctx.codeDir}: ${changes.gitStatusError}`,
          {
            status: "failed",
            lastError: `failed to inspect deployable changes: ${changes.gitStatusError}`,
          },
        );
      }

      const verificationResult = await verifyDeployCandidate({
        changes,
        ctx: {
          codeDir: ctx.codeDir,
          candidateRootDir: ctx.candidateRootDir,
          candidate: ctx.candidate,
          nowMs: ctx.nowMs,
          log: ctx.log,
        },
      });
      if (verificationResult) {
        return verificationResult;
      }

      if (changes.policy === "approval_required") {
        const approvalResult = await ensureDeployApproval({
          approvalId,
          changes,
          ctx: {
            db: ctx.db,
            request: ctx.request
              ? {
                  sessionId: ctx.request.sessionId,
                  channel: ctx.request.channel,
                  channelKey: ctx.request.channelKey,
                  agentId: ctx.request.agentId,
                  homeAgentId: ctx.request.homeAgentId,
                  runId: ctx.request.runId,
                  parentRunId: ctx.request.parentRunId,
                }
              : undefined,
            codeDir: ctx.codeDir,
            liveCodeDir: ctx.liveCodeDir,
            candidateRootDir: ctx.candidateRootDir,
            candidate: ctx.candidate,
            nowMs: ctx.nowMs,
            log: ctx.log,
          },
        });
        if (approvalResult) {
          return approvalResult;
        }
        ctx.log(`deploy approval accepted for ${summarizeItems(changes.approvalRequired)}`);
      }

      const msg =
        commitMessage?.trim() || `ha-rollout: apply local changes ${new Date(ctx.nowMs()).toISOString()}`;

      await updateBoundCandidateState(
        {
          candidateRootDir: ctx.candidateRootDir,
          candidate: ctx.candidate,
          nowMs: ctx.nowMs,
          log: ctx.log,
        },
        {
          status: changes.policy === "intake_auto_deploy" ? "auto_deploying" : "approved",
          classification: changes.policy === "intake_auto_deploy" ? "intake_only" : "approval_required",
          verificationStatus: "passed",
          verificationFingerprint: changes.fingerprint ?? null,
          verifiedAt: ctx.nowMs(),
          lastError: null,
        },
      );

      const target = resolveDeployGitTarget(ctx.codeDir, remote, branch);
      for (const note of target.notes) ctx.log(note);

      trigger = {
        id: randomUUID(),
        action: "apply",
        commitMessage: msg,
        remote: target.remote,
        branch: target.branch,
        sourceCodeDir: ctx.codeDir,
        liveCodeDir: ctx.liveCodeDir ?? ctx.codeDir,
        sourceBaseSha: ctx.candidate?.baseSha ?? null,
        candidateId: ctx.candidate?.candidateId ?? null,
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
    }

    mkdirSync(stateDir, { recursive: true });
    writeFileSync(triggerFile, JSON.stringify(trigger, null, 2) + "\n");
    ctx.log(`${action} trigger written: ${String(trigger.id ?? "unknown")}`);

    // Read initial state for comparison
    const initialState = existsSync(stateFile) ? readFileSync(stateFile, "utf-8") : "";
    const applyRequestedAtSec = Math.floor(ctx.nowMs() / 1000);

    // Poll for completion. This container (old active) is never rebuilt during
    // the deploy cycle — only the standby gets rebuilt with new code.
    const deadline = Date.now() + timeoutMs;
    const pollMs = 5_000;
    let triggerClearedPolls = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));

      // If trigger file is gone and state changed, deploy completed (or failed)
      if (!existsSync(triggerFile) && !existsSync(processingFile)) {
        triggerClearedPolls += 1;
        const newState = existsSync(stateFile) ? readFileSync(stateFile, "utf-8") : "";
        if (newState !== initialState) {
          const snapshot = parseDeployStateSnapshot(newState);
          const terminal = await interpretTerminalState(newState, snapshot);
          if (terminal) return terminal;
        }

        // Defensive path for racey filesystems: if state write landed with
        // equivalent content (or shortly after trigger cleanup), use freshness
        // markers to classify outcome instead of failing immediately.
        const snapshot = parseDeployStateSnapshot(newState);
        const stateLooksFresh =
          typeof snapshot.updatedAt === "number" &&
          snapshot.updatedAt >= applyRequestedAtSec;
        if (stateLooksFresh) {
          const terminal = await interpretTerminalState(newState, snapshot);
          if (terminal) return terminal;
        }
        if (triggerClearedPolls % 6 === 0) {
          ctx.log(
            `${action} trigger cleared but state unchanged; continuing to wait for stable deploy-state write`,
          );
        }
      } else {
        triggerClearedPolls = 0;
      }
    }

    const finalState = existsSync(stateFile) ? readFileSync(stateFile, "utf-8") : "";
    const finalSnapshot = parseDeployStateSnapshot(finalState);
    const finalStatus = finalSnapshot.status ?? "unknown";
    const triggerStatus = existsSync(triggerFile)
      ? "pending"
      : existsSync(processingFile)
        ? "processing"
        : "cleared";
    return await returnWithCandidateState(
      `ERROR: ${action} timed out waiting for host daemon. ` +
      `trigger=${triggerStatus} last_status=${finalStatus}. ` +
      `Is ha-deployer.service running?${formatDeployFailureSuffix(finalSnapshot)}`,
      {
        status: "failed",
        lastError:
          finalSnapshot.failureReason ??
          `${action} timed out waiting for host daemon (trigger=${triggerStatus}, last_status=${finalStatus})`,
      },
    );
  },
});
