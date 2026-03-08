import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  triggerId?: string;
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
    triggerId: parseStateValue(content, "LAST_TRIGGER_ID"),
  };
}

function formatDeployFailureSuffix(snapshot: DeployStateSnapshot): string {
  const lines: string[] = [];
  if (snapshot.failureReason) lines.push(`reason=${snapshot.failureReason}`);
  if (snapshot.effectiveSha) lines.push(`effective_sha=${snapshot.effectiveSha}`);
  if (snapshot.lastGoodSha) lines.push(`last_good_sha=${snapshot.lastGoodSha}`);
  if (snapshot.triggerId) lines.push(`trigger_id=${snapshot.triggerId}`);
  if (lines.length === 0) return "";
  return `\n\n${lines.join("\n")}`;
}

type DeployCompletionSnapshot = {
  status?: string;
  effectiveSha?: string | null;
  lastGoodSha?: string | null;
  failureReason?: string | null;
  triggerId?: string | null;
};

function readMatchingDeployCompletion(stateDir: string, triggerId: string): DeployCompletionSnapshot | null {
  const completionsDir = path.join(stateDir, "deploy-completions");
  if (!existsSync(completionsDir)) return null;
  const candidates = readdirSync(completionsDir)
    .filter((name) => name.endsWith(".json") || name.endsWith(".processing") || name.endsWith(".notified"))
    .sort();
  for (const name of candidates) {
    const fullPath = path.join(completionsDir, name);
    try {
      const parsed = JSON.parse(readFileSync(fullPath, "utf8")) as Record<string, unknown>;
      if ((parsed.triggerId ?? null) !== triggerId) continue;
      const status = typeof parsed.status === "string" ? parsed.status : undefined;
      if (!status || status === "started") continue;
      return {
        status,
        effectiveSha: typeof parsed.effectiveSha === "string" ? parsed.effectiveSha : null,
        lastGoodSha: typeof parsed.lastGoodSha === "string" ? parsed.lastGoodSha : null,
        failureReason: typeof parsed.failureReason === "string" ? parsed.failureReason : null,
        triggerId,
      };
    } catch {
      continue;
    }
  }
  return null;
}

function completionSnapshotToState(snapshot: DeployCompletionSnapshot): DeployStateSnapshot {
  return {
    status: snapshot.status,
    effectiveSha: snapshot.effectiveSha ?? undefined,
    lastGoodSha: snapshot.lastGoodSha ?? undefined,
    failureReason: snapshot.failureReason ?? undefined,
    triggerId: snapshot.triggerId ?? undefined,
  };
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
      stdio: ["ignore", "pipe", "pipe"],
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

function buildDeployChangeSummaryLines(
  changes: DeployChangeInspection,
  options?: {
    deployableHeading?: string;
    deployableLimit?: number;
    includeSkipped?: boolean;
    skippedLimit?: number;
  },
): string[] {
  const deployableHeading = options?.deployableHeading ?? "Changed deployable paths:";
  const deployableLimit = options?.deployableLimit ?? 10;
  const skippedLimit = options?.skippedLimit ?? 6;
  const lines = [
    "Change summary:",
    `- Total changed paths: ${changes.all.length}`,
    `- Deployable paths: ${changes.deployable.length}`,
    `- Approval-gated paths: ${changes.approvalRequired.length}`,
    `- Intake-only deployable paths: ${changes.intakeDeployable.length}`,
  ];
  if (changes.skipped.length > 0 || options?.includeSkipped) {
    lines.push(`- Non-deployable/skipped paths: ${changes.skipped.length}`);
  }
  if (changes.deployable.length > 0) {
    lines.push(
      "",
      deployableHeading,
      ...changes.deployable.slice(0, deployableLimit).map((entry) => `- ${entry}`),
    );
    if (changes.deployable.length > deployableLimit) {
      lines.push(`- (+${changes.deployable.length - deployableLimit} more)`);
    }
  }
  if (changes.skipped.length > 0 && options?.includeSkipped) {
    lines.push(
      "",
      "Skipped non-deployable paths:",
      ...changes.skipped.slice(0, skippedLimit).map((entry) => `- ${entry}`),
    );
    if (changes.skipped.length > skippedLimit) {
      lines.push(`- (+${changes.skipped.length - skippedLimit} more)`);
    }
  }
  return lines;
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

const DEPENDENCY_MANIFEST_PATHS = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

function dependencyManifestsChanged(changes: DeployChangeInspection): boolean {
  return changes.all.some((relativePath) => DEPENDENCY_MANIFEST_PATHS.has(relativePath));
}

function detectDependencyBootstrapCommand(
  codeDir: string,
  changes: DeployChangeInspection,
): { label: string; args: string[] } | null {
  if (!existsSync(path.join(codeDir, "package.json"))) return null;
  const hasNodeModules = existsSync(path.join(codeDir, "node_modules"));
  const manifestsChanged = dependencyManifestsChanged(changes);
  if (hasNodeModules && !manifestsChanged) return null;
  if (existsSync(path.join(codeDir, "pnpm-lock.yaml"))) {
    return { label: "dependency bootstrap", args: ["pnpm", "install", "--frozen-lockfile"] };
  }
  if (existsSync(path.join(codeDir, "yarn.lock"))) {
    return { label: "dependency bootstrap", args: ["yarn", "install", "--frozen-lockfile"] };
  }
  if (existsSync(path.join(codeDir, "package-lock.json")) || existsSync(path.join(codeDir, "npm-shrinkwrap.json"))) {
    return { label: "dependency bootstrap", args: ["npm", "ci"] };
  }
  return { label: "dependency bootstrap", args: ["npm", "install", "--package-lock=false"] };
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

  const dependencyBootstrap = detectDependencyBootstrapCommand(params.ctx.codeDir, params.changes);
  if (dependencyBootstrap) {
    params.ctx.log(`deploy verification: running ${dependencyBootstrap.args.join(" ")}`);
    try {
      runVerificationCommand(params.ctx.codeDir, dependencyBootstrap.args);
    } catch (err) {
      const detail = formatCommandFailure(dependencyBootstrap.args.join(" "), err);
      await updateBoundCandidateState(candidateStateCtx, {
        status: "failed",
        verificationStatus: "failed",
        verificationFingerprint: params.changes.fingerprint ?? null,
        verifiedAt: null,
        lastError: `verification failed during dependency bootstrap: ${detail}`,
      });
      return `ERROR: deploy verification failed during dependency bootstrap.\n\n${detail}`;
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
    ...buildDeployChangeSummaryLines(params.changes, {
      deployableHeading: "All deployable changed paths:",
      deployableLimit: 12,
      includeSkipped: true,
      skippedLimit: 8,
    }),
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
    `After approval, Nexus will automatically continue the deploy. If auto-continuation fails, rerun ha_deploy with action='apply' and approvalId='${params.approvalId}'.`,
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

type ParsedDeployApprovalContinuation = {
  commitMessage: string | null;
  remote: string | null;
  branch: string | null;
  liveCodeDir: string | null;
  request: {
    channel: string | null;
    channelKey: string | null;
    agentId: string | null;
    homeAgentId: string | null;
    sessionId: string | null;
    runId: string | null;
    parentRunId: string | null;
  } | null;
};

function parseDeployApprovalContinuation(metadata: Record<string, unknown> | null): ParsedDeployApprovalContinuation | null {
  const raw = metadata?.continuation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const continuation = raw as Record<string, unknown>;
  const requestRaw =
    continuation.request && typeof continuation.request === "object" && !Array.isArray(continuation.request)
      ? continuation.request as Record<string, unknown>
      : null;
  return {
    commitMessage: typeof continuation.commitMessage === "string" ? continuation.commitMessage : null,
    remote: typeof continuation.remote === "string" ? continuation.remote : null,
    branch: typeof continuation.branch === "string" ? continuation.branch : null,
    liveCodeDir: typeof continuation.liveCodeDir === "string" ? continuation.liveCodeDir : null,
    request: requestRaw
      ? {
          channel: typeof requestRaw.channel === "string" ? requestRaw.channel : null,
          channelKey: typeof requestRaw.channelKey === "string" ? requestRaw.channelKey : null,
          agentId: typeof requestRaw.agentId === "string" ? requestRaw.agentId : null,
          homeAgentId: typeof requestRaw.homeAgentId === "string" ? requestRaw.homeAgentId : null,
          sessionId: typeof requestRaw.sessionId === "string" ? requestRaw.sessionId : null,
          runId: typeof requestRaw.runId === "string" ? requestRaw.runId : null,
          parentRunId: typeof requestRaw.parentRunId === "string" ? requestRaw.parentRunId : null,
        }
      : null,
  };
}

function buildDeployApprovalNotificationBody(params: {
  approvalId: string;
  changes: DeployChangeInspection;
}): string {
  const lines = [
    "Deploy approval required.",
    `ID: ${params.approvalId}`,
    "",
    ...buildDeployChangeSummaryLines(params.changes, {
      deployableHeading: "All deployable changed paths:",
      deployableLimit: 8,
      includeSkipped: false,
    }),
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

function clearStaleProcessingTrigger(stateDir: string, log: (msg: string) => void): void {
  const triggerFile = path.join(stateDir, "deploy-trigger.json");
  const processingFile = path.join(stateDir, "deploy-trigger.processing.json");
  const lockDir = path.join(stateDir, "ha-rollout.lock");
  if (!existsSync(triggerFile) && existsSync(processingFile) && !existsSync(lockDir)) {
    const ageMs = fileAgeMs(processingFile);
    if (ageMs !== null && ageMs > 120_000) {
      rmSync(processingFile, { force: true });
      log(`removed stale processing trigger (${Math.round(ageMs / 1000)}s old)`);
    }
  }
}

function canQueueDeployTrigger(stateDir: string): string | null {
  const triggerFile = path.join(stateDir, "deploy-trigger.json");
  const processingFile = path.join(stateDir, "deploy-trigger.processing.json");
  if (existsSync(triggerFile) || existsSync(processingFile)) {
    return "ERROR: A deploy is already pending or in progress. Use action='status' to check.";
  }
  return null;
}

function writeApplyDeployTrigger(params: {
  stateDir: string;
  codeDir: string;
  liveCodeDir: string;
  candidate?: { candidateId: string; baseSha: string } | null;
  approvalId?: string | null;
  commitMessage: string;
  remote: string;
  branch: string;
  request?: {
    channel?: string | null;
    channelKey?: string | null;
    agentId?: string | null;
    homeAgentId?: string | null;
    sessionId?: string | null;
    runId?: string | null;
    parentRunId?: string | null;
  } | null;
  nowMs: number;
  log: (msg: string) => void;
}): string {
  const triggerFile = path.join(params.stateDir, "deploy-trigger.json");
  const trigger = {
    id: randomUUID(),
    action: "apply",
    commitMessage: params.commitMessage,
    remote: params.remote,
    branch: params.branch,
    sourceCodeDir: params.codeDir,
    liveCodeDir: params.liveCodeDir,
    sourceBaseSha: params.candidate?.baseSha ?? null,
    candidateId: params.candidate?.candidateId ?? null,
    approvalId: params.approvalId ?? null,
    requestedAt: new Date(params.nowMs).toISOString(),
    request: params.request
      ? {
          channel: params.request.channel ?? null,
          channelKey: params.request.channelKey ?? null,
          agentId: params.request.agentId ?? null,
          homeAgentId: params.request.homeAgentId ?? null,
          sessionId: params.request.sessionId ?? null,
          runId: params.request.runId ?? null,
          parentRunId: params.request.parentRunId ?? null,
        }
      : undefined,
  };

  mkdirSync(params.stateDir, { recursive: true });
  writeFileSync(triggerFile, JSON.stringify(trigger, null, 2) + "\n");
  params.log(`apply trigger written: ${String(trigger.id)}`);
  return String(trigger.id);
}

export async function continueApprovedDeployAfterApproval(params: {
  approvalId: string;
  metadataJson: string | null;
  stateDir: string;
  candidateRootDir?: string;
  nowMs: number;
  log: (msg: string) => void;
}): Promise<{ ok: boolean; message: string }> {
  const metadata = parseMetadataJson(params.metadataJson);
  const continuation = parseDeployApprovalContinuation(metadata);
  if (!metadataMatchesApproval(metadata, buildDeployApprovalMetadata({
    policy: typeof metadata?.policy === "string" ? metadata.policy as DeployChangeInspection["policy"] : "approval_required",
    changeFingerprint: typeof metadata?.changeFingerprint === "string" ? metadata.changeFingerprint : null,
    candidate:
      typeof metadata?.candidateId === "string" && metadata.candidateId &&
      typeof metadata?.sourceBaseSha === "string" && metadata.sourceBaseSha
        ? { candidateId: metadata.candidateId, baseSha: metadata.sourceBaseSha }
        : undefined,
    continuation: continuation ?? undefined,
  }))) {
    return {
      ok: false,
      message: `Deploy approval '${params.approvalId}' metadata is invalid. Rerun ha_deploy manually if needed.`,
    };
  }

  clearStaleProcessingTrigger(params.stateDir, params.log);
  const busyMessage = canQueueDeployTrigger(params.stateDir);
  if (busyMessage) {
    return {
      ok: false,
      message:
        `Deploy approval '${params.approvalId}' has been fulfilled, but automatic deploy continuation could not start.\n` +
        `${busyMessage}\n` +
        `Rerun ha_deploy with action='apply' and approvalId='${params.approvalId}' after the current deploy finishes.`,
    };
  }

  let candidate: { candidateId: string; baseSha: string; repoDir: string } | null = null;
  let codeDir = continuation?.liveCodeDir ?? "";
  let liveCodeDir = continuation?.liveCodeDir ?? "";

  const candidateId =
    typeof metadata?.candidateId === "string" && metadata.candidateId.trim().length > 0
      ? metadata.candidateId.trim()
      : "";
  if (candidateId) {
    if (!params.candidateRootDir) {
      return {
        ok: false,
        message:
          `Deploy approval '${params.approvalId}' has been fulfilled, but candidate storage is unavailable. ` +
          `Rerun ha_deploy with action='apply' and approvalId='${params.approvalId}'.`,
      };
    }
    const record = await loadCandidate(params.candidateRootDir, candidateId);
    candidate = {
      candidateId: record.candidateId,
      baseSha: record.baseSha,
      repoDir: record.repoDir,
    };
    codeDir = record.repoDir;
    liveCodeDir = record.liveCodeDir;
  }

  if (!codeDir) {
    return {
      ok: false,
      message:
        `Deploy approval '${params.approvalId}' has been fulfilled, but the source code directory is unknown. ` +
        `Rerun ha_deploy with action='apply' and approvalId='${params.approvalId}'.`,
    };
  }

  const changes = inspectDeployWorktree(codeDir);
  if (changes.gitStatusError) {
    return {
      ok: false,
      message:
        `Deploy approval '${params.approvalId}' has been fulfilled, but automatic deploy continuation failed ` +
        `while inspecting changes: ${changes.gitStatusError}`,
    };
  }
  if (changes.deployable.length === 0) {
    return {
      ok: false,
      message:
        `Deploy approval '${params.approvalId}' has been fulfilled, but there are no longer deployable changes in the candidate.`,
    };
  }
  if (changes.policy !== "approval_required") {
    return {
      ok: false,
      message:
        `Deploy approval '${params.approvalId}' has been fulfilled, but the candidate no longer matches an approval-gated deploy state.`,
    };
  }

  const expected = buildDeployApprovalMetadata({
    policy: changes.policy,
    changeFingerprint: changes.fingerprint,
    candidate: candidate ? { candidateId: candidate.candidateId, baseSha: candidate.baseSha } : undefined,
    continuation: continuation ?? undefined,
  });
  if (!metadataMatchesApproval(metadata, expected)) {
    return {
      ok: false,
      message:
        `Deploy approval '${params.approvalId}' has been fulfilled, but the candidate changed after approval. ` +
        `Request a fresh approval for the new snapshot.`,
    };
  }

  const verificationResult = await verifyDeployCandidate({
    changes,
    ctx: {
      codeDir,
      candidateRootDir: params.candidateRootDir,
      candidate: candidate ? { candidateId: candidate.candidateId } : undefined,
      nowMs: () => params.nowMs,
      log: params.log,
    },
  });
  if (verificationResult) {
    return {
      ok: false,
      message:
        `Deploy approval '${params.approvalId}' has been fulfilled, but automatic deploy continuation failed verification.\n\n` +
        verificationResult,
    };
  }

  const target = resolveDeployGitTarget(liveCodeDir || codeDir, continuation?.remote ?? "host", continuation?.branch ?? "main");
  for (const note of target.notes) params.log(note);

  await updateBoundCandidateState(
    {
      candidateRootDir: params.candidateRootDir,
      candidate: candidate ? { candidateId: candidate.candidateId } : undefined,
      nowMs: () => params.nowMs,
      log: params.log,
    },
    {
      status: "approved",
      classification: "approval_required",
      approvalStatus: "approved",
      verificationStatus: "passed",
      verificationFingerprint: changes.fingerprint ?? null,
      verifiedAt: params.nowMs,
      lastError: null,
    },
  );

  writeApplyDeployTrigger({
    stateDir: params.stateDir,
    codeDir,
    liveCodeDir: liveCodeDir || codeDir,
    candidate,
    approvalId: params.approvalId,
    commitMessage:
      continuation?.commitMessage?.trim() ||
      `ha-rollout: apply approved changes ${new Date(params.nowMs).toISOString()}`,
    remote: target.remote,
    branch: target.branch,
    request: continuation?.request ?? null,
    nowMs: params.nowMs,
    log: params.log,
  });

  await updateBoundCandidateState(
    {
      candidateRootDir: params.candidateRootDir,
      candidate: candidate ? { candidateId: candidate.candidateId } : undefined,
      nowMs: () => params.nowMs,
      log: params.log,
    },
    {
      status: "auto_deploying",
      classification: "approval_required",
      approvalStatus: "approved",
      verificationStatus: "passed",
      verificationFingerprint: changes.fingerprint ?? null,
      verifiedAt: params.nowMs,
      lastError: null,
    },
  );

  return {
    ok: true,
    message:
      `Deploy approval '${params.approvalId}' has been fulfilled.\n` +
      "Automatic deploy continuation has been queued.\n" +
      "Use ha_deploy action='status' if you need rollout status.",
  };
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
  commitMessage: string;
  remote: string;
  branch: string;
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
    continuation: {
      commitMessage: params.commitMessage,
      remote: params.remote,
      branch: params.branch,
      liveCodeDir: params.ctx.liveCodeDir ?? params.ctx.codeDir,
      request: params.ctx.request
        ? {
            channel: params.ctx.request.channel,
            channelKey: params.ctx.request.channelKey,
            agentId: params.ctx.request.agentId,
            homeAgentId: params.ctx.request.homeAgentId ?? null,
            sessionId: params.ctx.request.sessionId,
            runId: params.ctx.request.runId ?? null,
            parentRunId: params.ctx.request.parentRunId ?? null,
          }
        : null,
    },
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
    metadata: {
      ...expected,
      continuation: {
        commitMessage: params.commitMessage,
        remote: params.remote,
        branch: params.branch,
        liveCodeDir: params.ctx.liveCodeDir ?? params.ctx.codeDir,
        request: params.ctx.request
          ? {
              channel: params.ctx.request.channel,
              channelKey: params.ctx.request.channelKey,
              agentId: params.ctx.request.agentId,
              homeAgentId: params.ctx.request.homeAgentId ?? null,
              sessionId: params.ctx.request.sessionId,
              runId: params.ctx.request.runId ?? null,
              parentRunId: params.ctx.request.parentRunId ?? null,
            }
          : null,
      },
    },
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

      const msg =
        commitMessage?.trim() || `ha-rollout: apply local changes ${new Date(ctx.nowMs()).toISOString()}`;

      if (changes.policy === "approval_required") {
        const approvalResult = await ensureDeployApproval({
          approvalId,
          commitMessage: msg,
          remote,
          branch,
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

      const target = resolveDeployGitTarget(ctx.liveCodeDir ?? ctx.codeDir, remote, branch);
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
        approvalId: approvalId?.trim() || null,
        requestedAt: new Date(ctx.nowMs()).toISOString(),
        request: ctx.request
          ? {
              channel: ctx.request.channel,
              channelKey: ctx.request.channelKey,
              agentId: ctx.request.agentId,
              homeAgentId: ctx.request.homeAgentId ?? null,
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
    const triggerId = typeof trigger.id === "string" ? trigger.id : "";

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

        if (triggerId) {
          const completion = readMatchingDeployCompletion(stateDir, triggerId);
          if (completion) {
            const terminal = await interpretTerminalState(
              [
                `LAST_STATUS=${completion.status ?? ""}`,
                `LAST_EFFECTIVE_SHA=${completion.effectiveSha ?? ""}`,
                `LAST_GOOD_SHA=${completion.lastGoodSha ?? ""}`,
                `LAST_FAILURE_REASON=${completion.failureReason ?? ""}`,
                `LAST_TRIGGER_ID=${triggerId}`,
              ].join("\n"),
              completionSnapshotToState(completion),
            );
            if (terminal) return terminal;
          }

        }

        // Defensive path for racey filesystems: if state write landed with
        // equivalent content (or shortly after trigger cleanup), use freshness
        // markers to classify outcome instead of failing immediately.
        const snapshot = parseDeployStateSnapshot(newState);
        if (triggerId && snapshot.triggerId === triggerId) {
          const terminal = await interpretTerminalState(newState, snapshot);
          if (terminal) return terminal;
        }
        const stateLooksFresh =
          typeof snapshot.updatedAt === "number" &&
          snapshot.updatedAt >= applyRequestedAtSec;
        if (stateLooksFresh) {
          const terminal = await interpretTerminalState(newState, snapshot);
          if (terminal) return terminal;
        }
        if (triggerClearedPolls % 6 === 0) {
          const progressStatus = snapshot.status?.trim() || "unknown";
          const progressTriggerId = snapshot.triggerId?.trim() || "(none)";
          if (newState !== initialState || progressTriggerId === triggerId || stateLooksFresh) {
            ctx.log(
              `${action} trigger cleared; rollout still in progress (status=${progressStatus} trigger_id=${progressTriggerId})`,
            );
          } else {
            ctx.log(
              `${action} trigger cleared but state unchanged; continuing to wait for stable deploy-state write`,
            );
          }
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
