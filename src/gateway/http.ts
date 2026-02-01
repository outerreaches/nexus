import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { NexusDatabase } from "../storage/database.js";
import type { ProcessManager, ManagedProcessInfo } from "../process/manager.js";
import type { AgentTracker, AgentRunInfo } from "../core/agent-tracker.js";

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
  app.get("/dashboard", async (c) => {
    const status = await deps.getStatus();
    const nowMs = Date.now();

    const processWindowMinutes = clampInt(c.req.query("processWindowMinutes"), 5, 24 * 60) ?? 120;
    const agentWindowMinutes = clampInt(c.req.query("agentWindowMinutes"), 10, 24 * 60) ?? 360;
    const jobLimit = clampInt(c.req.query("jobLimit"), 1, 200) ?? 50;
    const runLimit = clampInt(c.req.query("runLimit"), 1, 200) ?? 50;
    const blackboardLimit = clampInt(c.req.query("blackboardLimit"), 1, 200) ?? 50;

    const processes = listProcesses(deps.processManager, nowMs, processWindowMinutes * 60_000);
    const agents = listAgents(deps.agentTracker, nowMs, agentWindowMinutes * 60_000);
    const allowedRunIds = new Set([...agents.active, ...agents.recent].map((r) => r.runId));
    const agentGraph = listAgentGraph(deps.db, allowedRunIds);
    const jobs = listJobs(deps.db, jobLimit);
    const jobRuns = listJobRuns(deps.db, runLimit);
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
        blackboard,
      }),
    );
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
  blackboard: BlackboardRow[];
}): string {
  const updatedAt = new Date(params.nowMs).toISOString();
  const statusJson = escapeHtml(JSON.stringify(params.status, null, 2));
  const hasAgents = params.agents.active.length + params.agents.recent.length > 0;
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
    <meta http-equiv="refresh" content="15" />
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
            <div id="agent-tooltip" class="agent-tooltip"></div>
          </div>
        </div>
        <div class="split">
          <div>
            <h3>Running</h3>
            ${renderAgentTable(params.agents.active)}
          </div>
          <div>
            <h3>Recent (${params.agentWindowMinutes}m)</h3>
            ${renderAgentTable(params.agents.recent)}
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

      const graphData = ${agentGraphJson};
      const hasAgents = ${hasAgents};
      const container = document.getElementById("agent-graph");
      const tooltip = document.getElementById("agent-tooltip");
      
      if (!container) {
        console.warn("Agent graph container missing");
      } else if (!hasAgents || !graphData || graphData.length === 0) {
        container.innerHTML = '<div class="no-data">No agent runs to display.</div>';
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

        const nodesById = new Map(graphData.map((n) => [n.run_id, { ...n, children: [] }]));
        for (const node of nodesById.values()) {
          if (node.parent_run_id && nodesById.has(node.parent_run_id)) {
            nodesById.get(node.parent_run_id).children.push(node);
          }
        }

        const roots = [...nodesById.values()].filter((n) => !n.parent_run_id || !nodesById.has(n.parent_run_id));
        
        // Solar system layout: single orchestrator at center, all agents orbit around it
        const baseOrbitRadius = 90;
        const orbitRadiusStep = 55;
        
        // Position all nodes to orbit around center (0,0,0) where the orchestrator will be
        const positionNode = (node, centerX, centerY, centerZ, depth, siblingIndex, siblingCount) => {
          node.depth = depth;
          // All nodes orbit - depth 0 are first-level agents around orchestrator
          const orbitRadius = baseOrbitRadius + depth * orbitRadiusStep * 0.6;
          const angleOffset = depth * 0.7; // Stagger angles by depth
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
          
          // Position children orbiting around this node
          node.children.forEach((child, idx) => {
            positionNode(child, node.x, node.y, node.z, depth + 1, idx, node.children.length);
          });
        };
        
        // All roots orbit the center orchestrator
        roots.forEach((root, idx) => positionNode(root, 0, 0, 0, 0, idx, roots.length));

        const statusColors = {
          running: 0x00ff41,
          complete: 0x00d4ff,
          failed: 0xff0040,
          budget_exhausted: 0xffb800,
        };

        const meshToNode = new Map();

        // Create orbit rings for visual effect
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

        // Add orbit rings around center orchestrator
        [90, 145, 200].forEach((r, i) => scene.add(createOrbitRing(r, -i * 12)));

        // Create the central orchestrator (always active, always at center)
        const orchestratorColor = 0x00ff41;
        const orchestratorRadius = 18;
        const orchestratorGeometry = new THREE.SphereGeometry(orchestratorRadius, 32, 32);
        const orchestratorMaterial = new THREE.MeshStandardMaterial({
          color: orchestratorColor,
          emissive: orchestratorColor,
          emissiveIntensity: 0.8,
          roughness: 0.2,
          metalness: 0.8,
        });
        const orchestratorMesh = new THREE.Mesh(orchestratorGeometry, orchestratorMaterial);
        orchestratorMesh.position.set(0, 0, 0);
        scene.add(orchestratorMesh);
        
        // Orchestrator glow layers
        const glowGeometry1 = new THREE.SphereGeometry(orchestratorRadius * 1.6, 32, 32);
        const glowMaterial1 = new THREE.MeshBasicMaterial({
          color: orchestratorColor,
          transparent: true,
          opacity: 0.12,
        });
        const glow1 = new THREE.Mesh(glowGeometry1, glowMaterial1);
        scene.add(glow1);
        
        const glowGeometry2 = new THREE.SphereGeometry(orchestratorRadius * 2.4, 32, 32);
        const glowMaterial2 = new THREE.MeshBasicMaterial({
          color: orchestratorColor,
          transparent: true,
          opacity: 0.05,
        });
        const glow2 = new THREE.Mesh(glowGeometry2, glowMaterial2);
        scene.add(glow2);
        
        // Virtual orchestrator node for tooltip
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
        meshToNode.set(orchestratorMesh, orchestratorNode);

        // Create agent nodes
        for (const node of nodesById.values()) {
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
          
          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.set(node.x ?? 0, node.y ?? 0, node.z ?? 0);
          scene.add(mesh);
          node.mesh = mesh;
          meshToNode.set(mesh, node);
        }

        // Connection lines from orchestrator to root agents
        const lineMaterial = new THREE.LineBasicMaterial({ 
          color: 0x00ff41, 
          transparent: true, 
          opacity: 0.5 
        });
        
        for (const root of roots) {
          const points = [
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(root.x ?? 0, root.y ?? 0, root.z ?? 0),
          ];
          const geometry = new THREE.BufferGeometry().setFromPoints(points);
          const line = new THREE.Line(geometry, lineMaterial.clone());
          scene.add(line);
          root.connectionLine = line;
          root.orbitCenterX = 0;
          root.orbitCenterY = 0;
          root.orbitCenterZ = 0;
        }

        // Connection lines for child agents (non-root nodes)
        const childLineMaterial = new THREE.LineBasicMaterial({ 
          color: 0x00ff41, 
          transparent: true, 
          opacity: 0.35
        });

        for (const node of nodesById.values()) {
          if (node.parent_run_id && nodesById.has(node.parent_run_id)) {
            const parent = nodesById.get(node.parent_run_id);
            const points = [
              new THREE.Vector3(parent.x ?? 0, parent.y ?? 0, parent.z ?? 0),
              new THREE.Vector3(node.x ?? 0, node.y ?? 0, node.z ?? 0),
            ];
            const geometry = new THREE.BufferGeometry().setFromPoints(points);
            const line = new THREE.Line(geometry, childLineMaterial.clone());
            scene.add(line);
            node.connectionLine = line;
          }
        }

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

        // Animation with gentle orbital motion
        let time = 0;
        const animate = () => {
          requestAnimationFrame(animate);
          time += 1;
          
          // Orchestrator glow pulse
          const glowPulse = 1 + Math.sin(time * 0.02) * 0.15;
          glow1.scale.setScalar(glowPulse);
          glow2.scale.setScalar(glowPulse * 0.95);
          orchestratorMesh.scale.setScalar(1 + Math.sin(time * 0.03) * 0.03);
          
          // Orbital animation for ALL nodes (including roots)
          for (const node of nodesById.values()) {
            if (node.mesh && node.orbitRadius > 0) {
              node.orbitAngle += node.orbitSpeed;
              const newX = node.orbitCenterX + Math.cos(node.orbitAngle) * node.orbitRadius;
              const newZ = node.orbitCenterZ + Math.sin(node.orbitAngle) * node.orbitRadius;
              node.mesh.position.x = newX;
              node.mesh.position.z = newZ;
              node.x = newX;
              node.z = newZ;
              
              // Update connection line
              if (node.connectionLine) {
                const positions = node.connectionLine.geometry.attributes.position.array;
                if (node.depth === 0) {
                  // Root nodes connect to center (orchestrator)
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
            
            // Pulse effect for running nodes
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
