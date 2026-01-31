import crypto from "node:crypto";

import type { NexusDatabase } from "../storage/database.js";

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

export function createPairingRequest(db: NexusDatabase, params: {
  channel: string;
  senderKey: string;
  nowMs: number;
  ttlMs: number;
  maxPending: number;
}): { created: boolean; code?: string } {
  pruneExpiredPairingRequests(db, params.nowMs);

  const existing = db.db
    .prepare("SELECT code FROM pairing_requests WHERE channel = ? AND sender_key = ?")
    .get(params.channel, params.senderKey) as { code: string } | undefined;
  if (existing?.code) return { created: false, code: existing.code };

  const pendingCount = db.db
    .prepare("SELECT COUNT(*) as c FROM pairing_requests WHERE channel = ?")
    .get(params.channel) as { c: number } | undefined;
  if ((pendingCount?.c ?? 0) >= params.maxPending) return { created: false };

  const code = randomPairingCode();
  db.db
    .prepare("INSERT INTO pairing_requests (code, channel, sender_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run(code, params.channel, params.senderKey, params.nowMs, params.nowMs + params.ttlMs);
  return { created: true, code };
}

export function approvePairingRequest(db: NexusDatabase, params: { channel: string; code: string; nowMs: number }): {
  ok: boolean;
  senderKey?: string;
} {
  pruneExpiredPairingRequests(db, params.nowMs);
  const row = db.db
    .prepare("SELECT sender_key FROM pairing_requests WHERE channel = ? AND code = ?")
    .get(params.channel, params.code) as { sender_key: string } | undefined;
  if (!row?.sender_key) return { ok: false };
  db.db.prepare("DELETE FROM pairing_requests WHERE channel = ? AND code = ?").run(params.channel, params.code);
  return { ok: true, senderKey: row.sender_key };
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

