import crypto from "node:crypto";

import type { NexusDatabase } from "../storage/database.js";

export type DataIntakeSourceRow = {
  id: string;
  source_id: string;
  label: string | null;
  params_json: string;
  interval_ms: number;
  enabled: number;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  last_error: string | null;
};

function randomId(prefix: string): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(10);
  let out = prefix;
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function listIntakeSources(params: { db: NexusDatabase; includeDisabled?: boolean }): DataIntakeSourceRow[] {
  const includeDisabled = params.includeDisabled ?? false;
  const sql = includeDisabled
    ? "SELECT * FROM data_intake_sources ORDER BY created_at DESC"
    : "SELECT * FROM data_intake_sources WHERE enabled = 1 ORDER BY created_at DESC";
  return params.db.db.prepare(sql).all() as DataIntakeSourceRow[];
}

export function getIntakeSource(params: { db: NexusDatabase; id: string }): DataIntakeSourceRow | null {
  const row = params.db.db.prepare("SELECT * FROM data_intake_sources WHERE id = ?").get(params.id) as
    | DataIntakeSourceRow
    | undefined;
  return row ?? null;
}

export function createIntakeSource(params: {
  db: NexusDatabase;
  sourceId: string;
  label?: string;
  params: Record<string, unknown>;
  intervalMs: number;
}): DataIntakeSourceRow {
  const now = Date.now();
  const id = randomId("DIS");
  const intervalMs = Math.max(60_000, params.intervalMs);
  params.db.db
    .prepare(
      "INSERT INTO data_intake_sources (id, source_id, label, params_json, interval_ms, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
    )
    .run(id, params.sourceId, params.label ?? null, JSON.stringify(params.params ?? {}), intervalMs, now, now);
  return params.db.db.prepare("SELECT * FROM data_intake_sources WHERE id = ?").get(id) as DataIntakeSourceRow;
}

export function updateIntakeSource(params: {
  db: NexusDatabase;
  id: string;
  label?: string | null;
  paramsJson?: string;
  intervalMs?: number;
  enabled?: boolean;
  lastRunAt?: number | null;
  lastError?: string | null;
}): DataIntakeSourceRow | null {
  const existing = getIntakeSource({ db: params.db, id: params.id });
  if (!existing) return null;
  const nextLabel = params.label ?? existing.label;
  const nextParams = params.paramsJson ?? existing.params_json;
  const nextInterval = Math.max(60_000, params.intervalMs ?? existing.interval_ms);
  const nextEnabled = params.enabled === undefined ? existing.enabled : params.enabled ? 1 : 0;
  const nextLastRun = params.lastRunAt === undefined ? existing.last_run_at : params.lastRunAt;
  const nextLastError = params.lastError === undefined ? existing.last_error : params.lastError;
  const now = Date.now();
  params.db.db
    .prepare(
      "UPDATE data_intake_sources SET label = ?, params_json = ?, interval_ms = ?, enabled = ?, updated_at = ?, last_run_at = ?, last_error = ? WHERE id = ?",
    )
    .run(nextLabel, nextParams, nextInterval, nextEnabled, now, nextLastRun, nextLastError, params.id);
  return getIntakeSource({ db: params.db, id: params.id });
}

export function deleteIntakeSource(params: { db: NexusDatabase; id: string }): boolean {
  const res = params.db.db.prepare("DELETE FROM data_intake_sources WHERE id = ?").run(params.id);
  return res.changes > 0;
}
