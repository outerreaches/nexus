import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

import type { NexusDatabase } from "../storage/database.js";
import { cleanupManagedBlackboardAttachments } from "../storage/blackboard-attachments.js";
import { randomId } from "../data-intake/utils.js";

export type MaintenanceConfig = {
  archiveRetentionDays: number;
  jobRunRetentionDays: number;
  ttlCleanupEnabled: boolean;
};

export type TableArchiveResult = { archived: number; errors: string[] };
export type TableCleanupResult = { deleted: number; summaryId: string | null };
export type TableTtlResult = { deleted: number };

export type MaintenanceResult = {
  status: "completed" | "dry_run" | "error";
  durationMs: number;
  archive: Record<string, TableArchiveResult>;
  cleanup: Record<string, TableCleanupResult>;
  ttl: Record<string, TableTtlResult>;
  errors: string[];
};

const ARCHIVE_TABLES = ["messages", "paper_trades", "data_items", "data_item_events", "agent_runs"] as const;
const CLEANUP_TABLES = ["job_runs", "job_events"] as const;
const TTL_TABLES = ["blackboard", "human_actions", "pairing_requests", "pairing_codes"] as const;

// Date column mapping for each archivable/cleanable table
const DATE_COLUMNS: Record<string, string> = {
  messages: "created_at",
  paper_trades: "created_at",
  data_items: "created_at",
  data_item_events: "created_at",
  agent_runs: "started_at",
  job_runs: "started_at",
  job_events: "created_at",
};

// Primary key column for each table
const ID_COLUMNS: Record<string, string> = {
  messages: "id",
  paper_trades: "id",
  data_items: "id",
  data_item_events: "id",
  agent_runs: "run_id",
  job_runs: "id",
  job_events: "id",
};

// TTL expiration config
const TTL_CONFIG: Record<string, { expiresCol: string; statusCol?: string; expiredStatus?: string }> = {
  blackboard: { expiresCol: "expires_at" },
  human_actions: { expiresCol: "expires_at", statusCol: "status", expiredStatus: "expired" },
  pairing_requests: { expiresCol: "expires_at" },
  pairing_codes: { expiresCol: "expires_at" },
};

export async function runMaintenance(params: {
  db: NexusDatabase;
  stateDir: string;
  config: MaintenanceConfig;
  nowMs: number;
  dryRun?: boolean;
  log?: (msg: string) => void;
}): Promise<MaintenanceResult> {
  const { db, stateDir, config, nowMs, dryRun = false, log = () => {} } = params;
  const startMs = Date.now();
  const errors: string[] = [];

  const result: MaintenanceResult = {
    status: dryRun ? "dry_run" : "completed",
    durationMs: 0,
    archive: {},
    cleanup: {},
    ttl: {},
    errors: [],
  };

  // Initialize result structures
  for (const t of ARCHIVE_TABLES) result.archive[t] = { archived: 0, errors: [] };
  for (const t of CLEANUP_TABLES) result.cleanup[t] = { deleted: 0, summaryId: null };
  for (const t of TTL_TABLES) result.ttl[t] = { deleted: 0 };

  // Calculate cutoff timestamps
  const archiveCutoffMs = nowMs - config.archiveRetentionDays * 24 * 60 * 60 * 1000;
  const cleanupCutoffMs = nowMs - config.jobRunRetentionDays * 24 * 60 * 60 * 1000;

  // 1. Archive tables (180-day retention by default)
  for (const table of ARCHIVE_TABLES) {
    try {
      const archived = await archiveTable({
        db,
        stateDir,
        table,
        dateColumn: DATE_COLUMNS[table]!,
        idColumn: ID_COLUMNS[table]!,
        cutoffMs: archiveCutoffMs,
        nowMs,
        dryRun,
        log,
      });
      result.archive[table]!.archived = archived;
    } catch (e) {
      const msg = `archive ${table}: ${e instanceof Error ? e.message : String(e)}`;
      result.archive[table]!.errors.push(msg);
      errors.push(msg);
      log(`maintenance: ERROR ${msg}`);
    }
  }

  // 2. Delete with summary (60-day retention for job_runs, job_events)
  for (const table of CLEANUP_TABLES) {
    try {
      const { deleted, summaryId } = await deleteWithSummary({
        db,
        table,
        dateColumn: DATE_COLUMNS[table]!,
        cutoffMs: cleanupCutoffMs,
        nowMs,
        dryRun,
        log,
      });
      result.cleanup[table]!.deleted = deleted;
      result.cleanup[table]!.summaryId = summaryId;
    } catch (e) {
      const msg = `cleanup ${table}: ${e instanceof Error ? e.message : String(e)}`;
      errors.push(msg);
      log(`maintenance: ERROR ${msg}`);
    }
  }

  // 3. TTL cleanup
  if (config.ttlCleanupEnabled) {
    for (const table of TTL_TABLES) {
      try {
        const deleted = await ttlCleanup({
          db,
          table,
          config: TTL_CONFIG[table]!,
          stateDir,
          nowMs,
          dryRun,
          log,
        });
        result.ttl[table]!.deleted = deleted;
      } catch (e) {
        const msg = `ttl ${table}: ${e instanceof Error ? e.message : String(e)}`;
        errors.push(msg);
        log(`maintenance: ERROR ${msg}`);
      }
    }
  }

  result.errors = errors;
  result.durationMs = Date.now() - startMs;
  if (errors.length > 0) result.status = "error";

  return result;
}

async function archiveTable(params: {
  db: NexusDatabase;
  stateDir: string;
  table: string;
  dateColumn: string;
  idColumn: string;
  cutoffMs: number;
  nowMs: number;
  dryRun: boolean;
  log: (msg: string) => void;
}): Promise<number> {
  const { db, stateDir, table, dateColumn, idColumn, cutoffMs, nowMs, dryRun, log } = params;

  // Count rows to archive
  const countStmt = db.db.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${dateColumn} < ?`);
  const { cnt } = countStmt.get(cutoffMs) as { cnt: number };

  if (cnt === 0) {
    log(`maintenance: archive ${table}: 0 rows to archive`);
    return 0;
  }

  log(`maintenance: archive ${table}: ${cnt} rows to archive (cutoff=${new Date(cutoffMs).toISOString()})`);

  if (dryRun) return cnt;

  // Get rows to archive
  const rows = db.db
    .prepare(`SELECT * FROM ${table} WHERE ${dateColumn} < ? ORDER BY ${dateColumn} ASC`)
    .all(cutoffMs) as Record<string, unknown>[];

  if (rows.length === 0) return 0;

  // Get table schema from main DB
  const schemaRow = db.db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { sql: string } | undefined;
  if (!schemaRow) throw new Error(`Schema not found for table ${table}`);
  const createTableSql = schemaRow.sql;

  // Get indexes for this table
  const indexRows = db.db
    .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL")
    .all(table) as { sql: string }[];

  // Group rows by YYYY-MM
  const rowsByMonth = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const dateVal = row[dateColumn] as number;
    const d = new Date(dateVal);
    const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!rowsByMonth.has(monthKey)) rowsByMonth.set(monthKey, []);
    rowsByMonth.get(monthKey)!.push(row);
  }

  const archivedIds: (string | number)[] = [];

  for (const [monthKey, monthRows] of rowsByMonth) {
    // Open/create archive database
    const archiveDir = path.join(stateDir, "archives", monthKey);
    await fs.mkdir(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, `${table}.db`);

    const archiveDb = new Database(archivePath);
    archiveDb.pragma("journal_mode = WAL");

    // Create table if not exists
    archiveDb.exec(createTableSql.replace(/CREATE TABLE/i, "CREATE TABLE IF NOT EXISTS"));

    // Create indexes if not exist
    for (const idx of indexRows) {
      try {
        archiveDb.exec(idx.sql.replace(/CREATE INDEX/i, "CREATE INDEX IF NOT EXISTS"));
      } catch {
        // Index may already exist with different definition
      }
    }

    // Insert rows into archive
    const columns = Object.keys(monthRows[0]!);
    const placeholders = columns.map(() => "?").join(", ");
    const insertStmt = archiveDb.prepare(
      `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
    );

    const insertTx = archiveDb.transaction(() => {
      for (const row of monthRows) {
        insertStmt.run(...columns.map((c) => row[c]));
      }
    });
    insertTx();
    archiveDb.close();

    // Track IDs for deletion
    for (const row of monthRows) {
      archivedIds.push(row[idColumn] as string | number);
    }

    log(`maintenance: archive ${table}: archived ${monthRows.length} rows to ${archivePath}`);
  }

  // Delete archived rows from main DB in batches
  if (archivedIds.length > 0) {
    const batchSize = 500;
    for (let i = 0; i < archivedIds.length; i += batchSize) {
      const batch = archivedIds.slice(i, i + batchSize);
      const placeholders = batch.map(() => "?").join(", ");
      db.db.prepare(`DELETE FROM ${table} WHERE ${idColumn} IN (${placeholders})`).run(...batch);
    }
  }

  // Record cleanup summary
  const summaryId = randomId("CS");
  const minDate = rows.length > 0 ? (rows[0]![dateColumn] as number) : null;
  const maxDate = rows.length > 0 ? (rows[rows.length - 1]![dateColumn] as number) : null;
  db.db
    .prepare(
      `INSERT INTO cleanup_summaries (id, table_name, operation, rows_affected, date_range_start, date_range_end, summary_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(summaryId, table, "archive", archivedIds.length, minDate, maxDate, JSON.stringify({ months: Array.from(rowsByMonth.keys()) }), nowMs);

  return archivedIds.length;
}

async function deleteWithSummary(params: {
  db: NexusDatabase;
  table: string;
  dateColumn: string;
  cutoffMs: number;
  nowMs: number;
  dryRun: boolean;
  log: (msg: string) => void;
}): Promise<{ deleted: number; summaryId: string | null }> {
  const { db, table, dateColumn, cutoffMs, nowMs, dryRun, log } = params;

  // Generate pre-deletion summary
  const summaryQuery = db.db.prepare(`
    SELECT
      COUNT(*) as total_count,
      MIN(${dateColumn}) as min_date,
      MAX(${dateColumn}) as max_date,
      COUNT(DISTINCT job_id) as distinct_jobs
    FROM ${table}
    WHERE ${dateColumn} < ?
  `);
  const summary = summaryQuery.get(cutoffMs) as {
    total_count: number;
    min_date: number | null;
    max_date: number | null;
    distinct_jobs: number;
  };

  if (summary.total_count === 0) {
    log(`maintenance: cleanup ${table}: 0 rows to delete`);
    return { deleted: 0, summaryId: null };
  }

  log(`maintenance: cleanup ${table}: ${summary.total_count} rows to delete (cutoff=${new Date(cutoffMs).toISOString()})`);

  if (dryRun) return { deleted: summary.total_count, summaryId: null };

  // Store summary before deletion
  const summaryId = randomId("CS");
  db.db
    .prepare(
      `INSERT INTO cleanup_summaries (id, table_name, operation, rows_affected, date_range_start, date_range_end, summary_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(summaryId, table, "delete", summary.total_count, summary.min_date, summary.max_date, JSON.stringify({ distinct_jobs: summary.distinct_jobs }), nowMs);

  // Perform deletion
  const res = db.db.prepare(`DELETE FROM ${table} WHERE ${dateColumn} < ?`).run(cutoffMs);

  return { deleted: res.changes, summaryId };
}

async function ttlCleanup(params: {
  db: NexusDatabase;
  table: string;
  config: { expiresCol: string; statusCol?: string; expiredStatus?: string };
  stateDir: string;
  nowMs: number;
  dryRun: boolean;
  log: (msg: string) => void;
}): Promise<number> {
  const { db, table, config, stateDir, nowMs, dryRun, log } = params;
  const { expiresCol, statusCol, expiredStatus } = config;

  // For human_actions, update status to 'expired' instead of deleting
  if (statusCol && expiredStatus) {
    const countStmt = db.db.prepare(
      `SELECT COUNT(*) as cnt FROM ${table} WHERE ${expiresCol} IS NOT NULL AND ${expiresCol} <= ? AND ${statusCol} = 'pending'`,
    );
    const { cnt } = countStmt.get(nowMs) as { cnt: number };

    if (cnt === 0) return 0;

    log(`maintenance: ttl ${table}: ${cnt} rows to expire`);
    if (dryRun) return cnt;

    const res = db.db
      .prepare(`UPDATE ${table} SET ${statusCol} = ? WHERE ${expiresCol} IS NOT NULL AND ${expiresCol} <= ? AND ${statusCol} = 'pending'`)
      .run(expiredStatus, nowMs);
    return res.changes;
  }

  // Standard TTL delete
  const countStmt = db.db.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${expiresCol} IS NOT NULL AND ${expiresCol} <= ?`);
  const { cnt } = countStmt.get(nowMs) as { cnt: number };

  if (cnt === 0) return 0;

  log(`maintenance: ttl ${table}: ${cnt} rows to delete`);
  if (dryRun) return cnt;

  let attachmentRows: { attachments_json: string | null }[] = [];
  if (table === "blackboard") {
    attachmentRows = db.db
      .prepare(`SELECT attachments_json FROM ${table} WHERE ${expiresCol} IS NOT NULL AND ${expiresCol} <= ?`)
      .all(nowMs) as { attachments_json: string | null }[];
  }

  const res = db.db.prepare(`DELETE FROM ${table} WHERE ${expiresCol} IS NOT NULL AND ${expiresCol} <= ?`).run(nowMs);
  if (table === "blackboard" && attachmentRows.length > 0) {
    const cleanup = await cleanupManagedBlackboardAttachments({ stateDir, rows: attachmentRows });
    if (cleanup.removed > 0 || cleanup.failed > 0) {
      log(`maintenance: ttl blackboard attachments removed=${cleanup.removed} failed=${cleanup.failed}`);
    }
  }
  return res.changes;
}

export function getMaintenanceStatus(params: { db: NexusDatabase; nowMs: number }): {
  lastRun: { id: string; created_at: number; table_name: string; operation: string } | null;
  nextScheduledRun: number | null;
  recentSummaries: { id: string; table_name: string; operation: string; rows_affected: number; created_at: number }[];
} {
  const { db } = params;

  // Get last cleanup summary
  const lastRun = db.db
    .prepare("SELECT id, table_name, operation, created_at FROM cleanup_summaries ORDER BY created_at DESC LIMIT 1")
    .get() as { id: string; table_name: string; operation: string; created_at: number } | undefined;

  // Get next scheduled maintenance job run
  const job = db.db.prepare("SELECT next_run_at FROM jobs WHERE id = 'SYS_DB_MAINTENANCE' AND enabled = 1").get() as
    | { next_run_at: number | null }
    | undefined;

  // Get recent summaries (last 20)
  const recentSummaries = db.db
    .prepare("SELECT id, table_name, operation, rows_affected, created_at FROM cleanup_summaries ORDER BY created_at DESC LIMIT 20")
    .all() as { id: string; table_name: string; operation: string; rows_affected: number; created_at: number }[];

  return {
    lastRun: lastRun ?? null,
    nextScheduledRun: job?.next_run_at ?? null,
    recentSummaries,
  };
}
