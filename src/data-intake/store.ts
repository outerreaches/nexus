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
  const sql = `
    SELECT d.*
    FROM data_items d
    JOIN (
      SELECT source_id, subject, MAX(collected_at) AS latest
      FROM data_items
      ${where}
      GROUP BY source_id, subject
    ) latest
    ON d.source_id = latest.source_id AND d.subject = latest.subject AND d.collected_at = latest.latest
    ${where}
    ORDER BY d.collected_at DESC
    LIMIT ?
  `;
  const stmt = params.db.db.prepare(sql);
  return stmt.all(...values, ...values, params.limit) as DataItemRow[];
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
  // Use a subquery to get one representative row per source_id
  // We pick the row with the highest collected_at, and if there are ties, the smallest id (deterministic)
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
}): number {
  const clauses: string[] = [];
  const values: unknown[] = [];

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
