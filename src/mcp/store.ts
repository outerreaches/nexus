import crypto from "node:crypto";

import type { NexusDatabase } from "../storage/database.js";

export type McpServerTransport = "stdio";
export type McpTrustLevel = "read_only" | "mutating";

export type McpServerRecord = {
  id: string;
  label: string;
  transport: McpServerTransport;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  enabled: boolean;
  active: boolean;
  trustLevel: McpTrustLevel;
  capabilityTags: string[];
  timeoutMs: number;
  maxConcurrency: number;
  idleTtlMs: number;
  lastDiscoveredTools: string[];
  lastError: string | null;
  lastErrorAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type McpProfileRecord = {
  id: string;
  name: string;
  serverId: string;
  description: string;
  toolNames: string[];
  hidden: boolean;
  ephemeral: boolean;
  enabled: boolean;
  llmPrimaryProvider: string | null;
  llmPrimaryModel: string | null;
  llmFallbackProvider: string | null;
  llmFallbackModel: string | null;
  llmDisableFallback: boolean;
  budgetMaxToolCalls: number | null;
  budgetMaxIterations: number | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
};

export type McpGrantStatus = "active" | "revoked" | "expired";

export type McpGrantRecord = {
  id: string;
  profileId: string;
  serverId: string;
  targetPreset: string;
  toolNames: string[];
  maxCalls: number | null;
  callCount: number;
  expiresAt: number | null;
  status: McpGrantStatus;
  runId: string | null;
  parentRunId: string | null;
  issuedByAgentId: string | null;
  issuedByRunId: string | null;
  revokeReason: string | null;
  revokedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type McpServerRow = {
  id: string;
  label: string;
  transport: string;
  command: string | null;
  args_json: string;
  env_json: string;
  url: string | null;
  headers_json: string;
  enabled: number;
  active: number;
  trust_level: string;
  capability_tags_json: string;
  timeout_ms: number;
  max_concurrency: number;
  idle_ttl_ms: number;
  last_discovered_tools_json: string;
  last_error: string | null;
  last_error_at: number | null;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
};

type McpProfileRow = {
  id: string;
  name: string;
  server_id: string;
  description: string;
  tool_names_json: string;
  hidden: number;
  ephemeral: number;
  enabled: number;
  llm_primary_provider: string | null;
  llm_primary_model: string | null;
  llm_fallback_provider: string | null;
  llm_fallback_model: string | null;
  llm_disable_fallback: number;
  budget_max_tool_calls: number | null;
  budget_max_iterations: number | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
};

type McpGrantRow = {
  id: string;
  profile_id: string;
  server_id: string;
  target_preset: string;
  tool_names_json: string;
  max_calls: number | null;
  call_count: number;
  expires_at: number | null;
  status: string;
  run_id: string | null;
  parent_run_id: string | null;
  issued_by_agent_id: string | null;
  issued_by_run_id: string | null;
  revoke_reason: string | null;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
};

export type McpServerCreateInput = {
  id?: string;
  label: string;
  transport: McpServerTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  active?: boolean;
  trustLevel?: McpTrustLevel;
  capabilityTags?: string[];
  timeoutMs?: number;
  maxConcurrency?: number;
  idleTtlMs?: number;
};

export type McpServerUpdateInput = {
  label?: string;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  active?: boolean;
  trustLevel?: McpTrustLevel;
  capabilityTags?: string[];
  timeoutMs?: number;
  maxConcurrency?: number;
  idleTtlMs?: number;
};

export type McpProfileCreateInput = {
  id?: string;
  name: string;
  serverId: string;
  description?: string;
  toolNames: string[];
  hidden?: boolean;
  ephemeral?: boolean;
  enabled?: boolean;
  llmPrimaryProvider?: string | null;
  llmPrimaryModel?: string | null;
  llmFallbackProvider?: string | null;
  llmFallbackModel?: string | null;
  llmDisableFallback?: boolean;
  budgetMaxToolCalls?: number | null;
  budgetMaxIterations?: number | null;
};

export type McpProfileUpdateInput = {
  name?: string;
  description?: string;
  toolNames?: string[];
  hidden?: boolean;
  ephemeral?: boolean;
  enabled?: boolean;
  llmPrimaryProvider?: string | null;
  llmPrimaryModel?: string | null;
  llmFallbackProvider?: string | null;
  llmFallbackModel?: string | null;
  llmDisableFallback?: boolean;
  budgetMaxToolCalls?: number | null;
  budgetMaxIterations?: number | null;
};

export type McpGrantCreateInput = {
  id?: string;
  profileId: string;
  serverId: string;
  targetPreset: string;
  toolNames: string[];
  maxCalls?: number | null;
  expiresAt?: number | null;
  runId?: string | null;
  parentRunId?: string | null;
  issuedByAgentId?: string | null;
  issuedByRunId?: string | null;
};

function randomId(prefix: string): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(10);
  let out = prefix;
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function parseStringArray(raw: string, fallback: string[] = []): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    return parsed.filter((v) => typeof v === "string");
  } catch {
    return fallback;
  }
}

function parseStringMap(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === "string" && typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function mapServerRow(row: McpServerRow): McpServerRecord {
  const transport = row.transport === "stdio" ? "stdio" : "stdio";
  const trustLevel = row.trust_level === "mutating" ? "mutating" : "read_only";
  return {
    id: row.id,
    label: row.label,
    transport,
    command: row.command,
    args: parseStringArray(row.args_json),
    env: parseStringMap(row.env_json),
    url: row.url,
    headers: parseStringMap(row.headers_json),
    enabled: row.enabled === 1,
    active: row.active === 1,
    trustLevel,
    capabilityTags: parseStringArray(row.capability_tags_json),
    timeoutMs: row.timeout_ms,
    maxConcurrency: row.max_concurrency,
    idleTtlMs: row.idle_ttl_ms,
    lastDiscoveredTools: parseStringArray(row.last_discovered_tools_json),
    lastError: row.last_error,
    lastErrorAt: row.last_error_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProfileRow(row: McpProfileRow): McpProfileRecord {
  return {
    id: row.id,
    name: row.name,
    serverId: row.server_id,
    description: row.description,
    toolNames: parseStringArray(row.tool_names_json),
    hidden: row.hidden === 1,
    ephemeral: row.ephemeral === 1,
    enabled: row.enabled === 1,
    llmPrimaryProvider: row.llm_primary_provider,
    llmPrimaryModel: row.llm_primary_model,
    llmFallbackProvider: row.llm_fallback_provider,
    llmFallbackModel: row.llm_fallback_model,
    llmDisableFallback: row.llm_disable_fallback === 1,
    budgetMaxToolCalls: row.budget_max_tool_calls,
    budgetMaxIterations: row.budget_max_iterations,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

function mapGrantRow(row: McpGrantRow): McpGrantRecord {
  const status: McpGrantStatus =
    row.status === "revoked"
      ? "revoked"
      : row.status === "expired"
        ? "expired"
        : "active";
  return {
    id: row.id,
    profileId: row.profile_id,
    serverId: row.server_id,
    targetPreset: row.target_preset,
    toolNames: parseStringArray(row.tool_names_json),
    maxCalls: row.max_calls,
    callCount: row.call_count,
    expiresAt: row.expires_at,
    status,
    runId: row.run_id,
    parentRunId: row.parent_run_id,
    issuedByAgentId: row.issued_by_agent_id,
    issuedByRunId: row.issued_by_run_id,
    revokeReason: row.revoke_reason,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value as number)));
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function listMcpServers(db: NexusDatabase, opts: { includeDisabled?: boolean } = {}): McpServerRecord[] {
  const includeDisabled = opts.includeDisabled ?? true;
  const rows = includeDisabled
    ? db.db.prepare("SELECT * FROM mcp_servers ORDER BY updated_at DESC").all() as McpServerRow[]
    : db.db.prepare("SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY updated_at DESC").all() as McpServerRow[];
  return rows.map(mapServerRow);
}

export function getMcpServer(db: NexusDatabase, id: string): McpServerRecord | null {
  const row = db.db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as McpServerRow | undefined;
  return row ? mapServerRow(row) : null;
}

export function createMcpServer(db: NexusDatabase, input: McpServerCreateInput, nowMs: number): McpServerRecord {
  const id = (input.id ?? randomId("MCP")).trim();
  const record = {
    id,
    label: input.label.trim(),
    transport: input.transport,
    command: input.command?.trim() || null,
    args: (input.args ?? []).map((v) => String(v)),
    env: input.env ?? {},
    enabled: input.enabled ?? true,
    active: input.active ?? false,
    trustLevel: input.trustLevel ?? "read_only",
    capabilityTags: (input.capabilityTags ?? []).map((v) => String(v)).filter(Boolean),
    timeoutMs: clampInt(input.timeoutMs, 45_000, 5_000, 600_000),
    maxConcurrency: clampInt(input.maxConcurrency, 2, 1, 16),
    idleTtlMs: clampInt(input.idleTtlMs, 600_000, 10_000, 86_400_000),
  };
  db.db
    .prepare(
      `INSERT INTO mcp_servers
       (id, label, transport, command, args_json, env_json, enabled, active, trust_level, capability_tags_json, timeout_ms, max_concurrency, idle_ttl_ms, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.id,
      record.label,
      record.transport,
      record.command,
      toJson(record.args),
      toJson(record.env),
      record.enabled ? 1 : 0,
      record.active ? 1 : 0,
      record.trustLevel,
      toJson(record.capabilityTags),
      record.timeoutMs,
      record.maxConcurrency,
      record.idleTtlMs,
      nowMs,
      nowMs,
    );
  const created = getMcpServer(db, record.id);
  if (!created) throw new Error("failed to create MCP server");
  return created;
}

export function updateMcpServer(db: NexusDatabase, id: string, patch: McpServerUpdateInput, nowMs: number): McpServerRecord | null {
  const current = getMcpServer(db, id);
  if (!current) return null;
  const next = {
    label: patch.label !== undefined ? patch.label.trim() : current.label,
    command: patch.command !== undefined ? (patch.command?.trim() || null) : current.command,
    args: patch.args !== undefined ? patch.args.map((v) => String(v)) : current.args,
    env: patch.env !== undefined ? patch.env : current.env,
    enabled: patch.enabled ?? current.enabled,
    active: patch.active ?? current.active,
    trustLevel: patch.trustLevel ?? current.trustLevel,
    capabilityTags: patch.capabilityTags !== undefined
      ? patch.capabilityTags.map((v) => String(v)).filter(Boolean)
      : current.capabilityTags,
    timeoutMs: patch.timeoutMs !== undefined ? clampInt(patch.timeoutMs, current.timeoutMs, 5_000, 600_000) : current.timeoutMs,
    maxConcurrency: patch.maxConcurrency !== undefined
      ? clampInt(patch.maxConcurrency, current.maxConcurrency, 1, 16)
      : current.maxConcurrency,
    idleTtlMs: patch.idleTtlMs !== undefined ? clampInt(patch.idleTtlMs, current.idleTtlMs, 10_000, 86_400_000) : current.idleTtlMs,
  };
  db.db
    .prepare(
      `UPDATE mcp_servers
       SET label = ?, command = ?, args_json = ?, env_json = ?, enabled = ?, active = ?, trust_level = ?, capability_tags_json = ?,
           timeout_ms = ?, max_concurrency = ?, idle_ttl_ms = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      next.label,
      next.command,
      toJson(next.args),
      toJson(next.env),
      next.enabled ? 1 : 0,
      next.active ? 1 : 0,
      next.trustLevel,
      toJson(next.capabilityTags),
      next.timeoutMs,
      next.maxConcurrency,
      next.idleTtlMs,
      nowMs,
      id,
    );
  return getMcpServer(db, id);
}

export function setMcpServerActive(db: NexusDatabase, id: string, active: boolean, nowMs: number): void {
  db.db.prepare("UPDATE mcp_servers SET active = ?, updated_at = ? WHERE id = ?").run(active ? 1 : 0, nowMs, id);
}

export function setMcpServerError(db: NexusDatabase, id: string, error: string | null, nowMs: number): void {
  db.db
    .prepare("UPDATE mcp_servers SET last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ?")
    .run(error, error ? nowMs : null, nowMs, id);
}

export function setMcpServerDiscoveredTools(db: NexusDatabase, id: string, tools: string[], nowMs: number): void {
  db.db
    .prepare("UPDATE mcp_servers SET last_discovered_tools_json = ?, updated_at = ? WHERE id = ?")
    .run(toJson(tools), nowMs, id);
}

export function touchMcpServerUsed(db: NexusDatabase, id: string, nowMs: number): void {
  db.db
    .prepare("UPDATE mcp_servers SET last_used_at = ?, updated_at = ? WHERE id = ?")
    .run(nowMs, nowMs, id);
}

export function deleteMcpServer(db: NexusDatabase, id: string): boolean {
  const res = db.db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
  return res.changes > 0;
}

export function listMcpProfiles(db: NexusDatabase, opts: { includeDisabled?: boolean } = {}): McpProfileRecord[] {
  const includeDisabled = opts.includeDisabled ?? true;
  const rows = includeDisabled
    ? db.db.prepare("SELECT * FROM mcp_profiles ORDER BY updated_at DESC").all() as McpProfileRow[]
    : db.db.prepare("SELECT * FROM mcp_profiles WHERE enabled = 1 ORDER BY updated_at DESC").all() as McpProfileRow[];
  return rows.map(mapProfileRow);
}

export function getMcpProfile(db: NexusDatabase, idOrName: string): McpProfileRecord | null {
  const row = db.db
    .prepare("SELECT * FROM mcp_profiles WHERE id = ? OR name = ? LIMIT 1")
    .get(idOrName, idOrName) as McpProfileRow | undefined;
  return row ? mapProfileRow(row) : null;
}

export function createMcpProfile(db: NexusDatabase, input: McpProfileCreateInput, nowMs: number): McpProfileRecord {
  const id = (input.id ?? randomId("MPP")).trim();
  db.db
    .prepare(
      `INSERT INTO mcp_profiles
       (id, name, server_id, description, tool_names_json, hidden, ephemeral, enabled, llm_primary_provider, llm_primary_model, llm_fallback_provider, llm_fallback_model, llm_disable_fallback, budget_max_tool_calls, budget_max_iterations, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.name.trim(),
      input.serverId.trim(),
      input.description?.trim() ?? "",
      toJson(input.toolNames),
      (input.hidden ?? true) ? 1 : 0,
      (input.ephemeral ?? true) ? 1 : 0,
      (input.enabled ?? true) ? 1 : 0,
      input.llmPrimaryProvider ?? null,
      input.llmPrimaryModel ?? null,
      input.llmFallbackProvider ?? null,
      input.llmFallbackModel ?? null,
      (input.llmDisableFallback ?? false) ? 1 : 0,
      input.budgetMaxToolCalls ?? null,
      input.budgetMaxIterations ?? null,
      nowMs,
      nowMs,
    );
  const created = getMcpProfile(db, id);
  if (!created) throw new Error("failed to create MCP profile");
  return created;
}

export function updateMcpProfile(db: NexusDatabase, idOrName: string, patch: McpProfileUpdateInput, nowMs: number): McpProfileRecord | null {
  const current = getMcpProfile(db, idOrName);
  if (!current) return null;
  const next = {
    name: patch.name !== undefined ? patch.name.trim() : current.name,
    description: patch.description !== undefined ? patch.description.trim() : current.description,
    toolNames: patch.toolNames !== undefined ? patch.toolNames.map((v) => String(v)) : current.toolNames,
    hidden: patch.hidden ?? current.hidden,
    ephemeral: patch.ephemeral ?? current.ephemeral,
    enabled: patch.enabled ?? current.enabled,
    llmPrimaryProvider: Object.prototype.hasOwnProperty.call(patch, "llmPrimaryProvider")
      ? patch.llmPrimaryProvider ?? null
      : current.llmPrimaryProvider,
    llmPrimaryModel: Object.prototype.hasOwnProperty.call(patch, "llmPrimaryModel")
      ? patch.llmPrimaryModel ?? null
      : current.llmPrimaryModel,
    llmFallbackProvider: Object.prototype.hasOwnProperty.call(patch, "llmFallbackProvider")
      ? patch.llmFallbackProvider ?? null
      : current.llmFallbackProvider,
    llmFallbackModel: Object.prototype.hasOwnProperty.call(patch, "llmFallbackModel")
      ? patch.llmFallbackModel ?? null
      : current.llmFallbackModel,
    llmDisableFallback: patch.llmDisableFallback ?? current.llmDisableFallback,
    budgetMaxToolCalls: Object.prototype.hasOwnProperty.call(patch, "budgetMaxToolCalls")
      ? patch.budgetMaxToolCalls ?? null
      : current.budgetMaxToolCalls,
    budgetMaxIterations: Object.prototype.hasOwnProperty.call(patch, "budgetMaxIterations")
      ? patch.budgetMaxIterations ?? null
      : current.budgetMaxIterations,
  };
  db.db
    .prepare(
      `UPDATE mcp_profiles
       SET name = ?, description = ?, tool_names_json = ?, hidden = ?, ephemeral = ?, enabled = ?,
           llm_primary_provider = ?, llm_primary_model = ?, llm_fallback_provider = ?, llm_fallback_model = ?, llm_disable_fallback = ?,
           budget_max_tool_calls = ?, budget_max_iterations = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      next.name,
      next.description,
      toJson(next.toolNames),
      next.hidden ? 1 : 0,
      next.ephemeral ? 1 : 0,
      next.enabled ? 1 : 0,
      next.llmPrimaryProvider,
      next.llmPrimaryModel,
      next.llmFallbackProvider,
      next.llmFallbackModel,
      next.llmDisableFallback ? 1 : 0,
      next.budgetMaxToolCalls,
      next.budgetMaxIterations,
      nowMs,
      current.id,
    );
  return getMcpProfile(db, current.id);
}

export function touchMcpProfileUsed(db: NexusDatabase, idOrName: string, nowMs: number): void {
  const current = getMcpProfile(db, idOrName);
  if (!current) return;
  db.db
    .prepare("UPDATE mcp_profiles SET last_used_at = ?, updated_at = ? WHERE id = ?")
    .run(nowMs, nowMs, current.id);
}

export function deleteMcpProfile(db: NexusDatabase, idOrName: string): boolean {
  const current = getMcpProfile(db, idOrName);
  if (!current) return false;
  const res = db.db.prepare("DELETE FROM mcp_profiles WHERE id = ?").run(current.id);
  return res.changes > 0;
}

export function listMcpGrants(
  db: NexusDatabase,
  opts: { includeExpired?: boolean; includeRevoked?: boolean } = {},
): McpGrantRecord[] {
  const includeExpired = opts.includeExpired ?? false;
  const includeRevoked = opts.includeRevoked ?? false;
  const clauses: string[] = [];
  if (!includeRevoked) clauses.push("status != 'revoked'");
  if (!includeExpired) {
    clauses.push("(status != 'expired' AND (expires_at IS NULL OR expires_at > strftime('%s','now') * 1000))");
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.db.prepare(`SELECT * FROM mcp_grants ${where} ORDER BY updated_at DESC`).all() as McpGrantRow[];
  return rows.map(mapGrantRow);
}

export function getMcpGrant(db: NexusDatabase, id: string): McpGrantRecord | null {
  const row = db.db.prepare("SELECT * FROM mcp_grants WHERE id = ?").get(id) as McpGrantRow | undefined;
  return row ? mapGrantRow(row) : null;
}

export function createMcpGrant(db: NexusDatabase, input: McpGrantCreateInput, nowMs: number): McpGrantRecord {
  const id = (input.id ?? randomId("MPG")).trim();
  const toolNames = Array.from(new Set(input.toolNames.map((name) => name.trim()).filter(Boolean)));
  db.db
    .prepare(
      `INSERT INTO mcp_grants
       (id, profile_id, server_id, target_preset, tool_names_json, max_calls, call_count, expires_at, status, run_id, parent_run_id, issued_by_agent_id, issued_by_run_id, revoke_reason, revoked_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'active', ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .run(
      id,
      input.profileId.trim(),
      input.serverId.trim(),
      input.targetPreset.trim(),
      toJson(toolNames),
      input.maxCalls ?? null,
      input.expiresAt ?? null,
      input.runId ?? null,
      input.parentRunId ?? null,
      input.issuedByAgentId ?? null,
      input.issuedByRunId ?? null,
      nowMs,
      nowMs,
    );
  const created = getMcpGrant(db, id);
  if (!created) throw new Error("failed to create MCP grant");
  return created;
}

export function bindMcpGrantToRun(
  db: NexusDatabase,
  grantId: string,
  params: { runId: string; parentRunId?: string | null },
  nowMs: number,
): McpGrantRecord | null {
  db.db
    .prepare("UPDATE mcp_grants SET run_id = ?, parent_run_id = COALESCE(?, parent_run_id), updated_at = ? WHERE id = ?")
    .run(params.runId, params.parentRunId ?? null, nowMs, grantId);
  return getMcpGrant(db, grantId);
}

export function revokeMcpGrant(db: NexusDatabase, grantId: string, reason: string | null, nowMs: number): McpGrantRecord | null {
  db.db
    .prepare("UPDATE mcp_grants SET status = 'revoked', revoke_reason = ?, revoked_at = ?, updated_at = ? WHERE id = ?")
    .run(reason, nowMs, nowMs, grantId);
  return getMcpGrant(db, grantId);
}

export function expireMcpGrant(db: NexusDatabase, grantId: string, nowMs: number): McpGrantRecord | null {
  db.db
    .prepare("UPDATE mcp_grants SET status = 'expired', updated_at = ? WHERE id = ?")
    .run(nowMs, grantId);
  return getMcpGrant(db, grantId);
}

export function incrementMcpGrantCallCount(db: NexusDatabase, grantId: string, nowMs: number): McpGrantRecord | null {
  db.db
    .prepare("UPDATE mcp_grants SET call_count = call_count + 1, updated_at = ? WHERE id = ?")
    .run(nowMs, grantId);
  return getMcpGrant(db, grantId);
}

export function appendMcpEvent(
  db: NexusDatabase,
  params: {
    id?: string;
    serverId?: string | null;
    profileId?: string | null;
    kind: string;
    payload: unknown;
    nowMs: number;
  },
): void {
  db.db
    .prepare(
      "INSERT INTO mcp_events (id, server_id, profile_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      params.id ?? randomId("MPE"),
      params.serverId ?? null,
      params.profileId ?? null,
      params.kind,
      toJson(params.payload ?? {}),
      params.nowMs,
    );
}
