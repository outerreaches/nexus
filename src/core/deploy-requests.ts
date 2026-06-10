import type { NexusDatabase } from "../storage/database.js";
import {
  getDeployRequest,
  upsertDeployRequest,
  type DeployRequestRow,
  type DeployRequestStatus,
} from "../storage/deploy-requests.js";
import type { HumanActionStatus } from "../storage/human-actions.js";
import { updateCandidate } from "../state/candidates.js";
import {
  hashDeployApprovalContinuation,
  isAffirmativeApprovalResponse,
  isDeployApprovalMetadata,
  isNegativeApprovalResponse,
  parseMetadataJson,
} from "./deploy-approval.js";

type DeployCompletionState = {
  requestStatus: DeployRequestStatus;
  terminal: boolean;
  candidateStatus: "auto_deploying" | "deployed" | "failed";
  candidateLastError: string | null;
};

function isPreservedPostApprovalStatus(status: DeployRequestStatus): boolean {
  return status === "queued" || status === "deploying" || status === "deployed" || status === "failed" || status === "stale";
}

function deriveDeployRequestStatusFromHumanAction(params: {
  status: HumanActionStatus;
  responseText?: string | null;
}): { status: DeployRequestStatus; lastError: string | null; approvedAt?: number | null } {
  if (params.status === "pending") {
    return { status: "pending_approval", lastError: null };
  }
  if (params.status === "canceled") {
    return { status: "rejected", lastError: "deploy approval was canceled" };
  }
  if (params.status === "expired") {
    return { status: "expired", lastError: "deploy approval expired" };
  }
  const responseText = params.responseText ?? "";
  if (isAffirmativeApprovalResponse(responseText)) {
    return { status: "approved", lastError: null };
  }
  if (isNegativeApprovalResponse(responseText)) {
    return { status: "rejected", lastError: "deploy approval was denied" };
  }
  return { status: "failed", lastError: "deploy approval had an unrecognized response" };
}

function deployRequestMatchesHumanActionSync(
  current: DeployRequestRow,
  next: {
    status: DeployRequestStatus;
    metadataJson: string | null;
    policy: string | null;
    changeFingerprint: string | null;
    continuationHash: string | null;
    candidateId: string | null;
    sourceBaseSha: string | null;
    approvedAt: number | null;
    lastError: string | null;
    createdAt: number;
  },
): boolean {
  return current.status === next.status
    && current.metadataJson === next.metadataJson
    && current.policy === next.policy
    && current.changeFingerprint === next.changeFingerprint
    && current.continuationHash === next.continuationHash
    && current.candidateId === next.candidateId
    && current.sourceBaseSha === next.sourceBaseSha
    && current.approvedAt === next.approvedAt
    && current.lastError === next.lastError
    && current.createdAt === next.createdAt;
}

export function syncDeployRequestForHumanAction(params: {
  db: NexusDatabase;
  approvalId: string;
  metadataJson: string | null;
  status: HumanActionStatus;
  responseText?: string | null;
  nowMs: number;
}): DeployRequestRow | null {
  const metadata = parseMetadataJson(params.metadataJson);
  if (!isDeployApprovalMetadata(metadata)) return null;
  const current = getDeployRequest(params.db, { approvalId: params.approvalId });
  const derived = deriveDeployRequestStatusFromHumanAction({
    status: params.status,
    responseText: params.responseText,
  });
  const nextStatus =
    derived.status === "approved" && current && isPreservedPostApprovalStatus(current.status)
      ? current.status
      : derived.status === "pending_approval" && current && current.status !== "pending_approval"
        ? current.status
        : derived.status;
  const next = {
    status: nextStatus,
    metadataJson: params.metadataJson,
    policy: metadata.policy,
    changeFingerprint: metadata.changeFingerprint,
    continuationHash:
      typeof metadata.continuationHash === "string"
        ? metadata.continuationHash
        : hashDeployApprovalContinuation(metadata.continuation),
    candidateId: metadata.candidateId,
    sourceBaseSha: metadata.sourceBaseSha,
    approvedAt:
      derived.status === "approved"
        ? current?.approvedAt ?? params.nowMs
        : current?.approvedAt ?? null,
    lastError:
      nextStatus !== derived.status && current
        ? current.lastError
        : derived.status === "approved" || derived.status === "pending_approval"
          ? null
          : derived.lastError,
    createdAt: current?.createdAt ?? params.nowMs,
  };
  if (current && deployRequestMatchesHumanActionSync(current, next)) return null;
  return upsertDeployRequest(params.db, {
    approvalId: params.approvalId,
    metadataJson: next.metadataJson,
    policy: next.policy,
    changeFingerprint: next.changeFingerprint,
    continuationHash: next.continuationHash,
    candidateId: next.candidateId,
    sourceBaseSha: next.sourceBaseSha,
    status: next.status,
    approvedAt: next.approvedAt,
    lastError: next.lastError,
    createdAt: next.createdAt,
    nowMs: params.nowMs,
  });
}

function mapCompletionState(params: {
  action: string;
  status: string;
  failureReason?: string | null;
}): DeployCompletionState | null {
  if (params.action !== "apply") return null;
  const failureReason = params.failureReason ?? null;
  if (params.status === "started") {
    return {
      requestStatus: "deploying",
      terminal: false,
      candidateStatus: "auto_deploying",
      candidateLastError: null,
    };
  }
  if (
    params.status === "applied_local_push_failed" ||
    params.status === "applied_local" ||
    params.status === "finalized" ||
    params.status === "finalized_without_ack" ||
    params.status === "finalize_failed" ||
    params.status === "finalize_failed_without_ack"
  ) {
    return {
      requestStatus: "deployed",
      terminal: true,
      candidateStatus: "deployed",
      candidateLastError: failureReason,
    };
  }
  if (params.status.includes("fail") || params.status.includes("rollback")) {
    return {
      requestStatus: "failed",
      terminal: true,
      candidateStatus: "failed",
      candidateLastError: failureReason ?? `deploy failed (status=${params.status})`,
    };
  }
  return {
    requestStatus: "failed",
    terminal: true,
    candidateStatus: "failed",
    candidateLastError: failureReason ?? `deploy ended with unrecognised status=${params.status}`,
  };
}

export function syncDeployRequestForCompletion(params: {
  db: NexusDatabase;
  approvalId: string;
  action: string;
  status: string;
  candidateId?: string | null;
  triggerId?: string | null;
  effectiveSha?: string | null;
  lastGoodSha?: string | null;
  failureReason?: string | null;
  nowMs: number;
}): DeployRequestRow | null {
  const mapped = mapCompletionState({
    action: params.action,
    status: params.status,
    failureReason: params.failureReason,
  });
  if (!mapped) return null;
  const current = getDeployRequest(params.db, { approvalId: params.approvalId });
  return upsertDeployRequest(params.db, {
    approvalId: params.approvalId,
    status: mapped.requestStatus,
    candidateId: params.candidateId !== undefined ? params.candidateId : (current?.candidateId ?? null),
    triggerId: params.triggerId !== undefined ? params.triggerId : (current?.triggerId ?? null),
    completionStatus: params.status,
    effectiveSha: params.effectiveSha !== undefined ? params.effectiveSha : (current?.effectiveSha ?? null),
    lastGoodSha: params.lastGoodSha !== undefined ? params.lastGoodSha : (current?.lastGoodSha ?? null),
    lastError: mapped.candidateLastError,
    startedAt: mapped.requestStatus === "deploying" ? current?.startedAt ?? params.nowMs : (current?.startedAt ?? null),
    completedAt: mapped.terminal ? params.nowMs : (current?.completedAt ?? null),
    createdAt: current?.createdAt ?? params.nowMs,
    nowMs: params.nowMs,
  });
}

export async function syncCandidateForDeployCompletion(params: {
  candidateRootDir?: string;
  candidateId?: string | null;
  action: string;
  status: string;
  failureReason?: string | null;
  nowMs: number;
  log?: (msg: string) => void;
}): Promise<void> {
  if (!params.candidateRootDir || !params.candidateId) return;
  const mapped = mapCompletionState({
    action: params.action,
    status: params.status,
    failureReason: params.failureReason,
  });
  if (!mapped) return;
  try {
    await updateCandidate(params.candidateRootDir, params.candidateId, {
      status: mapped.candidateStatus,
      lastError: mapped.candidateLastError,
      nowMs: params.nowMs,
    });
  } catch (err) {
    params.log?.(
      `deploy completion candidate sync failed for ${params.candidateId}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
