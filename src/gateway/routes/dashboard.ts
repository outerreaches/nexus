import type { Hono } from "hono";
import type { GatewayHttpDeps } from "../http.js";
import { initDataIntake, listDataSources } from "../../data-intake/index.js";
import { deleteDataItemsBySource } from "../../data-intake/store.js";
import { createIntakeSource, deleteIntakeSource, listIntakeSources, updateIntakeSource } from "../../data-intake/source-store.js";
import type { NexusDatabase } from "../../storage/database.js";
import {
  getMcpGrant,
  getMcpProfile,
  getMcpServer,
  listMcpGrants,
  listMcpProfiles,
  listMcpServers,
  revokeMcpGrant,
  updateMcpProfile,
  updateMcpServer,
  type McpGrantRecord,
} from "../../mcp/store.js";
import {
  clampInt,
  listProcesses,
  listAgents,
  listAgentGraph,
  listNodes,
  filterVisibleAgentRuns,
  filterVisibleAgentGraph,
  listJobs,
  listRunningJobRuns,
  listDataIntake,
  listBlackboard,
  listBlackboardScopes,
} from "../dashboard/queries.js";
import { renderDashboard } from "../dashboard/render.js";
import { cleanupManagedBlackboardAttachments } from "../../storage/blackboard-attachments.js";
import { archiveAndDeleteJob } from "../../storage/job-archive.js";
import { deleteNodeCascadeById, getNodeById, setNodeStatus, type NodeStatus } from "../../storage/nodes.js";

type McpEventRow = {
  id: string;
  server_id: string | null;
  profile_id: string | null;
  kind: string;
  payload_json: string;
  created_at: number;
};

function parseFormBoolean(value: unknown): boolean | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function listRecentMcpEvents(db: NexusDatabase, limit: number): McpEventRow[] {
  try {
    return db.db
      .prepare("SELECT id, server_id, profile_id, kind, payload_json, created_at FROM mcp_events ORDER BY created_at DESC LIMIT ?")
      .all(limit) as McpEventRow[];
  } catch {
    return [];
  }
}

function revokeMatchingActiveMcpGrants(params: {
  db: NexusDatabase;
  nowMs: number;
  reason: string;
  shouldRevoke: (grant: McpGrantRecord) => boolean;
}): number {
  let revoked = 0;
  const activeGrants = listMcpGrants(params.db, { includeExpired: false, includeRevoked: false });
  for (const grant of activeGrants) {
    if (grant.status !== "active") continue;
    if (!params.shouldRevoke(grant)) continue;
    const updated = revokeMcpGrant(params.db, grant.id, params.reason, params.nowMs);
    if (updated) revoked += 1;
  }
  return revoked;
}

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
    const visibleNodeWindowSeconds = clampInt(c.req.query("visibleNodeWindowSeconds"), 10, 3600) ?? 60;
    const nodeLimit = clampInt(c.req.query("nodeLimit"), 1, 500) ?? 200;
    const visibleNodeWindowMs = visibleNodeWindowSeconds * 1000;
    const jobLimit = clampInt(c.req.query("jobLimit"), 1, 200) ?? 50;
    const runLimit = clampInt(c.req.query("runLimit"), 1, 200) ?? 50;
    const blackboardLimit = clampInt(c.req.query("blackboardLimit"), 1, 200) ?? 50;
    const blackboardScopeRaw = String(c.req.query("blackboardScope") ?? "").trim();
    const blackboardScope = blackboardScopeRaw && blackboardScopeRaw !== "all" ? blackboardScopeRaw : null;
    const dataIntakeLimit = clampInt(c.req.query("dataIntakeLimit"), 1, 200) ?? 50;
    const hideOrphanData = c.req.query("hideOrphanData") === "true";

    const processes = listProcesses(deps.processManager, nowMs, processWindowMinutes * 60_000);
    const agents = listAgents(deps.agentTracker, nowMs, agentWindowMinutes * 60_000);
    const nodes = listNodes(deps.db, nodeLimit);
    const allowedRunIds = new Set([...agents.active, ...agents.recent].map((r) => r.runId));
    const agentGraph = filterVisibleAgentGraph(listAgentGraph(deps.db, allowedRunIds), nowMs, visibleNodeWindowMs);
    const visibleAgentsById = new Map(
      filterVisibleAgentRuns([...agents.active, ...agents.recent], nowMs, visibleNodeWindowMs).map((row) => [row.runId, row]),
    );
    const visibleAgents = [...visibleAgentsById.values()];
    const jobs = listJobs(deps.db, jobLimit);
    const runningJobRuns = listRunningJobRuns(deps.db);
    const dataIntake = listDataIntake(deps.db, nowMs, dataIntakeLimit, hideOrphanData);
    const blackboard = listBlackboard(deps.db, blackboardLimit, blackboardScope);
    const blackboardScopes = listBlackboardScopes(deps.db, 100);
    const mcpOverview = deps.mcp
      ? deps.mcp.getOverview()
      : {
          servers: deps.db
            ? listMcpServers(deps.db, { includeDisabled: true }).map((server) => ({
                id: server.id,
                label: server.label,
                enabled: server.enabled,
                active: server.active,
                connected: false,
                trustLevel: server.trustLevel,
                capabilityTags: server.capabilityTags,
                discoveredTools: server.lastDiscoveredTools.length,
                lastError: server.lastError,
                lastErrorAt: server.lastErrorAt,
                lastUsedAt: server.lastUsedAt,
              }))
            : [],
          profiles: deps.db
            ? listMcpProfiles(deps.db, { includeDisabled: true }).map((profile) => ({
                id: profile.id,
                name: profile.name,
                serverId: profile.serverId,
                enabled: profile.enabled,
                hidden: profile.hidden,
                ephemeral: profile.ephemeral,
                toolCount: profile.toolNames.length,
                updatedAt: profile.updatedAt,
              }))
            : [],
        };
    const profileNameById = new Map(mcpOverview.profiles.map((profile) => [profile.id, profile.name]));
    const mcpGrants = deps.db
      ? listMcpGrants(deps.db, { includeExpired: false, includeRevoked: false })
          .filter((grant) => grant.status === "active")
          .slice(0, 100)
          .map((grant) => ({
            id: grant.id,
            profileId: grant.profileId,
            profileName: profileNameById.get(grant.profileId) ?? grant.profileId,
            serverId: grant.serverId,
            targetPreset: grant.targetPreset,
            runId: grant.runId,
            parentRunId: grant.parentRunId,
            maxCalls: grant.maxCalls,
            callCount: grant.callCount,
            expiresAt: grant.expiresAt,
            status: grant.status,
            createdAt: grant.createdAt,
            updatedAt: grant.updatedAt,
          }))
      : [];
    const mcpEvents = deps.db
      ? listRecentMcpEvents(deps.db, 50).map((row) => ({
          id: row.id,
          serverId: row.server_id,
          profileId: row.profile_id,
          kind: row.kind,
          payloadJson: row.payload_json,
          createdAt: row.created_at,
        }))
      : [];

    return c.html(
      renderDashboard({
        status,
        nowMs,
        processWindowMinutes,
        agentWindowMinutes,
        visibleNodeWindowSeconds,
        processes,
        agents: { active: agents.active, recent: agents.recent },
        agentGraph,
        nodes,
        jobs,
        runningJobRuns,
        dataIntake,
        dataIntakeCatalog,
        mcp: {
          available: Boolean(deps.mcp),
          servers: mcpOverview.servers,
          profiles: mcpOverview.profiles,
          grants: mcpGrants,
          events: mcpEvents,
        },
        blackboard,
        blackboardScope: blackboardScopeRaw || "all",
        blackboardScopes,
        blackboardLimit,
        nodeLimit,
        jobLimit,
        runLimit,
        dataIntakeLimit,
        hideOrphanData,
        db: deps.db,
      }),
    );
  });

  app.post("/dashboard/mcp/server/enabled", async (c) => {
    if (!deps.db) return c.text("Database not available", 500);
    if (!deps.mcp) return c.text("MCP manager not available", 503);
    const body = await c.req.parseBody();
    const id = String(body.id ?? "").trim();
    if (!id) return c.text("Missing server id", 400);
    const enabled = parseFormBoolean(body.enabled);
    if (enabled === null) return c.text("Invalid enabled value", 400);
    const existing = getMcpServer(deps.db, id);
    if (!existing) return c.text("MCP server not found", 404);

    const nowMs = Date.now();
    if (!enabled) {
      if (existing.active) {
        await deps.mcp.deactivateServer(id);
      }
      const updated = updateMcpServer(deps.db, id, { enabled: false, active: false }, nowMs);
      if (!updated) return c.text("MCP server not found", 404);
      const revoked = revokeMatchingActiveMcpGrants({
        db: deps.db,
        nowMs,
        reason: `server_disabled:${id}`,
        shouldRevoke: (grant) => grant.serverId === id,
      });
      deps.log(`mcp: disabled server=${id} revoked_grants=${revoked}`);
    } else {
      const updated = updateMcpServer(deps.db, id, { enabled: true }, nowMs);
      if (!updated) return c.text("MCP server not found", 404);
      deps.log(`mcp: enabled server=${id}`);
    }
    return c.redirect("/dashboard");
  });

  app.post("/dashboard/mcp/server/active", async (c) => {
    if (!deps.db) return c.text("Database not available", 500);
    if (!deps.mcp) return c.text("MCP manager not available", 503);
    const body = await c.req.parseBody();
    const id = String(body.id ?? "").trim();
    if (!id) return c.text("Missing server id", 400);
    const active = parseFormBoolean(body.active);
    if (active === null) return c.text("Invalid active value", 400);
    const existing = getMcpServer(deps.db, id);
    if (!existing) return c.text("MCP server not found", 404);
    if (active && !existing.enabled) {
      return c.text("Cannot activate a disabled server. Enable it first.", 400);
    }

    if (active) {
      await deps.mcp.activateServer(id);
      deps.log(`mcp: activated server=${id}`);
    } else {
      await deps.mcp.deactivateServer(id);
      deps.log(`mcp: deactivated server=${id}`);
    }
    return c.redirect("/dashboard");
  });

  app.post("/dashboard/mcp/server/probe", async (c) => {
    if (!deps.db) return c.text("Database not available", 500);
    if (!deps.mcp) return c.text("MCP manager not available", 503);
    const body = await c.req.parseBody();
    const id = String(body.id ?? "").trim();
    if (!id) return c.text("Missing server id", 400);
    const existing = getMcpServer(deps.db, id);
    if (!existing) return c.text("MCP server not found", 404);
    await deps.mcp.probeServer(id);
    deps.log(`mcp: probed server=${id}`);
    return c.redirect("/dashboard");
  });

  app.post("/dashboard/mcp/profile/enabled", async (c) => {
    if (!deps.db) return c.text("Database not available", 500);
    const body = await c.req.parseBody();
    const id = String(body.id ?? "").trim();
    if (!id) return c.text("Missing profile id", 400);
    const enabled = parseFormBoolean(body.enabled);
    if (enabled === null) return c.text("Invalid enabled value", 400);
    const existing = getMcpProfile(deps.db, id);
    if (!existing) return c.text("MCP profile not found", 404);
    const nowMs = Date.now();
    const updated = updateMcpProfile(deps.db, id, { enabled }, nowMs);
    if (!updated) return c.text("MCP profile not found", 404);
    if (!enabled) {
      const revoked = revokeMatchingActiveMcpGrants({
        db: deps.db,
        nowMs,
        reason: `profile_disabled:${id}`,
        shouldRevoke: (grant) => grant.profileId === id,
      });
      deps.log(`mcp: disabled profile=${existing.name} revoked_grants=${revoked}`);
    } else {
      deps.log(`mcp: enabled profile=${existing.name}`);
    }
    return c.redirect("/dashboard");
  });

  app.post("/dashboard/mcp/grants/revoke", async (c) => {
    if (!deps.db) return c.text("Database not available", 500);
    const body = await c.req.parseBody();
    const id = String(body.id ?? "").trim();
    if (!id) return c.text("Missing grant id", 400);
    const existing = getMcpGrant(deps.db, id);
    if (!existing) return c.text("MCP grant not found", 404);
    const reasonRaw = String(body.reason ?? "").trim();
    const reason = reasonRaw.length > 0 ? reasonRaw.slice(0, 120) : "dashboard_revoke";
    const updated = revokeMcpGrant(deps.db, id, reason, Date.now());
    if (!updated) return c.text("MCP grant not found", 404);
    deps.log(`mcp: revoked grant=${id} reason=${reason}`);
    return c.redirect("/dashboard");
  });

  app.post("/dashboard/llm/mode", async (c) => {
    if (!deps.setModelMode) return c.text("LLM mode control is not available", 503);
    const body = await c.req.parseBody();
    const modeRaw = String(body.mode ?? "").trim().toLowerCase();
    if (modeRaw !== "default" && modeRaw !== "local_only") {
      return c.text("Invalid mode (expected default|local_only)", 400);
    }
    const mode = deps.setModelMode(modeRaw);
    deps.log(`dashboard: llm model mode set to ${mode}`);
    return c.redirect("/dashboard");
  });

  app.post("/dashboard/nodes/status", async (c) => {
    if (!deps.db) return c.text("Database not available", 500);
    const body = await c.req.parseBody();
    const id = String(body.id ?? "").trim();
    const statusRaw = String(body.status ?? "").trim().toLowerCase();
    if (!id) return c.text("Missing node id", 400);
    const allowed: readonly NodeStatus[] = ["pending", "approved", "blocked"];
    if (!allowed.includes(statusRaw as NodeStatus)) {
      return c.text("Invalid node status (expected pending|approved|blocked)", 400);
    }
    const existing = getNodeById(deps.db, id);
    if (!existing) return c.text("Node not found", 404);
    setNodeStatus(deps.db, {
      id,
      status: statusRaw as NodeStatus,
      connectedAt: null,
      nowMs: Date.now(),
    });
    return c.redirect("/dashboard");
  });

  app.post("/dashboard/nodes/delete", async (c) => {
    if (!deps.db) return c.text("Database not available", 500);
    const body = await c.req.parseBody();
    const id = String(body.id ?? "").trim();
    if (!id) return c.text("Missing node id", 400);
    const existing = getNodeById(deps.db, id);
    if (!existing) return c.text("Node not found", 404);
    if (existing.status === "online") {
      return c.text("Cannot delete an online node. Block it or wait for disconnect first.", 400);
    }

    const result = deleteNodeCascadeById(deps.db, id);
    if (!result.deleted) return c.text("Node not found", 404);
    deps.log(
      `nodes: deleted node=${id} sessions=${result.nodeSessionsDeleted} executions=${result.nodeExecutionsDeleted} process_runs=${result.processRunsDeleted} pairing_requests=${result.pairingRequestsDeleted}`,
    );
    return c.redirect("/dashboard");
  });

  app.post("/dashboard/blackboard/clear", async (c) => {
    if (!deps.db) return c.text("Database not available", 500);
    const body = await c.req.parseBody();
    const scopeRaw = String(body.scope ?? "all").trim();
    if (!scopeRaw || scopeRaw === "all") {
      const rows = deps.db.db.prepare("SELECT attachments_json FROM blackboard").all() as { attachments_json: string | null }[];
      deps.db.db.prepare("DELETE FROM blackboard").run();
      await cleanupManagedBlackboardAttachments({ stateDir: deps.stateDir, rows });
    } else {
      const rows = deps.db.db
        .prepare("SELECT attachments_json FROM blackboard WHERE session_scope = ?")
        .all(scopeRaw) as { attachments_json: string | null }[];
      deps.db.db.prepare("DELETE FROM blackboard WHERE session_scope = ?").run(scopeRaw);
      await cleanupManagedBlackboardAttachments({ stateDir: deps.stateDir, rows });
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

      const archived = archiveAndDeleteJob({
        db: deps.db,
        jobId: id,
        archivedAtMs: Date.now(),
        archiveReason: "dashboard_delete",
        archivedBy: "dashboard",
        metadata: { route: "/dashboard/jobs/delete" },
      });
      if (!archived.found) return c.text("Delete failed: job not found", 404);
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
