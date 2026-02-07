import type { Hono } from "hono";
import type { GatewayHttpDeps } from "../http.js";
import { initDataIntake, listDataSources } from "../../data-intake/index.js";
import { deleteDataItemsBySource } from "../../data-intake/store.js";
import { createIntakeSource, deleteIntakeSource, listIntakeSources, updateIntakeSource } from "../../data-intake/source-store.js";
import {
  clampInt,
  listProcesses,
  listAgents,
  listAgentGraph,
  listJobs,
  listRunningJobRuns,
  listDataIntake,
  listBlackboard,
  listBlackboardScopes,
} from "../dashboard/queries.js";
import { renderDashboard } from "../dashboard/render.js";

export function registerDashboardRoutes(app: Hono, deps: GatewayHttpDeps): void {
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
    const sources = listIntakeSources({ db: deps.db, includeDisabled: true });
    const existingSourceIds = new Set(sources.map((s) => s.source_id));
    const allDataSourceIds = deps.db.db
      .prepare("SELECT DISTINCT source_id FROM data_items")
      .all() as { source_id: string }[];
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
}
