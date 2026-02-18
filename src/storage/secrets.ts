import type { NexusDatabase } from "./database.js";

export type SecretProviderKind =
  | "local_file"
  | "sidecar_http"
  | "vault"
  | "openbao"
  | "aws_sm"
  | "gcp_sm"
  | "azure_kv";

export type SecretProviderProfileRecord = {
  id: string;
  kind: SecretProviderKind;
  endpointRef: string | null;
  authMode: string;
  strictMode: boolean;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type UpsertSecretProviderProfileParams = {
  id: string;
  kind: SecretProviderKind;
  endpointRef?: string | null;
  authMode?: string;
  strictMode?: boolean;
  config?: Record<string, unknown>;
  enabled?: boolean;
  nowMs?: number;
};

export type SecretAccessDecision = "allow" | "deny" | "error";

export type SecretAccessEventRecord = {
  id: string;
  providerProfileId: string | null;
  traceId: string | null;
  firewallSession: string | null;
  actor: string | null;
  secretPathHash: string;
  secretClass: string | null;
  decision: SecretAccessDecision;
  reason: string | null;
  leaseId: string | null;
  createdAt: number;
};

export type AppendSecretAccessEventParams = {
  id: string;
  providerProfileId?: string | null;
  traceId?: string | null;
  firewallSession?: string | null;
  actor?: string | null;
  secretPathHash: string;
  secretClass?: string | null;
  decision: SecretAccessDecision;
  reason?: string | null;
  leaseId?: string | null;
  nowMs?: number;
};

export type SecretLeaseStatus = "active" | "expired" | "revoked";

export type SecretLeaseRecord = {
  id: string;
  providerProfileId: string | null;
  leaseRef: string;
  secretClass: string | null;
  status: SecretLeaseStatus;
  issuedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  traceId: string | null;
  metadata: Record<string, unknown>;
};

export type CreateSecretLeaseParams = {
  id: string;
  providerProfileId?: string | null;
  leaseRef: string;
  secretClass?: string | null;
  status?: SecretLeaseStatus;
  issuedAt?: number;
  expiresAt?: number | null;
  revokedAt?: number | null;
  traceId?: string | null;
  metadata?: Record<string, unknown>;
};

type SecretProviderProfileRow = {
  id: string;
  kind: string;
  endpoint_ref: string | null;
  auth_mode: string;
  strict_mode: number;
  config_json: string;
  enabled: number;
  created_at: number;
  updated_at: number;
};

type SecretAccessEventRow = {
  id: string;
  provider_profile_id: string | null;
  trace_id: string | null;
  firewall_session: string | null;
  actor: string | null;
  secret_path_hash: string;
  secret_class: string | null;
  decision: string;
  reason: string | null;
  lease_id: string | null;
  created_at: number;
};

type SecretLeaseRow = {
  id: string;
  provider_profile_id: string | null;
  lease_ref: string;
  secret_class: string | null;
  status: string;
  issued_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  trace_id: string | null;
  metadata_json: string;
};

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function normalizeSecretProviderKind(value: string): SecretProviderKind {
  switch (value) {
    case "sidecar_http":
      return "sidecar_http";
    case "vault":
      return "vault";
    case "openbao":
      return "openbao";
    case "aws_sm":
      return "aws_sm";
    case "gcp_sm":
      return "gcp_sm";
    case "azure_kv":
      return "azure_kv";
    default:
      return "local_file";
  }
}

function normalizeSecretDecision(value: string): SecretAccessDecision {
  switch (value) {
    case "deny":
      return "deny";
    case "error":
      return "error";
    default:
      return "allow";
  }
}

function normalizeSecretLeaseStatus(value: string): SecretLeaseStatus {
  switch (value) {
    case "expired":
      return "expired";
    case "revoked":
      return "revoked";
    default:
      return "active";
  }
}

function mapSecretProviderProfileRow(row: SecretProviderProfileRow): SecretProviderProfileRecord {
  return {
    id: row.id,
    kind: normalizeSecretProviderKind(row.kind),
    endpointRef: row.endpoint_ref ?? null,
    authMode: row.auth_mode,
    strictMode: row.strict_mode === 1,
    config: parseJsonObject(row.config_json),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSecretAccessEventRow(row: SecretAccessEventRow): SecretAccessEventRecord {
  return {
    id: row.id,
    providerProfileId: row.provider_profile_id ?? null,
    traceId: row.trace_id ?? null,
    firewallSession: row.firewall_session ?? null,
    actor: row.actor ?? null,
    secretPathHash: row.secret_path_hash,
    secretClass: row.secret_class ?? null,
    decision: normalizeSecretDecision(row.decision),
    reason: row.reason ?? null,
    leaseId: row.lease_id ?? null,
    createdAt: row.created_at,
  };
}

function mapSecretLeaseRow(row: SecretLeaseRow): SecretLeaseRecord {
  return {
    id: row.id,
    providerProfileId: row.provider_profile_id ?? null,
    leaseRef: row.lease_ref,
    secretClass: row.secret_class ?? null,
    status: normalizeSecretLeaseStatus(row.status),
    issuedAt: row.issued_at,
    expiresAt: row.expires_at ?? null,
    revokedAt: row.revoked_at ?? null,
    traceId: row.trace_id ?? null,
    metadata: parseJsonObject(row.metadata_json),
  };
}

export function upsertSecretProviderProfile(db: NexusDatabase, params: UpsertSecretProviderProfileParams): void {
  const nowMs = params.nowMs ?? Date.now();
  db.db
    .prepare(
      `INSERT INTO secret_provider_profiles (
         id,
         kind,
         endpoint_ref,
         auth_mode,
         strict_mode,
         config_json,
         enabled,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         endpoint_ref = excluded.endpoint_ref,
         auth_mode = excluded.auth_mode,
         strict_mode = excluded.strict_mode,
         config_json = excluded.config_json,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    )
    .run(
      params.id,
      params.kind,
      params.endpointRef ?? null,
      params.authMode ?? "none",
      params.strictMode === false ? 0 : 1,
      JSON.stringify(params.config ?? {}),
      params.enabled === false ? 0 : 1,
      nowMs,
      nowMs,
    );
}

export function getSecretProviderProfileById(db: NexusDatabase, id: string): SecretProviderProfileRecord | null {
  const row = db.db
    .prepare(
      `SELECT
         id,
         kind,
         endpoint_ref,
         auth_mode,
         strict_mode,
         config_json,
         enabled,
         created_at,
         updated_at
       FROM secret_provider_profiles
       WHERE id = ?`,
    )
    .get(id) as SecretProviderProfileRow | undefined;
  return row ? mapSecretProviderProfileRow(row) : null;
}

export function listSecretProviderProfiles(db: NexusDatabase, params: { includeDisabled?: boolean; limit?: number } = {}): SecretProviderProfileRecord[] {
  const includeDisabled = params.includeDisabled === true;
  const limit = params.limit ?? 200;
  const rows = db.db
    .prepare(
      `SELECT
         id,
         kind,
         endpoint_ref,
         auth_mode,
         strict_mode,
         config_json,
         enabled,
         created_at,
         updated_at
       FROM secret_provider_profiles
       ${includeDisabled ? "" : "WHERE enabled = 1"}
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as SecretProviderProfileRow[];
  return rows.map(mapSecretProviderProfileRow);
}

export function appendSecretAccessEvent(db: NexusDatabase, params: AppendSecretAccessEventParams): void {
  const nowMs = params.nowMs ?? Date.now();
  db.db
    .prepare(
      `INSERT INTO secret_access_events (
         id,
         provider_profile_id,
         trace_id,
         firewall_session,
         actor,
         secret_path_hash,
         secret_class,
         decision,
         reason,
         lease_id,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.id,
      params.providerProfileId ?? null,
      params.traceId ?? null,
      params.firewallSession ?? null,
      params.actor ?? null,
      params.secretPathHash,
      params.secretClass ?? null,
      params.decision,
      params.reason ?? null,
      params.leaseId ?? null,
      nowMs,
    );
}

export function listSecretAccessEvents(db: NexusDatabase, params: { limit?: number; traceId?: string } = {}): SecretAccessEventRecord[] {
  const limit = params.limit ?? 200;
  if (params.traceId) {
    const rows = db.db
      .prepare(
        `SELECT
           id,
           provider_profile_id,
           trace_id,
           firewall_session,
           actor,
           secret_path_hash,
           secret_class,
           decision,
           reason,
           lease_id,
           created_at
         FROM secret_access_events
         WHERE trace_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(params.traceId, limit) as SecretAccessEventRow[];
    return rows.map(mapSecretAccessEventRow);
  }
  const rows = db.db
    .prepare(
      `SELECT
         id,
         provider_profile_id,
         trace_id,
         firewall_session,
         actor,
         secret_path_hash,
         secret_class,
         decision,
         reason,
         lease_id,
         created_at
       FROM secret_access_events
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as SecretAccessEventRow[];
  return rows.map(mapSecretAccessEventRow);
}

export function createSecretLease(db: NexusDatabase, params: CreateSecretLeaseParams): void {
  db.db
    .prepare(
      `INSERT INTO secret_leases (
         id,
         provider_profile_id,
         lease_ref,
         secret_class,
         status,
         issued_at,
         expires_at,
         revoked_at,
         trace_id,
         metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.id,
      params.providerProfileId ?? null,
      params.leaseRef,
      params.secretClass ?? null,
      params.status ?? "active",
      params.issuedAt ?? Date.now(),
      params.expiresAt ?? null,
      params.revokedAt ?? null,
      params.traceId ?? null,
      JSON.stringify(params.metadata ?? {}),
    );
}

export function getSecretLeaseById(db: NexusDatabase, id: string): SecretLeaseRecord | null {
  const row = db.db
    .prepare(
      `SELECT
         id,
         provider_profile_id,
         lease_ref,
         secret_class,
         status,
         issued_at,
         expires_at,
         revoked_at,
         trace_id,
         metadata_json
       FROM secret_leases
       WHERE id = ?`,
    )
    .get(id) as SecretLeaseRow | undefined;
  return row ? mapSecretLeaseRow(row) : null;
}

export function getActiveSecretLeaseByRef(db: NexusDatabase, params: { leaseRef: string; nowMs?: number }): SecretLeaseRecord | null {
  const nowMs = params.nowMs ?? Date.now();
  const row = db.db
    .prepare(
      `SELECT
         id,
         provider_profile_id,
         lease_ref,
         secret_class,
         status,
         issued_at,
         expires_at,
         revoked_at,
         trace_id,
         metadata_json
       FROM secret_leases
       WHERE lease_ref = ?
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY issued_at DESC
       LIMIT 1`,
    )
    .get(params.leaseRef, nowMs) as SecretLeaseRow | undefined;
  return row ? mapSecretLeaseRow(row) : null;
}

export function setSecretLeaseStatus(
  db: NexusDatabase,
  params: { id: string; status: SecretLeaseStatus; nowMs?: number },
): boolean {
  const nowMs = params.nowMs ?? Date.now();
  const revokedAt = params.status === "revoked" ? nowMs : null;
  const result = db.db
    .prepare(
      `UPDATE secret_leases
       SET status = ?,
           revoked_at = COALESCE(?, revoked_at)
       WHERE id = ?`,
    )
    .run(params.status, revokedAt, params.id);
  return result.changes > 0;
}
