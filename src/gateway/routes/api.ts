import type { Hono } from "hono";
import path from "node:path";
import fs from "node:fs/promises";
import type { GatewayHttpDeps } from "../http.js";
import type { AgentRunInfo } from "../dashboard/types.js";
import {
  clampInt,
  listAgents,
  listAgentGraph,
  filterVisibleAgentRuns,
  filterVisibleAgentGraph,
  listNodes as listNodeRows,
  getNodeById as getNodeRowById,
  listJobRuns,
  listLlmSessions,
  listLlmMessages,
} from "../dashboard/queries.js";
import { getNodeById as getNodeRecordById, setNodeStatus as setNodeRecordStatus } from "../../storage/nodes.js";

export function registerApiRoutes(app: Hono, deps: GatewayHttpDeps): void {
  app.get("/status", async (c) => c.json(await deps.getStatus()));

  // JSON API for live agent graph updates (used by dashboard for smooth refresh)
  app.get("/api/agents", async (c) => {
    const nowMs = Date.now();
    const agentWindowMinutes = clampInt(c.req.query("agentWindowMinutes"), 10, 24 * 60) ?? 360;
    const visibleNodeWindowSeconds = clampInt(c.req.query("visibleNodeWindowSeconds"), 10, 3600) ?? 60;
    const visibleNodeWindowMs = visibleNodeWindowSeconds * 1000;
    const agents = listAgents(deps.agentTracker, nowMs, agentWindowMinutes * 60_000);
    const allowedRunIds = new Set([...agents.active, ...agents.recent].map((r) => r.runId));
    const agentGraph = listAgentGraph(deps.db, allowedRunIds);
    const visibleGraph = filterVisibleAgentGraph(agentGraph, nowMs, visibleNodeWindowMs);
    const mergedAgentRows = [...agents.active, ...agents.recent];
    const visibleAgentRunsById = new Map(filterVisibleAgentRuns(mergedAgentRows, nowMs, visibleNodeWindowMs).map((r) => [r.runId, r]));
    const visibleAgentRuns = [...visibleAgentRunsById.values()];

    const nodes = visibleGraph.map(({ run_id, parent_run_id, agent_id, preset, status, started_at, ended_at, task }) => ({
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
      running: visibleGraph.filter((a) => a.status === "running").length,
      complete: visibleGraph.filter((a) => a.status === "complete").length,
      failed: visibleGraph.filter((a) => a.status === "failed" || a.status === "stopped").length,
      total: visibleGraph.length,
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
      recent: visibleAgentRuns.map(formatAgentRow),
    };

    return c.json({ nodes, stats, tables, timestamp: nowMs, visibleNodeWindowSeconds });
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

  app.get("/api/nodes", async (c) => {
    const limit = clampInt(c.req.query("limit"), 1, 500) ?? 200;
    const rows = listNodeRows(deps.db, limit);
    const nodes = rows.map((row) => ({
      id: row.id,
      label: row.label,
      backend: row.backend,
      status: row.status,
      trustLevel: row.trust_level,
      firewallMode: row.firewall_mode,
      endpoint: row.endpoint,
      capabilities: parseStringArrayJson(row.capabilities_json),
      tags: parseStringArrayJson(row.tags_json),
      lastSeenAt: row.last_seen_at,
      connectedAt: row.connected_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    return c.json({ nodes, timestamp: Date.now() });
  });

  app.get("/api/nodes/:id", async (c) => {
    const id = String(c.req.param("id") ?? "").trim();
    if (!id) return c.json({ error: "id is required" }, 400);
    const row = getNodeRowById(deps.db, id);
    if (!row) return c.json({ error: "node not found" }, 404);
    return c.json({
      node: {
        id: row.id,
        label: row.label,
        backend: row.backend,
        status: row.status,
        trustLevel: row.trust_level,
        firewallMode: row.firewall_mode,
        endpoint: row.endpoint,
        capabilities: parseStringArrayJson(row.capabilities_json),
        tags: parseStringArrayJson(row.tags_json),
        lastSeenAt: row.last_seen_at,
        connectedAt: row.connected_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      timestamp: Date.now(),
    });
  });

  app.get("/api/nodes/:id/audit", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    if (!deps.nodeGateway) return c.json({ error: "node gateway is not available" }, 503);

    const id = String(c.req.param("id") ?? "").trim();
    if (!id) return c.json({ error: "id is required" }, 400);
    const row = getNodeRowById(deps.db, id);
    if (!row) return c.json({ error: "node not found" }, 404);
    if (row.backend !== "nexus") {
      return c.json({ error: `node backend ${row.backend} does not support audit.query` }, 400);
    }

    const limit = clampInt(c.req.query("limit"), 1, 500) ?? 100;
    const timeoutMs = clampInt(c.req.query("timeoutMs"), 2_000, 120_000) ?? 15_000;
    const cursorCreatedAt = parseOptionalInt(c.req.query("cursorCreatedAt") ?? c.req.query("cursor"));
    const type = parseOptionalText(c.req.query("type"), 128);
    const processId = parseOptionalText(c.req.query("processId") ?? c.req.query("process"), 128);
    const firewallSession = parseOptionalText(c.req.query("firewallSession"), 256);
    const actor = parseOptionalText(c.req.query("actor"), 256);
    const requestArgs: Record<string, unknown> = {
      id,
      limit,
    };
    if (cursorCreatedAt !== null) requestArgs.cursorCreatedAt = cursorCreatedAt;
    if (type) requestArgs.type = type;
    if (processId) requestArgs.processId = processId;
    if (firewallSession) requestArgs.firewallSession = firewallSession;
    if (actor) requestArgs.actor = actor;

    try {
      const raw = await deps.nodeGateway.executeRoutedCall({
        nodeId: id,
        remoteName: "audit.query",
        args: requestArgs,
        timeoutMs,
        ctx: {
          workspaceDir: "",
          stateDir: deps.stateDir,
          codeDir: "",
          executionNode: id,
          executionMode: "remote",
          nowMs: () => Date.now(),
          log: deps.log,
        },
      });
      const parsed = parseJsonObject(raw);
      return c.json({
        nodeId: id,
        source: "remote",
        timestamp: Date.now(),
        ...(parsed ?? { payload: raw }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = readErrorCode(err);
      const status =
        code === "NODE_SOCKET_UNAVAILABLE" || code === "NODE_OFFLINE"
          ? 503
          : code === "NODE_RESPONSE_TIMEOUT"
            ? 504
            : code === "NODE_PROTOCOL_ERROR"
              ? 400
              : 502;
      return c.json(
        {
          error: message,
          code,
          nodeId: id,
          timestamp: Date.now(),
        },
        status,
      );
    }
  });

  app.post("/api/nodes/:id/status", async (c) => {
    if (!deps.db) return c.json({ error: "database is not available" }, 503);
    const id = String(c.req.param("id") ?? "").trim();
    if (!id) return c.json({ error: "id is required" }, 400);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const status = parseNodeStatus(asObject(body).status);
    if (!status) {
      return c.json(
        { error: "status must be one of pending|approved|blocked|offline|online" },
        400,
      );
    }

    const existing = getNodeRecordById(deps.db, id);
    if (!existing) return c.json({ error: "node not found" }, 404);

    const nowMs = Date.now();
    const connectedAt = status === "online" ? existing.connectedAt : null;
    setNodeRecordStatus(deps.db, {
      id,
      status,
      connectedAt,
      nowMs,
    });
    const updated = getNodeRecordById(deps.db, id);
    if (!updated) return c.json({ error: "node not found after update" }, 404);

    return c.json({
      ok: true,
      node: updated,
      timestamp: nowMs,
    });
  });

  app.get("/api/llm/sessions", async (c) => {
    const limit = clampInt(c.req.query("limit"), 1, 200) ?? 50;
    const channel = c.req.query("channel") ?? null;
    const channelKey = c.req.query("channelKey") ?? null;
    const agentId = c.req.query("agentId") ?? null;
    const sessions = listLlmSessions(deps.db, {
      limit,
      channel,
      channelKey,
      agentId,
    });
    return c.json({ sessions, timestamp: Date.now() });
  });

  app.get("/api/llm/messages", async (c) => {
    const sessionId = String(c.req.query("sessionId") ?? "").trim();
    if (!sessionId) return c.json({ error: "sessionId is required" }, 400);
    const limit = clampInt(c.req.query("limit"), 1, 500) ?? 200;
    const beforeIdRaw = String(c.req.query("beforeId") ?? "").trim();
    const beforeId = beforeIdRaw ? Number(beforeIdRaw) : null;
    const before = Number.isFinite(beforeId) && (beforeId ?? 0) > 0 ? Math.floor(beforeId as number) : null;

    const result = listLlmMessages(deps.db, {
      sessionId,
      limit,
      beforeId: before,
    });
    return c.json({
      sessionId,
      messages: result.messages,
      hasMore: result.hasMore,
      nextBeforeId: result.nextBeforeId,
      timestamp: Date.now(),
    });
  });

  app.get("/api/job-runs/export.csv", async (c) => {
    const limit = clampInt(c.req.query("limit"), 1, 10000) ?? 1000;
    const rows = listJobRuns(deps.db, limit);

    const csvHeader = "id,job_id,agent_id,scheduled_for,started_at,ended_at,status,error,tool_calls_used,iterations_used";
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
        escapeCsv(r.agent_id),
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
}

function parseStringArrayJson(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseOptionalInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed);
}

function parseOptionalText(value: string | undefined, maxChars: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string" && code.trim().length > 0) return code;
  return "NODE_AUDIT_QUERY_FAILED";
}

function parseNodeStatus(value: unknown): "pending" | "approved" | "blocked" | "offline" | "online" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  switch (normalized) {
    case "pending":
      return "pending";
    case "approved":
      return "approved";
    case "blocked":
      return "blocked";
    case "offline":
      return "offline";
    case "online":
      return "online";
    default:
      return null;
  }
}
