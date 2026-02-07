import type { NexusDatabase } from "../../storage/database.js";
import type {
  AgentRunInfo,
  ManagedProcessInfo,
  AgentRunRow,
  JobRow,
  JobRunRow,
  BlackboardRow,
  DataIntakePanelState,
  DataIntakeCatalogEntry,
} from "./types.js";
import { listHAEvents, getLastBackup } from "./queries.js";
import { dashboardStyles } from "./styles.js";
import {
  renderAgentTable,
  renderProcessTable,
  renderJobsTable,
  renderJobRunsTable,
  renderDataIntakeTable,
  renderBlackboardTable,
  renderHAEventsTable,
  escapeHtml,
  safeJsonForScript,
  truncate,
  formatTime,
} from "./tables.js";

export { renderAgentTable, escapeHtml, safeJsonForScript };

export function renderDashboard(params: {
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
    <style>${dashboardStyles()}</style>
  </head>
  <body>
    <header>
      <h1>Nexus Dashboard <span class="mode-pill ${modeClass}">${escapeHtml(modeLabel)}</span></h1>
      <div class="meta">Last updated: ${escapeHtml(updatedAt)}</div>
    </header>
    <main>
      <section>
        <div class="section-header">
          <h2>Agents (${params.agentWindowMinutes}m window)</h2>
          <div class="tab-bar">
            <button class="tab-btn active" data-tab="agents-view">Agents</button>
            <button class="tab-btn" data-tab="docker-logs">Logs</button>
          </div>
        </div>
        <div class="graph-wrap">
          <div class="tab-panel active" id="tab-agents-view">
            <div class="graph-header">
              <span>Agent Network Topology</span>
              <span>Nodes: <span id="stat-total">${agentStats.total}</span></span>
            </div>
            <div class="graph" id="agent-graph">
              <div class="agent-tooltip" id="agent-tooltip"></div>
              <div class="graph-stats">
                <div class="stat-row"><span class="stat-label">Running</span><span class="stat-value running" id="stat-running">${agentStats.running}</span></div>
                <div class="stat-row"><span class="stat-label">Complete</span><span class="stat-value" id="stat-complete">${agentStats.complete}</span></div>
                <div class="stat-row"><span class="stat-label">Failed</span><span class="stat-value failed" id="stat-failed">${agentStats.failed}</span></div>
              </div>
              <div class="graph-controls">
                <button class="graph-btn" id="btn-pause">Pause</button>
              </div>
              <div class="refresh-indicator" id="refresh-indicator">Update in 5s</div>
            </div>
          </div>
          <div class="tab-panel" id="tab-docker-logs">
            <div class="log-controls">
              <button class="graph-btn" id="logs-refresh">Refresh</button>
              <label style="display:flex; align-items:center; gap:6px; font-size:11px;">
                <input id="logs-auto" type="checkbox" /> Auto
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
            <div id="table-recent" class="scroll-5">${renderAgentTable(params.agents.recent)}</div>
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
        <div class="scroll-12">${renderJobsTable(params.jobs)}</div>
        <div class="section-header">
          <h3>Running Jobs</h3>
          <a href="/api/job-runs/export.csv?limit=1000" class="btn-export" download>Export All Runs (CSV)</a>
        </div>
        <div class="scroll-5">${renderJobRunsTable(params.runningJobRuns)}</div>
      </section>

      <section>
        <h2>Data Intake</h2>
        <div class="scroll-12">${renderDataIntakeTable(params.dataIntake, params.dataIntakeCatalog)}</div>
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
        <div class="scroll-16">${renderBlackboardTable(params.blackboard)}</div>
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
        <div class="scroll-16">${renderHAEventsTable(haEvents)}</div>
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

      // Filter out completed/failed nodes older than 60s from the 3D visualization
      const VISUAL_DECAY_MS = 60_000;
      const filterVisibleNodes = (nodes) => {
        const now = Date.now();
        return nodes.filter((n) => n.status === 'running' || !n.ended_at || (now - n.ended_at) < VISUAL_DECAY_MS);
      };

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
            updateSceneWithNewData(sceneState, filterVisibleNodes(data.nodes));
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

        // Build initial node tree (filter out stale completed nodes from visualization)
        const { nodesById, roots } = buildNodeTree(filterVisibleNodes(graphData));

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
