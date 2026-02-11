import fs from "node:fs/promises";
import path from "node:path";

import type { NexusDatabase } from "../storage/database.js";
import { randomId } from "../data-intake/utils.js";

export type BackupConfig = {
  retentionDays: number;
  maxBackups: number;
};

export type BackupResult = {
  id: string;
  filename: string;
  filePath: string;
  markdownSnapshotPath?: string;
  markdownFilesCopied?: number;
  sizeBytes: number;
  durationMs: number;
  status: "completed" | "failed";
  error?: string;
};

export type BackupStatus = {
  lastBackup: {
    id: string;
    filename: string;
    completed_at: number;
    status: string;
    size_bytes: number;
  } | null;
  backupAgeMs: number | null;
  recentBackups: Array<{
    id: string;
    filename: string;
    completed_at: number;
    size_bytes: number;
    status: string;
    backup_type: string;
  }>;
  nextScheduledBackup: number | null;
};

const PERSONALIZATION_FILES = ["SOUL.md", "AGENTS.md", "USER.md", "CODEGUIDE.md", "HEARTBEAT.md", "NOTES.md"] as const;

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listMarkdownFilesRecursive(rootDir: string): Promise<string[]> {
  if (!(await pathExists(rootDir))) return [];
  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        out.push(fullPath);
      }
    }
  }
  return out.sort();
}

async function copyStateMarkdownSnapshot(params: {
  stateDir: string;
  snapshotDir: string;
  log: (msg: string) => void;
}): Promise<{ copied: number; manifestPath: string }> {
  const { stateDir, snapshotDir, log } = params;
  await fs.mkdir(snapshotDir, { recursive: true });

  const copied: Array<{ source: string; dest: string }> = [];
  for (const filename of PERSONALIZATION_FILES) {
    const source = path.join(stateDir, filename);
    if (!(await pathExists(source))) continue;
    const dest = path.join(snapshotDir, filename);
    await fs.copyFile(source, dest);
    copied.push({ source, dest });
  }

  const agentRoot = path.join(stateDir, "agents");
  const agentFiles = await listMarkdownFilesRecursive(agentRoot);
  for (const source of agentFiles) {
    const rel = path.relative(stateDir, source);
    const dest = path.join(snapshotDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(source, dest);
    copied.push({ source, dest });
  }

  const manifestPath = path.join(snapshotDir, "manifest.json");
  const manifest = {
    createdAt: Date.now(),
    stateDir,
    copiedFiles: copied.map((f) => ({
      source: f.source,
      destRelative: path.relative(snapshotDir, f.dest),
    })),
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  log(`backup: copied ${copied.length} markdown file(s) to ${snapshotDir}`);
  return { copied: copied.length, manifestPath };
}

export async function runBackup(params: {
  db: NexusDatabase;
  stateDir: string;
  backupType: "scheduled" | "manual";
  nowMs: number;
  log?: (msg: string) => void;
}): Promise<BackupResult> {
  const { db, stateDir, backupType, nowMs, log = () => {} } = params;
  const startMs = Date.now();
  const backupId = randomId("BK");

  // Create backup directory structure
  const date = new Date(nowMs);
  const dateStr = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  const backupDir = path.join(stateDir, "backups", dateStr);
  await fs.mkdir(backupDir, { recursive: true });

  const timestamp = date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `nexus-${timestamp}.db`;
  const filePath = path.join(backupDir, filename);
  const snapshotDir = path.join(backupDir, `${path.parse(filename).name}.state`);

  log(`backup: starting ${backupType} backup to ${filePath}`);

  // Record backup start in database
  db.db
    .prepare(
      `INSERT INTO db_backups (id, filename, file_path, size_bytes, backup_type, started_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(backupId, filename, filePath, 0, backupType, nowMs, "running", nowMs);

  try {
    // Use better-sqlite3's backup API
    await db.db.backup(filePath);

    // Get backup file size
    const stats = await fs.stat(filePath);
    const sizeBytes = stats.size;

    const snapshot = await copyStateMarkdownSnapshot({
      stateDir,
      snapshotDir,
      log,
    });

    const durationMs = Date.now() - startMs;

    // Update backup record with completion
    db.db
      .prepare(
        `UPDATE db_backups SET size_bytes = ?, completed_at = ?, status = ? WHERE id = ?`,
      )
      .run(sizeBytes, Date.now(), "completed", backupId);

    log(`backup: completed in ${durationMs}ms (${Math.round(sizeBytes / 1024)}KB)`);

    return {
      id: backupId,
      filename,
      filePath,
      markdownSnapshotPath: snapshotDir,
      markdownFilesCopied: snapshot.copied,
      sizeBytes,
      durationMs,
      status: "completed",
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startMs;

    // Update backup record with error
    db.db
      .prepare(
        `UPDATE db_backups SET completed_at = ?, status = ?, error = ? WHERE id = ?`,
      )
      .run(Date.now(), "failed", errorMsg, backupId);

    log(`backup: FAILED after ${durationMs}ms - ${errorMsg}`);

    return {
      id: backupId,
      filename,
      filePath,
      sizeBytes: 0,
      durationMs,
      status: "failed",
      error: errorMsg,
    };
  }
}

export async function cleanupOldBackups(params: {
  db: NexusDatabase;
  stateDir: string;
  config: BackupConfig;
  nowMs: number;
  log?: (msg: string) => void;
}): Promise<number> {
  const { db, stateDir, config, nowMs, log = () => {} } = params;

  const cutoffMs = nowMs - config.retentionDays * 24 * 60 * 60 * 1000;

  // Get old backup records
  const oldBackups = db.db
    .prepare(
      `SELECT id, file_path FROM db_backups
       WHERE status = 'completed' AND created_at < ?
       ORDER BY created_at ASC`,
    )
    .all(cutoffMs) as { id: string; file_path: string }[];

  // Keep minimum number of backups
  const allBackups = db.db
    .prepare(
      `SELECT id FROM db_backups WHERE status = 'completed' ORDER BY created_at DESC`,
    )
    .all() as { id: string }[];

  const protectedIds = new Set(allBackups.slice(0, config.maxBackups).map((b) => b.id));

  let deletedCount = 0;

  for (const backup of oldBackups) {
    if (protectedIds.has(backup.id)) {
      log(`backup: keeping ${backup.id} (within minBackups=${config.maxBackups})`);
      continue;
    }

    // Delete file
    try {
      await fs.unlink(backup.file_path);
      log(`backup: deleted file ${backup.file_path}`);
    } catch {
      // File may already be deleted
    }

    // Delete markdown snapshot directory paired to this backup (best-effort)
    try {
      const parsed = path.parse(backup.file_path);
      const snapshotDir = path.join(parsed.dir, `${parsed.name}.state`);
      await fs.rm(snapshotDir, { recursive: true, force: true });
      log(`backup: deleted snapshot ${snapshotDir}`);
    } catch {
      // ignore cleanup errors
    }

    // Delete record
    db.db.prepare(`DELETE FROM db_backups WHERE id = ?`).run(backup.id);
    deletedCount++;
  }

  if (deletedCount > 0) {
    log(`backup: cleaned up ${deletedCount} old backups`);
  }

  return deletedCount;
}

export function getBackupStatus(params: { db: NexusDatabase; nowMs: number }): BackupStatus {
  const { db, nowMs } = params;

  // Get last completed backup
  const lastBackup = db.db
    .prepare(
      `SELECT id, filename, completed_at, status, size_bytes
       FROM db_backups
       WHERE status = 'completed'
       ORDER BY completed_at DESC
       LIMIT 1`,
    )
    .get() as BackupStatus["lastBackup"] | undefined;

  // Calculate backup age
  const backupAgeMs = lastBackup?.completed_at ? nowMs - lastBackup.completed_at : null;

  // Get recent backups (last 10)
  const recentBackups = db.db
    .prepare(
      `SELECT id, filename, completed_at, size_bytes, status, backup_type
       FROM db_backups
       ORDER BY created_at DESC
       LIMIT 10`,
    )
    .all() as BackupStatus["recentBackups"];

  // Get next scheduled backup from job
  const job = db.db
    .prepare(
      `SELECT next_run_at FROM jobs WHERE id = 'SYS_DB_BACKUP' AND enabled = 1`,
    )
    .get() as { next_run_at: number | null } | undefined;

  return {
    lastBackup: lastBackup ?? null,
    backupAgeMs,
    recentBackups,
    nextScheduledBackup: job?.next_run_at ?? null,
  };
}
