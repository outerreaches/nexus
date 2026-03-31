import type { NexusDatabase } from "./database.js";

export type DeployRequestStatus =
  | "pending_approval"
  | "approved"
  | "queued"
  | "deploying"
  | "deployed"
  | "failed"
  | "rejected"
  | "expired"
  | "stale";

export type DeployRequestRow = {
  approvalId: string;
  status: DeployRequestStatus;
  metadataJson: string | null;
  policy: string | null;
  changeFingerprint: string | null;
  continuationHash: string | null;
  candidateId: string | null;
  sourceBaseSha: string | null;
  triggerId: string | null;
  completionStatus: string | null;
  effectiveSha: string | null;
  lastGoodSha: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  approvedAt: number | null;
  queuedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
};

export type UpdateDeployRequestPatch = {
  status?: DeployRequestStatus;
  metadataJson?: string | null;
  policy?: string | null;
  changeFingerprint?: string | null;
  continuationHash?: string | null;
  candidateId?: string | null;
  sourceBaseSha?: string | null;
  triggerId?: string | null;
  completionStatus?: string | null;
  effectiveSha?: string | null;
  lastGoodSha?: string | null;
  lastError?: string | null;
  approvedAt?: number | null;
  queuedAt?: number | null;
  startedAt?: number | null;
  completedAt?: number | null;
  createdAt?: number;
  nowMs?: number;
};

function mapRow(row: any): DeployRequestRow {
  return {
    approvalId: String(row.approval_id),
    status: String(row.status) as DeployRequestStatus,
    metadataJson: row.metadata_json === null || row.metadata_json === undefined ? null : String(row.metadata_json),
    policy: row.policy === null || row.policy === undefined ? null : String(row.policy),
    changeFingerprint:
      row.change_fingerprint === null || row.change_fingerprint === undefined ? null : String(row.change_fingerprint),
    continuationHash:
      row.continuation_hash === null || row.continuation_hash === undefined ? null : String(row.continuation_hash),
    candidateId: row.candidate_id === null || row.candidate_id === undefined ? null : String(row.candidate_id),
    sourceBaseSha:
      row.source_base_sha === null || row.source_base_sha === undefined ? null : String(row.source_base_sha),
    triggerId: row.trigger_id === null || row.trigger_id === undefined ? null : String(row.trigger_id),
    completionStatus:
      row.completion_status === null || row.completion_status === undefined ? null : String(row.completion_status),
    effectiveSha: row.effective_sha === null || row.effective_sha === undefined ? null : String(row.effective_sha),
    lastGoodSha: row.last_good_sha === null || row.last_good_sha === undefined ? null : String(row.last_good_sha),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    approvedAt: row.approved_at === null || row.approved_at === undefined ? null : Number(row.approved_at),
    queuedAt: row.queued_at === null || row.queued_at === undefined ? null : Number(row.queued_at),
    startedAt: row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : Number(row.completed_at),
  };
}

export function getDeployRequest(
  db: NexusDatabase,
  params: { approvalId: string },
): DeployRequestRow | null {
  const row = db.db.prepare("SELECT * FROM deploy_requests WHERE approval_id = ?").get(params.approvalId);
  return row ? mapRow(row) : null;
}

export function listDeployRequests(
  db: NexusDatabase,
  params: {
    status?: DeployRequestStatus;
    statuses?: DeployRequestStatus[];
    limit?: number;
  } = {},
): DeployRequestRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (params.status) {
    where.push("status = ?");
    args.push(params.status);
  } else if (params.statuses && params.statuses.length > 0) {
    const uniqueStatuses = Array.from(new Set(params.statuses));
    where.push(`status IN (${uniqueStatuses.map(() => "?").join(", ")})`);
    args.push(...uniqueStatuses);
  }
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(1, Math.min(500, Math.floor(params.limit)))
      : 100;
  const sql =
    `SELECT * FROM deploy_requests ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ` +
    "ORDER BY updated_at ASC, created_at ASC LIMIT ?";
  const rows = db.db.prepare(sql).all(...args, limit);
  return (rows as any[]).map(mapRow);
}

export function upsertDeployRequest(
  db: NexusDatabase,
  params: { approvalId: string } & UpdateDeployRequestPatch,
): DeployRequestRow {
  const existing = getDeployRequest(db, { approvalId: params.approvalId });
  const nowMs = Math.max(0, Math.floor(params.nowMs ?? Date.now()));
  const next = {
    approval_id: params.approvalId,
    status: params.status ?? existing?.status ?? "pending_approval",
    metadata_json: params.metadataJson !== undefined ? params.metadataJson : (existing?.metadataJson ?? null),
    policy: params.policy !== undefined ? params.policy : (existing?.policy ?? null),
    change_fingerprint:
      params.changeFingerprint !== undefined ? params.changeFingerprint : (existing?.changeFingerprint ?? null),
    continuation_hash:
      params.continuationHash !== undefined ? params.continuationHash : (existing?.continuationHash ?? null),
    candidate_id: params.candidateId !== undefined ? params.candidateId : (existing?.candidateId ?? null),
    source_base_sha: params.sourceBaseSha !== undefined ? params.sourceBaseSha : (existing?.sourceBaseSha ?? null),
    trigger_id: params.triggerId !== undefined ? params.triggerId : (existing?.triggerId ?? null),
    completion_status:
      params.completionStatus !== undefined ? params.completionStatus : (existing?.completionStatus ?? null),
    effective_sha: params.effectiveSha !== undefined ? params.effectiveSha : (existing?.effectiveSha ?? null),
    last_good_sha: params.lastGoodSha !== undefined ? params.lastGoodSha : (existing?.lastGoodSha ?? null),
    last_error: params.lastError !== undefined ? params.lastError : (existing?.lastError ?? null),
    created_at: Math.max(0, Math.floor(params.createdAt ?? existing?.createdAt ?? nowMs)),
    updated_at: nowMs,
    approved_at: params.approvedAt !== undefined ? params.approvedAt : (existing?.approvedAt ?? null),
    queued_at: params.queuedAt !== undefined ? params.queuedAt : (existing?.queuedAt ?? null),
    started_at: params.startedAt !== undefined ? params.startedAt : (existing?.startedAt ?? null),
    completed_at: params.completedAt !== undefined ? params.completedAt : (existing?.completedAt ?? null),
  };
  db.db
    .prepare(
      "INSERT OR REPLACE INTO deploy_requests (" +
        "approval_id, status, metadata_json, policy, change_fingerprint, continuation_hash, " +
        "candidate_id, source_base_sha, trigger_id, completion_status, effective_sha, last_good_sha, " +
        "last_error, created_at, updated_at, approved_at, queued_at, started_at, completed_at" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      next.approval_id,
      next.status,
      next.metadata_json,
      next.policy,
      next.change_fingerprint,
      next.continuation_hash,
      next.candidate_id,
      next.source_base_sha,
      next.trigger_id,
      next.completion_status,
      next.effective_sha,
      next.last_good_sha,
      next.last_error,
      next.created_at,
      next.updated_at,
      next.approved_at,
      next.queued_at,
      next.started_at,
      next.completed_at,
    );
  return getDeployRequest(db, { approvalId: params.approvalId })!;
}
