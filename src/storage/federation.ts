import type { NexusDatabase } from "./database.js";
import { deriveFederationState, type FederationDerivedState, type FederationPeerStatusSnapshot } from "../federation/status.js";

export type FederationPeerTrustState = "pending" | "trusted" | "revoked" | "quarantined";

export type FederationPeerRecord = {
  id: string;
  label: string;
  endpoint: string;
  signingKey: string;
  trustState: FederationPeerTrustState;
  enabled: boolean;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type UpsertFederationPeerParams = {
  id: string;
  label: string;
  endpoint: string;
  signingKey: string;
  trustState?: FederationPeerTrustState;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
  nowMs?: number;
};

export type UpsertTransportRouteParams = {
  routeId: string;
  peerId: string;
  adapter: string;
  endpoint: string;
  healthy: boolean;
  lastCheckedAt?: number | null;
  lastError?: string | null;
  metadata?: Record<string, unknown>;
  nowMs?: number;
};

export type TransportRouteRecord = {
  routeId: string;
  peerId: string;
  adapter: string;
  endpoint: string;
  healthy: boolean;
  lastCheckedAt: number | null;
  lastError: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type UpsertFederationSessionParams = {
  id: string;
  peerId: string;
  status: "active" | "expired" | "revoked" | "failed";
  establishedAt?: number;
  expiresAt?: number | null;
  lastHeartbeatAt?: number | null;
  revokedAt?: number | null;
  sessionTokenHash?: string | null;
  metadata?: Record<string, unknown>;
};

export type FederationTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type FederationTaskRecord = {
  id: string;
  peerId: string;
  status: FederationTaskStatus;
  method: string;
  idempotencyKey: string | null;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type CreateFederationTaskParams = {
  id: string;
  peerId: string;
  method: string;
  request?: Record<string, unknown>;
  idempotencyKey?: string | null;
  nowMs?: number;
};

export type UpdateFederationTaskParams = {
  id: string;
  status: FederationTaskStatus;
  result?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  nowMs?: number;
};

export type FederationOutboxStatus = "pending" | "sending" | "sent" | "acked" | "failed" | "dead_letter";

export type FederationOutboxRecord = {
  id: string;
  peerId: string | null;
  transportKind: string;
  envelope: Record<string, unknown>;
  status: FederationOutboxStatus;
  attempts: number;
  nextAttemptAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  traceId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type EnqueueFederationOutboxParams = {
  id: string;
  peerId?: string | null;
  transportKind: string;
  envelope: Record<string, unknown>;
  traceId?: string | null;
  nowMs?: number;
};

export type UpdateFederationOutboxStatusParams = {
  id: string;
  status: FederationOutboxStatus;
  attempts?: number;
  nextAttemptAt?: number | null;
  lastAttemptAt?: number | null;
  lastError?: string | null;
  nowMs?: number;
};

export type FederationEventDirection = "inbound" | "outbound";
export type FederationAuditDecision = "allow" | "deny" | "info";

export type FederationEventRecord = {
  id: string;
  peerId: string | null;
  eventType: string;
  direction: FederationEventDirection;
  envelopeId: string | null;
  payload: Record<string, unknown>;
  traceId: string | null;
  createdAt: number;
};

export type AppendFederationEventParams = {
  id: string;
  peerId?: string | null;
  eventType: string;
  direction: FederationEventDirection;
  envelopeId?: string | null;
  payload?: Record<string, unknown>;
  traceId?: string | null;
  nowMs?: number;
};

export type FederationAuditRecord = {
  id: string;
  peerId: string | null;
  eventType: string;
  decision: FederationAuditDecision | null;
  actor: string | null;
  traceId: string | null;
  details: Record<string, unknown>;
  createdAt: number;
};

export type AppendFederationAuditParams = {
  id: string;
  peerId?: string | null;
  eventType: string;
  decision?: FederationAuditDecision | null;
  actor?: string | null;
  traceId?: string | null;
  details?: Record<string, unknown>;
  nowMs?: number;
};

export type FederationExportResourceType = "node_pool" | "data_intake" | "blackboard" | "mcp";

export type FederationExportRecord = {
  id: string;
  resourceType: FederationExportResourceType;
  resourceSelector: Record<string, unknown>;
  projection: Record<string, unknown>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type UpsertFederationExportParams = {
  id: string;
  resourceType: FederationExportResourceType;
  resourceSelector?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  enabled?: boolean;
  nowMs?: number;
};

export type FederationGrantRecord = {
  id: string;
  peerId: string;
  exportId: string;
  permission: string;
  sensitivityCeiling: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type FederationGrantProjectionRecord = {
  grantId: string;
  peerId: string;
  exportId: string;
  resourceType: FederationExportResourceType;
  sensitivityCeiling: string;
  permission: string;
  projection: Record<string, unknown>;
  resourceSelector: Record<string, unknown>;
};

export type UpsertFederationGrantParams = {
  id: string;
  peerId: string;
  exportId: string;
  permission?: string;
  sensitivityCeiling?: string;
  enabled?: boolean;
  nowMs?: number;
};

export type WebhookEndpointOwnerScope = "local" | "federation_peer";
export type WebhookEndpointSigningMode = "hmac" | "ed25519";
export type WebhookEndpointStatus = "active" | "paused" | "revoked";

export type WebhookEndpointRecord = {
  id: string;
  ownerScope: WebhookEndpointOwnerScope;
  peerId: string | null;
  url: string;
  eventFilter: string[];
  signingMode: WebhookEndpointSigningMode;
  secretRef: string | null;
  enabled: boolean;
  status: WebhookEndpointStatus;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type UpsertWebhookEndpointParams = {
  id: string;
  ownerScope?: WebhookEndpointOwnerScope;
  peerId?: string | null;
  url: string;
  eventFilter?: string[];
  signingMode?: WebhookEndpointSigningMode;
  secretRef?: string | null;
  enabled?: boolean;
  status?: WebhookEndpointStatus;
  metadata?: Record<string, unknown>;
  nowMs?: number;
};

export type WebhookSubscriptionRecord = {
  id: string;
  endpointId: string;
  eventType: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type UpsertWebhookSubscriptionParams = {
  id: string;
  endpointId: string;
  eventType: string;
  enabled?: boolean;
  nowMs?: number;
};

export type WebhookDeliveryStatus = "pending" | "sending" | "acked" | "failed" | "dead_letter";

export type WebhookDeliveryRecord = {
  id: string;
  endpointId: string;
  eventId: string | null;
  status: WebhookDeliveryStatus;
  attempts: number;
  responseCode: number | null;
  responseBody: string | null;
  nextAttemptAt: number | null;
  lastAttemptAt: number | null;
  traceId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type EnqueueWebhookDeliveryParams = {
  id: string;
  endpointId: string;
  eventId?: string | null;
  traceId?: string | null;
  nowMs?: number;
};

export type UpdateWebhookDeliveryStatusParams = {
  id: string;
  status: WebhookDeliveryStatus;
  attempts?: number;
  responseCode?: number | null;
  responseBody?: string | null;
  nextAttemptAt?: number | null;
  lastAttemptAt?: number | null;
  nowMs?: number;
};

export type WebhookDlqRecord = {
  id: string;
  deliveryId: string;
  endpointId: string;
  reason: string;
  payload: Record<string, unknown>;
  createdAt: number;
  replayedAt: number | null;
};

export type AppendWebhookDlqParams = {
  id: string;
  deliveryId: string;
  endpointId: string;
  reason: string;
  payload?: Record<string, unknown>;
  nowMs?: number;
};

export type IdentityKeyStatus = "active" | "next" | "revoked" | "expired";

export type IdentityKeyRecord = {
  id: string;
  scope: string;
  kid: string;
  publicKey: string;
  privateKeyRef: string | null;
  status: IdentityKeyStatus;
  notBefore: number | null;
  notAfter: number | null;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
  metadata: Record<string, unknown>;
};

export type UpsertIdentityKeyParams = {
  id?: string;
  scope: string;
  kid: string;
  publicKey: string;
  privateKeyRef?: string | null;
  status?: IdentityKeyStatus;
  notBefore?: number | null;
  notAfter?: number | null;
  revokedAt?: number | null;
  metadata?: Record<string, unknown>;
  nowMs?: number;
};

export type SetIdentityKeyStatusByScopeParams = {
  scope: string;
  status: IdentityKeyStatus;
  revokedAt?: number | null;
  nowMs?: number;
};

export type RotateIdentityKeyForScopeParams = {
  scope: string;
  kid: string;
  publicKey: string;
  privateKeyRef?: string | null;
  metadata?: Record<string, unknown>;
  overlapMs?: number;
  nowMs?: number;
};

export type ConsumeFederationReplayNonceParams = {
  sourceInstance: string;
  nonce: string;
  keyId?: string | null;
  envelopeId?: string | null;
  traceId?: string | null;
  ttlMs: number;
  nowMs?: number;
};

export type FederationReplayNonceConsumeResult = {
  accepted: boolean;
  duplicate: boolean;
  cleanupDeleted: number;
  expiresAt: number;
};

type FederationPeerRow = {
  id: string;
  label: string;
  endpoint: string;
  signing_key: string;
  trust_state: string;
  enabled: number;
  metadata_json: string;
  created_at: number;
  updated_at: number;
};

type RouteHealthRow = { healthy: number };
type SessionHealthRow = { status: string; expires_at: number | null };
type IdentityHealthRow = { id: string };
type FederationTaskRow = {
  id: string;
  peer_id: string;
  status: string;
  method: string;
  idempotency_key: string | null;
  request_json: string;
  result_json: string | null;
  error_json: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};
type FederationOutboxRow = {
  id: string;
  peer_id: string | null;
  transport_kind: string;
  envelope_json: string;
  status: string;
  attempts: number;
  next_attempt_at: number | null;
  last_attempt_at: number | null;
  last_error: string | null;
  trace_id: string | null;
  created_at: number;
  updated_at: number;
};
type FederationEventRow = {
  id: string;
  peer_id: string | null;
  event_type: string;
  direction: string;
  envelope_id: string | null;
  payload_json: string;
  trace_id: string | null;
  created_at: number;
};
type FederationAuditRow = {
  id: string;
  peer_id: string | null;
  event_type: string;
  decision: string | null;
  actor: string | null;
  trace_id: string | null;
  details_json: string;
  created_at: number;
};
type TransportRouteRow = {
  route_id: string;
  peer_id: string;
  adapter: string;
  endpoint: string;
  healthy: number;
  last_checked_at: number | null;
  last_error: string | null;
  metadata_json: string;
  created_at: number;
  updated_at: number;
};
type FederationExportRow = {
  id: string;
  resource_type: string;
  resource_selector_json: string;
  projection_json: string;
  enabled: number;
  created_at: number;
  updated_at: number;
};
type FederationGrantRow = {
  id: string;
  peer_id: string;
  export_id: string;
  permission: string;
  sensitivity_ceiling: string;
  enabled: number;
  created_at: number;
  updated_at: number;
};
type FederationGrantProjectionRow = {
  grant_id: string;
  peer_id: string;
  export_id: string;
  permission: string;
  sensitivity_ceiling: string;
  resource_type: string;
  projection_json: string;
  resource_selector_json: string;
};
type WebhookEndpointRow = {
  id: string;
  owner_scope: string;
  peer_id: string | null;
  url: string;
  event_filter_json: string;
  signing_mode: string;
  secret_ref: string | null;
  enabled: number;
  status: string;
  metadata_json: string;
  created_at: number;
  updated_at: number;
};
type WebhookSubscriptionRow = {
  id: string;
  endpoint_id: string;
  event_type: string;
  enabled: number;
  created_at: number;
  updated_at: number;
};
type WebhookDeliveryRow = {
  id: string;
  endpoint_id: string;
  event_id: string | null;
  status: string;
  attempts: number;
  response_code: number | null;
  response_body: string | null;
  next_attempt_at: number | null;
  last_attempt_at: number | null;
  trace_id: string | null;
  created_at: number;
  updated_at: number;
};
type WebhookDlqRow = {
  id: string;
  delivery_id: string;
  endpoint_id: string;
  reason: string;
  payload_json: string;
  created_at: number;
  replayed_at: number | null;
};
type IdentityKeyRow = {
  id: string;
  scope: string;
  kid: string;
  public_key: string;
  private_key_ref: string | null;
  status: string;
  not_before: number | null;
  not_after: number | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
  metadata_json: string;
};

export type FederationStatusSnapshot = {
  enabled: boolean;
  derivedState: FederationDerivedState;
  identityValid: boolean;
  firewallActive: boolean;
  trustedPeerCount: number;
  healthyTrustedPeerCount: number;
  peerCount: number;
  peers: Array<{
    id: string;
    trustState: FederationPeerTrustState;
    routeHealthy: boolean;
    sessionHealthy: boolean;
  }>;
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

function parseJsonStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((entry) => typeof entry === "string") as string[];
    }
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { filters?: unknown }).filters)) {
      return ((parsed as { filters: unknown[] }).filters).filter((entry) => typeof entry === "string") as string[];
    }
    return [];
  } catch {
    return [];
  }
}

function normalizeTrustState(value: string): FederationPeerTrustState {
  switch (value) {
    case "trusted":
      return "trusted";
    case "revoked":
      return "revoked";
    case "quarantined":
      return "quarantined";
    default:
      return "pending";
  }
}

function mapPeerRow(row: FederationPeerRow): FederationPeerRecord {
  return {
    id: row.id,
    label: row.label,
    endpoint: row.endpoint,
    signingKey: row.signing_key,
    trustState: normalizeTrustState(row.trust_state),
    enabled: row.enabled === 1,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeTaskStatus(value: string): FederationTaskStatus {
  switch (value) {
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
      return value;
    default:
      return "pending";
  }
}

function mapTaskRow(row: FederationTaskRow): FederationTaskRecord {
  return {
    id: row.id,
    peerId: row.peer_id,
    status: normalizeTaskStatus(row.status),
    method: row.method,
    idempotencyKey: row.idempotency_key,
    request: parseJsonObject(row.request_json),
    result: row.result_json ? parseJsonObject(row.result_json) : null,
    error: row.error_json ? parseJsonObject(row.error_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
  };
}

function normalizeOutboxStatus(value: string): FederationOutboxStatus {
  switch (value) {
    case "sending":
    case "sent":
    case "acked":
    case "failed":
    case "dead_letter":
      return value;
    default:
      return "pending";
  }
}

function mapOutboxRow(row: FederationOutboxRow): FederationOutboxRecord {
  return {
    id: row.id,
    peerId: row.peer_id ?? null,
    transportKind: row.transport_kind,
    envelope: parseJsonObject(row.envelope_json),
    status: normalizeOutboxStatus(row.status),
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at ?? null,
    lastAttemptAt: row.last_attempt_at ?? null,
    lastError: row.last_error ?? null,
    traceId: row.trace_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFederationEventRow(row: FederationEventRow): FederationEventRecord {
  return {
    id: row.id,
    peerId: row.peer_id ?? null,
    eventType: row.event_type,
    direction: row.direction === "outbound" ? "outbound" : "inbound",
    envelopeId: row.envelope_id ?? null,
    payload: parseJsonObject(row.payload_json),
    traceId: row.trace_id ?? null,
    createdAt: row.created_at,
  };
}

function normalizeFederationAuditDecision(value: string | null): FederationAuditDecision | null {
  switch (value) {
    case "allow":
    case "deny":
    case "info":
      return value;
    default:
      return null;
  }
}

function mapFederationAuditRow(row: FederationAuditRow): FederationAuditRecord {
  return {
    id: row.id,
    peerId: row.peer_id ?? null,
    eventType: row.event_type,
    decision: normalizeFederationAuditDecision(row.decision),
    actor: row.actor ?? null,
    traceId: row.trace_id ?? null,
    details: parseJsonObject(row.details_json),
    createdAt: row.created_at,
  };
}

function mapTransportRouteRow(row: TransportRouteRow): TransportRouteRecord {
  return {
    routeId: row.route_id,
    peerId: row.peer_id,
    adapter: row.adapter,
    endpoint: row.endpoint,
    healthy: row.healthy === 1,
    lastCheckedAt: row.last_checked_at ?? null,
    lastError: row.last_error ?? null,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeFederationExportResourceType(value: string): FederationExportResourceType {
  switch (value) {
    case "data_intake":
      return "data_intake";
    case "blackboard":
      return "blackboard";
    case "mcp":
      return "mcp";
    default:
      return "node_pool";
  }
}

function mapFederationExportRow(row: FederationExportRow): FederationExportRecord {
  return {
    id: row.id,
    resourceType: normalizeFederationExportResourceType(row.resource_type),
    resourceSelector: parseJsonObject(row.resource_selector_json),
    projection: parseJsonObject(row.projection_json),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFederationGrantRow(row: FederationGrantRow): FederationGrantRecord {
  return {
    id: row.id,
    peerId: row.peer_id,
    exportId: row.export_id,
    permission: row.permission,
    sensitivityCeiling: row.sensitivity_ceiling,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFederationGrantProjectionRow(row: FederationGrantProjectionRow): FederationGrantProjectionRecord {
  return {
    grantId: row.grant_id,
    peerId: row.peer_id,
    exportId: row.export_id,
    permission: row.permission,
    sensitivityCeiling: row.sensitivity_ceiling,
    resourceType: normalizeFederationExportResourceType(row.resource_type),
    projection: parseJsonObject(row.projection_json),
    resourceSelector: parseJsonObject(row.resource_selector_json),
  };
}

function normalizeWebhookOwnerScope(value: string): WebhookEndpointOwnerScope {
  return value === "federation_peer" ? "federation_peer" : "local";
}

function normalizeWebhookSigningMode(value: string): WebhookEndpointSigningMode {
  return value === "ed25519" ? "ed25519" : "hmac";
}

function normalizeWebhookStatus(value: string): WebhookEndpointStatus {
  switch (value) {
    case "paused":
      return "paused";
    case "revoked":
      return "revoked";
    default:
      return "active";
  }
}

function mapWebhookEndpointRow(row: WebhookEndpointRow): WebhookEndpointRecord {
  const eventFilter = parseJsonStringArray(row.event_filter_json);
  return {
    id: row.id,
    ownerScope: normalizeWebhookOwnerScope(row.owner_scope),
    peerId: row.peer_id ?? null,
    url: row.url,
    eventFilter,
    signingMode: normalizeWebhookSigningMode(row.signing_mode),
    secretRef: row.secret_ref ?? null,
    enabled: row.enabled === 1,
    status: normalizeWebhookStatus(row.status),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWebhookSubscriptionRow(row: WebhookSubscriptionRow): WebhookSubscriptionRecord {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    eventType: row.event_type,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeWebhookDeliveryStatus(value: string): WebhookDeliveryStatus {
  switch (value) {
    case "sending":
      return "sending";
    case "acked":
      return "acked";
    case "failed":
      return "failed";
    case "dead_letter":
      return "dead_letter";
    default:
      return "pending";
  }
}

function mapWebhookDeliveryRow(row: WebhookDeliveryRow): WebhookDeliveryRecord {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    eventId: row.event_id ?? null,
    status: normalizeWebhookDeliveryStatus(row.status),
    attempts: row.attempts,
    responseCode: row.response_code ?? null,
    responseBody: row.response_body ?? null,
    nextAttemptAt: row.next_attempt_at ?? null,
    lastAttemptAt: row.last_attempt_at ?? null,
    traceId: row.trace_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWebhookDlqRow(row: WebhookDlqRow): WebhookDlqRecord {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    endpointId: row.endpoint_id,
    reason: row.reason,
    payload: parseJsonObject(row.payload_json),
    createdAt: row.created_at,
    replayedAt: row.replayed_at ?? null,
  };
}

function normalizeIdentityKeyStatus(value: string): IdentityKeyStatus {
  switch (value) {
    case "next":
      return "next";
    case "revoked":
      return "revoked";
    case "expired":
      return "expired";
    default:
      return "active";
  }
}

function mapIdentityKeyRow(row: IdentityKeyRow): IdentityKeyRecord {
  return {
    id: row.id,
    scope: row.scope,
    kid: row.kid,
    publicKey: row.public_key,
    privateKeyRef: row.private_key_ref ?? null,
    status: normalizeIdentityKeyStatus(row.status),
    notBefore: row.not_before ?? null,
    notAfter: row.not_after ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at ?? null,
    metadata: parseJsonObject(row.metadata_json),
  };
}

export function federationPeerIdentityScope(peerId: string): string {
  return `federation_peer:${peerId}`;
}

export function listFederationPeers(db: NexusDatabase, limit: number = 200): FederationPeerRecord[] {
  const rows = db.db
    .prepare(
      `SELECT
         id,
         label,
         endpoint,
         signing_key,
         trust_state,
         enabled,
         metadata_json,
         created_at,
         updated_at
       FROM federation_peers
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as FederationPeerRow[];
  return rows.map(mapPeerRow);
}

export function getFederationPeerById(db: NexusDatabase, id: string): FederationPeerRecord | null {
  const row = db.db
    .prepare(
      `SELECT
         id,
         label,
         endpoint,
         signing_key,
         trust_state,
         enabled,
         metadata_json,
         created_at,
         updated_at
       FROM federation_peers
       WHERE id = ?`,
    )
    .get(id) as FederationPeerRow | undefined;
  return row ? mapPeerRow(row) : null;
}

export function upsertFederationPeer(db: NexusDatabase, params: UpsertFederationPeerParams): void {
  const nowMs = params.nowMs ?? Date.now();
  const trustState = params.trustState ?? "pending";
  const enabled = params.enabled === false ? 0 : 1;
  db.db
    .prepare(
      `INSERT INTO federation_peers (
         id,
         label,
         endpoint,
         signing_key,
         trust_state,
         enabled,
         metadata_json,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         endpoint = excluded.endpoint,
         signing_key = excluded.signing_key,
         trust_state = excluded.trust_state,
         enabled = excluded.enabled,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
    )
    .run(
      params.id,
      params.label,
      params.endpoint,
      params.signingKey,
      trustState,
      enabled,
      JSON.stringify(params.metadata ?? {}),
      nowMs,
      nowMs,
    );
}

export function setFederationPeerTrustState(
  db: NexusDatabase,
  params: { id: string; trustState: FederationPeerTrustState; enabled?: boolean; nowMs?: number },
): boolean {
  const nowMs = params.nowMs ?? Date.now();
  const enabled = params.enabled === undefined ? null : params.enabled ? 1 : 0;
  const result = enabled === null
    ? db.db.prepare("UPDATE federation_peers SET trust_state = ?, updated_at = ? WHERE id = ?").run(params.trustState, nowMs, params.id)
    : db.db
        .prepare("UPDATE federation_peers SET trust_state = ?, enabled = ?, updated_at = ? WHERE id = ?")
        .run(params.trustState, enabled, nowMs, params.id);
  return result.changes > 0;
}

export function upsertTransportRoute(db: NexusDatabase, params: UpsertTransportRouteParams): void {
  const nowMs = params.nowMs ?? Date.now();
  const metadataJson = JSON.stringify(params.metadata ?? {});
  const updateByRouteId = db.db
    .prepare(
      `UPDATE transport_routes
       SET peer_id = ?,
           adapter = ?,
           endpoint = ?,
           healthy = ?,
           last_checked_at = ?,
           last_error = ?,
           metadata_json = ?,
           updated_at = ?
       WHERE route_id = ?`,
    )
    .run(
      params.peerId,
      params.adapter,
      params.endpoint,
      params.healthy ? 1 : 0,
      params.lastCheckedAt ?? nowMs,
      params.lastError ?? null,
      metadataJson,
      nowMs,
      params.routeId,
    );
  if (updateByRouteId.changes > 0) return;

  const updateByTuple = db.db
    .prepare(
      `UPDATE transport_routes
       SET healthy = ?,
           last_checked_at = ?,
           last_error = ?,
           metadata_json = ?,
           updated_at = ?
       WHERE peer_id = ?
         AND adapter = ?
         AND endpoint = ?`,
    )
    .run(
      params.healthy ? 1 : 0,
      params.lastCheckedAt ?? nowMs,
      params.lastError ?? null,
      metadataJson,
      nowMs,
      params.peerId,
      params.adapter,
      params.endpoint,
    );
  if (updateByTuple.changes > 0) return;

  db.db
    .prepare(
      `INSERT INTO transport_routes (
         route_id,
         peer_id,
         adapter,
         endpoint,
         healthy,
         last_checked_at,
         last_error,
         metadata_json,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.routeId,
      params.peerId,
      params.adapter,
      params.endpoint,
      params.healthy ? 1 : 0,
      params.lastCheckedAt ?? nowMs,
      params.lastError ?? null,
      metadataJson,
      nowMs,
      nowMs,
    );
}

export function getPreferredTransportRouteForPeer(
  db: NexusDatabase,
  params: { peerId: string; adapter?: string; requireHealthy?: boolean },
): TransportRouteRecord | null {
  const row = (params.adapter
    ? db.db
        .prepare(
          `SELECT
             route_id,
             peer_id,
             adapter,
             endpoint,
             healthy,
             last_checked_at,
             last_error,
             metadata_json,
             created_at,
             updated_at
           FROM transport_routes
           WHERE peer_id = ?
             AND adapter = ?
             ${params.requireHealthy ? "AND healthy = 1" : ""}
           ORDER BY healthy DESC, updated_at DESC
           LIMIT 1`,
        )
        .get(params.peerId, params.adapter)
    : db.db
        .prepare(
          `SELECT
             route_id,
             peer_id,
             adapter,
             endpoint,
             healthy,
             last_checked_at,
             last_error,
             metadata_json,
             created_at,
             updated_at
           FROM transport_routes
           WHERE peer_id = ?
             ${params.requireHealthy ? "AND healthy = 1" : ""}
           ORDER BY healthy DESC, updated_at DESC
           LIMIT 1`,
        )
        .get(params.peerId)) as TransportRouteRow | undefined;
  return row ? mapTransportRouteRow(row) : null;
}

export function upsertFederationSession(db: NexusDatabase, params: UpsertFederationSessionParams): void {
  const establishedAt = params.establishedAt ?? Date.now();
  db.db
    .prepare(
      `INSERT INTO federation_sessions (
         id,
         peer_id,
         session_token_hash,
         status,
         established_at,
         expires_at,
         last_heartbeat_at,
         revoked_at,
         metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         peer_id = excluded.peer_id,
         session_token_hash = excluded.session_token_hash,
         status = excluded.status,
         established_at = excluded.established_at,
         expires_at = excluded.expires_at,
         last_heartbeat_at = excluded.last_heartbeat_at,
         revoked_at = excluded.revoked_at,
         metadata_json = excluded.metadata_json`,
    )
    .run(
      params.id,
      params.peerId,
      params.sessionTokenHash ?? null,
      params.status,
      establishedAt,
      params.expiresAt ?? null,
      params.lastHeartbeatAt ?? null,
      params.revokedAt ?? null,
      JSON.stringify(params.metadata ?? {}),
    );
}

export function expireFederationSessions(db: NexusDatabase, nowMs: number = Date.now()): number {
  const result = db.db
    .prepare(
      `UPDATE federation_sessions
       SET status = 'expired'
       WHERE status = 'active'
         AND expires_at IS NOT NULL
         AND expires_at <= ?`,
    )
    .run(nowMs);
  return result.changes;
}

export function createFederationTask(db: NexusDatabase, params: CreateFederationTaskParams): void {
  const nowMs = params.nowMs ?? Date.now();
  db.db
    .prepare(
      `INSERT INTO federation_tasks (
         id,
         peer_id,
         status,
         method,
         idempotency_key,
         request_json,
         created_at,
         updated_at
       ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
    )
    .run(
      params.id,
      params.peerId,
      params.method,
      params.idempotencyKey ?? null,
      JSON.stringify(params.request ?? {}),
      nowMs,
      nowMs,
    );
}

export function getFederationTaskById(db: NexusDatabase, id: string): FederationTaskRecord | null {
  const row = db.db
    .prepare(
      `SELECT
         id,
         peer_id,
         status,
         method,
         idempotency_key,
         request_json,
         result_json,
         error_json,
         created_at,
         updated_at,
         completed_at
       FROM federation_tasks
       WHERE id = ?`,
    )
    .get(id) as FederationTaskRow | undefined;
  return row ? mapTaskRow(row) : null;
}

export function listFederationTasks(db: NexusDatabase, limit: number = 100): FederationTaskRecord[] {
  const rows = db.db
    .prepare(
      `SELECT
         id,
         peer_id,
         status,
         method,
         idempotency_key,
         request_json,
         result_json,
         error_json,
         created_at,
         updated_at,
         completed_at
       FROM federation_tasks
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as FederationTaskRow[];
  return rows.map(mapTaskRow);
}

export function updateFederationTask(db: NexusDatabase, params: UpdateFederationTaskParams): boolean {
  const nowMs = params.nowMs ?? Date.now();
  const completedAt = params.status === "completed" || params.status === "failed" || params.status === "cancelled" ? nowMs : null;
  const result = db.db
    .prepare(
      `UPDATE federation_tasks
       SET status = ?,
           result_json = ?,
           error_json = ?,
           updated_at = ?,
           completed_at = ?
       WHERE id = ?`,
    )
    .run(
      params.status,
      params.result ? JSON.stringify(params.result) : null,
      params.error ? JSON.stringify(params.error) : null,
      nowMs,
      completedAt,
      params.id,
    );
  return result.changes > 0;
}

export function enqueueFederationOutbox(db: NexusDatabase, params: EnqueueFederationOutboxParams): void {
  const nowMs = params.nowMs ?? Date.now();
  db.db
    .prepare(
      `INSERT INTO federation_outbox (
         id,
         peer_id,
         transport_kind,
         envelope_json,
         status,
         attempts,
         trace_id,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    )
    .run(
      params.id,
      params.peerId ?? null,
      params.transportKind,
      JSON.stringify(params.envelope),
      params.traceId ?? null,
      nowMs,
      nowMs,
    );
}

export function listFederationOutbox(
  db: NexusDatabase,
  params: { limit?: number; status?: FederationOutboxStatus } = {},
): FederationOutboxRecord[] {
  const limit = params.limit ?? 100;
  if (params.status) {
    const rows = db.db
      .prepare(
        `SELECT
           id,
           peer_id,
           transport_kind,
           envelope_json,
           status,
           attempts,
           next_attempt_at,
           last_attempt_at,
           last_error,
           trace_id,
           created_at,
           updated_at
         FROM federation_outbox
         WHERE status = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(params.status, limit) as FederationOutboxRow[];
    return rows.map(mapOutboxRow);
  }
  const rows = db.db
    .prepare(
      `SELECT
         id,
         peer_id,
         transport_kind,
         envelope_json,
         status,
         attempts,
         next_attempt_at,
         last_attempt_at,
         last_error,
         trace_id,
         created_at,
         updated_at
       FROM federation_outbox
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as FederationOutboxRow[];
  return rows.map(mapOutboxRow);
}

export function updateFederationOutboxStatus(db: NexusDatabase, params: UpdateFederationOutboxStatusParams): boolean {
  const nowMs = params.nowMs ?? Date.now();
  const result = db.db
    .prepare(
      `UPDATE federation_outbox
       SET status = ?,
           attempts = COALESCE(?, attempts),
           next_attempt_at = ?,
           last_attempt_at = ?,
           last_error = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(
      params.status,
      params.attempts ?? null,
      params.nextAttemptAt ?? null,
      params.lastAttemptAt ?? null,
      params.lastError ?? null,
      nowMs,
      params.id,
    );
  return result.changes > 0;
}

export function upsertIdentityKey(db: NexusDatabase, params: UpsertIdentityKeyParams): void {
  const nowMs = params.nowMs ?? Date.now();
  const status = params.status ?? "active";
  db.db
    .prepare(
      `INSERT INTO identity_keyring (
         id,
         scope,
         kid,
         public_key,
         private_key_ref,
         status,
         not_before,
         not_after,
         created_at,
         updated_at,
         revoked_at,
         metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, kid) DO UPDATE SET
         public_key = excluded.public_key,
         private_key_ref = excluded.private_key_ref,
         status = excluded.status,
         not_before = excluded.not_before,
         not_after = excluded.not_after,
         updated_at = excluded.updated_at,
         revoked_at = excluded.revoked_at,
         metadata_json = excluded.metadata_json`,
    )
    .run(
      params.id ?? `${params.scope}:${params.kid}`,
      params.scope,
      params.kid,
      params.publicKey,
      params.privateKeyRef ?? null,
      status,
      params.notBefore ?? nowMs,
      params.notAfter ?? null,
      nowMs,
      nowMs,
      params.revokedAt ?? null,
      JSON.stringify(params.metadata ?? {}),
    );
}

export function rotateIdentityKeyForScope(db: NexusDatabase, params: RotateIdentityKeyForScopeParams): void {
  const nowMs = params.nowMs ?? Date.now();
  const overlapMs = Math.max(0, params.overlapMs ?? 24 * 60 * 60 * 1000);
  const overlapEndsAt = nowMs + overlapMs;
  const tx = db.db.transaction(() => {
    db.db
      .prepare(
        `UPDATE identity_keyring
         SET status = 'next',
             not_after = CASE
               WHEN ? = 0 THEN ?
               WHEN not_after IS NULL OR not_after > ? THEN ?
               ELSE not_after
             END,
             updated_at = ?
         WHERE scope = ?
           AND status = 'active'
           AND kid != ?`,
      )
      .run(
        overlapMs,
        nowMs,
        overlapEndsAt,
        overlapEndsAt,
        nowMs,
        params.scope,
        params.kid,
      );

    db.db
      .prepare(
        `INSERT INTO identity_keyring (
           id,
           scope,
           kid,
           public_key,
           private_key_ref,
           status,
           not_before,
           not_after,
           created_at,
           updated_at,
           revoked_at,
           metadata_json
         ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, NULL, ?)
         ON CONFLICT(scope, kid) DO UPDATE SET
           public_key = excluded.public_key,
           private_key_ref = excluded.private_key_ref,
           status = 'active',
           not_before = excluded.not_before,
           not_after = NULL,
           updated_at = excluded.updated_at,
           revoked_at = NULL,
           metadata_json = excluded.metadata_json`,
      )
      .run(
        `${params.scope}:${params.kid}`,
        params.scope,
        params.kid,
        params.publicKey,
        params.privateKeyRef ?? null,
        nowMs,
        nowMs,
        nowMs,
        JSON.stringify(params.metadata ?? {}),
      );
  });
  tx();
}

export function countIdentityKeysByScope(db: NexusDatabase, scope: string): number {
  const row = db.db
    .prepare("SELECT COUNT(*) AS cnt FROM identity_keyring WHERE scope = ?")
    .get(scope) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

export function getIdentityKeyByScopeKid(
  db: NexusDatabase,
  params: { scope: string; kid: string; nowMs?: number; includeInactive?: boolean },
): IdentityKeyRecord | null {
  const nowMs = params.nowMs ?? Date.now();
  const row = params.includeInactive
    ? db.db
        .prepare(
          `SELECT
             id,
             scope,
             kid,
             public_key,
             private_key_ref,
             status,
             not_before,
             not_after,
             created_at,
             updated_at,
             revoked_at,
             metadata_json
           FROM identity_keyring
           WHERE scope = ?
             AND kid = ?
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(params.scope, params.kid) as IdentityKeyRow | undefined
    : db.db
        .prepare(
          `SELECT
             id,
             scope,
             kid,
             public_key,
             private_key_ref,
             status,
             not_before,
             not_after,
             created_at,
             updated_at,
             revoked_at,
             metadata_json
           FROM identity_keyring
           WHERE scope = ?
             AND kid = ?
             AND status IN ('active', 'next')
             AND (not_before IS NULL OR not_before <= ?)
             AND (not_after IS NULL OR not_after > ?)
           ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'next' THEN 1 ELSE 2 END, updated_at DESC
           LIMIT 1`,
        )
        .get(params.scope, params.kid, nowMs, nowMs) as IdentityKeyRow | undefined;
  return row ? mapIdentityKeyRow(row) : null;
}

export function getPreferredIdentityKeyForScope(
  db: NexusDatabase,
  params: { scope: string; nowMs?: number },
): IdentityKeyRecord | null {
  const nowMs = params.nowMs ?? Date.now();
  const row = db.db
    .prepare(
      `SELECT
         id,
         scope,
         kid,
         public_key,
         private_key_ref,
         status,
         not_before,
         not_after,
         created_at,
         updated_at,
         revoked_at,
         metadata_json
       FROM identity_keyring
       WHERE scope = ?
         AND status IN ('active', 'next')
         AND (not_before IS NULL OR not_before <= ?)
         AND (not_after IS NULL OR not_after > ?)
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'next' THEN 1 ELSE 2 END,
                COALESCE(not_before, 0) DESC,
                updated_at DESC
       LIMIT 1`,
    )
    .get(params.scope, nowMs, nowMs) as IdentityKeyRow | undefined;
  return row ? mapIdentityKeyRow(row) : null;
}

export function setIdentityKeyStatusByScope(db: NexusDatabase, params: SetIdentityKeyStatusByScopeParams): number {
  const nowMs = params.nowMs ?? Date.now();
  if (params.status === "revoked") {
    const result = db.db
      .prepare(
        `UPDATE identity_keyring
         SET status = ?,
             updated_at = ?,
             revoked_at = COALESCE(revoked_at, ?)
         WHERE scope = ?`,
      )
      .run("revoked", nowMs, params.revokedAt ?? nowMs, params.scope);
    return result.changes;
  }
  const result = db.db
    .prepare(
      `UPDATE identity_keyring
       SET status = ?,
           updated_at = ?,
           revoked_at = NULL
       WHERE scope = ?
         AND status IN ('active', 'next')`,
    )
    .run(params.status, nowMs, params.scope);
  return result.changes;
}

export function purgeExpiredFederationReplayNonces(db: NexusDatabase, nowMs: number = Date.now()): number {
  const result = db.db.prepare("DELETE FROM federation_replay_nonces WHERE expires_at <= ?").run(nowMs);
  return result.changes;
}

export function consumeFederationReplayNonce(
  db: NexusDatabase,
  params: ConsumeFederationReplayNonceParams,
): FederationReplayNonceConsumeResult {
  const nowMs = params.nowMs ?? Date.now();
  const ttlMs = Math.max(1_000, params.ttlMs);
  const expiresAt = nowMs + ttlMs;
  const cleanupDeleted = purgeExpiredFederationReplayNonces(db, nowMs);
  const result = db.db
    .prepare(
      `INSERT OR IGNORE INTO federation_replay_nonces (
         source_instance,
         nonce,
         key_id,
         envelope_id,
         trace_id,
         first_seen_at,
         expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.sourceInstance,
      params.nonce,
      params.keyId ?? null,
      params.envelopeId ?? null,
      params.traceId ?? null,
      nowMs,
      expiresAt,
    );
  const accepted = result.changes > 0;
  return {
    accepted,
    duplicate: !accepted,
    cleanupDeleted,
    expiresAt,
  };
}

export function appendFederationEvent(db: NexusDatabase, params: AppendFederationEventParams): void {
  const nowMs = params.nowMs ?? Date.now();
  db.db
    .prepare(
      `INSERT INTO federation_events (
         id,
         peer_id,
         event_type,
         direction,
         envelope_id,
         payload_json,
         trace_id,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.id,
      params.peerId ?? null,
      params.eventType,
      params.direction,
      params.envelopeId ?? null,
      JSON.stringify(params.payload ?? {}),
      params.traceId ?? null,
      nowMs,
    );
}

export function getFederationEventByEnvelopeId(
  db: NexusDatabase,
  params: { envelopeId: string; direction?: FederationEventDirection },
): FederationEventRecord | null {
  const direction = params.direction ?? null;
  const row = direction
    ? db.db
        .prepare(
          `SELECT
             id,
             peer_id,
             event_type,
             direction,
             envelope_id,
             payload_json,
             trace_id,
             created_at
           FROM federation_events
           WHERE envelope_id = ?
             AND direction = ?
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .get(params.envelopeId, direction) as FederationEventRow | undefined
    : db.db
        .prepare(
          `SELECT
             id,
             peer_id,
             event_type,
             direction,
             envelope_id,
             payload_json,
             trace_id,
             created_at
           FROM federation_events
           WHERE envelope_id = ?
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .get(params.envelopeId) as FederationEventRow | undefined;

  return row ? mapFederationEventRow(row) : null;
}

export function getFederationEventById(db: NexusDatabase, id: string): FederationEventRecord | null {
  const row = db.db
    .prepare(
      `SELECT
         id,
         peer_id,
         event_type,
         direction,
         envelope_id,
         payload_json,
         trace_id,
         created_at
       FROM federation_events
       WHERE id = ?`,
    )
    .get(id) as FederationEventRow | undefined;
  return row ? mapFederationEventRow(row) : null;
}

export function appendFederationAudit(db: NexusDatabase, params: AppendFederationAuditParams): void {
  const nowMs = params.nowMs ?? Date.now();
  db.db
    .prepare(
      `INSERT INTO federation_audit (
         id,
         peer_id,
         event_type,
         decision,
         actor,
         trace_id,
         details_json,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.id,
      params.peerId ?? null,
      params.eventType,
      params.decision ?? null,
      params.actor ?? null,
      params.traceId ?? null,
      JSON.stringify(params.details ?? {}),
      nowMs,
    );
}

export function listFederationAudit(
  db: NexusDatabase,
  params: { limit?: number; peerId?: string } = {},
): FederationAuditRecord[] {
  const limit = params.limit ?? 100;
  const rows = params.peerId
    ? db.db
        .prepare(
          `SELECT
             id,
             peer_id,
             event_type,
             decision,
             actor,
             trace_id,
             details_json,
             created_at
           FROM federation_audit
           WHERE peer_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(params.peerId, limit) as FederationAuditRow[]
    : db.db
        .prepare(
          `SELECT
             id,
             peer_id,
             event_type,
             decision,
             actor,
             trace_id,
             details_json,
             created_at
           FROM federation_audit
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(limit) as FederationAuditRow[];
  return rows.map(mapFederationAuditRow);
}

export function listFederationEvents(
  db: NexusDatabase,
  params: { limit?: number; peerId?: string; direction?: FederationEventDirection } = {},
): FederationEventRecord[] {
  const limit = params.limit ?? 100;
  const direction = params.direction ?? null;
  if (params.peerId && direction) {
    const rows = db.db
      .prepare(
        `SELECT
           id,
           peer_id,
           event_type,
           direction,
           envelope_id,
           payload_json,
           trace_id,
           created_at
         FROM federation_events
         WHERE peer_id = ?
           AND direction = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(params.peerId, direction, limit) as FederationEventRow[];
    return rows.map(mapFederationEventRow);
  }
  if (params.peerId) {
    const rows = db.db
      .prepare(
        `SELECT
           id,
           peer_id,
           event_type,
           direction,
           envelope_id,
           payload_json,
           trace_id,
           created_at
         FROM federation_events
         WHERE peer_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(params.peerId, limit) as FederationEventRow[];
    return rows.map(mapFederationEventRow);
  }
  if (direction) {
    const rows = db.db
      .prepare(
        `SELECT
           id,
           peer_id,
           event_type,
           direction,
           envelope_id,
           payload_json,
           trace_id,
           created_at
         FROM federation_events
         WHERE direction = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(direction, limit) as FederationEventRow[];
    return rows.map(mapFederationEventRow);
  }
  const rows = db.db
    .prepare(
      `SELECT
         id,
         peer_id,
         event_type,
         direction,
         envelope_id,
         payload_json,
         trace_id,
         created_at
       FROM federation_events
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as FederationEventRow[];
  return rows.map(mapFederationEventRow);
}

export function upsertFederationExport(db: NexusDatabase, params: UpsertFederationExportParams): void {
  const nowMs = params.nowMs ?? Date.now();
  db.db
    .prepare(
      `INSERT INTO federation_exports (
         id,
         resource_type,
         resource_selector_json,
         projection_json,
         enabled,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         resource_type = excluded.resource_type,
         resource_selector_json = excluded.resource_selector_json,
         projection_json = excluded.projection_json,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    )
    .run(
      params.id,
      params.resourceType,
      JSON.stringify(params.resourceSelector ?? {}),
      JSON.stringify(params.projection ?? {}),
      params.enabled === false ? 0 : 1,
      nowMs,
      nowMs,
    );
}

export function listFederationExports(db: NexusDatabase, limit: number = 200): FederationExportRecord[] {
  const rows = db.db
    .prepare(
      `SELECT
         id,
         resource_type,
         resource_selector_json,
         projection_json,
         enabled,
         created_at,
         updated_at
       FROM federation_exports
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as FederationExportRow[];
  return rows.map(mapFederationExportRow);
}

export function getFederationExportById(db: NexusDatabase, id: string): FederationExportRecord | null {
  const row = db.db
    .prepare(
      `SELECT
         id,
         resource_type,
         resource_selector_json,
         projection_json,
         enabled,
         created_at,
         updated_at
       FROM federation_exports
       WHERE id = ?`,
    )
    .get(id) as FederationExportRow | undefined;
  return row ? mapFederationExportRow(row) : null;
}

export function removeFederationExport(db: NexusDatabase, id: string): boolean {
  const result = db.db.prepare("DELETE FROM federation_exports WHERE id = ?").run(id);
  return result.changes > 0;
}

export function upsertFederationGrant(db: NexusDatabase, params: UpsertFederationGrantParams): void {
  const nowMs = params.nowMs ?? Date.now();
  db.db
    .prepare(
      `INSERT INTO federation_grants (
         id,
         peer_id,
         export_id,
         permission,
         sensitivity_ceiling,
         enabled,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(peer_id, export_id) DO UPDATE SET
         permission = excluded.permission,
         sensitivity_ceiling = excluded.sensitivity_ceiling,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    )
    .run(
      params.id,
      params.peerId,
      params.exportId,
      params.permission ?? "read",
      params.sensitivityCeiling ?? "internal",
      params.enabled === false ? 0 : 1,
      nowMs,
      nowMs,
    );
}

export function listFederationGrants(
  db: NexusDatabase,
  params: { limit?: number; peerId?: string; enabledOnly?: boolean } = {},
): FederationGrantRecord[] {
  const limit = params.limit ?? 200;
  if (params.peerId) {
    const rows = db.db
      .prepare(
        `SELECT
           id,
           peer_id,
           export_id,
           permission,
           sensitivity_ceiling,
           enabled,
           created_at,
           updated_at
         FROM federation_grants
         WHERE peer_id = ?
           ${params.enabledOnly ? "AND enabled = 1" : ""}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(params.peerId, limit) as FederationGrantRow[];
    return rows.map(mapFederationGrantRow);
  }
  const rows = db.db
    .prepare(
      `SELECT
         id,
         peer_id,
         export_id,
         permission,
         sensitivity_ceiling,
         enabled,
         created_at,
         updated_at
       FROM federation_grants
       ${params.enabledOnly ? "WHERE enabled = 1" : ""}
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as FederationGrantRow[];
  return rows.map(mapFederationGrantRow);
}

export function removeFederationGrant(db: NexusDatabase, id: string): boolean {
  const result = db.db.prepare("DELETE FROM federation_grants WHERE id = ?").run(id);
  return result.changes > 0;
}

export function peerHasFederationGrantForResource(
  db: NexusDatabase,
  params: { peerId: string; resourceType: FederationExportResourceType },
): boolean {
  const row = db.db
    .prepare(
      `SELECT g.id
       FROM federation_grants g
       INNER JOIN federation_exports e ON e.id = g.export_id
       WHERE g.peer_id = ?
         AND g.enabled = 1
         AND e.enabled = 1
         AND e.resource_type = ?
       LIMIT 1`,
    )
    .get(params.peerId, params.resourceType) as { id: string } | undefined;
  return Boolean(row?.id);
}

export function getFederationGrantProjectionForPeerResource(
  db: NexusDatabase,
  params: { peerId: string; resourceType: FederationExportResourceType },
): FederationGrantProjectionRecord | null {
  const row = db.db
    .prepare(
      `SELECT
         g.id AS grant_id,
         g.peer_id,
         g.export_id,
         g.permission,
         g.sensitivity_ceiling,
         e.resource_type,
         e.projection_json,
         e.resource_selector_json
       FROM federation_grants g
       INNER JOIN federation_exports e ON e.id = g.export_id
       WHERE g.peer_id = ?
         AND g.enabled = 1
         AND e.enabled = 1
         AND e.resource_type = ?
       ORDER BY g.updated_at DESC
       LIMIT 1`,
    )
    .get(params.peerId, params.resourceType) as FederationGrantProjectionRow | undefined;
  return row ? mapFederationGrantProjectionRow(row) : null;
}

export function upsertWebhookEndpoint(db: NexusDatabase, params: UpsertWebhookEndpointParams): void {
  const nowMs = params.nowMs ?? Date.now();
  db.db
    .prepare(
      `INSERT INTO webhook_endpoints (
         id,
         owner_scope,
         peer_id,
         url,
         event_filter_json,
         signing_mode,
         secret_ref,
         enabled,
         status,
         metadata_json,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         owner_scope = excluded.owner_scope,
         peer_id = excluded.peer_id,
         url = excluded.url,
         event_filter_json = excluded.event_filter_json,
         signing_mode = excluded.signing_mode,
         secret_ref = excluded.secret_ref,
         enabled = excluded.enabled,
         status = excluded.status,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
    )
    .run(
      params.id,
      params.ownerScope ?? "local",
      params.peerId ?? null,
      params.url,
      JSON.stringify(params.eventFilter ?? []),
      params.signingMode ?? "hmac",
      params.secretRef ?? null,
      params.enabled === false ? 0 : 1,
      params.status ?? "active",
      JSON.stringify(params.metadata ?? {}),
      nowMs,
      nowMs,
    );
}

export function listWebhookEndpoints(
  db: NexusDatabase,
  params: { limit?: number; ownerScope?: WebhookEndpointOwnerScope; peerId?: string } = {},
): WebhookEndpointRecord[] {
  const limit = params.limit ?? 200;
  if (params.peerId) {
    const rows = db.db
      .prepare(
        `SELECT
           id,
           owner_scope,
           peer_id,
           url,
           event_filter_json,
           signing_mode,
           secret_ref,
           enabled,
           status,
           metadata_json,
           created_at,
           updated_at
         FROM webhook_endpoints
         WHERE peer_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(params.peerId, limit) as WebhookEndpointRow[];
    return rows.map(mapWebhookEndpointRow);
  }
  if (params.ownerScope) {
    const rows = db.db
      .prepare(
        `SELECT
           id,
           owner_scope,
           peer_id,
           url,
           event_filter_json,
           signing_mode,
           secret_ref,
           enabled,
           status,
           metadata_json,
           created_at,
           updated_at
         FROM webhook_endpoints
         WHERE owner_scope = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(params.ownerScope, limit) as WebhookEndpointRow[];
    return rows.map(mapWebhookEndpointRow);
  }
  const rows = db.db
    .prepare(
      `SELECT
         id,
         owner_scope,
         peer_id,
         url,
         event_filter_json,
         signing_mode,
         secret_ref,
         enabled,
         status,
         metadata_json,
         created_at,
         updated_at
       FROM webhook_endpoints
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as WebhookEndpointRow[];
  return rows.map(mapWebhookEndpointRow);
}

export function getWebhookEndpointById(db: NexusDatabase, id: string): WebhookEndpointRecord | null {
  const row = db.db
    .prepare(
      `SELECT
         id,
         owner_scope,
         peer_id,
         url,
         event_filter_json,
         signing_mode,
         secret_ref,
         enabled,
         status,
         metadata_json,
         created_at,
         updated_at
       FROM webhook_endpoints
       WHERE id = ?`,
    )
    .get(id) as WebhookEndpointRow | undefined;
  return row ? mapWebhookEndpointRow(row) : null;
}

export function removeWebhookEndpoint(db: NexusDatabase, id: string): boolean {
  const result = db.db.prepare("DELETE FROM webhook_endpoints WHERE id = ?").run(id);
  return result.changes > 0;
}

export function upsertWebhookSubscription(db: NexusDatabase, params: UpsertWebhookSubscriptionParams): void {
  const nowMs = params.nowMs ?? Date.now();
  db.db
    .prepare(
      `INSERT INTO webhook_subscriptions (
         id,
         endpoint_id,
         event_type,
         enabled,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint_id, event_type) DO UPDATE SET
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    )
    .run(
      params.id,
      params.endpointId,
      params.eventType,
      params.enabled === false ? 0 : 1,
      nowMs,
      nowMs,
    );
}

export function listWebhookSubscriptions(
  db: NexusDatabase,
  params: { limit?: number; endpointId?: string; enabledOnly?: boolean } = {},
): WebhookSubscriptionRecord[] {
  const limit = params.limit ?? 500;
  if (params.endpointId) {
    const rows = db.db
      .prepare(
        `SELECT
           id,
           endpoint_id,
           event_type,
           enabled,
           created_at,
           updated_at
         FROM webhook_subscriptions
         WHERE endpoint_id = ?
           ${params.enabledOnly ? "AND enabled = 1" : ""}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(params.endpointId, limit) as WebhookSubscriptionRow[];
    return rows.map(mapWebhookSubscriptionRow);
  }
  const rows = db.db
    .prepare(
      `SELECT
         id,
         endpoint_id,
         event_type,
         enabled,
         created_at,
         updated_at
       FROM webhook_subscriptions
       ${params.enabledOnly ? "WHERE enabled = 1" : ""}
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as WebhookSubscriptionRow[];
  return rows.map(mapWebhookSubscriptionRow);
}

export function removeWebhookSubscription(db: NexusDatabase, id: string): boolean {
  const result = db.db.prepare("DELETE FROM webhook_subscriptions WHERE id = ?").run(id);
  return result.changes > 0;
}

export function enqueueWebhookDelivery(db: NexusDatabase, params: EnqueueWebhookDeliveryParams): void {
  const nowMs = params.nowMs ?? Date.now();
  db.db
    .prepare(
      `INSERT INTO webhook_deliveries (
         id,
         endpoint_id,
         event_id,
         status,
         attempts,
         trace_id,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
    )
    .run(params.id, params.endpointId, params.eventId ?? null, params.traceId ?? null, nowMs, nowMs);
}

export function listWebhookDeliveries(
  db: NexusDatabase,
  params: { limit?: number; endpointId?: string; status?: WebhookDeliveryStatus } = {},
): WebhookDeliveryRecord[] {
  const limit = params.limit ?? 500;
  if (params.endpointId && params.status) {
    const rows = db.db
      .prepare(
        `SELECT
           id,
           endpoint_id,
           event_id,
           status,
           attempts,
           response_code,
           response_body,
           next_attempt_at,
           last_attempt_at,
           trace_id,
           created_at,
           updated_at
         FROM webhook_deliveries
         WHERE endpoint_id = ?
           AND status = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(params.endpointId, params.status, limit) as WebhookDeliveryRow[];
    return rows.map(mapWebhookDeliveryRow);
  }
  if (params.endpointId) {
    const rows = db.db
      .prepare(
        `SELECT
           id,
           endpoint_id,
           event_id,
           status,
           attempts,
           response_code,
           response_body,
           next_attempt_at,
           last_attempt_at,
           trace_id,
           created_at,
           updated_at
         FROM webhook_deliveries
         WHERE endpoint_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(params.endpointId, limit) as WebhookDeliveryRow[];
    return rows.map(mapWebhookDeliveryRow);
  }
  if (params.status) {
    const rows = db.db
      .prepare(
        `SELECT
           id,
           endpoint_id,
           event_id,
           status,
           attempts,
           response_code,
           response_body,
           next_attempt_at,
           last_attempt_at,
           trace_id,
           created_at,
           updated_at
         FROM webhook_deliveries
         WHERE status = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(params.status, limit) as WebhookDeliveryRow[];
    return rows.map(mapWebhookDeliveryRow);
  }
  const rows = db.db
    .prepare(
      `SELECT
         id,
         endpoint_id,
         event_id,
         status,
         attempts,
         response_code,
         response_body,
         next_attempt_at,
         last_attempt_at,
         trace_id,
         created_at,
         updated_at
       FROM webhook_deliveries
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as WebhookDeliveryRow[];
  return rows.map(mapWebhookDeliveryRow);
}

export function getWebhookDeliveryById(db: NexusDatabase, id: string): WebhookDeliveryRecord | null {
  const row = db.db
    .prepare(
      `SELECT
         id,
         endpoint_id,
         event_id,
         status,
         attempts,
         response_code,
         response_body,
         next_attempt_at,
         last_attempt_at,
         trace_id,
         created_at,
         updated_at
       FROM webhook_deliveries
       WHERE id = ?`,
    )
    .get(id) as WebhookDeliveryRow | undefined;
  return row ? mapWebhookDeliveryRow(row) : null;
}

export function updateWebhookDeliveryStatus(db: NexusDatabase, params: UpdateWebhookDeliveryStatusParams): boolean {
  const nowMs = params.nowMs ?? Date.now();
  const result = db.db
    .prepare(
      `UPDATE webhook_deliveries
       SET status = ?,
           attempts = COALESCE(?, attempts),
           response_code = ?,
           response_body = ?,
           next_attempt_at = ?,
           last_attempt_at = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(
      params.status,
      params.attempts ?? null,
      params.responseCode ?? null,
      params.responseBody ?? null,
      params.nextAttemptAt ?? null,
      params.lastAttemptAt ?? null,
      nowMs,
      params.id,
    );
  return result.changes > 0;
}

export function appendWebhookDlq(db: NexusDatabase, params: AppendWebhookDlqParams): void {
  const nowMs = params.nowMs ?? Date.now();
  db.db
    .prepare(
      `INSERT INTO webhook_dlq (
         id,
         delivery_id,
         endpoint_id,
         reason,
         payload_json,
         created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(params.id, params.deliveryId, params.endpointId, params.reason, JSON.stringify(params.payload ?? {}), nowMs);
}

export function listWebhookDlq(db: NexusDatabase, limit: number = 200): WebhookDlqRecord[] {
  const rows = db.db
    .prepare(
      `SELECT
         id,
         delivery_id,
         endpoint_id,
         reason,
         payload_json,
         created_at,
         replayed_at
       FROM webhook_dlq
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as WebhookDlqRow[];
  return rows.map(mapWebhookDlqRow);
}

export function markWebhookDlqReplayed(db: NexusDatabase, id: string, nowMs: number = Date.now()): boolean {
  const result = db.db
    .prepare("UPDATE webhook_dlq SET replayed_at = ? WHERE id = ?")
    .run(nowMs, id);
  return result.changes > 0;
}

export function getFederationStatusSnapshot(params: {
  db: NexusDatabase;
  enabled: boolean;
  firewallActive: boolean;
  nowMs?: number;
}): FederationStatusSnapshot {
  const nowMs = params.nowMs ?? Date.now();
  if (!params.enabled) {
    return {
      enabled: false,
      derivedState: "standalone",
      identityValid: false,
      firewallActive: false,
      trustedPeerCount: 0,
      healthyTrustedPeerCount: 0,
      peerCount: 0,
      peers: [],
    };
  }

  expireFederationSessions(params.db, nowMs);

  const identityRow = params.db.db
    .prepare(
      `SELECT id
       FROM identity_keyring
       WHERE scope = 'federation'
         AND status IN ('active', 'next')
         AND (not_before IS NULL OR not_before <= ?)
         AND (not_after IS NULL OR not_after > ?)
       LIMIT 1`,
    )
    .get(nowMs, nowMs) as IdentityHealthRow | undefined;
  const identityValid = Boolean(identityRow?.id);

  const peers = listFederationPeers(params.db, 500).filter((peer) => peer.enabled);
  const routeHealthStmt = params.db.db.prepare(
    `SELECT healthy
     FROM transport_routes
     WHERE peer_id = ?
     ORDER BY updated_at DESC
     LIMIT 1`,
  );
  const sessionHealthStmt = params.db.db.prepare(
    `SELECT status, expires_at
     FROM federation_sessions
     WHERE peer_id = ?
     ORDER BY established_at DESC
     LIMIT 1`,
  );

  const snapshots: FederationPeerStatusSnapshot[] = peers.map((peer) => {
    const routeRow = routeHealthStmt.get(peer.id) as RouteHealthRow | undefined;
    const sessionRow = sessionHealthStmt.get(peer.id) as SessionHealthRow | undefined;
    const routeHealthy = Boolean(routeRow && routeRow.healthy === 1);
    const sessionHealthy = Boolean(
      sessionRow &&
        sessionRow.status === "active" &&
        (sessionRow.expires_at == null || sessionRow.expires_at > nowMs),
    );
    return {
      trustState: peer.trustState,
      routeHealthy,
      sessionHealthy,
    };
  });

  const derivedState = deriveFederationState({
    enabled: true,
    identityValid,
    firewallActive: params.firewallActive,
    peers: snapshots,
  });

  const trustedPeerCount = snapshots.filter((peer) => peer.trustState === "trusted").length;
  const healthyTrustedPeerCount = snapshots.filter(
    (peer) => peer.trustState === "trusted" && peer.routeHealthy && peer.sessionHealthy,
  ).length;
  const peerStatuses = [];
  const snapshotIterator = snapshots[Symbol.iterator]();
  for (const peer of peers) {
    const nextSnapshot = snapshotIterator.next();
    if (nextSnapshot.done) break;
    const snapshot = nextSnapshot.value;
    peerStatuses.push({
      id: peer.id,
      trustState: snapshot.trustState,
      routeHealthy: snapshot.routeHealthy,
      sessionHealthy: snapshot.sessionHealthy,
    });
  }

  return {
    enabled: true,
    derivedState,
    identityValid,
    firewallActive: params.firewallActive,
    trustedPeerCount,
    healthyTrustedPeerCount,
    peerCount: snapshots.length,
    peers: peerStatuses,
  };
}
