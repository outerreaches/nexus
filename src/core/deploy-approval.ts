import type { HumanActionStatus } from "../storage/human-actions.js";
import { updateCandidate } from "../state/candidates.js";
import type { DeployPolicy } from "./deploy-policy.js";

export const DEPLOY_APPROVAL_METADATA_KIND = "ha_deploy_approval";

export type DeployApprovalMetadata = {
  kind: typeof DEPLOY_APPROVAL_METADATA_KIND;
  policy: DeployPolicy;
  changeFingerprint: string | null;
  candidateId: string | null;
  sourceBaseSha: string | null;
};

export function parseMetadataJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function buildDeployApprovalMetadata(params: {
  policy: DeployPolicy;
  changeFingerprint: string | null;
  candidate?: { candidateId: string; baseSha: string };
}): DeployApprovalMetadata {
  return {
    kind: DEPLOY_APPROVAL_METADATA_KIND,
    policy: params.policy,
    changeFingerprint: params.changeFingerprint,
    candidateId: params.candidate?.candidateId ?? null,
    sourceBaseSha: params.candidate?.baseSha ?? null,
  };
}

export function metadataMatchesApproval(
  metadata: Record<string, unknown> | null,
  expected: DeployApprovalMetadata,
): boolean {
  if (!metadata) return false;
  return (
    metadata.kind === expected.kind &&
    metadata.policy === expected.policy &&
    metadata.changeFingerprint === expected.changeFingerprint &&
    metadata.candidateId === expected.candidateId &&
    metadata.sourceBaseSha === expected.sourceBaseSha
  );
}

export function isAffirmativeApprovalResponse(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  return (
    normalized === "approve" ||
    normalized === "approved" ||
    normalized === "yes" ||
    normalized === "y" ||
    normalized === "ok" ||
    normalized === "deploy" ||
    normalized === "allow" ||
    normalized.startsWith("approve ")
  );
}

export function isNegativeApprovalResponse(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  return (
    normalized === "reject" ||
    normalized === "rejected" ||
    normalized === "deny" ||
    normalized === "denied" ||
    normalized === "no" ||
    normalized === "n" ||
    normalized.startsWith("reject ")
  );
}

export async function syncCandidateForDeployApproval(params: {
  candidateRootDir?: string;
  approvalId: string;
  metadataJson: string | null;
  status: HumanActionStatus;
  responseText?: string | null;
  nowMs: number;
  log?: (msg: string) => void;
}): Promise<void> {
  if (!params.candidateRootDir) return;
  const metadata = parseMetadataJson(params.metadataJson);
  if (!metadata || metadata.kind !== DEPLOY_APPROVAL_METADATA_KIND) return;
  const candidateId =
    typeof metadata.candidateId === "string" && metadata.candidateId.trim().length > 0
      ? metadata.candidateId.trim()
      : "";
  if (!candidateId) return;

  const basePatch = {
    classification: "approval_required" as const,
    approvalId: params.approvalId,
    nowMs: params.nowMs,
  };

  try {
    if (params.status === "pending") {
      await updateCandidate(params.candidateRootDir, candidateId, {
        ...basePatch,
        status: "pending_approval",
        approvalStatus: "pending",
        lastError: null,
      });
      return;
    }
    if (params.status === "canceled") {
      await updateCandidate(params.candidateRootDir, candidateId, {
        ...basePatch,
        status: "rejected",
        approvalStatus: "rejected",
        lastError: `deploy approval '${params.approvalId}' was canceled`,
      });
      return;
    }
    if (params.status === "expired") {
      await updateCandidate(params.candidateRootDir, candidateId, {
        ...basePatch,
        status: "expired",
        approvalStatus: "rejected",
        lastError: `deploy approval '${params.approvalId}' expired`,
      });
      return;
    }

    const responseText = params.responseText ?? "";
    if (isAffirmativeApprovalResponse(responseText)) {
      await updateCandidate(params.candidateRootDir, candidateId, {
        ...basePatch,
        status: "approved",
        approvalStatus: "approved",
        lastError: null,
      });
      return;
    }
    if (isNegativeApprovalResponse(responseText)) {
      await updateCandidate(params.candidateRootDir, candidateId, {
        ...basePatch,
        status: "rejected",
        approvalStatus: "rejected",
        lastError: `deploy approval '${params.approvalId}' was denied`,
      });
      return;
    }
    await updateCandidate(params.candidateRootDir, candidateId, {
      ...basePatch,
      status: "failed",
      approvalStatus: "rejected",
      lastError: `deploy approval '${params.approvalId}' had an unrecognized response`,
    });
  } catch (err) {
    params.log?.(
      `deploy approval candidate sync failed for ${candidateId}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
