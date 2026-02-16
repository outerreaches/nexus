import type { NexusDatabase } from "./database.js";

export type NodeBackend = "nexus" | "openclaw";
export type NodeStatus = "pending" | "approved" | "blocked" | "offline" | "online";
export type NodeTrustLevel = "untrusted" | "standard" | "secure";
export type NodeFirewallMode = "hermes" | "audit-only" | "transparent";

export type NodeRecord = {
  id: string;
  label: string;
  publicKey: string;
  fingerprint: string;
  status: NodeStatus;
  endpoint: string | null;
  backend: NodeBackend;
  trustLevel: NodeTrustLevel;
  firewallMode: NodeFirewallMode;
  capabilities: string[];
  tags: string[];
  permissions: Record<string, boolean>;
  metadata: Record<string, unknown>;
  lastSeenAt: number | null;
  connectedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type UpsertNodeParams = {
  id: string;
  label: string;
  publicKey: string;
  fingerprint: string;
  status?: NodeStatus;
  endpoint?: string | null;
  backend?: NodeBackend;
  trustLevel?: NodeTrustLevel;
  firewallMode?: NodeFirewallMode;
  capabilities?: string[];
  tags?: string[];
  permissions?: Record<string, boolean>;
  metadata?: Record<string, unknown>;
  connectedAt?: number | null;
  lastSeenAt?: number | null;
  nowMs?: number;
};

export type DeleteNodeCascadeResult = {
  nodeId: string;
  deleted: boolean;
  nodeSessionsDeleted: number;
  nodeExecutionsDeleted: number;
  processRunsDeleted: number;
  pairingRequestsDeleted: number;
};

type NodeRow = {
  id: string;
  label: string;
  public_key: string;
  fingerprint: string;
  status: string;
  endpoint: string | null;
  backend: string;
  trust_level: string;
  firewall_mode: string;
  capabilities_json: string;
  tags_json: string;
  permissions_json: string;
  metadata_json: string;
  last_seen_at: number | null;
  connected_at: number | null;
  created_at: number;
  updated_at: number;
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

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function parsePermissions(value: string | null | undefined): Record<string, boolean> {
  const parsed = parseJsonObject(value);
  const out: Record<string, boolean> = {};
  for (const [key, v] of Object.entries(parsed)) {
    if (typeof v === "boolean") out[key] = v;
  }
  return out;
}

function normalizeBackend(value: string): NodeBackend {
  return value === "openclaw" ? "openclaw" : "nexus";
}

function normalizeStatus(value: string): NodeStatus {
  switch (value) {
    case "approved":
    case "blocked":
    case "offline":
    case "online":
      return value;
    default:
      return "pending";
  }
}

function normalizeTrustLevel(value: string): NodeTrustLevel {
  switch (value) {
    case "untrusted":
    case "secure":
      return value;
    default:
      return "standard";
  }
}

function normalizeFirewallMode(value: string): NodeFirewallMode {
  switch (value) {
    case "hermes":
    case "audit-only":
      return value;
    default:
      return "transparent";
  }
}

function mapNodeRow(row: NodeRow): NodeRecord {
  return {
    id: row.id,
    label: row.label,
    publicKey: row.public_key,
    fingerprint: row.fingerprint,
    status: normalizeStatus(row.status),
    endpoint: row.endpoint ?? null,
    backend: normalizeBackend(row.backend),
    trustLevel: normalizeTrustLevel(row.trust_level),
    firewallMode: normalizeFirewallMode(row.firewall_mode),
    capabilities: parseStringArray(row.capabilities_json),
    tags: parseStringArray(row.tags_json),
    permissions: parsePermissions(row.permissions_json),
    metadata: parseJsonObject(row.metadata_json),
    lastSeenAt: row.last_seen_at ?? null,
    connectedAt: row.connected_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listNodes(db: NexusDatabase, limit: number = 200): NodeRecord[] {
  const rows = db.db
    .prepare(
      `SELECT
         id,
         label,
         public_key,
         fingerprint,
         status,
         endpoint,
         backend,
         trust_level,
         firewall_mode,
         capabilities_json,
         tags_json,
         permissions_json,
         metadata_json,
         last_seen_at,
         connected_at,
         created_at,
         updated_at
       FROM nodes
       ORDER BY
         CASE status
           WHEN 'online' THEN 0
           WHEN 'offline' THEN 1
           WHEN 'pending' THEN 2
           WHEN 'approved' THEN 3
           ELSE 4
         END,
         COALESCE(last_seen_at, 0) DESC,
         created_at DESC
       LIMIT ?`,
    )
    .all(limit) as NodeRow[];
  return rows.map(mapNodeRow);
}

export function getNodeById(db: NexusDatabase, id: string): NodeRecord | null {
  const row = db.db
    .prepare(
      `SELECT
         id,
         label,
         public_key,
         fingerprint,
         status,
         endpoint,
         backend,
         trust_level,
         firewall_mode,
         capabilities_json,
         tags_json,
         permissions_json,
         metadata_json,
         last_seen_at,
         connected_at,
         created_at,
         updated_at
       FROM nodes
       WHERE id = ?`,
    )
    .get(id) as NodeRow | undefined;
  return row ? mapNodeRow(row) : null;
}

export function deleteNodeById(db: NexusDatabase, id: string): boolean {
  const result = db.db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
  return result.changes > 0;
}

export function deleteNodeCascadeById(db: NexusDatabase, id: string): DeleteNodeCascadeResult {
  const row = db.db
    .prepare("SELECT id, fingerprint, public_key FROM nodes WHERE id = ?")
    .get(id) as { id?: string; fingerprint?: string; public_key?: string } | undefined;
  if (!row?.id || typeof row.fingerprint !== "string" || typeof row.public_key !== "string") {
    return {
      nodeId: id,
      deleted: false,
      nodeSessionsDeleted: 0,
      nodeExecutionsDeleted: 0,
      processRunsDeleted: 0,
      pairingRequestsDeleted: 0,
    };
  }

  const run = db.db.transaction((nodeId: string, fingerprint: string, publicKey: string): DeleteNodeCascadeResult => {
    const nodeSessionsDeleted = db.db.prepare("DELETE FROM node_sessions WHERE node_id = ?").run(nodeId).changes;
    const nodeExecutionsDeleted = db.db.prepare("DELETE FROM node_executions WHERE node_id = ?").run(nodeId).changes;
    const processRunsDeleted = db.db.prepare("DELETE FROM process_runs WHERE node_id = ?").run(nodeId).changes;
    const pairingRequestsDeleted = db.db
      .prepare("DELETE FROM node_pairing_requests WHERE fingerprint = ? OR public_key = ?")
      .run(fingerprint, publicKey).changes;
    const deleted = db.db.prepare("DELETE FROM nodes WHERE id = ?").run(nodeId).changes > 0;
    return {
      nodeId,
      deleted,
      nodeSessionsDeleted: Number(nodeSessionsDeleted),
      nodeExecutionsDeleted: Number(nodeExecutionsDeleted),
      processRunsDeleted: Number(processRunsDeleted),
      pairingRequestsDeleted: Number(pairingRequestsDeleted),
    };
  });

  return run(row.id, row.fingerprint, row.public_key);
}

export function upsertNode(db: NexusDatabase, params: UpsertNodeParams): void {
  const nowMs = params.nowMs ?? Date.now();
  const status = params.status ?? "pending";
  const backend = params.backend ?? "nexus";
  const trustLevel = params.trustLevel ?? "standard";
  const firewallMode = params.firewallMode ?? "transparent";
  const capabilitiesJson = JSON.stringify(params.capabilities ?? []);
  const tagsJson = JSON.stringify(params.tags ?? []);
  const permissionsJson = JSON.stringify(params.permissions ?? {});
  const metadataJson = JSON.stringify(params.metadata ?? {});
  db.db
    .prepare(
      `INSERT INTO nodes (
         id,
         label,
         public_key,
         fingerprint,
         status,
         endpoint,
         backend,
         trust_level,
         firewall_mode,
         capabilities_json,
         tags_json,
         permissions_json,
         metadata_json,
         connected_at,
         last_seen_at,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         public_key = excluded.public_key,
         fingerprint = excluded.fingerprint,
         status = excluded.status,
         endpoint = excluded.endpoint,
         backend = excluded.backend,
         trust_level = excluded.trust_level,
         firewall_mode = excluded.firewall_mode,
         capabilities_json = excluded.capabilities_json,
         tags_json = excluded.tags_json,
         permissions_json = excluded.permissions_json,
         metadata_json = excluded.metadata_json,
         connected_at = excluded.connected_at,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at`,
    )
    .run(
      params.id,
      params.label,
      params.publicKey,
      params.fingerprint,
      status,
      params.endpoint ?? null,
      backend,
      trustLevel,
      firewallMode,
      capabilitiesJson,
      tagsJson,
      permissionsJson,
      metadataJson,
      params.connectedAt ?? null,
      params.lastSeenAt ?? null,
      nowMs,
      nowMs,
    );
}

export function touchNodeLastSeen(
  db: NexusDatabase,
  params: { id: string; lastSeenAt: number; endpoint?: string | null; capabilities?: string[]; tags?: string[] },
): void {
  if (params.capabilities || params.tags || params.endpoint !== undefined) {
    db.db
      .prepare(
        `UPDATE nodes
         SET
           last_seen_at = ?,
           endpoint = COALESCE(?, endpoint),
           capabilities_json = COALESCE(?, capabilities_json),
           tags_json = COALESCE(?, tags_json),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        params.lastSeenAt,
        params.endpoint ?? null,
        params.capabilities ? JSON.stringify(params.capabilities) : null,
        params.tags ? JSON.stringify(params.tags) : null,
        params.lastSeenAt,
        params.id,
      );
    return;
  }

  db.db
    .prepare("UPDATE nodes SET last_seen_at = ?, updated_at = ? WHERE id = ?")
    .run(params.lastSeenAt, params.lastSeenAt, params.id);
}

export function setNodeStatus(
  db: NexusDatabase,
  params: { id: string; status: NodeStatus; connectedAt?: number | null; nowMs?: number },
): void {
  const nowMs = params.nowMs ?? Date.now();
  db.db
    .prepare(
      `UPDATE nodes
       SET
         status = ?,
         connected_at = ?,
         updated_at = ?
       WHERE id = ?`,
    )
    .run(params.status, params.connectedAt ?? null, nowMs, params.id);
}

export function setNodeMetadata(
  db: NexusDatabase,
  params: { id: string; metadata: Record<string, unknown>; nowMs?: number },
): void {
  const nowMs = params.nowMs ?? Date.now();
  db.db
    .prepare(
      `UPDATE nodes
       SET
         metadata_json = ?,
         updated_at = ?
       WHERE id = ?`,
    )
    .run(JSON.stringify(params.metadata ?? {}), nowMs, params.id);
}

export function createNodeSession(
  db: NexusDatabase,
  params: {
    id: string;
    nodeId: string;
    startedAt: number;
    ipAddress?: string | null;
    capabilities?: string[];
  },
): void {
  db.db
    .prepare(
      `INSERT INTO node_sessions (
         id,
         node_id,
         started_at,
         ended_at,
         ip_address,
         capabilities_json
       ) VALUES (?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      params.id,
      params.nodeId,
      params.startedAt,
      params.ipAddress ?? null,
      JSON.stringify(params.capabilities ?? []),
    );
}

export function endNodeSession(db: NexusDatabase, params: { id: string; endedAt: number }): void {
  db.db
    .prepare(
      `UPDATE node_sessions
       SET ended_at = ?
       WHERE id = ?`,
    )
    .run(params.endedAt, params.id);
}
