import crypto from "node:crypto";

import type { NexusDatabase } from "../storage/database.js";
import {
  appendSecretAccessEvent,
  createSecretLease,
  getSecretLeaseById,
  getSecretProviderProfileById,
  setSecretLeaseStatus,
} from "../storage/secrets.js";
import { resolveSecretThroughBroker } from "./broker.js";
import { assertCredentialLocality } from "./locality.js";

export type ParsedSecretReference = {
  providerId: string;
  secretPath: string;
  field: string | null;
};

export type ResolvedSecretValue = {
  providerId: string;
  secretPath: string;
  secretClass: string;
  value: string;
  leaseId: string | null;
  expiresAt: number | null;
};

function isStrictSecretsMode(): boolean {
  const raw = (process.env.NEXUS_SECRETS_STRICT ?? "1").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "no");
}

function hashSecretPath(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function parseLeaseTtlMs(config: Record<string, unknown>): number | null {
  const raw = config.leaseTtlMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const ttl = Math.max(0, Math.floor(raw));
  return ttl > 0 ? ttl : null;
}

export function parseSecretReference(input: string): ParsedSecretReference | null {
  const raw = input.trim();
  if (!raw) return null;
  const unwrapped = raw.startsWith("{{") && raw.endsWith("}}")
    ? raw.slice(2, -2).trim()
    : raw;
  if (!unwrapped.startsWith("secret:")) return null;

  const body = unwrapped.slice("secret:".length).trim();
  if (!body) return null;
  const hashIndex = body.indexOf("#");
  const pathPart = hashIndex >= 0 ? body.slice(0, hashIndex) : body;
  const field = hashIndex >= 0 ? body.slice(hashIndex + 1).trim() : null;
  const slashIndex = pathPart.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= pathPart.length - 1) return null;
  const providerId = pathPart.slice(0, slashIndex).trim();
  const secretPath = pathPart.slice(slashIndex + 1).trim();
  if (!providerId || !secretPath) return null;

  return {
    providerId,
    secretPath,
    field: field && field.length > 0 ? field : null,
  };
}

function auditSecretAccess(params: {
  db: NexusDatabase | null;
  providerId?: string | null;
  traceId?: string | null;
  firewallSession?: string | null;
  actor?: string | null;
  secretPath: string;
  secretClass?: string | null;
  decision: "allow" | "deny" | "error";
  reason?: string | null;
  leaseId?: string | null;
  nowMs: number;
}): void {
  if (!params.db) return;
  appendSecretAccessEvent(params.db, {
    id: crypto.randomUUID(),
    providerProfileId: params.providerId ?? null,
    traceId: params.traceId ?? null,
    firewallSession: params.firewallSession ?? null,
    actor: params.actor ?? null,
    secretPathHash: hashSecretPath(params.secretPath),
    secretClass: params.secretClass ?? null,
    decision: params.decision,
    reason: params.reason ?? null,
    leaseId: params.leaseId ?? null,
    nowMs: params.nowMs,
  });
}

export async function resolveSecretReference(params: {
  db?: NexusDatabase | null;
  stateDir: string;
  reference: string;
  traceId?: string | null;
  firewallSession?: string | null;
  actor?: string | null;
  nowMs?: number;
}): Promise<ResolvedSecretValue> {
  const strictMode = isStrictSecretsMode();
  const parsed = parseSecretReference(params.reference);
  const nowMs = params.nowMs ?? Date.now();
  if (!parsed) {
    throw new Error(`invalid_secret_reference:${params.reference}`);
  }
  assertCredentialLocality({
    credentialId: parsed.secretPath,
    operation: "resolve",
  });
  const db = params.db ?? null;
  if (!db && strictMode) {
    throw new Error("secret_resolution_requires_database_in_strict_mode");
  }

  const profile = db ? getSecretProviderProfileById(db, parsed.providerId) : null;
  if (!profile || !profile.enabled) {
    auditSecretAccess({
      db,
      providerId: null,
      traceId: params.traceId,
      firewallSession: params.firewallSession,
      actor: params.actor,
      secretPath: `${parsed.providerId}/${parsed.secretPath}`,
      secretClass: null,
      decision: strictMode ? "deny" : "error",
      reason: `provider_missing_or_disabled:${parsed.providerId}`,
      nowMs,
    });
    if (strictMode) {
      throw new Error(`secret_provider_missing_or_disabled:${parsed.providerId}`);
    }
    throw new Error(`secret_provider_unavailable:${parsed.providerId}`);
  }

  const field = parsed.field?.toLowerCase() === "username" ? "username" : "password";
  let value: string;
  let secretClass = "credential";
  let remoteLeaseId: string | null = null;
  let remoteExpiresAt: number | null = null;
  let resolveReason = "resolved";
  try {
    const resolved = await resolveSecretThroughBroker({
      profile,
      stateDir: params.stateDir,
      secretPath: parsed.secretPath,
      field,
      strictMode,
      traceId: params.traceId,
      firewallSession: params.firewallSession,
      actor: params.actor,
    });
    value = resolved.value;
    secretClass = resolved.secretClass;
    remoteLeaseId = resolved.leaseId;
    remoteExpiresAt = resolved.expiresAt;
    resolveReason = resolved.reason;
  } catch (err) {
    auditSecretAccess({
      db,
      providerId: profile.id,
      traceId: params.traceId,
      firewallSession: params.firewallSession,
      actor: params.actor,
      secretPath: `${profile.id}/${parsed.secretPath}`,
      secretClass: profile.kind === "local_file" ? "credential" : "external",
      decision: strictMode ? "deny" : "error",
      reason: err instanceof Error ? err.message : String(err),
      nowMs,
    });
    throw err;
  }

  let leaseId: string | null = null;
  let expiresAt: number | null = null;
  const leaseTtlMs = parseLeaseTtlMs(profile.config);
  if (db) {
    leaseId = crypto.randomUUID();
    expiresAt = remoteExpiresAt ?? (leaseTtlMs ? nowMs + leaseTtlMs : null);
    createSecretLease(db, {
      id: leaseId,
      providerProfileId: profile.id,
      leaseRef: `${profile.id}/${parsed.secretPath}`,
      secretClass,
      status: "active",
      issuedAt: nowMs,
      expiresAt,
      traceId: params.traceId ?? null,
      metadata: {
        field,
        remoteLeaseId,
      },
    });
  }

  auditSecretAccess({
    db,
    providerId: profile.id,
    traceId: params.traceId,
    firewallSession: params.firewallSession,
    actor: params.actor,
    secretPath: `${profile.id}/${parsed.secretPath}`,
    secretClass,
    decision: "allow",
    reason: resolveReason,
    leaseId,
    nowMs,
  });

  return {
    providerId: profile.id,
    secretPath: parsed.secretPath,
    secretClass,
    value,
    leaseId,
    expiresAt,
  };
}

export function revokeSecretLease(params: { db: NexusDatabase; leaseId: string; nowMs?: number }): boolean {
  return setSecretLeaseStatus(params.db, {
    id: params.leaseId,
    status: "revoked",
    nowMs: params.nowMs,
  });
}

export function isSecretLeaseActive(params: { db: NexusDatabase; leaseId: string; nowMs?: number }): boolean {
  const row = getSecretLeaseById(params.db, params.leaseId);
  if (!row) return false;
  if (row.status !== "active") return false;
  const nowMs = params.nowMs ?? Date.now();
  if (row.expiresAt != null && row.expiresAt <= nowMs) return false;
  return true;
}
