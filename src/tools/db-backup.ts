import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";
import { runBackup, cleanupOldBackups, getBackupStatus, type BackupConfig } from "../maintenance/db-backup.js";

export const dbBackup = defineTool({
  name: "db_backup",
  description:
    "Create a database backup or check backup status. " +
    "Use action='status' to see backup state, last backup time, and next scheduled backup. " +
    "Use action='run' to create a manual backup immediately. " +
    "Backups are stored in {stateDir}/backups/YYYY-MM-DD/ with automatic retention cleanup.",
  parameters: z.object({
    action: z.enum(["run", "status"]).default("status").describe("Action to perform"),
    retentionDays: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe("Override backup retention in days (default: 7)"),
    maxBackups: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Override minimum backups to keep (default: 10)"),
    cleanup: z.boolean().default(true).describe("Whether to cleanup old backups after run"),
  }),
  execute: async (args, ctx) => {
    const db = ctx.db as NexusDatabase | undefined;
    if (!db) return "ERROR: database is not available";

    const nowMs = ctx.nowMs();

    if (args.action === "status") {
      const status = getBackupStatus({ db, nowMs });
      return JSON.stringify(
        {
          lastBackup: status.lastBackup
            ? {
                ...status.lastBackup,
                completed_at_iso: new Date(status.lastBackup.completed_at).toISOString(),
                size_mb: Math.round(status.lastBackup.size_bytes / 1024 / 1024 * 100) / 100,
              }
            : null,
          backupAge: status.backupAgeMs
            ? {
                ms: status.backupAgeMs,
                hours: Math.round(status.backupAgeMs / 3600000 * 10) / 10,
              }
            : null,
          nextScheduledBackup: status.nextScheduledBackup
            ? {
                ms: status.nextScheduledBackup,
                iso: new Date(status.nextScheduledBackup).toISOString(),
              }
            : null,
          recentBackups: status.recentBackups.map((b) => ({
            ...b,
            completed_at_iso: b.completed_at ? new Date(b.completed_at).toISOString() : null,
            size_mb: Math.round(b.size_bytes / 1024 / 1024 * 100) / 100,
          })),
        },
        null,
        2,
      );
    }

    // Run backup
    const result = await runBackup({
      db,
      stateDir: ctx.stateDir,
      backupType: "manual",
      nowMs,
      log: ctx.log,
    });

    // Cleanup old backups if enabled and backup succeeded
    let cleanedUp = 0;
    if (args.cleanup && result.status === "completed") {
      const config: BackupConfig = {
        retentionDays: args.retentionDays ?? 7,
        maxBackups: args.maxBackups ?? 10,
      };
      cleanedUp = await cleanupOldBackups({
        db,
        stateDir: ctx.stateDir,
        config,
        nowMs,
        log: ctx.log,
      });
    }

    return JSON.stringify(
      {
        ...result,
        size_mb: Math.round(result.sizeBytes / 1024 / 1024 * 100) / 100,
        cleanedUpBackups: cleanedUp,
      },
      null,
      2,
    );
  },
});
