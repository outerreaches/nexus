import crypto from "node:crypto";

import type { NexusDatabase } from "./database.js";

export type HttpAuthSessionRecord = {
  sessionHash: string;
  csrfToken: string;
  userLabel: string | null;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
};

export function hashHttpAuthSessionToken(sessionToken: string): string {
  return crypto.createHash("sha256").update(sessionToken).digest("hex");
}

export function createHttpAuthSession(params: {
  db: NexusDatabase;
  sessionToken: string;
  csrfToken: string;
  userLabel?: string | null;
  nowMs: number;
  ttlMs: number;
}): HttpAuthSessionRecord {
  const sessionHash = hashHttpAuthSessionToken(params.sessionToken);
  const expiresAt = params.nowMs + Math.max(1_000, params.ttlMs);
  params.db.db
    .prepare(
      `INSERT INTO http_auth_sessions (
         session_hash,
         csrf_token,
         user_label,
         created_at,
         expires_at,
         last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionHash,
      params.csrfToken,
      params.userLabel ?? null,
      params.nowMs,
      expiresAt,
      params.nowMs,
    );
  return {
    sessionHash,
    csrfToken: params.csrfToken,
    userLabel: params.userLabel ?? null,
    createdAt: params.nowMs,
    expiresAt,
    lastSeenAt: params.nowMs,
    revokedAt: null,
  };
}

export function getHttpAuthSessionByToken(params: {
  db: NexusDatabase;
  sessionToken: string;
  nowMs: number;
}): HttpAuthSessionRecord | null {
  const sessionHash = hashHttpAuthSessionToken(params.sessionToken);
  const row = params.db.db
    .prepare(
      `SELECT
         session_hash,
         csrf_token,
         user_label,
         created_at,
         expires_at,
         last_seen_at,
         revoked_at
       FROM http_auth_sessions
       WHERE session_hash = ?
         AND revoked_at IS NULL
         AND expires_at > ?
       LIMIT 1`,
    )
    .get(sessionHash, params.nowMs) as
    | {
      session_hash: string;
      csrf_token: string;
      user_label: string | null;
      created_at: number;
      expires_at: number;
      last_seen_at: number;
      revoked_at: number | null;
    }
    | undefined;
  if (!row) return null;
  return {
    sessionHash: row.session_hash,
    csrfToken: row.csrf_token,
    userLabel: row.user_label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

export function touchHttpAuthSession(params: {
  db: NexusDatabase;
  sessionToken: string;
  nowMs: number;
}): void {
  const sessionHash = hashHttpAuthSessionToken(params.sessionToken);
  params.db.db
    .prepare(
      `UPDATE http_auth_sessions
       SET last_seen_at = ?
       WHERE session_hash = ?
         AND revoked_at IS NULL`,
    )
    .run(params.nowMs, sessionHash);
}

export function revokeHttpAuthSession(params: {
  db: NexusDatabase;
  sessionToken: string;
  nowMs: number;
}): boolean {
  const sessionHash = hashHttpAuthSessionToken(params.sessionToken);
  const result = params.db.db
    .prepare(
      `UPDATE http_auth_sessions
       SET revoked_at = ?
       WHERE session_hash = ?
         AND revoked_at IS NULL`,
    )
    .run(params.nowMs, sessionHash);
  return result.changes > 0;
}

export function purgeHttpAuthSessions(params: {
  db: NexusDatabase;
  nowMs: number;
  revokedRetentionMs?: number;
}): number {
  const revokedCutoff = params.nowMs - Math.max(0, params.revokedRetentionMs ?? 24 * 60 * 60 * 1000);
  const result = params.db.db
    .prepare(
      `DELETE FROM http_auth_sessions
       WHERE expires_at <= ?
          OR (revoked_at IS NOT NULL AND revoked_at <= ?)`,
    )
    .run(params.nowMs, revokedCutoff);
  return result.changes;
}
