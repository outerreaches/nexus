import type { Hono } from "hono";
import type { GatewayHttpDeps } from "../http.js";

export function registerHealthRoutes(app: Hono, deps: GatewayHttpDeps): void {
  app.get("/healthz", (c) => c.json({ ok: true }));

  // Liveness: HTTP server is responding
  app.get("/health/live", (c) => {
    return c.json({ ok: true, timestamp: Date.now() });
  });

  // Traffic health: failover/routing critical checks only.
  // This endpoint intentionally excludes operational degradation checks
  // (backup age, memory thresholds, stuck agents, proactive lag).
  app.get("/health/traffic", async (c) => {
    const checks: Record<string, { ok: boolean; error?: string; details?: unknown }> = {};
    const nowMs = Date.now();
    let mode = "unknown";

    try {
      if (deps.db) {
        const stmt = deps.db.db.prepare("SELECT 1 as test");
        stmt.get();
        checks.database = { ok: true };
      } else {
        checks.database = { ok: false, error: "no database connection" };
      }
    } catch (err) {
      checks.database = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const statusRaw = await deps.getStatus();
      const status =
        statusRaw && typeof statusRaw === "object" && !Array.isArray(statusRaw)
          ? (statusRaw as Record<string, unknown>)
          : {};
      mode = typeof status.mode === "string" ? status.mode : "unknown";
      const activeLeaseRaw = status.activeLease;
      const activeLease =
        activeLeaseRaw && typeof activeLeaseRaw === "object" && !Array.isArray(activeLeaseRaw)
          ? (activeLeaseRaw as Record<string, unknown>)
          : {};
      const leaseHeld = typeof activeLease.held === "boolean" ? activeLease.held : null;

      if (mode !== "active") {
        checks.role = { ok: false, error: `instance mode=${mode}` };
        checks.lease = { ok: true, details: { held: leaseHeld, mode } };
      } else {
        checks.role = { ok: true, details: { mode } };
        if (leaseHeld === false) {
          checks.lease = { ok: false, error: "active mode without held lease" };
        } else {
          checks.lease = { ok: true, details: { held: leaseHeld } };
        }
      }
    } catch (err) {
      checks.role = { ok: false, error: "status unavailable" };
      checks.lease = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const allOk = Object.values(checks).every((check) => check.ok);
    return c.json({ ok: allOk, checks, timestamp: nowMs }, allOk ? 200 : 503);
  });

  // Readiness: full operational check.
  app.get("/health/ready", async (c) => {
    const checks: Record<string, { ok: boolean; error?: string; details?: unknown }> = {};
    const nowMs = Date.now();
    let mode = "unknown";

    // Check 1: Database accessible
    try {
      if (deps.db) {
        const stmt = deps.db.db.prepare("SELECT 1 as test");
        stmt.get();
        checks.database = { ok: true };
      } else {
        checks.database = { ok: false, error: "no database connection" };
      }
    } catch (err) {
      checks.database = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Check 2: No stuck agents (running > 30 minutes)
    const stuckThresholdMs = 30 * 60 * 1000;
    const activeAgents = deps.agentTracker?.listActive() ?? [];
    const stuckAgents = activeAgents.filter((a) => nowMs - a.startedAt > stuckThresholdMs);
    if (stuckAgents.length > 0) {
      checks.agents = { ok: false, error: `${stuckAgents.length} stuck agents (>30min)` };
    } else {
      checks.agents = { ok: true, details: { active: activeAgents.length } };
    }

    // Check 3: Scheduler status (from status object)
    try {
      const status = await deps.getStatus();
      const schedulerEnabled = (status.scheduler as { enabled?: boolean })?.enabled ?? false;
      mode = (status.mode as string) || "unknown";

      // In HA mode, only the active instance should be considered ready for traffic.
      if (mode !== "active") {
        checks.role = { ok: false, error: `instance mode=${mode}` };
      } else {
        checks.role = { ok: true, details: { mode } };
      }

      if (mode === "active" && !schedulerEnabled) {
        checks.scheduler = { ok: false, error: "scheduler disabled while active" };
      } else {
        checks.scheduler = { ok: true, details: { enabled: schedulerEnabled, mode } };
      }

      // Check 4: Proactive heartbeat status
      const proactive = status.proactive as { enabled?: boolean; paused?: boolean; lastTickAt?: number; maxIntervalMs?: number } | undefined;
      if (proactive?.enabled && !proactive?.paused) {
        const lastTickAge = proactive.lastTickAt ? nowMs - proactive.lastTickAt : null;
        const maxHeartbeatAge = (proactive.maxIntervalMs ?? 300000) * 3;
        if (lastTickAge !== null && lastTickAge > maxHeartbeatAge) {
          checks.proactive = { ok: false, error: `heartbeat stale (${Math.round(lastTickAge / 1000)}s ago)` };
        } else {
          checks.proactive = { ok: true, details: { lastTickAge: lastTickAge ? Math.round(lastTickAge / 1000) : null } };
        }
      } else {
        checks.proactive = { ok: true, details: { enabled: proactive?.enabled ?? false, paused: proactive?.paused ?? false } };
      }
    } catch {
      checks.role = { ok: false, error: "status unavailable" };
      checks.scheduler = { ok: true, details: { status: "unknown" } };
      checks.proactive = { ok: true, details: { status: "unknown" } };
    }

    // Check 5: Memory usage
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const memoryThresholdMB = Number(process.env.NEXUS_MEMORY_THRESHOLD_MB) || 2048;
    if (heapUsedMB > memoryThresholdMB) {
      checks.memory = { ok: false, error: `heap usage ${heapUsedMB}MB exceeds threshold ${memoryThresholdMB}MB` };
    } else {
      checks.memory = { ok: true, details: { heapUsedMB, thresholdMB: memoryThresholdMB } };
    }

    // Check 6: Database backup age
    try {
      if (deps.db) {
        const lastBackup = deps.db.db
          .prepare("SELECT completed_at FROM db_backups WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1")
          .get() as { completed_at: number } | undefined;
        const latestBackup = deps.db.db
          .prepare("SELECT status, created_at, completed_at, error FROM db_backups ORDER BY created_at DESC LIMIT 1")
          .get() as { status: string; created_at: number; completed_at: number | null; error: string | null } | undefined;
        const recentBackups = deps.db.db
          .prepare("SELECT status FROM db_backups ORDER BY created_at DESC LIMIT 20")
          .all() as { status: string }[];
        const maxFailureStreak = Math.max(1, Number(process.env.NEXUS_BACKUP_FAILURE_STREAK_THRESHOLD) || 3);
        let failureStreak = 0;
        for (const row of recentBackups) {
          if (row.status === "failed") failureStreak += 1;
          else break;
        }
        const maxBackupAgeMs = 48 * 60 * 60 * 1000; // 48 hours
        if (!latestBackup) {
          checks.backup = { ok: true, details: { status: "no backups yet" } };
        } else if (!lastBackup) {
          if (latestBackup.status === "running") {
            checks.backup = {
              ok: true,
              details: {
                status: "running",
                startedAt: latestBackup.created_at,
              },
            };
          } else {
            checks.backup = {
              ok: false,
              error: "no successful backups yet",
              details: { latestStatus: latestBackup.status, failureStreak, latestError: latestBackup.error },
            };
          }
        } else {
          const backupAgeMs = nowMs - lastBackup.completed_at;
          if (failureStreak >= maxFailureStreak) {
            checks.backup = {
              ok: false,
              error: `${failureStreak} consecutive backup failures`,
              details: {
                latestStatus: latestBackup.status,
                ageHours: Math.round(backupAgeMs / 3600000),
                threshold: maxFailureStreak,
              },
            };
          } else if (backupAgeMs > maxBackupAgeMs) {
            checks.backup = { ok: false, error: `backup too old (${Math.round(backupAgeMs / 3600000)}h ago)` };
          } else {
            checks.backup = {
              ok: true,
              details: {
                ageHours: Math.round(backupAgeMs / 3600000),
                latestStatus: latestBackup.status,
                failureStreak,
              },
            };
          }
        }
      } else {
        checks.backup = { ok: false, error: "no database connection" };
      }
    } catch (err) {
      checks.backup = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    return c.json({ ok: allOk, checks, timestamp: nowMs }, allOk ? 200 : 503);
  });
}
