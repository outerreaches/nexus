import crypto from "node:crypto";

import type { NexusDatabase } from "../storage/database.js";

const MAX_PAIRING_CODE_INSERT_ATTEMPTS = 5;

function randomPairingCode(): string {
  // 8 chars, uppercase, no ambiguous chars (OpenClaw-style).
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function pruneExpiredPairingRequests(db: NexusDatabase, nowMs: number): void {
  db.db.prepare("DELETE FROM pairing_requests WHERE expires_at <= ?").run(nowMs);
}

export function listPairingRequests(db: NexusDatabase, params: { channel: string; nowMs: number }): Array<{
  code: string;
  senderKey: string;
  createdAt: number;
  expiresAt: number;
}> {
  pruneExpiredPairingRequests(db, params.nowMs);
  const rows = db.db
    .prepare("SELECT code, sender_key, created_at, expires_at FROM pairing_requests WHERE channel = ? ORDER BY created_at DESC")
    .all(params.channel) as { code: string; sender_key: string; created_at: number; expires_at: number }[];
  return rows.map((r) => ({ code: r.code, senderKey: r.sender_key, createdAt: r.created_at, expiresAt: r.expires_at }));
}

export function getPairingRequest(db: NexusDatabase, params: { channel: string; code: string; nowMs: number }): {
  code: string;
  senderKey: string;
  createdAt: number;
  expiresAt: number;
} | null {
  pruneExpiredPairingRequests(db, params.nowMs);
  const row = db.db
    .prepare("SELECT code, sender_key, created_at, expires_at FROM pairing_requests WHERE channel = ? AND code = ?")
    .get(params.channel, params.code) as { code: string; sender_key: string; created_at: number; expires_at: number } | undefined;
  if (!row) return null;
  return {
    code: row.code,
    senderKey: row.sender_key,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function isPairingCodeCollisionError(err: unknown): boolean {
  if (err instanceof Error && /UNIQUE constraint failed: pairing_requests\.code/i.test(err.message)) return true;
  if (typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
    return true;
  }
  return false;
}

export function createPairingRequest(db: NexusDatabase, params: {
  channel: string;
  senderKey: string;
  nowMs: number;
  ttlMs: number;
  maxPending: number;
}):
  | { status: "created"; code: string; expiresAt: number }
  | { status: "already_pending"; code: string; expiresAt: number }
  | { status: "max_pending" }
  | { status: "error"; reason: "code_generation_exhausted" } {
  pruneExpiredPairingRequests(db, params.nowMs);

  const existing = db.db
    .prepare("SELECT code, expires_at FROM pairing_requests WHERE channel = ? AND sender_key = ? ORDER BY created_at DESC LIMIT 1")
    .get(params.channel, params.senderKey) as { code: string; expires_at: number } | undefined;
  if (existing?.code) return { status: "already_pending", code: existing.code, expiresAt: existing.expires_at };

  const pendingCount = db.db
    .prepare("SELECT COUNT(*) as c FROM pairing_requests WHERE channel = ?")
    .get(params.channel) as { c: number } | undefined;
  if ((pendingCount?.c ?? 0) >= params.maxPending) return { status: "max_pending" };

  const expiresAt = params.nowMs + params.ttlMs;
  const insert = db.db.prepare("INSERT INTO pairing_requests (code, channel, sender_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?)");
  for (let attempt = 1; attempt <= MAX_PAIRING_CODE_INSERT_ATTEMPTS; attempt += 1) {
    const code = randomPairingCode();
    try {
      insert.run(code, params.channel, params.senderKey, params.nowMs, expiresAt);
      return { status: "created", code, expiresAt };
    } catch (err) {
      if (isPairingCodeCollisionError(err)) continue;
      throw err;
    }
  }
  return { status: "error", reason: "code_generation_exhausted" };
}

export function approvePairingRequest(db: NexusDatabase, params: { channel: string; code: string; nowMs: number }): {
  ok: boolean;
  senderKey?: string;
} {
  const select = db.db.prepare("SELECT sender_key FROM pairing_requests WHERE channel = ? AND code = ? AND expires_at > ?");
  const remove = db.db.prepare("DELETE FROM pairing_requests WHERE channel = ? AND code = ?");
  const tx = db.db.transaction((channel: string, code: string, nowMs: number) => {
    pruneExpiredPairingRequests(db, nowMs);
    const row = select.get(channel, code, nowMs) as { sender_key: string } | undefined;
    if (!row?.sender_key) return { ok: false as const };
    const deleted = remove.run(channel, code);
    if ((deleted.changes ?? 0) !== 1) return { ok: false as const };
    return { ok: true as const, senderKey: row.sender_key };
  });
  return tx(params.channel, params.code, params.nowMs);
}

export function isTelegramUserAllowed(db: NexusDatabase, params: { userId: number; staticAllowFrom: number[]; allowAll: boolean }): boolean {
  if (params.allowAll && params.staticAllowFrom.length === 0) return true;
  if (params.staticAllowFrom.includes(params.userId)) return true;
  const row = db.db.prepare("SELECT user_id FROM telegram_allowlist WHERE user_id = ?").get(params.userId) as
    | { user_id: number }
    | undefined;
  return !!row?.user_id;
}

export function allowTelegramUser(db: NexusDatabase, params: { userId: number; nowMs: number; note?: string }): void {
  db.db
    .prepare("INSERT OR REPLACE INTO telegram_allowlist (user_id, added_at, added_by, note) VALUES (?, ?, ?, ?)")
    .run(params.userId, params.nowMs, null, params.note ?? null);
}
