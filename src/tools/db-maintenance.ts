import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";
import { runMaintenance, getMaintenanceStatus, type MaintenanceConfig } from "../maintenance/db-maintenance.js";

export const dbMaintenance = defineTool({
  name: "db_maintenance",
  description:
    "Run database maintenance tasks: archive old data to monthly files, cleanup expired rows, and prune job history. " +
    "Use action='status' to check maintenance state and next scheduled run. Use action='run' to execute maintenance. " +
    "Use dryRun=true to preview changes without applying them.",
  parameters: z.object({
    action: z.enum(["run", "status"]).default("status").describe("Action to perform"),
    dryRun: z.boolean().default(false).describe("If true, preview changes without applying them"),
    archiveRetentionDays: z
      .number()
      .int()
      .min(30)
      .max(365)
      .optional()
      .describe("Override archive retention (default: 180 days)"),
    jobRunRetentionDays: z
      .number()
      .int()
      .min(7)
      .max(180)
      .optional()
      .describe("Override job_runs/job_events retention (default: 60 days)"),
    ttlCleanupEnabled: z.boolean().optional().describe("Override TTL cleanup setting (default: true)"),
  }),
  execute: async (args, ctx) => {
    const db = ctx.db as NexusDatabase | undefined;
    if (!db) return "ERROR: database is not available";

    const nowMs = ctx.nowMs();

    if (args.action === "status") {
      const status = getMaintenanceStatus({ db, nowMs });
      return JSON.stringify(
        {
          lastRun: status.lastRun
            ? {
                ...status.lastRun,
                created_at_iso: new Date(status.lastRun.created_at).toISOString(),
              }
            : null,
          nextScheduledRun: status.nextScheduledRun
            ? {
                ms: status.nextScheduledRun,
                iso: new Date(status.nextScheduledRun).toISOString(),
              }
            : null,
          recentSummaries: status.recentSummaries.map((s) => ({
            ...s,
            created_at_iso: new Date(s.created_at).toISOString(),
          })),
        },
        null,
        2,
      );
    }

    // Run maintenance
    const config: MaintenanceConfig = {
      archiveRetentionDays: args.archiveRetentionDays ?? 180,
      jobRunRetentionDays: args.jobRunRetentionDays ?? 60,
      ttlCleanupEnabled: args.ttlCleanupEnabled ?? true,
    };

    const result = await runMaintenance({
      db,
      stateDir: ctx.stateDir,
      config,
      nowMs,
      dryRun: args.dryRun,
      log: ctx.log,
    });

    return JSON.stringify(result);
  },
});
