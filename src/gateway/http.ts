import { Hono } from "hono";
import { serve } from "@hono/node-server";
import path from "node:path";
import fs from "node:fs/promises";
import type { NexusDatabase } from "../storage/database.js";
import type { ProcessManager, ManagedProcessInfo } from "../process/manager.js";
import type { AgentTracker, AgentRunInfo } from "../core/agent-tracker.js";
import { initDataIntake, listDataSources } from "../data-intake/index.js";
import { listLatestDataItemsPerSource, deleteDataItemsBySource } from "../data-intake/store.js";
import { createIntakeSource, deleteIntakeSource, listIntakeSources, updateIntakeSource } from "../data-intake/source-store.js";

export type GatewayHttpDeps = {
  port: number;
  stateDir: string;
  getStatus: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  log: (msg: string) => void;
  db?: NexusDatabase;
  processManager?: ProcessManager;
  agentTracker?: AgentTracker;
};

export async function startHttpServer(deps: GatewayHttpDeps): Promise<{ stop: () => Promise<void>; listen: () => void; app: Hono }> {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  // Health check endpoints for fault tolerance / watchdog
  app.get("/health/live", (c) => {
    // Liveness: HTTP server is responding
    return c.json({ ok: true, timestamp: Date.now() });
  });

  app.get("/health/ready", async (c) => {
    // Readiness: full system check
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

  app.get("/status", async (c) => c.json(await deps.getStatus()));

  // JSON API for live agent graph updates (used by dashboard for smooth refresh)
  app.get("/api/agents", async (c) => {
    const nowMs = Date.now();
    const agentWindowMinutes = clampInt(c.req.query("agentWindowMinutes"), 10, 24 * 60) ?? 360;
    const agents = listAgents(deps.agentTracker, nowMs, agentWindowMinutes * 60_000);
    const allowedRunIds = new Set([...agents.active, ...agents.recent].map((r) => r.runId));
    const agentGraph = listAgentGraph(deps.db, allowedRunIds);

    const nodes = agentGraph.map(({ run_id, parent_run_id, agent_id, preset, status, started_at, ended_at, task }) => ({
      run_id,
      parent_run_id,
      agent_id,
      preset,
      status,
      started_at,
      ended_at,
      task,
    }));

    const stats = {
      running: agentGraph.filter((a) => a.status === "running").length,
      complete: agentGraph.filter((a) => a.status === "complete").length,
      failed: agentGraph.filter((a) => a.status === "failed" || a.status === "stopped").length,
      total: agentGraph.length,
    };

    // Include table data for live updates
    const formatAgentRow = (r: AgentRunInfo) => ({
      status: r.status,
      agentId: r.agentId,
      preset: r.preset,
      channel: `${r.channel}:${r.channelKey}`,
      task: r.task,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      toolCallsUsed: r.toolCallsUsed,
      iterationsUsed: r.iterationsUsed,
    });

    const tables = {
      active: agents.active.map(formatAgentRow),
      recent: agents.recent.map(formatAgentRow),
    };

    return c.json({ nodes, stats, tables, timestamp: nowMs });
  });

  app.get("/api/logs", async (c) => {
    const maxChars = clampInt(c.req.query("maxChars"), 200, 200_000) ?? 50_000;
    const logPath = path.join(deps.stateDir, "gateway.log");
    try {
      const buf = await fs.readFile(logPath);
      const text = buf.toString("utf8");
      return c.text(text.length > maxChars ? text.slice(-maxChars) : text);
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT") {
        return c.text("No logs found.");
      }
      return c.text(`ERROR: ${err instanceof Error ? err.message : String(err)}`, 500);
    }
  });

  app.get("/api/job-runs/export.csv", async (c) => {
    const limit = clampInt(c.req.query("limit"), 1, 10000) ?? 1000;
    const rows = listJobRuns(deps.db, limit);

    const csvHeader = "id,job_id,owner_agent_id,scheduled_for,started_at,ended_at,status,error,tool_calls_used,iterations_used";
    const csvRows = rows.map((r) => {
      const escapeCsv = (s: string | null | undefined) => {
        if (s == null) return "";
        const str = String(s);
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };
      return [
        escapeCsv(r.id),
        escapeCsv(r.job_id),
        escapeCsv(r.owner_agent_id),
        r.scheduled_for ?? "",
        r.started_at ?? "",
        r.ended_at ?? "",
        escapeCsv(r.status),
        escapeCsv(r.error),
        r.tool_calls_used ?? "",
        r.iterations_used ?? "",
      ].join(",");
    });

    const csv = [csvHeader, ...csvRows].join("\n");
    c.header("Content-Type", "text/csv");
    c.header("Content-Disposition", `attachment; filename="job-runs-${new Date().toISOString().slice(0, 10)}.csv"`);
    return c.body(csv);
  });

  app.get("/dashboard", async (c) => {
    const status = await deps.getStatus();
    const nowMs = Date.now();

    initDataIntake();
    const dataIntakeCatalog = listDataSources().map((source) => ({
      id: source.id,
      name: source.name,
      description: source.description,
      usageNote: source.usageNote,
      tags: source.tags,
    }));

    const processWindowMinutes = clampInt(c.req.query("processWindowMinutes"), 5, 24 * 60) ?? 120;
    const agentWindowMinutes = clampInt(c.req.query("agentWindowMinutes"), 10, 24 * 60) ?? 360;
    const jobLimit = clampInt(c.req.query("jobLimit"), 1, 200) ?? 50;
    const runLimit = clampInt(c.req.query("runLimit"), 1, 200) ?? 50;
    const blackboardLimit = clampInt(c.req.query("blackboardLimit"), 1, 200) ?? 50;
    const blackboardScopeRaw = String(c.req.query("blackboardScope") ?? "").trim();
    const blackboardScope = blackboardScopeRaw && blackboardScopeRaw !== "all" ? blackboardScopeRaw : null;
    const dataIntakeLimit = clampInt(c.req.query("dataIntakeLimit"), 1, 200) ?? 50;
    const hideOrphanData = c.req.query("hideOrphanData") === "true";

    const processes = listProcesses(deps.processManager, nowMs, processWindowMinutes * 60_000);
    const agents = listAgents(deps.agentTracker, nowMs, agentWindowMinutes * 60_000);
    const allowedRunIds = new Set([...agents.active, ...agents.recent].map((r) => r.runId));
    const agentGraph = listAgentGraph(deps.db, allowedRunIds);
    const jobs = listJobs(deps.db, jobLimit);
    const runningJobRuns = listRunningJobRuns(deps.db);
    const dataIntake = listDataIntake(deps.db, nowMs, dataIntakeLimit, hideOrphanData);
    const blackboard = listBlackboard(deps.db, blackboardLimit, blackboardScope);
    const blackboardScopes = listBlackboardScopes(deps.db, 100);

    return c.html(
      renderDashboard({
        status,
        nowMs,
        processWindowMinutes,
        agentWindowMinutes,
        processes,
        agents,
        agentGraph,
        jobs,
        runningJobRuns,
        dataIntake,
        dataIntakeCatalog,
        blackboard,
        blackboardScope: blackboardScopeRaw || "all",
        blackboardScopes,
        blackboardLimit,
        jobLimit,
        runLimit,
        dataIntakeLimit,
        hideOrphanData,
        db: deps.db,
      }),
    );
  });

  app.post("/dashboard/blackboard/clear", async (c) => {
    if (!deps.db) return c.text("Database not available", 500);
    const body = await c.req.parseBody();
    const scopeRaw = String(body.scope ?? "all").trim();
    if (!scopeRaw || scopeRaw === "all") {
      deps.db.db.prepare("DELETE FROM blackboard").run();
    } else {
      deps.db.db.prepare("DELETE FROM blackboard WHERE session_scope = ?").run(scopeRaw);
    }
    return c.redirect("/dashboard");
  });

  app.post("/dashboard/data-intake/add", async (c) => {
    if (!deps.db) return c.text("Database not available", 500);
    initDataIntake();
    const body = await c.req.parseBody();
    const sourceId = String(body.sourceId ?? "").trim();
    const label = String(body.label ?? "").trim() || undefined;
    const intervalMsRaw = String(body.intervalMs ?? "").trim();
    const paramsRaw = String(body.paramsJson ?? "").trim();
    if (!sourceId) return c.text("Missing sourceId", 400);
    let params: Record<string, unknown> = {};
    if (paramsRaw) {
      try {
        params = JSON.parse(paramsRaw) as Record<string, unknown>;
      } catch (err) {
        return c.text(`Invalid params JSON: ${err instanceof Error ? err.message : String(err)}`, 400);
      }
    }
    const intervalMs = intervalMsRaw ? Number(intervalMsRaw) : undefined;
    if (intervalMsRaw && (!Number.isFinite(intervalMs ?? NaN) || (intervalMs ?? 0) <= 0)) {
      return c.text("Invalid intervalMs", 400);
    }
    createIntakeSource({
      db: deps.db,
      sourceId,
      label,
      params,
      intervalMs: intervalMs ?? 15 * 60_000,
      nowMs: Date.now(),
    });
    return c.redirect("/dashboard");
  });

  app.post("/dashboard/data-intake/update", async (c) => {
    if (!deps.db) return c.text("Database not available", 500);
    const body = await c.req.parseBody();
    const id = String(body.id ?? "").trim();
    if (!id) return c.text("Missing id", 400);
    const enabledRaw = String(body.enabled ?? "").trim();
    const enabled = enabledRaw ? enabledRaw === "true" : undefined;
    const intervalMsRaw = String(body.intervalMs ?? "").trim();
    const intervalMs = intervalMsRaw ? Number(intervalMsRaw) : undefined;
    if (intervalMsRaw && (!Number.isFinite(intervalMs ?? NaN) || (intervalMs ?? 0) <= 0)) {
      return c.text("Invalid intervalMs", 400);
    }
    const labelRaw = String(body.label ?? "").trim();
    const paramsRaw = String(body.paramsJson ?? "").trim();
    let paramsJson: string | undefined;
    if (paramsRaw) {
      try {
        paramsJson = JSON.stringify(JSON.parse(paramsRaw));
      } catch (err) {
        return c.text(`Invalid params JSON: ${err instanceof Error ? err.message : String(err)}`, 400);
      }
    }
    updateIntakeSource({
      db: deps.db,
      id,
      enabled,
      intervalMs,
      label: labelRaw || undefined,
      paramsJson,
      nowMs: Date.now(),
    });
    return c.redirect("/dashboard");
  });

  app.post("/dashboard/data-intake/delete", async (c) => {
    if (!deps.db) return c.text("Database not available", 500);
    const body = await c.req.parseBody();
    const id = String(body.id ?? "").trim();
    if (!id) return c.text("Missing id", 400);
    try {
      const ok = deleteIntakeSource({ db: deps.db, id });
      if (!ok) return c.text("Source not found", 404);
    } catch (err) {
      return c.text(`Delete failed: ${err instanceof Error ? err.message : String(err)}`, 500);
    }
    return c.redirect("/dashboard");
  });

  app.post("/dashboard/data-intake/clean-data", async (c) => {
    if (!deps.db) return c.text("Database not available", 500);
    const body = await c.req.parseBody();
    const sourceId = String(body.sourceId ?? "").trim();
    if (!sourceId) return c.text("Missing sourceId", 400);
    const deleted = deleteDataItemsBySource({ db: deps.db, sourceId });
    deps.log(`data-intake: cleaned ${deleted} items for source ${sourceId}`);
    return c.redirect("/dashboard");
  });

  app.post("/dashboard/data-intake/clean-orphans", async (c) => {
    if (!deps.db) return c.text("Database not available", 500);
    // Get all source IDs that still exist
    const sources = listIntakeSources({ db: deps.db, includeDisabled: true });
    const existingSourceIds = new Set(sources.map((s) => s.source_id));
    // Get all distinct source IDs in data_items
    const allDataSourceIds = deps.db.db
      .prepare("SELECT DISTINCT source_id FROM data_items")
      .all() as { source_id: string }[];
    // Delete data for sources that no longer exist
    let totalDeleted = 0;
    for (const row of allDataSourceIds) {
      if (!existingSourceIds.has(row.source_id)) {
        const deleted = deleteDataItemsBySource({ db: deps.db, sourceId: row.source_id });
        totalDeleted += deleted;
        deps.log(`data-intake: cleaned ${deleted} orphan items for source ${row.source_id}`);
      }
    }
    deps.log(`data-intake: cleaned ${totalDeleted} total orphan items`);
    return c.redirect("/dashboard");
  });



  app.post("/dashboard/jobs/delete", async (c) => {
    if (!deps.db) return c.text("Database not available", 500);
    const body = await c.req.parseBody();
    const id = String(body.id ?? "").trim();
    if (!id) return c.text("Missing id", 400);
    try {
      // Prevent deleting jobs that back a data intake source (they are managed via the Data Intake panel).
      const linked = deps.db.db
        .prepare("SELECT id, source_id, label FROM data_intake_sources WHERE job_id = ? LIMIT 1")
        .get(id) as { id: string; source_id: string; label: string | null } | undefined;
      if (linked) {
        const label = linked.label ?? linked.source_id;
        return c.text(
          `Delete failed: job is linked to data intake source '${label}' (instance ${linked.id}). Delete the source from the Data Intake panel instead.`,
          400,
        );
      }

      const tx = deps.db.db.transaction(() => {
        // Delete events first to be compatible with schemas where job_events.run_id may reference job_runs(id).
        deps.db!.db.prepare("DELETE FROM job_events WHERE job_id = ?").run(id);
        deps.db!.db.prepare("DELETE FROM job_runs WHERE job_id = ?").run(id);
        deps.db!.db.prepare("DELETE FROM job_leases WHERE job_id = ?").run(id);
        deps.db!.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
      });
      tx();
    } catch (err) {
      return c.text(`Delete failed: ${err instanceof Error ? err.message : String(err)}`, 500);
    }
    return c.redirect("/dashboard");
  });

  app.post("/dashboard/jobs/toggle", async (c) => {
    if (!deps.db) return c.text("Database not available", 500);
    const body = await c.req.parseBody();
    const id = String(body.id ?? "").trim();
    const enabled = body.enabled === "true" ? 1 : 0;
    if (!id) return c.text("Missing id", 400);
    deps.db.db.prepare("UPDATE jobs SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled, Date.now(), id);
    return c.redirect("/dashboard");
  });

  let server: ReturnType<typeof serve> | null = null;

  return {
    listen: () => {
      server = serve({
        fetch: app.fetch,
        port: deps.port,
      });
      deps.log(`http: listening on :${deps.port}`);
    },
    stop: async () => {
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
    },
    app,
  };
}

type JobRow = {
  id: string;
  owner_agent_id: string;
  name: string;
  cron: string;
  timezone: string;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  consecutive_failures: number;
  last_failure_at: number | null;
  spec_json: string;
};

type JobRunRow = {
  id: string;
  job_id: string;
  owner_agent_id: string;
  scheduled_for: number;
  started_at: number;
  ended_at: number | null;
  status: string;
  error: string | null;
  tool_calls_used: number | null;
  iterations_used: number | null;
};

type AgentRunRow = {
  run_id: string;
  parent_run_id: string | null;
  agent_id: string;
  preset: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  task: string | null;
};

type BlackboardRow = {
  id: string;
  session_scope: string;
  type: string;
  agent_id: string;
  agent_preset: string;
  title: string;
  content: string;
  created_at: number;
  expires_at: number | null;
};

type DataIntakeRow = {
  source_id: string;
  source_name: string;
  tags_json: string;
  subject: string;
  value_json: string;
  collected_at: number;
  expires_at: number;
};

type DataIntakePanelState = {
  enabled: boolean;
  targets: string[];
  rows: DataIntakeRow[];
  hideOrphans: boolean;
  sources: {
    id: string;
    source_id: string;
    label: string | null;
    params_json: string;
    interval_ms: number;
    enabled: number;
    last_run_at: number | null;
    last_error: string | null;
  }[];
};

type DataIntakeCatalogEntry = {
  id: string;
  name: string;
  description: string;
  tags: string[];
};

function listProcesses(manager: ProcessManager | undefined, nowMs: number, windowMs: number): ManagedProcessInfo[] {
  if (!manager) return [];
  const cutoff = nowMs - windowMs;
  return manager
    .list()
    .filter((p) => p.status === "running" || (p.endedAt !== null && p.endedAt >= cutoff));
}

function listAgents(tracker: AgentTracker | undefined, nowMs: number, windowMs: number): { active: AgentRunInfo[]; recent: AgentRunInfo[] } {
  if (!tracker) return { active: [], recent: [] };
  return {
    active: tracker.listActive(),
    recent: tracker.listRecent({ sinceMs: nowMs - windowMs, limit: 200 }),
  };
}

function listAgentGraph(db: NexusDatabase | undefined, allowedRunIds: Set<string>): AgentRunRow[] {
  if (!db) return [];
  if (allowedRunIds.size === 0) return [];
  const ids = [...allowedRunIds];
  const placeholders = ids.map(() => "?").join(", ");
  return db.db
    .prepare(
      `SELECT run_id, parent_run_id, agent_id, preset, status, started_at, ended_at, task FROM agent_runs WHERE run_id IN (${placeholders}) ORDER BY started_at ASC`,
    )
    .all(...ids) as AgentRunRow[];
}

function listJobs(db: NexusDatabase | undefined, limit: number): JobRow[] {
  if (!db) return [];
  return db.db
    .prepare(
      "SELECT id, owner_agent_id, name, cron, timezone, enabled, next_run_at, last_run_at, consecutive_failures, last_failure_at, spec_json FROM jobs ORDER BY created_at DESC LIMIT ?",
    )
    .all(limit) as JobRow[];
}

function listJobRuns(db: NexusDatabase | undefined, limit: number): JobRunRow[] {
  if (!db) return [];
  return db.db
    .prepare(
      "SELECT id, job_id, owner_agent_id, scheduled_for, started_at, ended_at, status, error, tool_calls_used, iterations_used FROM job_runs ORDER BY started_at DESC LIMIT ?",
    )
    .all(limit) as JobRunRow[];
}

function listRunningJobRuns(db: NexusDatabase | undefined): JobRunRow[] {
  if (!db) return [];
  return db.db
    .prepare(
      "SELECT id, job_id, owner_agent_id, scheduled_for, started_at, ended_at, status, error, tool_calls_used, iterations_used FROM job_runs WHERE status = 'running' ORDER BY started_at DESC",
    )
    .all() as JobRunRow[];
}

function listBlackboard(db: NexusDatabase | undefined, limit: number, scope?: string | null): BlackboardRow[] {
  if (!db) return [];
  if (scope) {
    return db.db
      .prepare(
        "SELECT id, session_scope, type, agent_id, agent_preset, title, content, created_at, expires_at FROM blackboard WHERE session_scope = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(scope, limit) as BlackboardRow[];
  }
  return db.db
    .prepare(
      "SELECT id, session_scope, type, agent_id, agent_preset, title, content, created_at, expires_at FROM blackboard ORDER BY created_at DESC LIMIT ?",
    )
    .all(limit) as BlackboardRow[];
}

function listBlackboardScopes(db: NexusDatabase | undefined, limit: number): string[] {
  if (!db) return [];
  const rows = db.db
    .prepare(
      "SELECT session_scope, MAX(created_at) AS last_seen FROM blackboard GROUP BY session_scope ORDER BY last_seen DESC LIMIT ?",
    )
    .all(limit) as { session_scope: string }[];
  return rows.map((r) => r.session_scope);
}

function listDataIntake(
  db: NexusDatabase | undefined,
  nowMs: number,
  limit: number,
  hideOrphans: boolean,
): DataIntakePanelState {
  if (!db) return { enabled: true, targets: [], rows: [], sources: [], hideOrphans };
  let rows = listLatestDataItemsPerSource({
    db,
    includeExpired: false,
    limit,
    nowMs,
  }) as unknown as DataIntakeRow[];
  const sources = listIntakeSources({ db, includeDisabled: true }).map((row) => ({
    id: row.id,
    source_id: row.source_id,
    label: row.label,
    params_json: row.params_json,
    interval_ms: row.interval_ms,
    enabled: row.enabled,
    last_run_at: row.last_run_at,
    last_error: row.last_error,
  }));
  // Filter orphaned rows if toggle is on
  if (hideOrphans) {
    const sourceIds = new Set(sources.map((s) => s.source_id));
    rows = rows.filter((r) => sourceIds.has(r.source_id));
  }
  return { enabled: true, targets: sources.map((row) => row.source_id), rows, sources, hideOrphans };
}

function renderDashboard(params: {
  status: Record<string, unknown>;
  nowMs: number;
  processWindowMinutes: number;
  agentWindowMinutes: number;
  jobLimit: number;
  runLimit: number;
  blackboardLimit: number;
  dataIntakeLimit: number;
  hideOrphanData: boolean;
  processes: ManagedProcessInfo[];
  agents: { active: AgentRunInfo[]; recent: AgentRunInfo[] };
  agentGraph: AgentRunRow[];
  jobs: JobRow[];
  runningJobRuns: JobRunRow[];
  dataIntake: DataIntakePanelState;
  dataIntakeCatalog: DataIntakeCatalogEntry[];
  blackboard: BlackboardRow[];
  blackboardScope: string;
  blackboardScopes: string[];
  db?: NexusDatabase;
}): string {
  const updatedAt = new Date(params.nowMs).toISOString();
  const statusJson = escapeHtml(JSON.stringify(params.status, null, 2));
  const modeRaw = String((params.status as { mode?: string }).mode ?? "unknown").toLowerCase();
  const modeLabel = modeRaw === "active" ? "ACTIVE" : modeRaw === "standby" ? "STANDBY" : modeRaw.toUpperCase();
  const modeClass = modeRaw === "active" ? "active" : modeRaw === "standby" ? "standby" : "unknown";
  const hasAgents = params.agents.active.length + params.agents.recent.length > 0;
  const heartbeat = (params.status as { proactive?: { enabled?: boolean; paused?: boolean; lastTickAt?: number | null; nextTickAt?: number | null; lastStatus?: string } })
    .proactive ?? { enabled: false };
  const heartbeatLabel = heartbeat.enabled ? (heartbeat.paused ? "Heartbeat (paused)" : "Heartbeat") : "Heartbeat (disabled)";
  const heartbeatLast = heartbeat.lastTickAt ? new Date(heartbeat.lastTickAt).toISOString() : "-";
  const heartbeatNext = heartbeat.nextTickAt ? new Date(heartbeat.nextTickAt).toISOString() : "-";
  const heartbeatStatus = heartbeat.lastStatus ? String(heartbeat.lastStatus) : "-";
  const heartbeatPanelClass = heartbeat.enabled ? (heartbeat.paused ? "paused" : "running") : "";
  const blackboardScopeValue = params.blackboardScope || "all";
  const blackboardClearMessage = blackboardScopeValue === "all"
    ? "Clear ALL blackboard entries?"
    : `Clear blackboard scope "${blackboardScopeValue}"?`;
  const blackboardClearConfirm = safeJsonForScript(blackboardClearMessage);
  const blackboardScopeOptions = Array.from(new Set(["all", ...params.blackboardScopes.filter(Boolean)]))
    .map((scope) => `<option value="${escapeHtml(scope)}"></option>`)
    .join("");
  const dashboardQueryInputs = [
    ["processWindowMinutes", params.processWindowMinutes],
    ["agentWindowMinutes", params.agentWindowMinutes],
    ["jobLimit", params.jobLimit],
    ["runLimit", params.runLimit],
    ["blackboardLimit", params.blackboardLimit],
    ["dataIntakeLimit", params.dataIntakeLimit],
    ["hideOrphanData", params.hideOrphanData ? "true" : "false"],
  ]
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${escapeHtml(String(value))}" />`)
    .join("");

  // Compute stats from agent graph
  const agentStats = {
    running: params.agentGraph.filter((a) => a.status === "running").length,
    complete: params.agentGraph.filter((a) => a.status === "complete").length,
    failed: params.agentGraph.filter((a) => a.status === "failed" || a.status === "stopped").length,
    total: params.agentGraph.length,
  };
  const agentStatsJson = safeJsonForScript(agentStats);

  const agentGraphJson = safeJsonForScript(
    params.agentGraph.map(({ run_id, parent_run_id, agent_id, preset, status, started_at, ended_at, task }) => ({
      run_id,
      parent_run_id,
      agent_id,
      preset,
      status,
      started_at,
      ended_at,
      task,
    })),
  );

  // HA section data
  const leaseInfo = (params.status as { activeLease?: { key: string; holderId: string; held: boolean; expiresAt: number | null; ttlMs: number; renewMs: number } }).activeLease ?? {
    key: "gateway_active",
    holderId: "unknown",
    held: false,
    expiresAt: null,
    ttlMs: 45000,
    renewMs: 15000,
  };
  const haEvents = listHAEvents(params.db, 20);
  const lastBackup = getLastBackup(params.db);
  const backupAgeMs = lastBackup?.completed_at ? params.nowMs - lastBackup.completed_at : null;
  const backupAgeHours = backupAgeMs ? Math.round(backupAgeMs / 3600000) : null;
  const backupStatus = lastBackup?.status ?? "none";
  const backupStatusClass = backupStatus === "completed" ? "enabled" : backupStatus === "failed" ? "failed" : "disabled";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />

    <title>Nexus Dashboard</title>
    <script type="importmap">
      {
        "imports": {
          "three": "https://unpkg.com/three@0.161.0/build/three.module.js"
        }
      }
    </script>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap');
      :root {
        color-scheme: dark;
        --bg: #0a0a0a;
        --panel: #0d0d0d;
        --text: #00ff41;
        --text-dim: #00cc33;
        --muted: #00aa2a;
        --accent: #00ff41;
        --ok: #00ff41;
        --warn: #ffb800;
        --err: #ff0040;
        --info: #00d4ff;
        --line: #003311;
        --glow: 0 0 10px rgba(0, 255, 65, 0.5);
        --glow-strong: 0 0 20px rgba(0, 255, 65, 0.8), 0 0 40px rgba(0, 255, 65, 0.4);
      }
      @keyframes flicker {
        0%, 100% { opacity: 1; }
        92% { opacity: 1; }
        93% { opacity: 0.8; }
        94% { opacity: 1; }
        97% { opacity: 0.9; }
        98% { opacity: 1; }
      }
      @keyframes scanline {
        0% { transform: translateY(-100%); }
        100% { transform: translateY(100vh); }
      }
      @keyframes pulse-glow {
        0%, 100% { text-shadow: var(--glow); }
        50% { text-shadow: var(--glow-strong); }
      }
      @keyframes heartbeat-pulse {
        0%, 100% { box-shadow: 0 0 8px rgba(255, 60, 60, 0.3); }
        50% { box-shadow: 0 0 16px rgba(255, 60, 60, 0.6), 0 0 24px rgba(255, 60, 60, 0.3); }
      }
      body {
        font-family: 'Share Tech Mono', 'Courier New', monospace;
        margin: 0;
        background: var(--bg);
        color: var(--text);
        animation: flicker 8s infinite;
        position: relative;
      }
      body::before {
        content: '';
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: repeating-linear-gradient(
          0deg,
          rgba(0, 0, 0, 0.15),
          rgba(0, 0, 0, 0.15) 1px,
          transparent 1px,
          transparent 2px
        );
        pointer-events: none;
        z-index: 1000;
      }
      body::after {
        content: '';
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 100px;
        background: linear-gradient(
          180deg,
          rgba(0, 255, 65, 0.03) 0%,
          transparent 100%
        );
        animation: scanline 8s linear infinite;
        pointer-events: none;
        z-index: 1001;
      }
      header {
        padding: 24px 32px;
        border-bottom: 1px solid var(--line);
        background: linear-gradient(180deg, #0d120d 0%, #0a0a0a 100%);
        box-shadow: 0 2px 20px rgba(0, 255, 65, 0.1);
      }
      h1 {
        margin: 0 0 8px;
        font-size: 28px;
        text-transform: uppercase;
        letter-spacing: 4px;
        text-shadow: var(--glow-strong);
        animation: pulse-glow 3s ease-in-out infinite;
      }
      h1::before {
        content: '> ';
        color: var(--muted);
      }
      h2, h3 {
        text-transform: uppercase;
        letter-spacing: 2px;
        text-shadow: var(--glow);
      }
      .mode-pill {
        float: right;
        display: inline-block;
        margin-left: 12px;
        font-size: 11px;
        letter-spacing: 2px;
        text-transform: uppercase;
        padding: 6px 12px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: #050805;
        box-shadow: 0 0 12px rgba(0, 255, 65, 0.08);
      }
      .mode-pill.active {
        color: var(--ok);
        border-color: rgba(0, 255, 65, 0.6);
        box-shadow: 0 0 16px rgba(0, 255, 65, 0.35);
      }
      .mode-pill.standby {
        color: var(--warn);
        border-color: rgba(255, 184, 0, 0.6);
        box-shadow: 0 0 16px rgba(255, 184, 0, 0.3);
      }
      .mode-pill.unknown {
        color: var(--muted);
      }
      .meta {
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 1px;
      }
      .meta::before {
        content: '// ';
      }
      main {
        padding: 24px 32px 48px;
        display: grid;
        gap: 20px;
      }
      section {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 4px;
        padding: 16px 18px;
        box-shadow: 0 0 30px rgba(0, 255, 65, 0.05), inset 0 0 60px rgba(0, 0, 0, 0.5);
        position: relative;
      }
      section::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 1px;
        background: linear-gradient(90deg, transparent, var(--text), transparent);
        opacity: 0.5;
      }
      section h2 {
        margin: 0 0 12px;
        font-size: 16px;
        border-bottom: 1px solid var(--line);
        padding-bottom: 8px;
      }
      section h2::before {
        content: '[';
        color: var(--muted);
      }
      section h2::after {
        content: ']';
        color: var(--muted);
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      th, td {
        text-align: left;
        padding: 8px 6px;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
      }
      th {
        font-weight: 600;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 1px;
        font-size: 10px;
      }
      tr:hover td {
        background: rgba(0, 255, 65, 0.05);
      }
      .badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 2px;
        font-size: 10px;
        line-height: 1.4;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 1px;
        border: 1px solid currentColor;
      }
      .status-running { 
        background: rgba(0, 255, 65, 0.1); 
        color: var(--ok);
        box-shadow: 0 0 10px rgba(0, 255, 65, 0.3);
        animation: pulse-glow 2s ease-in-out infinite;
      }
      .status-complete { background: rgba(0, 212, 255, 0.1); color: var(--info); }
      .status-failed { 
        background: rgba(255, 0, 64, 0.15); 
        color: var(--err);
        box-shadow: 0 0 10px rgba(255, 0, 64, 0.3);
      }
      .status-budget_exhausted { background: rgba(255, 184, 0, 0.15); color: var(--warn); }
      .status-exited { background: rgba(255, 184, 0, 0.15); color: var(--warn); }
      .status-stopped { background: rgba(255, 0, 64, 0.15); color: var(--err); }
      .status-enabled { 
        background: rgba(0, 255, 65, 0.1); 
        color: var(--ok);
        box-shadow: 0 0 10px rgba(0, 255, 65, 0.3);
      }
      .status-disabled { background: rgba(255, 0, 64, 0.15); color: var(--err); }
      pre {
        margin: 0;
        padding: 12px;
        border-radius: 2px;
        background: #050505;
        border: 1px solid var(--line);
        overflow: auto;
        color: var(--text-dim);
        font-size: 11px;
        text-shadow: 0 0 5px rgba(0, 255, 65, 0.3);
      }
      .muted { color: var(--muted); }
      .split {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 16px;
      }
      .no-data {
        color: var(--muted);
        font-style: normal;
        text-transform: uppercase;
        letter-spacing: 1px;
        font-size: 11px;
      }
      .no-data::before {
        content: '// ';
      }
      .section-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }
      .section-header h3 {
        margin: 0;
      }
      .btn-export {
        background: transparent;
        border: 1px solid var(--line);
        color: var(--text-dim);
        padding: 4px 10px;
        font-size: 11px;
        text-decoration: none;
        font-family: inherit;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        cursor: pointer;
      }
      .btn-export:hover {
        background: rgba(0, 255, 65, 0.1);
        border-color: var(--text);
        color: var(--text);
      }
      .graph-wrap {
        border: 1px solid var(--line);
        border-radius: 4px;
        padding: 12px;
        background: #050505;
        margin-bottom: 16px;
        box-shadow: inset 0 0 40px rgba(0, 0, 0, 0.8);
      }
      .tab-bar {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .section-header .tab-bar {
        margin-left: auto;
        justify-content: flex-end;
      }
      .tab-btn {
        background: transparent;
        border: 1px solid var(--line);
        color: var(--text-dim);
        padding: 4px 10px;
        font-size: 11px;
        text-decoration: none;
        font-family: inherit;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        cursor: pointer;
      }
      .tab-btn.active {
        background: rgba(0, 255, 65, 0.1);
        border-color: var(--text);
        color: var(--text);
        box-shadow: var(--glow);
      }
      .tab-panel {
        display: none;
        margin-top: 12px;
      }
      .tab-panel.active {
        display: block;
      }
      .graph-wrap .tab-panel {
        margin-top: 0;
      }
      .log-controls {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
        margin-bottom: 10px;
      }
      .log-viewer {
        max-height: 520px;
        overflow: auto;
        white-space: pre-wrap;
        font-size: 11px;
        color: var(--text-dim);
        border: 1px solid var(--line);
        background: #050505;
        padding: 10px;
        box-shadow: inset 0 0 25px rgba(0, 0, 0, 0.8);
      }
      .graph-header {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: var(--muted);
        margin-bottom: 8px;
        text-transform: uppercase;
        letter-spacing: 1px;
      }
      .graph {
        width: 100%;
        height: 480px;
        position: relative;
      }
      .agent-tooltip {
        position: absolute;
        background: rgba(5, 5, 5, 0.95);
        border: 1px solid var(--text);
        border-radius: 4px;
        padding: 12px 16px;
        font-size: 11px;
        pointer-events: none;
        z-index: 100;
        max-width: 320px;
        box-shadow: 0 0 20px rgba(0, 255, 65, 0.3), inset 0 0 30px rgba(0, 0, 0, 0.5);
        display: none;
      }
      .agent-tooltip.visible {
        display: block;
      }
      .agent-tooltip::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 1px;
        background: linear-gradient(90deg, transparent, var(--text), transparent);
      }
      .agent-tooltip .tt-header {
        font-size: 13px;
        font-weight: 600;
        margin-bottom: 8px;
        text-transform: uppercase;
        letter-spacing: 1px;
        text-shadow: var(--glow);
      }
      .agent-tooltip .tt-row {
        display: flex;
        gap: 8px;
        margin-bottom: 4px;
      }
      .agent-tooltip .tt-label {
        color: var(--muted);
        min-width: 60px;
      }
      .agent-tooltip .tt-value {
        color: var(--text);
        word-break: break-all;
      }
      .agent-tooltip .tt-task {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--line);
        color: var(--text-dim);
        line-height: 1.4;
        max-height: 80px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .graph-stats {
        position: absolute;
        top: 12px;
        left: 12px;
        background: rgba(5, 5, 5, 0.85);
        border: 1px solid var(--line);
        border-radius: 4px;
        padding: 10px 14px;
        font-size: 11px;
        z-index: 50;
        min-width: 120px;
      }
      .graph-stats .stat-row {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 4px;
      }
      .graph-stats .stat-row:last-child {
        margin-bottom: 0;
      }
      .graph-stats .stat-label {
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 1px;
        font-size: 9px;
      }
      .graph-stats .stat-value {
        color: var(--text);
        font-weight: 600;
      }
      .graph-stats .stat-value.running {
        color: var(--ok);
        text-shadow: var(--glow);
      }
      .graph-stats .stat-value.failed {
        color: var(--err);
      }
      .graph-controls {
        position: absolute;
        top: 12px;
        right: 12px;
        display: flex;
        gap: 8px;
        z-index: 50;
      }
      .graph-btn {
        background: rgba(5, 5, 5, 0.85);
        border: 1px solid var(--line);
        border-radius: 4px;
        padding: 6px 12px;
        font-size: 10px;
        font-family: inherit;
        color: var(--text);
        cursor: pointer;
        text-transform: uppercase;
        letter-spacing: 1px;
        transition: all 0.15s ease;
      }
      .graph-btn:hover {
        border-color: var(--text);
        box-shadow: 0 0 10px rgba(0, 255, 65, 0.2);
      }
      .graph-btn.active {
        background: rgba(0, 255, 65, 0.1);
        border-color: var(--text);
      }
      .refresh-indicator {
        position: absolute;
        bottom: 12px;
        right: 12px;
        font-size: 10px;
        color: var(--muted);
        z-index: 50;
      }
      ::-webkit-scrollbar {
        width: 8px;
        height: 8px;
      }
      ::-webkit-scrollbar-track {
        background: var(--bg);
      }
      ::-webkit-scrollbar-thumb {
        background: var(--line);
        border-radius: 2px;
      }
      ::-webkit-scrollbar-thumb:hover {
        background: var(--muted);
      }
      form.form-inline {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 16px;
        padding: 12px;
        border: 1px solid var(--line);
        background: var(--panel);
        box-shadow: var(--glow);
      }
      form.form-inline.compact {
        margin: 0;
        padding: 8px 10px;
        border: 1px dashed var(--line);
        background: rgba(0, 0, 0, 0.35);
        box-shadow: none;
      }
      .inline-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .inline-actions form {
        margin: 0;
      }
      .heartbeat-panel {
        margin-top: 14px;
        padding: 10px 12px;
        border: 1px solid var(--line);
        background: rgba(0, 255, 65, 0.05);
        box-shadow: var(--glow);
        font-size: 12px;
      }
      .heartbeat-panel.running {
        border-color: rgba(255, 60, 60, 0.4);
        background: rgba(255, 60, 60, 0.05);
        animation: heartbeat-pulse 2s ease-in-out infinite;
      }
      .heartbeat-panel.paused {
        border-color: rgba(255, 180, 0, 0.4);
        background: rgba(255, 180, 0, 0.05);
        box-shadow: 0 0 8px rgba(255, 180, 0, 0.3);
      }
      .heartbeat-title {
        text-transform: uppercase;
        letter-spacing: 1px;
        font-size: 11px;
        margin-bottom: 6px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .heartbeat-controls {
        display: flex;
        gap: 6px;
      }
      .heartbeat-btn {
        background: transparent;
        border: 1px solid var(--line);
        color: var(--text);
        padding: 2px 8px;
        font-size: 10px;
        cursor: pointer;
        font-family: inherit;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .heartbeat-btn:hover {
        background: rgba(0, 255, 65, 0.1);
        border-color: var(--text);
      }
      .heartbeat-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .heartbeat-row {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-bottom: 4px;
      }
      .heartbeat-row:last-child {
        margin-bottom: 0;
      }
      .inline-input {
        background: #040804;
        border: 1px solid var(--line);
        color: var(--text);
        padding: 4px 6px;
        font-size: 11px;
        min-width: 120px;
      }
      .inline-edit {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        align-items: center;
      }
      .form-row {
        display: flex;
        flex-direction: column;
        gap: 6px;
        min-width: 180px;
      }
      .form-row label {
        font-size: 12px;
        color: var(--muted);
      }
      .form-row input,
      .form-row select {
        background: #040804;
        border: 1px solid var(--line);
        color: var(--text);
        padding: 6px 8px;
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <header>
      <h1>Nexus Dashboard</h1>
      <div class="meta">
        Updated ${escapeHtml(updatedAt)} · Auto-refresh 15s
        <span class="mode-pill ${modeClass}">${escapeHtml(modeLabel)}</span>
      </div>
    </header>
    <main>
      <section>
        <div class="section-header">
          <h2>Agents</h2>
          <div class="tab-bar" role="tablist">
            <button class="tab-btn active" data-tab="agents-view" type="button">Agents</button>
            <button class="tab-btn" data-tab="docker-logs" type="button">Docker Logs</button>
          </div>
        </div>
        <div class="graph-wrap">
          <div class="tab-panel active" id="tab-agents-view">
            <div class="graph-header">
              <span>Hierarchy (last ${params.agentWindowMinutes}m)</span>
              <span class="muted">Drag to rotate, scroll to zoom</span>
            </div>
            <div id="agent-graph" class="graph">
              <div id="agent-stats" class="graph-stats">
                <div class="stat-row"><span class="stat-label">Running</span><span id="stat-running" class="stat-value running">0</span></div>
                <div class="stat-row"><span class="stat-label">Complete</span><span id="stat-complete" class="stat-value">0</span></div>
                <div class="stat-row"><span class="stat-label">Failed</span><span id="stat-failed" class="stat-value failed">0</span></div>
                <div class="stat-row"><span class="stat-label">Total</span><span id="stat-total" class="stat-value">0</span></div>
              </div>
              <div class="graph-controls">
                <button id="btn-pause" class="graph-btn">Pause</button>
              </div>
              <div id="agent-tooltip" class="agent-tooltip"></div>
              <div id="refresh-indicator" class="refresh-indicator"></div>
            </div>
          </div>
          <div class="tab-panel" id="tab-docker-logs">
            <div class="graph-header">
              <span>Docker Logs (gateway.log)</span>
              <span class="muted">Tail</span>
            </div>
            <div class="log-controls">
              <button id="logs-refresh" class="graph-btn" type="button">Refresh</button>
              <label style="display:flex; align-items:center; gap:6px; font-size:11px;">
                <input id="logs-auto" type="checkbox" checked />
                Auto refresh
              </label>
              <label style="display:flex; align-items:center; gap:6px; font-size:11px;">
                Max chars
                <input id="logs-max" class="inline-input" type="number" min="200" max="200000" step="1000" value="50000" />
              </label>
            </div>
            <pre id="docker-logs" class="log-viewer">Loading logs…</pre>
          </div>
        </div>
        <div class="split">
          <div>
            <h3>Running</h3>
            <div id="table-active">${renderAgentTable(params.agents.active)}</div>
          </div>
          <div>
            <h3>Recent (${params.agentWindowMinutes}m)</h3>
            <div id="table-recent">${renderAgentTable(params.agents.recent)}</div>
          </div>
        </div>
        <div class="heartbeat-panel ${heartbeatPanelClass}" id="heartbeat-panel">
          <div class="heartbeat-title">
            <span id="heartbeat-label">${heartbeatLabel}</span>
            ${heartbeat.enabled ? `<div class="heartbeat-controls">
              <button class="heartbeat-btn" id="heartbeat-pause" ${heartbeat.paused ? 'style="display:none"' : ""}>Pause</button>
              <button class="heartbeat-btn" id="heartbeat-resume" ${!heartbeat.paused ? 'style="display:none"' : ""}>Resume</button>
            </div>` : ""}
          </div>
          <div class="heartbeat-row"><span class="muted">Last:</span> <span id="heartbeat-last">${escapeHtml(heartbeatLast)}</span></div>
          <div class="heartbeat-row"><span class="muted">Next:</span> <span id="heartbeat-next">${escapeHtml(heartbeatNext)}</span></div>
          <div class="heartbeat-row"><span class="muted">Status:</span> <span id="heartbeat-status">${escapeHtml(heartbeatStatus)}</span></div>
        </div>
      </section>

      <section>
        <h2>Processes (${params.processWindowMinutes}m window)</h2>
        ${renderProcessTable(params.processes)}
      </section>

      <section>
        <h2>Scheduled Jobs</h2>
        ${renderJobsTable(params.jobs)}
        <div class="section-header">
          <h3>Running Jobs</h3>
          <a href="/api/job-runs/export.csv?limit=1000" class="btn-export" download>Export All Runs (CSV)</a>
        </div>
        ${renderJobRunsTable(params.runningJobRuns)}
      </section>

      <section>
        <h2>Data Intake</h2>
        ${renderDataIntakeTable(params.dataIntake, params.dataIntakeCatalog)}
      </section>

      <section>
        <div class="section-header">
          <h2>Blackboard</h2>
          <div class="inline-actions">
            <form method="get" action="/dashboard" class="form-inline compact">
              <div class="form-row">
                <label for="blackboard-scope">Scope</label>
                <input id="blackboard-scope" name="blackboardScope" list="blackboard-scope-list" value="${escapeHtml(blackboardScopeValue)}" placeholder="all" />
                <datalist id="blackboard-scope-list">${blackboardScopeOptions}</datalist>
              </div>
              <div class="form-row">
                <button type="submit" class="graph-btn">Filter</button>
              </div>
              ${dashboardQueryInputs}
            </form>
            <form method="post" action="/dashboard/blackboard/clear" class="form-inline compact" onsubmit="return confirm(${blackboardClearConfirm})">
              <input type="hidden" name="scope" value="${escapeHtml(blackboardScopeValue)}" />
              <button type="submit" class="graph-btn btn-danger">Clear Scope</button>
            </form>
          </div>
        </div>
        ${renderBlackboardTable(params.blackboard)}
      </section>

      <section>
        <div class="section-header">
          <h2>High Availability</h2>
          <div class="inline-actions">
            <form method="post" action="/api/activate" class="form-inline compact" onsubmit="return confirm('Activate this instance and take over as primary?')">
              <button type="submit" class="graph-btn" ${modeRaw === "active" ? "disabled" : ""}>Activate</button>
            </form>
            <form method="post" action="/api/deactivate" class="form-inline compact" onsubmit="return confirm('Deactivate this instance and go to standby mode?')">
              <button type="submit" class="graph-btn btn-danger" ${modeRaw === "standby" ? "disabled" : ""}>Deactivate</button>
            </form>
            <form method="post" action="/api/backup" class="form-inline compact">
              <button type="submit" class="graph-btn">Backup Now</button>
            </form>
          </div>
        </div>
        <div class="split">
          <div>
            <h3>Instance Status</h3>
            <table>
              <tbody>
                <tr><td>Mode</td><td><span class="badge status-${modeClass}">${escapeHtml(modeLabel)}</span></td></tr>
                <tr><td>Lease Holder</td><td>${escapeHtml(truncate(leaseInfo.holderId, 40))}</td></tr>
                <tr><td>Lease Held</td><td>${leaseInfo.held ? "Yes" : "No"}</td></tr>
                <tr><td>Lease Expires</td><td>${leaseInfo.expiresAt ? escapeHtml(formatTime(leaseInfo.expiresAt)) : "-"}</td></tr>
                <tr><td>Lease TTL</td><td>${Math.round(leaseInfo.ttlMs / 1000)}s</td></tr>
              </tbody>
            </table>
          </div>
          <div>
            <h3>Backup Status</h3>
            <table>
              <tbody>
                <tr><td>Last Backup</td><td>${lastBackup?.completed_at ? escapeHtml(formatTime(lastBackup.completed_at)) : "Never"}</td></tr>
                <tr><td>Backup Age</td><td>${backupAgeHours !== null ? backupAgeHours + "h" : "-"}</td></tr>
                <tr><td>Size</td><td>${lastBackup ? Math.round(lastBackup.size_bytes / 1024) + " KB" : "-"}</td></tr>
                <tr><td>Status</td><td><span class="badge status-${backupStatusClass}">${escapeHtml(backupStatus)}</span></td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <h3>Recent Events</h3>
        ${renderHAEventsTable(haEvents)}
      </section>

      <section>
        <h2>System Status</h2>
        <pre>${statusJson}</pre>
      </section>
    </main>
    <script type="module">
      import * as THREE from "https://unpkg.com/three@0.161.0/build/three.module.js";
      import { OrbitControls } from "https://unpkg.com/three@0.161.0/examples/jsm/controls/OrbitControls.js";

      let graphData = ${agentGraphJson};
      let agentStats = ${agentStatsJson};
      const agentWindowMinutes = ${params.agentWindowMinutes};
      const container = document.getElementById("agent-graph");
      const tooltip = document.getElementById("agent-tooltip");
      const pauseBtn = document.getElementById("btn-pause");
      const refreshIndicator = document.getElementById("refresh-indicator");
      const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));
      const tabPanels = {
        "agents-view": document.getElementById("tab-agents-view"),
        "docker-logs": document.getElementById("tab-docker-logs"),
      };
      const logsPanel = tabPanels["docker-logs"];
      const logsPre = document.getElementById("docker-logs");
      const logsRefreshBtn = document.getElementById("logs-refresh");
      const logsAutoToggle = document.getElementById("logs-auto");
      const logsMaxInput = document.getElementById("logs-max");

      const fetchLogs = async () => {
        if (!logsPre) return;
        const maxChars = Math.min(200000, Math.max(200, Number(logsMaxInput?.value ?? 50000) || 50000));
        try {
          const res = await fetch("/api/logs?maxChars=" + maxChars);
          if (!res.ok) {
            logsPre.textContent = "ERROR: " + res.status;
            return;
          }
          logsPre.textContent = await res.text();
        } catch (err) {
          logsPre.textContent = "ERROR: " + (err instanceof Error ? err.message : String(err));
        }
      };

      const setActiveTab = (name) => {
        tabButtons.forEach((btn) => {
          const isActive = btn.getAttribute("data-tab") === name;
          btn.classList.toggle("active", isActive);
        });
        Object.entries(tabPanels).forEach(([key, panel]) => {
          if (!panel) return;
          panel.classList.toggle("active", key === name);
        });
        if (name === "docker-logs") {
          fetchLogs();
        }
      };

      tabButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
          const name = btn.getAttribute("data-tab");
          if (name) setActiveTab(name);
        });
      });

      if (logsRefreshBtn) {
        logsRefreshBtn.addEventListener("click", fetchLogs);
      }
      
      // Update stats display
      const updateStats = (stats) => {
        const running = document.getElementById("stat-running");
        const complete = document.getElementById("stat-complete");
        const failed = document.getElementById("stat-failed");
        const total = document.getElementById("stat-total");
        if (running) running.textContent = stats.running;
        if (complete) complete.textContent = stats.complete;
        if (failed) failed.textContent = stats.failed;
        if (total) total.textContent = stats.total;
      };
      updateStats(agentStats);
      
      // Helper to escape HTML
      const escapeHtml = (str) => {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      };
      
      // Helper to format time
      const formatTime = (ms) => {
        if (!ms) return '-';
        try { return new Date(ms).toISOString(); } catch { return '-'; }
      };
      
      // Helper to truncate text
      const truncateText = (text, max) => {
        if (!text) return '';
        if (text.length <= max) return text;
        return text.slice(0, max) + '...';
      };
      
      // Render agent table HTML
      const renderAgentTableHtml = (rows) => {
        if (!rows || rows.length === 0) {
          return '<div class="no-data">No agent runs.</div>';
        }
        const header = \`<table>
          <thead><tr>
            <th>Status</th><th>Agent</th><th>Preset</th><th>Channel</th>
            <th>Task</th><th>Started</th><th>Ended</th><th>Budget</th>
          </tr></thead><tbody>\`;
        const rowsHtml = rows.map(r => {
          const budget = (r.toolCallsUsed !== undefined || r.iterationsUsed !== undefined)
            ? \`\${r.toolCallsUsed ?? '-'} tools / \${r.iterationsUsed ?? '-'} iters\`
            : '-';
          const statusClass = r.status.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
          return \`<tr>
            <td><span class="badge status-\${statusClass}">\${escapeHtml(r.status)}</span></td>
            <td>\${escapeHtml(r.agentId)}</td>
            <td>\${escapeHtml(r.preset)}</td>
            <td>\${escapeHtml(r.channel)}</td>
            <td>\${escapeHtml(truncateText(r.task, 160))}</td>
            <td>\${escapeHtml(formatTime(r.startedAt))}</td>
            <td>\${escapeHtml(r.endedAt ? formatTime(r.endedAt) : '-')}</td>
            <td>\${escapeHtml(budget)}</td>
          </tr>\`;
        }).join('');
        return header + rowsHtml + '</tbody></table>';
      };
      
      // Update agent tables
      const updateTables = (tables) => {
        const activeContainer = document.getElementById('table-active');
        const recentContainer = document.getElementById('table-recent');
        if (activeContainer) activeContainer.innerHTML = renderAgentTableHtml(tables.active);
        if (recentContainer) recentContainer.innerHTML = renderAgentTableHtml(tables.recent);
      };
      
      // Pause state (orbital animation)
      let isPaused = false;
      if (pauseBtn) {
        pauseBtn.addEventListener("click", () => {
          isPaused = !isPaused;
          pauseBtn.textContent = isPaused ? "Resume" : "Pause";
          pauseBtn.classList.toggle("active", isPaused);
        });
      }
      
      // Heartbeat pause/resume controls
      const heartbeatPanel = document.getElementById("heartbeat-panel");
      const heartbeatPauseBtn = document.getElementById("heartbeat-pause");
      const heartbeatResumeBtn = document.getElementById("heartbeat-resume");
      const heartbeatLabel = document.getElementById("heartbeat-label");
      
      const updateHeartbeatUI = (paused) => {
        if (heartbeatPanel) {
          heartbeatPanel.classList.toggle("running", !paused);
          heartbeatPanel.classList.toggle("paused", paused);
        }
        if (heartbeatLabel) {
          heartbeatLabel.textContent = paused ? "Heartbeat (paused)" : "Heartbeat";
        }
        if (heartbeatPauseBtn) heartbeatPauseBtn.style.display = paused ? "none" : "";
        if (heartbeatResumeBtn) heartbeatResumeBtn.style.display = paused ? "" : "none";
      };
      
      if (heartbeatPauseBtn) {
        heartbeatPauseBtn.addEventListener("click", async () => {
          heartbeatPauseBtn.disabled = true;
          try {
            const res = await fetch("/api/proactive/pause", { method: "POST" });
            if (res.ok) updateHeartbeatUI(true);
          } finally {
            heartbeatPauseBtn.disabled = false;
          }
        });
      }
      if (heartbeatResumeBtn) {
        heartbeatResumeBtn.addEventListener("click", async () => {
          heartbeatResumeBtn.disabled = true;
          try {
            const res = await fetch("/api/proactive/resume", { method: "POST" });
            if (res.ok) updateHeartbeatUI(false);
          } finally {
            heartbeatResumeBtn.disabled = false;
          }
        });
      }
      
      // Live data refresh countdown display
      let refreshCountdown = 5;
      const updateRefreshIndicator = () => {
        if (refreshIndicator) {
          refreshIndicator.textContent = \`Update in \${refreshCountdown}s\`;
        }
      };
      updateRefreshIndicator();
      
      // Scene state - will be populated when scene is created
      let sceneState = null;
      
      // Fetch new data and update scene
      const fetchAndUpdate = async () => {
        try {
          const res = await fetch(\`/api/agents?agentWindowMinutes=\${agentWindowMinutes}\`);
          if (!res.ok) return;
          const data = await res.json();
          graphData = data.nodes;
          agentStats = data.stats;
          updateStats(agentStats);
          
          if (data.tables) {
            updateTables(data.tables);
          }
          
          if (sceneState) {
            updateSceneWithNewData(sceneState, data.nodes);
          }
        } catch (e) {
          console.warn("Failed to fetch agent data:", e);
        }
      };
      
      setInterval(() => {
        refreshCountdown--;
        updateRefreshIndicator();
        if (refreshCountdown <= 0) {
          refreshCountdown = 5;
          fetchAndUpdate();
          if (logsAutoToggle?.checked && logsPanel?.classList.contains("active")) {
            fetchLogs();
          }
        }
      }, 1000);
      
      // Status color mapping
      const statusColors = {
        running: 0x00ff41,
        complete: 0x00d4ff,
        failed: 0xff0040,
        budget_exhausted: 0xffb800,
      };
      const baseOrbitRadius = 90;
      const orbitRadiusStep = 55;
      
      // Helper to create a node mesh
      const createNodeMesh = (node, THREE) => {
        const color = statusColors[node.status] ?? 0x00aa2a;
        const radius = Math.max(5, 9 - node.depth * 1.2);
        const geometry = new THREE.SphereGeometry(radius, 32, 32);
        const material = new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: node.status === 'running' ? 0.5 : 0.25,
          roughness: 0.3,
          metalness: 0.7,
        });
        return new THREE.Mesh(geometry, material);
      };
      
      // Helper to create connection line
      const createConnectionLine = (fromX, fromY, fromZ, toX, toY, toZ, opacity, THREE) => {
        const points = [
          new THREE.Vector3(fromX, fromY, fromZ),
          new THREE.Vector3(toX, toY, toZ),
        ];
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({ color: 0x00ff41, transparent: true, opacity });
        return new THREE.Line(geometry, material);
      };
      
      // Position a node in the solar system layout
      const positionNode = (node, centerX, centerY, centerZ, depth, siblingIndex, siblingCount) => {
        node.depth = depth;
        const orbitRadius = baseOrbitRadius + depth * orbitRadiusStep * 0.6;
        const angleOffset = depth * 0.7;
        const angle = (siblingIndex / Math.max(1, siblingCount)) * Math.PI * 2 + angleOffset;
        node.x = centerX + Math.cos(angle) * orbitRadius;
        node.y = centerY - depth * 12;
        node.z = centerZ + Math.sin(angle) * orbitRadius;
        node.orbitAngle = angle;
        node.orbitSpeed = 0.0004 + Math.random() * 0.0003 - depth * 0.00005;
        node.orbitRadius = orbitRadius;
        node.orbitCenterX = centerX;
        node.orbitCenterY = centerY;
        node.orbitCenterZ = centerZ;
      };
      
      // Build node tree and position nodes
      const buildNodeTree = (nodes) => {
        const nodesById = new Map(nodes.map((n) => [n.run_id, { ...n, children: [] }]));
        for (const node of nodesById.values()) {
          if (node.parent_run_id && nodesById.has(node.parent_run_id)) {
            nodesById.get(node.parent_run_id).children.push(node);
          }
        }
        const roots = [...nodesById.values()].filter((n) => !n.parent_run_id || !nodesById.has(n.parent_run_id));
        
        const positionChildren = (node, cx, cy, cz, depth) => {
          node.children.forEach((child, idx) => {
            positionNode(child, node.x, node.y, node.z, depth + 1, idx, node.children.length);
            positionChildren(child, child.x, child.y, child.z, depth + 1);
          });
        };
        roots.forEach((root, idx) => {
          positionNode(root, 0, 0, 0, 0, idx, roots.length);
          positionChildren(root, root.x, root.y, root.z, 0);
        });
        return { nodesById, roots };
      };
      
      // Update scene with new data (add new nodes, update existing, remove old)
      const updateSceneWithNewData = (state, newNodes) => {
        const { scene, nodesById, meshToNode, THREE } = state;
        const newNodeIds = new Set(newNodes.map((n) => n.run_id));
        const { nodesById: newNodesById, roots: newRoots } = buildNodeTree(newNodes);
        
        // Remove nodes that no longer exist
        for (const [runId, node] of nodesById.entries()) {
          if (!newNodeIds.has(runId)) {
            if (node.mesh) {
              scene.remove(node.mesh);
              meshToNode.delete(node.mesh);
              node.mesh.geometry.dispose();
              node.mesh.material.dispose();
            }
            if (node.connectionLine) {
              scene.remove(node.connectionLine);
              node.connectionLine.geometry.dispose();
              node.connectionLine.material.dispose();
            }
            nodesById.delete(runId);
          }
        }
        
        // Add or update nodes
        for (const [runId, newNode] of newNodesById.entries()) {
          if (nodesById.has(runId)) {
            // Update existing node
            const existingNode = nodesById.get(runId);
            if (existingNode.status !== newNode.status) {
              // Status changed - update color
              const color = statusColors[newNode.status] ?? 0x00aa2a;
              existingNode.mesh.material.color.setHex(color);
              existingNode.mesh.material.emissive.setHex(color);
              existingNode.mesh.material.emissiveIntensity = newNode.status === 'running' ? 0.5 : 0.25;
              existingNode.status = newNode.status;
            }
            // Update other data fields
            existingNode.ended_at = newNode.ended_at;
            existingNode.task = newNode.task;
          } else {
            // Add new node
            const mesh = createNodeMesh(newNode, THREE);
            mesh.position.set(newNode.x ?? 0, newNode.y ?? 0, newNode.z ?? 0);
            scene.add(mesh);
            newNode.mesh = mesh;
            nodesById.set(runId, newNode);
            meshToNode.set(mesh, newNode);
            
            // Create connection line
            const isRoot = newNode.depth === 0;
            if (isRoot) {
              const line = createConnectionLine(0, 0, 0, newNode.x, newNode.y, newNode.z, 0.5, THREE);
              scene.add(line);
              newNode.connectionLine = line;
            } else if (newNode.parent_run_id && nodesById.has(newNode.parent_run_id)) {
              const parent = nodesById.get(newNode.parent_run_id);
              const line = createConnectionLine(parent.x, parent.y, parent.z, newNode.x, newNode.y, newNode.z, 0.35, THREE);
              scene.add(line);
              newNode.connectionLine = line;
            }
          }
        }
      };
      
      if (!container) {
        console.warn("Agent graph container missing");
      } else {
        const width = container.clientWidth || 800;
        const height = 480;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x050505);

        const camera = new THREE.PerspectiveCamera(50, width / height, 1, 2000);
        camera.position.set(0, 200, 350);

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(window.devicePixelRatio);
        container.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.minDistance = 100;
        controls.maxDistance = 600;

        const ambientLight = new THREE.AmbientLight(0x00ff41, 0.15);
        scene.add(ambientLight);
        const pointLight = new THREE.PointLight(0x00ff41, 1.5, 500);
        pointLight.position.set(0, 50, 0);
        scene.add(pointLight);

        // Create orbit rings
        const createOrbitRing = (radius, y) => {
          const segments = 64;
          const points = [];
          for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            points.push(new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius));
          }
          const geometry = new THREE.BufferGeometry().setFromPoints(points);
          const material = new THREE.LineBasicMaterial({ color: 0x003311, transparent: true, opacity: 0.3 });
          return new THREE.Line(geometry, material);
        };
        [90, 145, 200].forEach((r, i) => scene.add(createOrbitRing(r, -i * 12)));

        // Create central orchestrator
        const orchestratorColor = 0x00ff41;
        const orchestratorRadius = 18;
        const orchestratorMesh = new THREE.Mesh(
          new THREE.SphereGeometry(orchestratorRadius, 32, 32),
          new THREE.MeshStandardMaterial({
            color: orchestratorColor,
            emissive: orchestratorColor,
            emissiveIntensity: 0.8,
            roughness: 0.2,
            metalness: 0.8,
          })
        );
        orchestratorMesh.position.set(0, 0, 0);
        scene.add(orchestratorMesh);
        
        const glow1 = new THREE.Mesh(
          new THREE.SphereGeometry(orchestratorRadius * 1.6, 32, 32),
          new THREE.MeshBasicMaterial({ color: orchestratorColor, transparent: true, opacity: 0.12 })
        );
        scene.add(glow1);
        
        const glow2 = new THREE.Mesh(
          new THREE.SphereGeometry(orchestratorRadius * 2.4, 32, 32),
          new THREE.MeshBasicMaterial({ color: orchestratorColor, transparent: true, opacity: 0.05 })
        );
        scene.add(glow2);
        
        const orchestratorNode = {
          agent_id: 'ORCHESTRATOR',
          preset: 'core',
          status: 'running',
          started_at: null,
          ended_at: null,
          task: 'Central command node - coordinates all agent activity',
          depth: -1,
          isOrchestrator: true,
        };
        
        const meshToNode = new Map();
        meshToNode.set(orchestratorMesh, orchestratorNode);

        // Build initial node tree
        const { nodesById, roots } = buildNodeTree(graphData);
        
        // Create initial node meshes
        for (const node of nodesById.values()) {
          const mesh = createNodeMesh(node, THREE);
          mesh.position.set(node.x ?? 0, node.y ?? 0, node.z ?? 0);
          scene.add(mesh);
          node.mesh = mesh;
          meshToNode.set(mesh, node);
        }
        
        // Create initial connection lines
        for (const root of roots) {
          const line = createConnectionLine(0, 0, 0, root.x, root.y, root.z, 0.5, THREE);
          scene.add(line);
          root.connectionLine = line;
        }
        for (const node of nodesById.values()) {
          if (node.parent_run_id && nodesById.has(node.parent_run_id)) {
            const parent = nodesById.get(node.parent_run_id);
            const line = createConnectionLine(parent.x, parent.y, parent.z, node.x, node.y, node.z, 0.35, THREE);
            scene.add(line);
            node.connectionLine = line;
          }
        }
        
        // Store scene state for live updates
        sceneState = { scene, nodesById, meshToNode, THREE };

        // Raycaster for hover detection
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();
        let hoveredNode = null;

        const formatTime = (ms) => {
          if (!ms) return '-';
          try { return new Date(ms).toLocaleString(); } catch { return '-'; }
        };

        const truncate = (str, len) => {
          if (!str) return '-';
          return str.length > len ? str.slice(0, len) + '...' : str;
        };

        const updateTooltip = (node, x, y) => {
          if (!tooltip) return;
          const statusLabel = node.status.replace('_', ' ').toUpperCase();
          tooltip.innerHTML = \`
            <div class="tt-header">\${node.agent_id}</div>
            <div class="tt-row"><span class="tt-label">Preset:</span><span class="tt-value">\${node.preset || '-'}</span></div>
            <div class="tt-row"><span class="tt-label">Status:</span><span class="tt-value">\${statusLabel}</span></div>
            <div class="tt-row"><span class="tt-label">Started:</span><span class="tt-value">\${formatTime(node.started_at)}</span></div>
            <div class="tt-row"><span class="tt-label">Ended:</span><span class="tt-value">\${formatTime(node.ended_at)}</span></div>
            \${node.task ? \`<div class="tt-task">\${truncate(node.task, 200)}</div>\` : ''}
          \`;
          tooltip.style.left = Math.min(x + 15, container.clientWidth - 340) + 'px';
          tooltip.style.top = Math.min(y + 15, container.clientHeight - 180) + 'px';
          tooltip.classList.add('visible');
        };

        const hideTooltip = () => {
          if (tooltip) tooltip.classList.remove('visible');
        };

        const onMouseMove = (event) => {
          const rect = renderer.domElement.getBoundingClientRect();
          mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
          mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

          raycaster.setFromCamera(mouse, camera);
          const meshes = [...meshToNode.keys()];
          const intersects = raycaster.intersectObjects(meshes);

          if (intersects.length > 0) {
            const mesh = intersects[0].object;
            const node = meshToNode.get(mesh);
            if (node && node !== hoveredNode) {
              hoveredNode = node;
              renderer.domElement.style.cursor = 'pointer';
              updateTooltip(node, event.clientX - rect.left, event.clientY - rect.top);
            }
          } else {
            if (hoveredNode) {
              hoveredNode = null;
              renderer.domElement.style.cursor = 'grab';
              hideTooltip();
            }
          }
        };

        renderer.domElement.addEventListener('mousemove', onMouseMove);
        renderer.domElement.addEventListener('mouseleave', hideTooltip);
        renderer.domElement.style.cursor = 'grab';

        const resize = () => {
          const w = container.clientWidth || width;
          const h = height;
          renderer.setSize(w, h);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        };
        window.addEventListener("resize", resize);

        // Animation loop
        let time = 0;
        const animate = () => {
          requestAnimationFrame(animate);
          time += 1;
          
          // Orchestrator glow pulse
          const glowPulse = 1 + Math.sin(time * 0.02) * 0.15;
          glow1.scale.setScalar(glowPulse);
          glow2.scale.setScalar(glowPulse * 0.95);
          orchestratorMesh.scale.setScalar(1 + Math.sin(time * 0.03) * 0.03);
          
          // Orbital animation (respects pause)
          if (!isPaused) {
            for (const node of nodesById.values()) {
              if (node.mesh && node.orbitRadius > 0) {
                node.orbitAngle += node.orbitSpeed;
                const newX = node.orbitCenterX + Math.cos(node.orbitAngle) * node.orbitRadius;
                const newZ = node.orbitCenterZ + Math.sin(node.orbitAngle) * node.orbitRadius;
                node.mesh.position.x = newX;
                node.mesh.position.z = newZ;
                node.x = newX;
                node.z = newZ;
                
                if (node.connectionLine) {
                  const positions = node.connectionLine.geometry.attributes.position.array;
                  if (node.depth === 0) {
                    positions[0] = 0;
                    positions[1] = 0;
                    positions[2] = 0;
                  } else if (node.parent_run_id && nodesById.has(node.parent_run_id)) {
                    const parent = nodesById.get(node.parent_run_id);
                    positions[0] = parent.x;
                    positions[1] = parent.y;
                    positions[2] = parent.z;
                  }
                  positions[3] = node.x;
                  positions[4] = node.y;
                  positions[5] = node.z;
                  node.connectionLine.geometry.attributes.position.needsUpdate = true;
                }
              }
            }
          }
          
          // Pulse effect for running nodes
          for (const node of nodesById.values()) {
            if (node.status === 'running' && node.mesh) {
              const scale = 1 + Math.sin(time * 0.05) * 0.12;
              node.mesh.scale.setScalar(scale);
            }
          }
          
          controls.update();
          renderer.render(scene, camera);
        };
        animate();
      }
    </script>
  </body>
</html>`;
}

function renderAgentTable(rows: AgentRunInfo[]): string {
  if (rows.length === 0) return `<div class="no-data">No agent runs.</div>`;
  return `<table>
    <thead>
      <tr>
        <th>Status</th>
        <th>Agent</th>
        <th>Preset</th>
        <th>Channel</th>
        <th>Task</th>
        <th>Started</th>
        <th>Ended</th>
        <th>Budget</th>
      </tr>
    </thead>
    <tbody>
      ${rows
      .map((r) => {
        const status = r.status;
        const budget = r.toolCallsUsed !== undefined || r.iterationsUsed !== undefined
          ? `${r.toolCallsUsed ?? "-"} tools / ${r.iterationsUsed ?? "-"} iters`
          : "-";
        return `<tr>
            <td><span class="badge status-${escapeClass(status)}">${escapeHtml(status)}</span></td>
            <td>${escapeHtml(r.agentId)}</td>
            <td>${escapeHtml(r.preset)}</td>
            <td>${escapeHtml(`${r.channel}:${r.channelKey}`)}</td>
            <td>${escapeHtml(truncate(r.task, 160))}</td>
            <td>${escapeHtml(formatTime(r.startedAt))}</td>
            <td>${escapeHtml(r.endedAt ? formatTime(r.endedAt) : "-")}</td>
            <td>${escapeHtml(budget)}</td>
          </tr>`;
      })
      .join("")}
    </tbody>
  </table>`;
}

function renderProcessTable(rows: ManagedProcessInfo[]): string {
  if (rows.length === 0) return `<div class="no-data">No processes found.</div>`;
  return `<table>
    <thead>
      <tr>
        <th>Status</th>
        <th>ID</th>
        <th>PID</th>
        <th>Command</th>
        <th>Started</th>
        <th>Ended</th>
        <th>Exit</th>
      </tr>
    </thead>
    <tbody>
      ${rows
      .map((p) => {
        const exit = p.exitCode !== null || p.signal ? `${p.exitCode ?? ""} ${p.signal ?? ""}`.trim() : "-";
        return `<tr>
            <td><span class="badge status-${escapeClass(p.status)}">${escapeHtml(p.status)}</span></td>
            <td>${escapeHtml(p.id)}</td>
            <td>${escapeHtml(p.pid !== null ? String(p.pid) : "-")}</td>
            <td>${escapeHtml(truncate(p.command, 120))}</td>
            <td>${escapeHtml(formatTime(p.startedAt))}</td>
            <td>${escapeHtml(p.endedAt ? formatTime(p.endedAt) : "-")}</td>
            <td>${escapeHtml(exit || "-")}</td>
          </tr>`;
      })
      .join("")}
    </tbody>
  </table>`;
}

function renderJobsTable(rows: JobRow[]): string {
  if (rows.length === 0) return `<div class="no-data">No jobs found.</div>`;
  return `<table>
    <thead>
      <tr>
        <th>Status</th>
        <th>Mode</th>
        <th>ID</th>
        <th>Name</th>
        <th>Cron</th>
        <th>Timezone</th>
        <th>Owner</th>
        <th>Next Run</th>
        <th>Last Run</th>
        <th>Failures</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      ${rows
      .map((j) => {
        const enabled = j.enabled === 1;
        const toggleLabel = enabled ? "Disable" : "Enable";
        const toggleValue = enabled ? "false" : "true";
        const toggleConfirm = enabled
          ? `return confirm('Disable job "${escapeHtml(j.name.replace(/'/g, "\\'"))}"?')`
          : `return confirm('Enable job "${escapeHtml(j.name.replace(/'/g, "\\'"))}"?')`;
        const deleteConfirm = `return confirm('Permanently delete job "${escapeHtml(j.name.replace(/'/g, "\\'"))}"? This cannot be undone.')`;

        let mode = "agent_task";
        try {
          const spec = JSON.parse(j.spec_json || "{}");
          if (spec.mode) mode = spec.mode;
        } catch { }

        const modeBadgeClass = mode === "agent_task" ? "status-running" : mode === "tool_call" ? "status-enabled" : "status-complete";

        return `<tr>
            <td><span class="badge ${enabled ? "status-enabled" : "status-disabled"}">${enabled ? "enabled" : "disabled"}</span></td>
            <td><span class="badge ${modeBadgeClass}">${escapeHtml(mode)}</span></td>
            <td>${escapeHtml(j.id)}</td>
            <td>${escapeHtml(j.name)}</td>
            <td>${escapeHtml(j.cron)}</td>
            <td>${escapeHtml(j.timezone)}</td>
            <td>${escapeHtml(j.owner_agent_id)}</td>
            <td>${escapeHtml(j.next_run_at ? formatTime(j.next_run_at) : "-")}</td>
            <td>${escapeHtml(j.last_run_at ? formatTime(j.last_run_at) : "-")}</td>
            <td>${escapeHtml(String(j.consecutive_failures ?? 0))}</td>
            <td>
              <div class="inline-actions">
                <form method="post" action="/dashboard/jobs/toggle" onsubmit="${toggleConfirm}">
                  <input type="hidden" name="id" value="${escapeHtml(j.id)}" />
                  <input type="hidden" name="enabled" value="${toggleValue}" />
                  <button type="submit" class="graph-btn">${toggleLabel}</button>
                </form>
                <form method="post" action="/dashboard/jobs/delete" onsubmit="${deleteConfirm}">
                  <input type="hidden" name="id" value="${escapeHtml(j.id)}" />
                  <button type="submit" class="graph-btn btn-danger">Delete</button>
                </form>
              </div>
            </td>
          </tr>`;
      })
      .join("")}
    </tbody>
  </table>`;
}

function renderJobRunsTable(rows: JobRunRow[]): string {
  if (rows.length === 0) return `<div class="no-data">No jobs currently running.</div>`;
  return `<table>
    <thead>
      <tr>
        <th>Status</th>
        <th>Run ID</th>
        <th>Job ID</th>
        <th>Owner</th>
        <th>Scheduled</th>
        <th>Started</th>
        <th>Ended</th>
        <th>Error</th>
      </tr>
    </thead>
    <tbody>
      ${rows
      .map((r) => {
        const statusClass = r.status === "success" ? "status-complete" : r.status === "running" ? "status-running" : "status-failed";
        return `<tr>
            <td><span class="badge ${statusClass}">${escapeHtml(r.status)}</span></td>
            <td>${escapeHtml(r.id)}</td>
            <td>${escapeHtml(r.job_id)}</td>
            <td>${escapeHtml(r.owner_agent_id)}</td>
            <td>${escapeHtml(formatTime(r.scheduled_for))}</td>
            <td>${escapeHtml(formatTime(r.started_at))}</td>
            <td>${escapeHtml(r.ended_at ? formatTime(r.ended_at) : "-")}</td>
            <td>${escapeHtml(truncate(r.error ?? "", 120))}</td>
          </tr>`;
      })
      .join("")}
    </tbody>
  </table>`;
}

function renderDataIntakeTable(params: DataIntakePanelState, catalog: DataIntakeCatalogEntry[]): string {
  const options = catalog
    .map((entry) => {
      const tagText = entry.tags.length > 0 ? ` (${entry.tags.join(", ")})` : "";
      return `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.name)}${escapeHtml(tagText)}</option>`;
    })
    .join("");

  const addForm = `<form method="post" action="/dashboard/data-intake/add" class="form-inline">
    <div class="form-row">
      <label>Source</label>
      <select name="sourceId" required>
        <option value="">Select source...</option>
        ${options}
      </select>
    </div>
    <div class="form-row">
      <label>Label</label>
      <input type="text" name="label" placeholder="Optional label" />
    </div>
    <div class="form-row">
      <label>Interval (ms)</label>
      <input type="number" name="intervalMs" min="60000" placeholder="900000" />
    </div>
    <div class="form-row">
      <label>Params (JSON)</label>
      <input type="text" name="paramsJson" placeholder='{"symbols":["BTC"]}' />
    </div>
    <button type="submit" class="graph-btn">Add Source</button>
  </form>`;

  /* Manual schedule form removed as jobs are now auto-created per source */
  const scheduleForm = "";

  const sourcesTable = params.sources.length === 0
    ? `<div class="no-data">No data intake sources configured.</div>`
    : `<table>
      <thead>
        <tr>
          <th>Status</th>
          <th>ID</th>
          <th>Source</th>
          <th>Label</th>
          <th>Last Run</th>
          <th>Error</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${params.sources
      .map((row) => {
        const enabled = row.enabled === 1;
        const toggleLabel = enabled ? "Disable" : "Enable";
        const toggleValue = enabled ? "false" : "true";
        const paramsPreview = row.params_json && row.params_json.length > 0 ? row.params_json : "{}";
        return `<tr>
              <td><span class="badge ${enabled ? "status-enabled" : "status-disabled"}">${enabled ? "enabled" : "disabled"}</span></td>
              <td>${escapeHtml(row.id)}</td>
              <td>${escapeHtml(row.source_id)}</td>
              <td>${escapeHtml(row.label ?? "-")}</td>
              <td>${escapeHtml(row.last_run_at ? formatTime(row.last_run_at) : "-")}</td>
              <td>${escapeHtml(row.last_error ? truncate(row.last_error, 80) : "-")}</td>
              <td>
                <div class="inline-actions">
                  <form method="post" action="/dashboard/data-intake/update" class="inline-edit">
                    <input type="hidden" name="id" value="${escapeHtml(row.id)}" />
                    <input type="text" name="label" class="inline-input" placeholder="Label" value="${escapeHtml(row.label ?? "")}" />
                    <input type="text" name="paramsJson" class="inline-input" placeholder="Params JSON" value="${escapeHtml(paramsPreview)}" />
                    <button type="submit" class="graph-btn">Update</button>
                  </form>
                  <form method="post" action="/dashboard/data-intake/update">
                    <input type="hidden" name="id" value="${escapeHtml(row.id)}" />
                    <input type="hidden" name="enabled" value="${toggleValue}" />
                    <button type="submit" class="graph-btn">${toggleLabel}</button>
                  </form>
                  <form method="post" action="/dashboard/data-intake/delete">
                    <input type="hidden" name="id" value="${escapeHtml(row.id)}" />
                    <button type="submit" class="graph-btn" onclick="return confirm('Delete this source?')">Delete</button>
                  </form>
                  <form method="post" action="/dashboard/data-intake/clean-data">
                    <input type="hidden" name="sourceId" value="${escapeHtml(row.source_id)}" />
                    <button type="submit" class="graph-btn" onclick="return confirm('Delete all stored data for this source?')">Clean Data</button>
                  </form>
                </div>
              </td>
            </tr>`;
      })
      .join("")}
      </tbody>
    </table>`;

  const orphanToggle = `<div class="form-inline" style="margin: 1rem 0; display: flex; align-items: center; gap: 1rem;">
    <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
      <input type="checkbox" 
             ${params.hideOrphans ? "checked" : ""} 
             onchange="window.location.href='/dashboard?hideOrphanData=' + (this.checked ? 'true' : 'false')" />
      Hide orphan data (sources that no longer exist)
    </label>
    <form method="post" action="/dashboard/data-intake/clean-orphans" style="margin: 0;">
      <button type="submit" class="graph-btn" onclick="return confirm('Delete all data from sources that no longer exist?')">Clean Orphaned Data</button>
    </form>
  </div>`;

  const latestTable = params.rows.length === 0
    ? `<div class="no-data">No recent data intake items found.</div>`
    : `<h3>Latest Values</h3>
      <table>
        <thead>
          <tr>
            <th>Source</th>
            <th>Tags</th>
            <th>Subject</th>
            <th>Value</th>
            <th>Collected</th>
            <th>Expires</th>
          </tr>
        </thead>
        <tbody>
          ${params.rows
      .map((row) => {
        let valueText = row.value_json;
        try {
          valueText = JSON.stringify(JSON.parse(row.value_json));
        } catch {
          // keep raw
        }
        let tagsArr: string[] = [];
        try {
          tagsArr = JSON.parse(row.tags_json);
        } catch {
          // keep empty
        }
        const tagsText = tagsArr.length > 0 ? tagsArr.join(", ") : "-";
        return `<tr>
                <td>${escapeHtml(row.source_name || row.source_id)}</td>
                <td>${escapeHtml(tagsText)}</td>
                <td>${escapeHtml(row.subject)}</td>
                <td>${escapeHtml(truncate(valueText, 120))}</td>
                <td>${escapeHtml(formatTime(row.collected_at))}</td>
                <td>${escapeHtml(formatTime(row.expires_at))}</td>
              </tr>`;
      })
      .join("")}
        </tbody>
      </table>`;

  return `${addForm}${scheduleForm}${sourcesTable}${orphanToggle}${latestTable}`;
}

function renderBlackboardTable(rows: BlackboardRow[]): string {
  if (rows.length === 0) return `<div class="no-data">No blackboard entries found.</div>`;
  return `<table>
    <thead>
      <tr>
        <th>Type</th>
        <th>Title</th>
        <th>Agent</th>
        <th>Preset</th>
        <th>Scope</th>
        <th>Created</th>
        <th>Expires</th>
        <th>Content</th>
      </tr>
    </thead>
    <tbody>
      ${rows
      .map((b) => {
        return `<tr>
            <td>${escapeHtml(b.type)}</td>
            <td>${escapeHtml(b.title)}</td>
            <td>${escapeHtml(b.agent_id)}</td>
            <td>${escapeHtml(b.agent_preset)}</td>
            <td>${escapeHtml(b.session_scope)}</td>
            <td>${escapeHtml(formatTime(b.created_at))}</td>
            <td>${escapeHtml(b.expires_at ? formatTime(b.expires_at) : "-")}</td>
            <td>${escapeHtml(truncate(b.content, 140))}</td>
          </tr>`;
      })
      .join("")}
    </tbody>
  </table>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJsonForScript(value: unknown): string {
  if (value === undefined) return "null";
  const json = JSON.stringify(value);
  if (json === undefined) return "null";
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\\\u2028")
    .replace(/\u2029/g, "\\\\u2029");
}

type HAEventRow = {
  id: string;
  event_type: string;
  source: string;
  from_instance: string | null;
  to_instance: string | null;
  details_json: string;
  created_at: number;
};

type BackupRow = {
  id: string;
  filename: string;
  completed_at: number | null;
  size_bytes: number;
  status: string;
  backup_type: string;
};

function listHAEvents(db: NexusDatabase | undefined, limit: number): HAEventRow[] {
  if (!db) return [];
  try {
    return db.db
      .prepare("SELECT id, event_type, source, from_instance, to_instance, details_json, created_at FROM ha_events ORDER BY created_at DESC LIMIT ?")
      .all(limit) as HAEventRow[];
  } catch {
    return [];
  }
}

function getLastBackup(db: NexusDatabase | undefined): BackupRow | null {
  if (!db) return null;
  try {
    return db.db
      .prepare("SELECT id, filename, completed_at, size_bytes, status, backup_type FROM db_backups WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1")
      .get() as BackupRow | undefined ?? null;
  } catch {
    return null;
  }
}

function renderHAEventsTable(events: HAEventRow[]): string {
  if (events.length === 0) return `<div class="no-data">No HA events recorded.</div>`;
  return `<table>
    <thead>
      <tr>
        <th>Time</th>
        <th>Event</th>
        <th>Source</th>
        <th>From</th>
        <th>To</th>
      </tr>
    </thead>
    <tbody>
      ${events
        .map((e) => {
          const eventClass = e.event_type === "failover" ? "running" : e.event_type === "failback" ? "complete" : "enabled";
          return `<tr>
            <td>${escapeHtml(formatTime(e.created_at))}</td>
            <td><span class="badge status-${eventClass}">${escapeHtml(e.event_type)}</span></td>
            <td>${escapeHtml(e.source)}</td>
            <td>${escapeHtml(e.from_instance ?? "-")}</td>
            <td>${escapeHtml(e.to_instance ?? "-")}</td>
          </tr>`;
        })
        .join("")}
    </tbody>
  </table>`;
}

function escapeClass(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…(+${text.length - maxChars} chars)`;
}

function formatTime(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(ms);
  }
}

function clampInt(value: string | undefined, min: number, max: number): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
