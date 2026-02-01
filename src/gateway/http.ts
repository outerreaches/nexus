import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { NexusDatabase } from "../storage/database.js";
import type { ProcessManager, ManagedProcessInfo } from "../process/manager.js";
import type { AgentTracker, AgentRunInfo } from "../core/agent-tracker.js";
import { initDataIntake, listDataSources } from "../data-intake/index.js";
import { listLatestDataItems } from "../data-intake/store.js";
import { createIntakeSource, deleteIntakeSource, listIntakeSources, updateIntakeSource } from "../data-intake/source-store.js";

export type GatewayHttpDeps = {
  port: number;
  getStatus: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  log: (msg: string) => void;
  db?: NexusDatabase;
  processManager?: ProcessManager;
  agentTracker?: AgentTracker;
};

export async function startHttpServer(deps: GatewayHttpDeps): Promise<{ stop: () => Promise<void>; app: Hono }> {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));
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
  
  app.get("/dashboard", async (c) => {
    const status = await deps.getStatus();
    const nowMs = Date.now();

    initDataIntake();
    const dataIntakeCatalog = listDataSources().map((source) => ({
      id: source.id,
      name: source.name,
      description: source.description,
      tags: source.tags,
    }));

    const processWindowMinutes = clampInt(c.req.query("processWindowMinutes"), 5, 24 * 60) ?? 120;
    const agentWindowMinutes = clampInt(c.req.query("agentWindowMinutes"), 10, 24 * 60) ?? 360;
    const jobLimit = clampInt(c.req.query("jobLimit"), 1, 200) ?? 50;
    const runLimit = clampInt(c.req.query("runLimit"), 1, 200) ?? 50;
    const blackboardLimit = clampInt(c.req.query("blackboardLimit"), 1, 200) ?? 50;
    const dataIntakeLimit = clampInt(c.req.query("dataIntakeLimit"), 1, 200) ?? 50;

    const processes = listProcesses(deps.processManager, nowMs, processWindowMinutes * 60_000);
    const agents = listAgents(deps.agentTracker, nowMs, agentWindowMinutes * 60_000);
    const allowedRunIds = new Set([...agents.active, ...agents.recent].map((r) => r.runId));
    const agentGraph = listAgentGraph(deps.db, allowedRunIds);
    const jobs = listJobs(deps.db, jobLimit);
    const jobRuns = listJobRuns(deps.db, runLimit);
    const dataIntake = listDataIntake(deps.db, nowMs, dataIntakeLimit);
    const blackboard = listBlackboard(deps.db, blackboardLimit);

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
        jobRuns,
        dataIntake,
        dataIntakeCatalog,
        blackboard,
      }),
    );
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
    });
    return c.redirect("/dashboard");
  });

  app.post("/dashboard/data-intake/delete", async (c) => {
    if (!deps.db) return c.text("Database not available", 500);
    const body = await c.req.parseBody();
    const id = String(body.id ?? "").trim();
    if (!id) return c.text("Missing id", 400);
    deleteIntakeSource({ db: deps.db, id });
    return c.redirect("/dashboard");
  });

  app.post("/dashboard/data-intake/schedule", async (c) => {
    if (!deps.db) return c.text("Database not available", 500);
    const body = await c.req.parseBody();
    const jobName = String(body.jobName ?? "").trim();
    const cron = String(body.cron ?? "").trim();
    const timezone = String(body.timezone ?? "UTC").trim() || "UTC";
    if (!jobName) return c.text("Missing jobName", 400);
    if (!cron) return c.text("Missing cron", 400);

    const { nextCronTimeMs, parseCron, validateTimeZone } = await import("../scheduler/cron.js");
    const nowMs = Date.now();
    const next = nextCronTimeMs({
      schedule: parseCron(cron),
      afterMs: nowMs,
      timeZone: validateTimeZone(timezone),
    });
    const crypto = await import("node:crypto");
    const id = `J${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
    const task = [
      "Refresh all enabled data intake source instances from storage.",
      "",
      "Steps:",
      "1) Call data_intake_source_list with includeDisabled=false.",
      "2) For each source instance, call data_intake_run using source_id and params_json.",
      "3) Report any failures.",
      "",
      "Parsing params_json:",
      "- params_json is a JSON string; parse it to an object before passing to data_intake_run.",
    ].join("\n");
    const spec = { mode: "agent_task", task };
    const owner = "main";
    deps.db.db
      .prepare(
        "INSERT INTO jobs (id, owner_agent_id, name, cron, timezone, enabled, spec_json, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, owner, `data-intake: ${jobName}`, cron, validateTimeZone(timezone), 1, JSON.stringify(spec), next, nowMs, nowMs);

    return c.redirect("/dashboard");
  });

  const server = serve({
    fetch: app.fetch,
    port: deps.port,
  });

  deps.log(`http: listening on :${deps.port}`);

  return {
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
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
  subject: string;
  value_json: string;
  collected_at: number;
  expires_at: number;
};

type DataIntakePanelState = {
  enabled: boolean;
  targets: string[];
  rows: DataIntakeRow[];
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
      "SELECT id, owner_agent_id, name, cron, timezone, enabled, next_run_at, last_run_at, consecutive_failures, last_failure_at FROM jobs ORDER BY created_at DESC LIMIT ?",
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

function listBlackboard(db: NexusDatabase | undefined, limit: number): BlackboardRow[] {
  if (!db) return [];
  return db.db
    .prepare(
      "SELECT id, session_scope, type, agent_id, agent_preset, title, content, created_at, expires_at FROM blackboard ORDER BY created_at DESC LIMIT ?",
    )
    .all(limit) as BlackboardRow[];
}

function listDataIntake(
  db: NexusDatabase | undefined,
  nowMs: number,
  limit: number,
): DataIntakePanelState {
  if (!db) return { enabled: true, targets: [], rows: [], sources: [] };
  const rows = listLatestDataItems({
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
  return { enabled: true, targets: sources.map((row) => row.source_id), rows, sources };
}

function renderDashboard(params: {
  status: Record<string, unknown>;
  nowMs: number;
  processWindowMinutes: number;
  agentWindowMinutes: number;
  processes: ManagedProcessInfo[];
  agents: { active: AgentRunInfo[]; recent: AgentRunInfo[] };
  agentGraph: AgentRunRow[];
  jobs: JobRow[];
  jobRuns: JobRunRow[];
  dataIntake: DataIntakePanelState;
  dataIntakeCatalog: DataIntakeCatalogEntry[];
  blackboard: BlackboardRow[];
}): string {
  const updatedAt = new Date(params.nowMs).toISOString();
  const statusJson = escapeHtml(JSON.stringify(params.status, null, 2));
  const hasAgents = params.agents.active.length + params.agents.recent.length > 0;
  
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
      .graph-wrap {
        border: 1px solid var(--line);
        border-radius: 4px;
        padding: 12px;
        background: #050505;
        margin-bottom: 16px;
        box-shadow: inset 0 0 40px rgba(0, 0, 0, 0.8);
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
      .inline-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .inline-actions form {
        margin: 0;
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
      <div class="meta">Updated ${escapeHtml(updatedAt)} · Auto-refresh 15s</div>
    </header>
    <main>
      <section>
        <h2>Agents</h2>
        <div class="graph-wrap">
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
      </section>

      <section>
        <h2>Processes (${params.processWindowMinutes}m window)</h2>
        ${renderProcessTable(params.processes)}
      </section>

      <section>
        <h2>Scheduled Jobs</h2>
        ${renderJobsTable(params.jobs)}
        <h3>Recent Job Runs</h3>
        ${renderJobRunsTable(params.jobRuns)}
      </section>

      <section>
        <h2>Data Intake</h2>
        ${renderDataIntakeTable(params.dataIntake, params.dataIntakeCatalog)}
      </section>

      <section>
        <h2>Blackboard</h2>
        ${renderBlackboardTable(params.blackboard)}
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
        <th>ID</th>
        <th>Name</th>
        <th>Cron</th>
        <th>Timezone</th>
        <th>Owner</th>
        <th>Next Run</th>
        <th>Last Run</th>
        <th>Failures</th>
      </tr>
    </thead>
    <tbody>
      ${rows
        .map((j) => {
          const enabled = j.enabled === 1;
          return `<tr>
            <td><span class="badge ${enabled ? "status-enabled" : "status-disabled"}">${enabled ? "enabled" : "disabled"}</span></td>
            <td>${escapeHtml(j.id)}</td>
            <td>${escapeHtml(j.name)}</td>
            <td>${escapeHtml(j.cron)}</td>
            <td>${escapeHtml(j.timezone)}</td>
            <td>${escapeHtml(j.owner_agent_id)}</td>
            <td>${escapeHtml(j.next_run_at ? formatTime(j.next_run_at) : "-")}</td>
            <td>${escapeHtml(j.last_run_at ? formatTime(j.last_run_at) : "-")}</td>
            <td>${escapeHtml(String(j.consecutive_failures ?? 0))}</td>
          </tr>`;
        })
        .join("")}
    </tbody>
  </table>`;
}

function renderJobRunsTable(rows: JobRunRow[]): string {
  if (rows.length === 0) return `<div class="no-data">No job runs found.</div>`;
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

  const scheduleForm = `<form method="post" action="/dashboard/data-intake/schedule" class="form-inline">
    <div class="form-row">
      <label>Job Name</label>
      <input type="text" name="jobName" placeholder="data-intake refresh" required />
    </div>
    <div class="form-row">
      <label>Cron</label>
      <input type="text" name="cron" placeholder="*/5 * * * *" required />
    </div>
    <div class="form-row">
      <label>Timezone</label>
      <input type="text" name="timezone" placeholder="UTC" />
    </div>
    <button type="submit" class="graph-btn">Create Refresh Job</button>
  </form>`;

  const sourcesTable = params.sources.length === 0
    ? `<div class="no-data">No data intake sources configured.</div>`
    : `<table>
      <thead>
        <tr>
          <th>Status</th>
          <th>ID</th>
          <th>Source</th>
          <th>Label</th>
          <th>Interval</th>
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
              <td>${escapeHtml(`${Math.round(row.interval_ms / 60000)}m`)}</td>
              <td>${escapeHtml(row.last_run_at ? formatTime(row.last_run_at) : "-")}</td>
              <td>${escapeHtml(row.last_error ? truncate(row.last_error, 80) : "-")}</td>
              <td>
                <div class="inline-actions">
                  <form method="post" action="/dashboard/data-intake/update" class="inline-edit">
                    <input type="hidden" name="id" value="${escapeHtml(row.id)}" />
                    <input type="text" name="label" class="inline-input" placeholder="Label" value="${escapeHtml(row.label ?? "")}" />
                    <input type="number" name="intervalMs" class="inline-input" min="60000" placeholder="Interval ms" value="${escapeHtml(String(row.interval_ms))}" />
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
                    <button type="submit" class="graph-btn">Delete</button>
                  </form>
                </div>
              </td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>`;

  const latestTable = params.rows.length === 0
    ? `<div class="no-data">No recent data intake items found.</div>`
    : `<h3>Latest Values</h3>
      <table>
        <thead>
          <tr>
            <th>Source</th>
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
              return `<tr>
                <td>${escapeHtml(row.source_name || row.source_id)}</td>
                <td>${escapeHtml(row.subject)}</td>
                <td>${escapeHtml(truncate(valueText, 120))}</td>
                <td>${escapeHtml(formatTime(row.collected_at))}</td>
                <td>${escapeHtml(formatTime(row.expires_at))}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>`;

  return `${addForm}${scheduleForm}${sourcesTable}${latestTable}`;
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
