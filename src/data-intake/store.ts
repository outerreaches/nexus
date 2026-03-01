import type { NexusDatabase } from "../storage/database.js";

export type DataItemRow = {
  id: string;
  source_id: string;
  source_name: string;
  tags_json: string;
  subject: string;
  value_json: string;
  metadata_json: string;
  collected_at: number;
  expires_at: number;
  created_at: number;
};

export function listDataItems(params: {
  db: NexusDatabase;
  sourceId?: string;
  tag?: string;
  subject?: string;
  subjectLike?: string;
  limit: number;
  includeExpired: boolean;
  nowMs: number;
}): DataItemRow[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.sourceId) {
    conditions.push("source_id = ?");
    values.push(params.sourceId);
  }
  if (params.subject) {
    conditions.push("subject = ?");
    values.push(params.subject);
  } else if (params.subjectLike) {
    conditions.push("subject LIKE ?");
    values.push(params.subjectLike);
  }
  if (params.tag) {
    conditions.push("tags_json LIKE ?");
    values.push(`%${params.tag}%`);
  }
  if (!params.includeExpired) {
    conditions.push("expires_at > ?");
    values.push(params.nowMs);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT * FROM data_items ${where} ORDER BY collected_at DESC LIMIT ?`;
  const stmt = params.db.db.prepare(sql);
  return stmt.all(...values, params.limit) as DataItemRow[];
}

export function listLatestDataItems(params: {
  db: NexusDatabase;
  sourceId?: string;
  tag?: string;
  subject?: string;
  subjectLike?: string;
  limit: number;
  includeExpired: boolean;
  nowMs: number;
}): DataItemRow[] {
  // With upsert model, each (source_id, subject) has exactly one row — it IS the latest.
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.sourceId) {
    conditions.push("source_id = ?");
    values.push(params.sourceId);
  }
  if (params.subject) {
    conditions.push("subject = ?");
    values.push(params.subject);
  } else if (params.subjectLike) {
    conditions.push("subject LIKE ?");
    values.push(params.subjectLike);
  }
  if (params.tag) {
    conditions.push("tags_json LIKE ?");
    values.push(`%${params.tag}%`);
  }
  if (!params.includeExpired) {
    conditions.push("expires_at > ?");
    values.push(params.nowMs);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT * FROM data_items ${where} ORDER BY collected_at DESC LIMIT ?`;
  const stmt = params.db.db.prepare(sql);
  return stmt.all(...values, params.limit) as DataItemRow[];
}

/** Returns only the most recent record per source_id (useful for dashboard summaries) */
export function listLatestDataItemsPerSource(params: {
  db: NexusDatabase;
  limit: number;
  includeExpired: boolean;
  nowMs: number;
}): DataItemRow[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (!params.includeExpired) {
    conditions.push("expires_at > ?");
    values.push(params.nowMs);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  // With upsert model, pick one representative row per source_id (most recent collected_at)
  const sql = `
    SELECT d.*
    FROM data_items d
    WHERE d.id IN (
      SELECT id FROM (
        SELECT id, source_id, collected_at,
               ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY collected_at DESC, id ASC) as rn
        FROM data_items
        ${where}
      ) ranked
      WHERE rn = 1
    )
    ORDER BY d.collected_at DESC
    LIMIT ?
  `;
  const stmt = params.db.db.prepare(sql);
  return stmt.all(...values, params.limit) as DataItemRow[];
}

export function pruneDataItems(params: {
  db: NexusDatabase;
  nowMs: number;
  maxAgeMs?: number;
  includeUnexpired?: boolean;
  sourceId?: string;
}): number {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (params.sourceId) {
    clauses.push("source_id = ?");
    values.push(params.sourceId);
  }

  if (params.maxAgeMs) {
    const cutoff = params.nowMs - params.maxAgeMs;
    if (params.includeUnexpired) {
      clauses.push("collected_at <= ?");
      values.push(cutoff);
    } else {
      clauses.push("(expires_at <= ? OR collected_at <= ?)");
      values.push(params.nowMs, cutoff);
    }
  } else {
    clauses.push("expires_at <= ?");
    values.push(params.nowMs);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const res = params.db.db.prepare(`DELETE FROM data_items ${where}`).run(...values);
  return res.changes;
}

/** Delete all data items for a specific source (regardless of expiration) */
export function deleteDataItemsBySource(params: {
  db: NexusDatabase;
  sourceId: string;
}): number {
  const res = params.db.db.prepare("DELETE FROM data_items WHERE source_id = ?").run(params.sourceId);
  return res.changes;
}

// ─── Snapshot queries ────────────────────────────────────────────────────────

export type DataSnapshotRow = {
  id: number;
  source_id: string;
  subject: string;
  value_json: string;
  collected_at: number;
  created_at: number;
};

export function listDataSnapshots(params: {
  db: NexusDatabase;
  sourceId?: string;
  subject?: string;
  afterMs?: number;
  beforeMs?: number;
  limit: number;
}): DataSnapshotRow[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.sourceId) {
    conditions.push("source_id = ?");
    values.push(params.sourceId);
  }
  if (params.subject) {
    conditions.push("subject = ?");
    values.push(params.subject);
  }
  if (params.afterMs != null) {
    conditions.push("collected_at >= ?");
    values.push(params.afterMs);
  }
  if (params.beforeMs != null) {
    conditions.push("collected_at <= ?");
    values.push(params.beforeMs);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `SELECT * FROM data_snapshots ${where} ORDER BY collected_at DESC LIMIT ?`;
  return params.db.db.prepare(sql).all(...values, params.limit) as DataSnapshotRow[];
}

export function pruneDataSnapshots(params: {
  db: NexusDatabase;
  nowMs: number;
  maxAgeMs: number;
}): number {
  const cutoff = params.nowMs - params.maxAgeMs;
  const res = params.db.db.prepare("DELETE FROM data_snapshots WHERE collected_at < ?").run(cutoff);
  return res.changes;
}
