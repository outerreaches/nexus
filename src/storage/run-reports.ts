import crypto from "node:crypto";

import type { NexusDatabase } from "./database.js";

export type RunReportStatus = "pending" | "sending" | "sent" | "failed" | "dead_letter";

export type RunReportRecord = {
  id: string;
  kind: string;
  sourceRunId: string | null;
  parentRunId: string | null;
  sourceAgentId: string | null;
  sourceChannel: string | null;
  sourceChannelKey: string | null;
  targetAgentId: string | null;
  targetChannel: string;
  targetChannelKey: string | null;
  title: string;
  body: string;
  metadataJson: string;
  status: RunReportStatus;
  attempts: number;
  lastAttemptAt: number | null;
  nextAttemptAt: number | null;
  lastError: string | null;
  deliveredAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type RunReportRow = {
  id: string;
  kind: string;
  source_run_id: string | null;
  parent_run_id: string | null;
  source_agent_id: string | null;
  source_channel: string | null;
  source_channel_key: string | null;
  target_agent_id: string | null;
  target_channel: string;
  target_channel_key: string | null;
  title: string;
  body: string;
  metadata_json: string | null;
  status: string;
  attempts: number;
  last_attempt_at: number | null;
  next_attempt_at: number | null;
  last_error: string | null;
  delivered_at: number | null;
  created_at: number;
  updated_at: number;
};

function toInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function mapRow(row: RunReportRow): RunReportRecord {
  return {
    id: row.id,
    kind: row.kind,
    sourceRunId: row.source_run_id ?? null,
    parentRunId: row.parent_run_id ?? null,
    sourceAgentId: row.source_agent_id ?? null,
    sourceChannel: row.source_channel ?? null,
    sourceChannelKey: row.source_channel_key ?? null,
    targetAgentId: row.target_agent_id ?? null,
    targetChannel: row.target_channel || "agent",
    targetChannelKey: row.target_channel_key ?? null,
    title: row.title,
    body: row.body,
    metadataJson: row.metadata_json ?? "{}",
    status: normalizeStatus(row.status),
    attempts: toInt(row.attempts),
    lastAttemptAt: row.last_attempt_at == null ? null : toInt(row.last_attempt_at),
    nextAttemptAt: row.next_attempt_at == null ? null : toInt(row.next_attempt_at),
    lastError: row.last_error ?? null,
    deliveredAt: row.delivered_at == null ? null : toInt(row.delivered_at),
    createdAt: toInt(row.created_at),
    updatedAt: toInt(row.updated_at),
  };
}

function normalizeStatus(value: string): RunReportStatus {
  const status = value.trim().toLowerCase();
  if (status === "pending" || status === "sending" || status === "sent" || status === "failed" || status === "dead_letter") {
    return status;
  }
  return "pending";
}

export function createRunReportId(): string {
  return `RR${crypto.randomUUID().replace(/-/g, "")}`;
}

export function enqueueRunReport(
  db: NexusDatabase,
  params: {
    id?: string;
    kind: string;
    title: string;
    body: string;
    sourceRunId?: string | null;
    parentRunId?: string | null;
    sourceAgentId?: string | null;
    sourceChannel?: string | null;
    sourceChannelKey?: string | null;
    targetAgentId?: string | null;
    targetChannel?: string | null;
    targetChannelKey?: string | null;
    metadata?: Record<string, unknown>;
    nowMs?: number;
  },
): string {
  const nowMs = toInt(params.nowMs ?? Date.now());
  const id = params.id?.trim() || createRunReportId();
  const kind = params.kind.trim() || "unknown";
  const title = params.title.trim() || "Run Report";
  const body = params.body.trim() || "(empty)";
  const targetChannel = params.targetChannel?.trim() || "agent";
  const metadataJson = JSON.stringify(params.metadata ?? {});

  db.db
    .prepare(
      `INSERT INTO run_reports (
         id, kind, source_run_id, parent_run_id, source_agent_id, source_channel, source_channel_key,
         target_agent_id, target_channel, target_channel_key, title, body, metadata_json,
         status, attempts, last_attempt_at, next_attempt_at, last_error, delivered_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .run(
      id,
      kind,
      params.sourceRunId ?? null,
      params.parentRunId ?? null,
      params.sourceAgentId ?? null,
      params.sourceChannel ?? null,
      params.sourceChannelKey ?? null,
      params.targetAgentId ?? null,
      targetChannel,
      params.targetChannelKey ?? null,
      title,
      body,
      metadataJson,
      nowMs,
      nowMs,
    );

  return id;
}

export function listRunnableRunReports(
  db: NexusDatabase,
  params: { nowMs: number; limit: number },
): RunReportRecord[] {
  const nowMs = toInt(params.nowMs);
  const limit = Math.max(1, toInt(params.limit));
  const rows = db.db
    .prepare(
      `SELECT
         id, kind, source_run_id, parent_run_id, source_agent_id, source_channel, source_channel_key,
         target_agent_id, target_channel, target_channel_key, title, body, metadata_json,
         status, attempts, last_attempt_at, next_attempt_at, last_error, delivered_at, created_at, updated_at
       FROM run_reports
       WHERE status IN ('pending', 'failed')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(nowMs, limit) as RunReportRow[];
  return rows.map(mapRow);
}

export function claimRunReport(
  db: NexusDatabase,
  params: { id: string; nowMs: number; lockUntilMs: number },
): boolean {
  const nowMs = toInt(params.nowMs);
  const lockUntilMs = Math.max(nowMs + 1, toInt(params.lockUntilMs));
  const res = db.db
    .prepare(
      `UPDATE run_reports
       SET status = 'sending',
           attempts = attempts + 1,
           last_attempt_at = ?,
           next_attempt_at = ?,
           updated_at = ?
       WHERE id = ?
         AND status IN ('pending', 'failed')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
    )
    .run(nowMs, lockUntilMs, nowMs, params.id, nowMs);
  return (res.changes ?? 0) > 0;
}

export function markRunReportSent(
  db: NexusDatabase,
  params: { id: string; nowMs: number },
): void {
  const nowMs = toInt(params.nowMs);
  db.db
    .prepare(
      `UPDATE run_reports
       SET status = 'sent',
           next_attempt_at = NULL,
           last_error = NULL,
           delivered_at = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(nowMs, nowMs, params.id);
}

export function markRunReportFailed(
  db: NexusDatabase,
  params: {
    id: string;
    status: "failed" | "dead_letter";
    nowMs: number;
    nextAttemptAt?: number | null;
    error?: string | null;
  },
): void {
  const nowMs = toInt(params.nowMs);
  const nextAttemptAt = params.nextAttemptAt == null ? null : toInt(params.nextAttemptAt);
  const error = params.error?.trim() ? params.error.trim().slice(0, 1200) : null;
  db.db
    .prepare(
      `UPDATE run_reports
       SET status = ?,
           next_attempt_at = ?,
           last_error = ?,
           updated_at = ?
       WHERE id = ?`,
    )
    .run(params.status, nextAttemptAt, error, nowMs, params.id);
}

export function getRunReportById(db: NexusDatabase, id: string): RunReportRecord | null {
  const row = db.db
    .prepare(
      `SELECT
         id, kind, source_run_id, parent_run_id, source_agent_id, source_channel, source_channel_key,
         target_agent_id, target_channel, target_channel_key, title, body, metadata_json,
         status, attempts, last_attempt_at, next_attempt_at, last_error, delivered_at, created_at, updated_at
       FROM run_reports
       WHERE id = ?
       LIMIT 1`,
    )
    .get(id) as RunReportRow | undefined;
  if (!row) return null;
  return mapRow(row);
}

export function findNearestTelegramAncestorRun(
  db: NexusDatabase,
  runId: string,
): { runId: string; agentId: string; channelKey: string; sessionId: string | null } | null {
  let currentRunId: string | null = runId;
  for (let i = 0; i < 40 && currentRunId; i++) {
    const row = db.db
      .prepare(
        `SELECT run_id, parent_run_id, agent_id, channel, channel_key, session_id
         FROM agent_runs
         WHERE run_id = ?
         LIMIT 1`,
      )
      .get(currentRunId) as
      | {
          run_id: string;
          parent_run_id: string | null;
          agent_id: string;
          channel: string | null;
          channel_key: string | null;
          session_id: string | null;
        }
      | undefined;
    if (!row) break;
    const channel = (row.channel ?? "").trim().toLowerCase();
    const channelKey = row.channel_key?.trim() ?? "";
    if (channel === "telegram" && channelKey) {
      return {
        runId: row.run_id,
        agentId: row.agent_id,
        channelKey,
        sessionId: row.session_id ?? null,
      };
    }
    currentRunId = row.parent_run_id ?? null;
  }
  return null;
}
