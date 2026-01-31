import crypto from "node:crypto";

import type { NexusDatabase } from "./database.js";

export type HumanActionStatus = "pending" | "fulfilled" | "canceled" | "expired";
export type HumanActionKind = "input" | "confirm";

export type HumanActionRow = {
  id: string;
  sessionId: string | null;
  channel: string | null;
  channelKey: string | null;
  agentId: string | null;
  kind: HumanActionKind;
  prompt: string;
  status: HumanActionStatus;
  createdAt: number;
  expiresAt: number | null;
  respondedAt: number | null;
  respondedByChannel: string | null;
  respondedByKey: string | null;
  responseText: string | null;
  metadataJson: string | null;
};

function randomActionId(): string {
  // Uppercase, no ambiguous chars (OpenClaw-style).
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(10);
  let out = "HA";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function mapRow(r: any): HumanActionRow {
  return {
    id: String(r.id),
    sessionId: r.session_id ? String(r.session_id) : null,
    channel: r.channel ? String(r.channel) : null,
    channelKey: r.channel_key ? String(r.channel_key) : null,
    agentId: r.agent_id ? String(r.agent_id) : null,
    kind: String(r.kind) as HumanActionKind,
    prompt: String(r.prompt ?? ""),
    status: String(r.status) as HumanActionStatus,
    createdAt: Number(r.created_at ?? 0),
    expiresAt: r.expires_at === null || r.expires_at === undefined ? null : Number(r.expires_at),
    respondedAt: r.responded_at === null || r.responded_at === undefined ? null : Number(r.responded_at),
    respondedByChannel: r.responded_by_channel ? String(r.responded_by_channel) : null,
    respondedByKey: r.responded_by_key ? String(r.responded_by_key) : null,
    responseText: r.response_text === null || r.response_text === undefined ? null : String(r.response_text),
    metadataJson: r.metadata_json === null || r.metadata_json === undefined ? null : String(r.metadata_json),
  };
}

export function pruneExpiredHumanActions(db: NexusDatabase, nowMs: number): void {
  db.db
    .prepare("UPDATE human_actions SET status = 'expired' WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?")
    .run(nowMs);
}

export function createHumanAction(db: NexusDatabase, params: {
  nowMs: number;
  ttlMs?: number;
  sessionId?: string;
  channel?: string;
  channelKey?: string;
  agentId?: string;
  kind: HumanActionKind;
  prompt: string;
  metadata?: Record<string, unknown>;
}): HumanActionRow {
  pruneExpiredHumanActions(db, params.nowMs);

  const ttlMs = typeof params.ttlMs === "number" && Number.isFinite(params.ttlMs) ? params.ttlMs : 10 * 60_000;
  const expiresAt = ttlMs > 0 ? params.nowMs + ttlMs : null;
  const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null;

  for (let attempt = 0; attempt < 4; attempt++) {
    const id = randomActionId();
    try {
      db.db
        .prepare(
          "INSERT INTO human_actions (id, session_id, channel, channel_key, agent_id, kind, prompt, status, created_at, expires_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
        )
        .run(
          id,
          params.sessionId ?? null,
          params.channel ?? null,
          params.channelKey ?? null,
          params.agentId ?? null,
          params.kind,
          params.prompt,
          params.nowMs,
          expiresAt,
          metadataJson,
        );

      const row = db.db.prepare("SELECT * FROM human_actions WHERE id = ?").get(id);
      return mapRow(row);
    } catch (e) {
      // Retry on ID collision; otherwise rethrow.
      if (e instanceof Error && /UNIQUE constraint failed: human_actions\.id/i.test(e.message)) continue;
      throw e;
    }
  }

  throw new Error("Failed to create human action request (id collision).");
}

export function getHumanAction(db: NexusDatabase, params: { id: string; nowMs: number }): HumanActionRow | null {
  pruneExpiredHumanActions(db, params.nowMs);
  const row = db.db.prepare("SELECT * FROM human_actions WHERE id = ?").get(params.id);
  return row ? mapRow(row) : null;
}

export function listHumanActions(db: NexusDatabase, params: {
  nowMs: number;
  status?: HumanActionStatus;
  sessionId?: string;
  limit?: number;
}): HumanActionRow[] {
  pruneExpiredHumanActions(db, params.nowMs);
  const limit = typeof params.limit === "number" && Number.isFinite(params.limit) ? Math.max(1, Math.min(200, Math.floor(params.limit))) : 50;

  const where: string[] = [];
  const args: any[] = [];
  if (params.status) {
    where.push("status = ?");
    args.push(params.status);
  }
  if (params.sessionId) {
    where.push("session_id = ?");
    args.push(params.sessionId);
  }

  const sql = `SELECT * FROM human_actions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`;
  const rows = db.db.prepare(sql).all(...args, limit);
  return (rows as any[]).map(mapRow);
}

export function fulfillHumanAction(db: NexusDatabase, params: {
  id: string;
  responseText: string;
  respondedByChannel?: string;
  respondedByKey?: string;
  nowMs: number;
}): { ok: boolean; status?: HumanActionStatus; error?: string } {
  pruneExpiredHumanActions(db, params.nowMs);

  const row = db.db.prepare("SELECT status FROM human_actions WHERE id = ?").get(params.id) as { status: HumanActionStatus } | undefined;
  if (!row?.status) return { ok: false, error: "not_found" };
  if (row.status !== "pending") return { ok: false, status: row.status, error: "not_pending" };

  db.db
    .prepare(
      "UPDATE human_actions SET status = 'fulfilled', responded_at = ?, responded_by_channel = ?, responded_by_key = ?, response_text = ? WHERE id = ?",
    )
    .run(params.nowMs, params.respondedByChannel ?? null, params.respondedByKey ?? null, params.responseText, params.id);

  return { ok: true, status: "fulfilled" };
}

export function cancelHumanAction(db: NexusDatabase, params: { id: string; nowMs: number }): { ok: boolean; status?: HumanActionStatus } {
  pruneExpiredHumanActions(db, params.nowMs);
  const row = db.db.prepare("SELECT status FROM human_actions WHERE id = ?").get(params.id) as { status: HumanActionStatus } | undefined;
  if (!row?.status) return { ok: false };
  if (row.status !== "pending") return { ok: false, status: row.status };
  db.db.prepare("UPDATE human_actions SET status = 'canceled', responded_at = ? WHERE id = ?").run(params.nowMs, params.id);
  return { ok: true, status: "canceled" };
}

export function getHumanActionResponseForTyping(db: NexusDatabase, params: { id: string; nowMs: number }): string {
  pruneExpiredHumanActions(db, params.nowMs);
  const row = db.db.prepare("SELECT status, response_text FROM human_actions WHERE id = ?").get(params.id) as
    | { status: HumanActionStatus; response_text: string | null }
    | undefined;
  if (!row?.status) throw new Error(`Unknown human action id: ${params.id}`);
  if (row.status !== "fulfilled") throw new Error(`Human action ${params.id} is not fulfilled (status=${row.status}).`);
  const v = row.response_text ?? "";
  if (!v.trim()) throw new Error(`Human action ${params.id} has an empty response.`);
  return v;
}

