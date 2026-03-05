import type { NexusDatabase } from "../../storage/database.js";
import type {
  AgentRunInfo,
  ManagedProcessInfo,
  AgentRunRow,
  NodeRow,
  JobRow,
  JobRunRow,
  BlackboardRow,
  DataIntakePanelState,
  DataIntakeCatalogEntry,
  McpPanelState,
} from "./types.js";
import { listHAEvents, getLastBackup } from "./queries.js";
import { dashboardStyles } from "./styles.js";
import {
  renderAgentTable,
  renderProcessTable,
  renderNodesTable,
  renderJobsTable,
  renderJobRunsTable,
  renderDataIntakeTable,
  renderBlackboardTable,
  renderMcpServersTable,
  renderMcpProfilesTable,
  renderMcpGrantsTable,
  renderMcpEventsTable,
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
  visibleNodeWindowSeconds: number;
  nodeLimit: number;
  jobLimit: number;
  runLimit: number;
  blackboardLimit: number;
  dataIntakeLimit: number;
  hideOrphanData: boolean;
  processes: ManagedProcessInfo[];
  agents: { active: AgentRunInfo[]; recent: AgentRunInfo[] };
  agentGraph: AgentRunRow[];
  nodes: NodeRow[];
  jobs: JobRow[];
  runningJobRuns: JobRunRow[];
  dataIntake: DataIntakePanelState;
  dataIntakeCatalog: DataIntakeCatalogEntry[];
  mcp: McpPanelState;
  blackboard: BlackboardRow[];
  blackboardScope: string;
  blackboardScopes: string[];
  memoryHints: Record<string, string[]>;
  csrfToken?: string | null;
  db?: NexusDatabase;
}): string {
  const updatedAt = new Date(params.nowMs).toISOString();
  const statusJson = escapeHtml(JSON.stringify(params.status, null, 2));
  const modeRaw = String((params.status as { mode?: string }).mode ?? "unknown").toLowerCase();
  const modeLabel = modeRaw === "active" ? "ACTIVE" : modeRaw === "standby" ? "STANDBY" : modeRaw.toUpperCase();
  const modeClass = modeRaw === "active" ? "active" : modeRaw === "standby" ? "standby" : "unknown";
  const runtimeProfile = String((params.status as { runtime?: { profile?: string } }).runtime?.profile ?? "standard");
  const federation = (params.status as {
    federation?: {
      enabled?: boolean;
      derivedState?: string;
      trustedPeerCount?: number;
      healthyTrustedPeerCount?: number;
      identityValid?: boolean;
      firewallActive?: boolean;
    };
  }).federation;
  const federationEnabled = federation?.enabled === true;
  const federationState = String(federation?.derivedState ?? (federationEnabled ? "federation_capable" : "standalone"));
  const federationTrustedPeers = Number.isFinite(federation?.trustedPeerCount)
    ? Number(federation?.trustedPeerCount ?? 0)
    : 0;
  const federationHealthyTrustedPeers = Number.isFinite(federation?.healthyTrustedPeerCount)
    ? Number(federation?.healthyTrustedPeerCount ?? 0)
    : 0;
  const federationIdentity = federation?.identityValid === true ? "Valid" : "Missing";
  const federationFirewall = federation?.firewallActive === true ? "Active" : "Inactive";
  const heartbeat = (params.status as { proactive?: { enabled?: boolean; paused?: boolean; lastTickAt?: number | null; nextTickAt?: number | null; lastStatus?: string } })
    .proactive ?? { enabled: false };
  const heartbeatLabel = heartbeat.enabled ? (heartbeat.paused ? "Heartbeat (paused)" : "Heartbeat") : "Heartbeat (disabled)";
  const heartbeatLast = heartbeat.lastTickAt ? new Date(heartbeat.lastTickAt).toISOString() : "-";
  const heartbeatNext = heartbeat.nextTickAt ? new Date(heartbeat.nextTickAt).toISOString() : "-";
  const heartbeatStatus = heartbeat.lastStatus ? String(heartbeat.lastStatus) : "-";
  const heartbeatPanelClass = heartbeat.enabled ? (heartbeat.paused ? "paused" : "running") : "";
  const llmModeRaw = String((params.status as { llm?: { modelMode?: string } }).llm?.modelMode ?? "default").toLowerCase();
  const llmMode = llmModeRaw === "local_only" ? "local_only" : "default";
  const llmModeBadgeClass = llmMode === "local_only" ? "status-budget_exhausted" : "status-enabled";
  const llmModeLabel = llmMode === "local_only" ? "LOCAL ONLY" : "DEFAULT";
  const llmLocalProvider = String((params.status as { llm?: { localProvider?: string } }).llm?.localProvider ?? "local");
  const llmLocalModel = String((params.status as { llm?: { localModel?: string | null } }).llm?.localModel ?? "unknown");
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
    ["visibleNodeWindowSeconds", params.visibleNodeWindowSeconds],
    ["nodeLimit", params.nodeLimit],
    ["jobLimit", params.jobLimit],
    ["runLimit", params.runLimit],
    ["blackboardLimit", params.blackboardLimit],
    ["dataIntakeLimit", params.dataIntakeLimit],
    ["hideOrphanData", params.hideOrphanData ? "true" : "false"],
  ]
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${escapeHtml(String(value))}" />`)
    .join("");
  const auditCapableNodes = params.nodes.filter((row) => row.backend === "nexus");
  const nodeAuditDefaultNodeId = auditCapableNodes.find((row) => row.status === "online")?.id ?? auditCapableNodes[0]?.id ?? "";
  const nodeAuditNodeOptions = auditCapableNodes
    .map(
      (row) =>
        `<option value="${escapeHtml(row.id)}"${row.id === nodeAuditDefaultNodeId ? ' selected="selected"' : ""}>${escapeHtml(
          `${row.id} (${row.status})`,
        )}</option>`,
    )
    .join("");

  const isOrchestratorPreset = (preset: string | null | undefined) => String(preset ?? "").trim().toLowerCase() === "orchestrator";

  // Compute stats from displayed sub-agent graph (hide orchestrator runs from orb counts).
  const visibleSubAgentGraph = params.agentGraph.filter((row) => !isOrchestratorPreset(row.preset));
  const agentStats = {
    running: visibleSubAgentGraph.filter((a) => a.status === "running").length,
    complete: visibleSubAgentGraph.filter((a) => a.status === "complete").length,
    failed: visibleSubAgentGraph.filter((a) => a.status === "failed" || a.status === "stopped").length,
    total: visibleSubAgentGraph.length,
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
  const executionNodesJson = safeJsonForScript(
    params.nodes.map(({ id, label, backend, status, connected_at }) => ({
      id,
      label,
      backend,
      status,
      connected_at,
    })),
  );
  const maxAgentDepthRaw = Number.parseInt(String(process.env.NEXUS_MAX_AGENT_DEPTH ?? "4"), 10);
  const maxAgentDepth = Number.isFinite(maxAgentDepthRaw) ? Math.max(0, maxAgentDepthRaw) : 4;
  const maxAgentLevels = maxAgentDepth + 1;

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
  const mcpServerDisabled = params.mcp.servers.filter((row) => !row.enabled).length;
  const mcpServerActive = params.mcp.servers.filter((row) => row.active).length;
  const mcpServerConnected = params.mcp.servers.filter((row) => row.connected).length;
  const mcpServerDegraded = params.mcp.servers.filter((row) => row.lastError).length;
  const mcpProfileDisabled = params.mcp.profiles.filter((row) => !row.enabled).length;
  const csrfHiddenInput = params.csrfToken
    ? `<input type="hidden" name="csrfToken" value="${escapeHtml(params.csrfToken)}" />`
    : "";
  const csrfTokenJson = safeJsonForScript(params.csrfToken ?? null);

  const page = `<!doctype html>
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
      <div class="header-row">
        <h1>Nexus Dashboard</h1>
        <div class="header-actions">
          <span class="mode-pill ${modeClass}">${escapeHtml(modeLabel)}</span>
          <button type="button" class="graph-btn btn-danger header-stopall" id="stop-all-btn">Stop All</button>
          ${params.csrfToken ? `<form method="post" action="/auth/logout" class="form-inline compact"><button type="submit" class="graph-btn">Sign Out</button></form>` : ""}
        </div>
      </div>
      <div class="meta">Last updated: ${escapeHtml(updatedAt)}</div>
    </header>
    <main>
      <section>
        <div class="section-header">
          <h2>Agents (activity ${params.agentWindowMinutes}m)</h2>
          <div class="tab-bar">
            <button class="tab-btn active" data-tab="agents-view">Agents</button>
            <button class="tab-btn" data-tab="docker-logs">Logs</button>
            <button class="tab-btn" data-tab="llm-raw">LLM Raw</button>
            <button class="tab-btn" data-tab="cli-chat">CLI Chat</button>
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
                <button class="graph-btn" id="btn-reset-view">Reset View</button>
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
          <div class="tab-panel" id="tab-llm-raw">
            <div class="log-controls">
              <button class="graph-btn" id="llm-sessions-refresh">Sessions</button>
              <button class="graph-btn" id="llm-messages-refresh">Messages</button>
              <button class="graph-btn" id="llm-messages-older">Older</button>
              <label style="display:flex; align-items:center; gap:6px; font-size:11px;">
                Session limit
                <input id="llm-sessions-limit" class="inline-input" type="number" min="1" max="200" step="1" value="50" />
              </label>
              <label style="display:flex; align-items:center; gap:6px; font-size:11px;">
                Message limit
                <input id="llm-messages-limit" class="inline-input" type="number" min="1" max="500" step="1" value="200" />
              </label>
              <label style="display:flex; align-items:center; gap:6px; font-size:11px; min-width: 320px;">
                Session
                <select id="llm-session-select" class="inline-input" style="min-width: 320px;"></select>
              </label>
            </div>
            <pre id="llm-raw" class="log-viewer">Loading session list…</pre>
          </div>
          <div class="tab-panel" id="tab-cli-chat">
            <div class="cli-chat-shell">
              <div class="log-controls cli-chat-controls">
                <button class="graph-btn" id="cli-refresh">Refresh</button>
                <button class="graph-btn" id="cli-session-new">New Chat</button>
                <span id="cli-session-hint" class="meta">Session: initializing...</span>
              </div>
              <div id="cli-chat-view" class="cli-chat-view">
                <span class="log-empty">Preparing CLI chat...</span>
              </div>
              <div class="cli-chat-composer">
                <textarea
                  id="cli-input"
                  class="inline-input cli-chat-input"
                  rows="3"
                  placeholder="Type a message and press Enter. Use Shift+Enter for a newline."
                ></textarea>
                <button class="graph-btn" id="cli-send">Send</button>
              </div>
            </div>
          </div>
        </div>
        <div class="split">
          <div>
            <h3>Running</h3>
            <div id="table-active">${renderAgentTable(params.agents.active)}</div>
          </div>
          <div>
            <h3>Recent Activity (${params.agentWindowMinutes}m)</h3>
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
        <div class="scroll-5">${renderProcessTable(params.processes)}</div>
      </section>

      <section>
        <h2>Execution Nodes</h2>
        <div class="meta">Pending nodes need approval. Approved nodes wait for reconnect; use "Set Pending" to re-run pairing.</div>
        <div class="scroll-12">${renderNodesTable(params.nodes)}</div>
        <div class="section-header" style="margin-top: 14px;">
          <h3>Node Audit Events</h3>
          <div class="meta">Pulled on-demand via <code>audit.query</code> from node-local durable state.</div>
        </div>
        <div class="log-controls" id="node-audit-controls">
          <label style="display:flex; align-items:center; gap:6px; font-size:11px;">
            Node
            <select id="node-audit-node" class="inline-input" style="min-width: 280px;">
              ${nodeAuditNodeOptions}
            </select>
          </label>
          <label style="display:flex; align-items:center; gap:6px; font-size:11px;">
            Limit
            <input id="node-audit-limit" class="inline-input" type="number" min="1" max="500" step="1" value="100" />
          </label>
          <label style="display:flex; align-items:center; gap:6px; font-size:11px;">
            Type
            <input id="node-audit-type" class="inline-input" type="text" placeholder="symbols.list" />
          </label>
          <label style="display:flex; align-items:center; gap:6px; font-size:11px;">
            Process
            <input id="node-audit-process" class="inline-input" type="text" placeholder="proc_..." />
          </label>
          <label style="display:flex; align-items:center; gap:6px; font-size:11px;">
            Firewall Session
            <input id="node-audit-firewall" class="inline-input" type="text" placeholder="fw_..." />
          </label>
          <label style="display:flex; align-items:center; gap:6px; font-size:11px;">
            Actor
            <input id="node-audit-actor" class="inline-input" type="text" placeholder="node:..." />
          </label>
          <button class="graph-btn" id="node-audit-fetch">Fetch</button>
          <button class="graph-btn" id="node-audit-older" disabled>Older</button>
        </div>
        <pre id="node-audit-viewer" class="log-viewer">${escapeHtml(
    auditCapableNodes.length > 0
      ? "Select a node and click Fetch to load node audit events."
      : "No Nexus nodes are registered.",
  )}</pre>
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
          <h2>MCP Operations</h2>
          <div class="inline-actions">
            <span class="badge status-enabled">servers ${params.mcp.servers.length}</span>
            <span class="badge status-running">active ${mcpServerActive}</span>
            <span class="badge status-complete">connected ${mcpServerConnected}</span>
            <span class="badge status-disabled">disabled ${mcpServerDisabled}</span>
            <span class="badge ${mcpServerDegraded > 0 ? "status-failed" : "status-enabled"}">degraded ${mcpServerDegraded}</span>
            <span class="badge status-disabled">profiles disabled ${mcpProfileDisabled}</span>
            <span class="badge status-running">active grants ${params.mcp.grants.length}</span>
          </div>
        </div>
        ${params.mcp.available ? `<div class="meta">Minimal MCP controls: enable/disable, activate/deactivate, probe, and grant revoke.</div>` : `<div class="meta">MCP manager unavailable in this gateway process.</div>`}
        <h3>Servers</h3>
        <div class="scroll-12">${renderMcpServersTable(params.mcp.servers)}</div>
        <h3>Profiles</h3>
        <div class="scroll-12">${renderMcpProfilesTable(params.mcp.profiles)}</div>
        <h3>Active Grants</h3>
        <div class="scroll-12">${renderMcpGrantsTable(params.mcp.grants)}</div>
        <h3>Recent Events</h3>
        <div class="scroll-12">${renderMcpEventsTable(params.mcp.events)}</div>
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
          <h2>LLM Routing</h2>
          <div class="inline-actions">
            <span class="badge ${llmModeBadgeClass}">${escapeHtml(llmModeLabel)}</span>
            <form method="post" action="/dashboard/llm/mode" class="form-inline compact">
              <input type="hidden" name="mode" value="default" />
              <button type="submit" class="graph-btn" ${llmMode === "default" ? "disabled" : ""}>Use Default</button>
            </form>
            <form method="post" action="/dashboard/llm/mode" class="form-inline compact">
              <input type="hidden" name="mode" value="local_only" />
              <button type="submit" class="graph-btn" ${llmMode === "local_only" ? "disabled" : ""}>Force Local</button>
            </form>
          </div>
        </div>
        <div class="meta">Applies to new runs only. In-flight runs keep their current model route.</div>
        <div class="meta">Local target: provider=<code>${escapeHtml(llmLocalProvider)}</code> model=<code>${escapeHtml(llmLocalModel)}</code></div>
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
                <tr><td>Runtime Profile</td><td>${escapeHtml(runtimeProfile)}</td></tr>
                <tr><td>Federation</td><td>${federationEnabled ? "Enabled" : "Disabled"}</td></tr>
                <tr><td>Federation State</td><td>${escapeHtml(federationState)}</td></tr>
                <tr><td>Federation Identity</td><td>${escapeHtml(federationIdentity)}</td></tr>
                <tr><td>Federation Firewall</td><td>${escapeHtml(federationFirewall)}</td></tr>
                <tr><td>Trusted Peers</td><td>${federationTrustedPeers}</td></tr>
                <tr><td>Healthy Trusted Peers</td><td>${federationHealthyTrustedPeers}</td></tr>
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
        <div class="section-header">
          <h2>Federation Onboarding</h2>
          <div class="inline-actions">
            <button class="graph-btn" id="federation-refresh">Refresh</button>
          </div>
        </div>
        <div class="meta">Operator onboarding controls for federation peer bootstrap, trust transitions, and health checks.</div>
        <div class="split">
          <div>
            <h3>Checklist</h3>
            <table id="federation-checklist-table">
              <tbody>
                <tr><td>Federation Enabled</td><td id="federation-check-enabled">-</td></tr>
                <tr><td>Identity Material</td><td id="federation-check-identity">-</td></tr>
                <tr><td>Firewall Baseline</td><td id="federation-check-firewall">-</td></tr>
                <tr><td>Trusted Peers</td><td id="federation-check-trusted">-</td></tr>
                <tr><td>Healthy Trusted Peers</td><td id="federation-check-healthy-trusted">-</td></tr>
                <tr><td>Derived State</td><td id="federation-check-derived">-</td></tr>
              </tbody>
            </table>
          </div>
          <div>
            <h3>Add Peer</h3>
            <div class="log-controls" style="margin-bottom: 6px;">
              <input id="federation-add-id" class="inline-input" type="text" placeholder="peer id" />
              <input id="federation-add-label" class="inline-input" type="text" placeholder="label" />
              <input id="federation-add-endpoint" class="inline-input" type="text" placeholder="https://peer.example/api/federation/inbox" />
            </div>
            <div class="log-controls" style="margin-bottom: 6px;">
              <input id="federation-add-signing-key" class="inline-input" type="text" placeholder="peer signing key (Ed25519 PEM or raw)" style="min-width: 380px;" />
              <input id="federation-add-signing-kid" class="inline-input" type="text" value="kid-initial" placeholder="kid-initial" />
            </div>
            <div class="log-controls">
              <label style="display:flex; align-items:center; gap:6px; font-size:11px;">
                Trust
                <select id="federation-add-trust-state" class="inline-input">
                  <option value="pending" selected="selected">pending</option>
                  <option value="trusted">trusted</option>
                  <option value="quarantined">quarantined</option>
                  <option value="revoked">revoked</option>
                </select>
              </label>
              <label style="display:flex; align-items:center; gap:6px; font-size:11px;">
                <input id="federation-add-enabled" type="checkbox" checked="checked" /> enabled
              </label>
              <button class="graph-btn" id="federation-peer-add">Add/Upsert Peer</button>
            </div>
          </div>
        </div>
        <h3>Peers</h3>
        <div class="scroll-12">
          <table id="federation-peer-table">
            <thead>
              <tr>
                <th>Peer</th>
                <th>Endpoint</th>
                <th>Trust</th>
                <th>Enabled</th>
                <th>Route</th>
                <th>Session</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr><td colspan="7" class="muted">Loading federation peers…</td></tr>
            </tbody>
          </table>
        </div>
        <h3>Recent Federation Tasks</h3>
        <div class="scroll-12">
          <table id="federation-task-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Peer</th>
                <th>Status</th>
                <th>Method</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              <tr><td colspan="5" class="muted">Loading federation tasks…</td></tr>
            </tbody>
          </table>
        </div>
        <pre id="federation-onboarding-log" class="log-viewer">Federation onboarding panel ready.</pre>
      </section>

      <section>
        <h2>Memory Hints (Seen Keywords)</h2>
        <div class="meta">Keywords currently suppressed from re-triggering memory database lookups. Resets on service restart.</div>
        <div class="scroll-12">
          <table>
            <thead>
              <tr>
                <th style="width: 200px;">Session ID</th>
                <th>Seen Keywords Cache</th>
              </tr>
            </thead>
            <tbody>
              ${Object.keys(params.memoryHints).length === 0 ? `<tr><td colspan="2" class="muted">No memory hints cached yet.</td></tr>` : ""}
              ${Object.entries(params.memoryHints)
      .map(
        ([sessionId, keywords]) => `
                <tr>
                  <td><code>${escapeHtml(sessionId)}</code></td>
                  <td>
                    <div style="display: flex; flex-wrap: wrap; gap: 4px;">
                      ${keywords.length === 0 ? '<span class="muted">None</span>' : keywords.map((k) => `<span class="badge" style="background: #334155;">${escapeHtml(k)}</span>`).join("")}
                    </div>
                  </td>
                </tr>
              `,
      )
      .join("")}
            </tbody>
          </table>
        </div>
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
      const visibleNodeWindowSeconds = ${params.visibleNodeWindowSeconds};
      const visibleNodeWindowMs = visibleNodeWindowSeconds * 1000;
      const container = document.getElementById("agent-graph");
      const tooltip = document.getElementById("agent-tooltip");
      const pauseBtn = document.getElementById("btn-pause");
      const resetViewBtn = document.getElementById("btn-reset-view");
      const refreshIndicator = document.getElementById("refresh-indicator");
      const nodeLimit = ${params.nodeLimit};
      const maxAgentLevels = ${maxAgentLevels};
      let executionNodeData = ${executionNodesJson};
      const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));
      const tabPanels = {
        "agents-view": document.getElementById("tab-agents-view"),
        "docker-logs": document.getElementById("tab-docker-logs"),
        "llm-raw": document.getElementById("tab-llm-raw"),
        "cli-chat": document.getElementById("tab-cli-chat"),
      };
      const logsPanel = tabPanels["docker-logs"];
      const logsPre = document.getElementById("docker-logs");
      const logsRefreshBtn = document.getElementById("logs-refresh");
      const logsAutoToggle = document.getElementById("logs-auto");
      const logsMaxInput = document.getElementById("logs-max");
      const llmPanel = tabPanels["llm-raw"];
      const llmPre = document.getElementById("llm-raw");
      const llmSessionsRefreshBtn = document.getElementById("llm-sessions-refresh");
      const llmMessagesRefreshBtn = document.getElementById("llm-messages-refresh");
      const llmOlderBtn = document.getElementById("llm-messages-older");
      const llmSessionsLimitInput = document.getElementById("llm-sessions-limit");
      const llmMessagesLimitInput = document.getElementById("llm-messages-limit");
      const llmSessionSelect = document.getElementById("llm-session-select");
      const cliChatView = document.getElementById("cli-chat-view");
      const cliRefreshBtn = document.getElementById("cli-refresh");
      const cliSessionNewBtn = document.getElementById("cli-session-new");
      const cliSendBtn = document.getElementById("cli-send");
      const cliSessionHint = document.getElementById("cli-session-hint");
      const cliInput = document.getElementById("cli-input");
      const federationRefreshBtn = document.getElementById("federation-refresh");
      const federationPeerAddBtn = document.getElementById("federation-peer-add");
      const federationAddIdInput = document.getElementById("federation-add-id");
      const federationAddLabelInput = document.getElementById("federation-add-label");
      const federationAddEndpointInput = document.getElementById("federation-add-endpoint");
      const federationAddSigningKeyInput = document.getElementById("federation-add-signing-key");
      const federationAddSigningKidInput = document.getElementById("federation-add-signing-kid");
      const federationAddTrustStateInput = document.getElementById("federation-add-trust-state");
      const federationAddEnabledInput = document.getElementById("federation-add-enabled");
      const federationPeerTable = document.getElementById("federation-peer-table");
      const federationTaskTable = document.getElementById("federation-task-table");
      const federationLogViewer = document.getElementById("federation-onboarding-log");
      const federationCheckEnabled = document.getElementById("federation-check-enabled");
      const federationCheckIdentity = document.getElementById("federation-check-identity");
      const federationCheckFirewall = document.getElementById("federation-check-firewall");
      const federationCheckTrusted = document.getElementById("federation-check-trusted");
      const federationCheckHealthyTrusted = document.getElementById("federation-check-healthy-trusted");
      const federationCheckDerived = document.getElementById("federation-check-derived");
      const nodeAuditViewer = document.getElementById("node-audit-viewer");
      const nodeAuditNodeInput = document.getElementById("node-audit-node");
      const nodeAuditLimitInput = document.getElementById("node-audit-limit");
      const nodeAuditTypeInput = document.getElementById("node-audit-type");
      const nodeAuditProcessInput = document.getElementById("node-audit-process");
      const nodeAuditFirewallInput = document.getElementById("node-audit-firewall");
      const nodeAuditActorInput = document.getElementById("node-audit-actor");
      const nodeAuditFetchBtn = document.getElementById("node-audit-fetch");
      const nodeAuditOlderBtn = document.getElementById("node-audit-older");
      const stopAllBtn = document.getElementById("stop-all-btn");
      const csrfToken = ${csrfTokenJson};

      const withCsrfHeaders = (init = {}) => {
        const method = String(init.method ?? "GET").toUpperCase();
        if (!csrfToken || method === "GET" || method === "HEAD" || method === "OPTIONS") {
          return init;
        }
        const headers = new Headers(init.headers ?? {});
        if (!headers.has("x-csrf-token")) {
          headers.set("x-csrf-token", csrfToken);
        }
        return { ...init, headers };
      };

      const fetchWithAuth = (input, init = {}) => {
        return fetch(input, withCsrfHeaders(init));
      };

      const escapeLogHtml = (value) =>
        String(value ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");

      const classifyLogLine = (line) => {
        const lower = String(line ?? "").toLowerCase();
        const classes = ["log-line"];
        if (
          lower.includes("error:") ||
          lower.includes("status=error") ||
          lower.includes("status=failed") ||
          lower.includes("uncaught") ||
          lower.includes("unhandled rejection")
        ) {
          classes.push("level-error");
        } else if (
          lower.includes("timeout") ||
          lower.includes("killing") ||
          lower.includes("warning") ||
          lower.includes("budget_exhausted") ||
          lower.includes("rate-limit") ||
          lower.includes(" 429")
        ) {
          classes.push("level-warn");
        } else if (
          lower.includes("status=ok") ||
          lower.includes("deploy completed") ||
          lower.includes("telegram: dispatch") ||
          lower.includes("telegram: send")
        ) {
          classes.push("level-ok");
        } else {
          classes.push("level-neutral");
        }
        if (lower.includes("tool_call")) classes.push("kind-tool-call");
        if (lower.includes("tool_result")) classes.push("kind-tool-result");
        if (lower.includes("deploy")) classes.push("kind-deploy");
        if (lower.includes("timeout") || lower.includes("killing")) classes.push("kind-timeout");
        return classes.join(" ");
      };

      const highlightLogLine = (line) => {
        let html = escapeLogHtml(line);
        html = html.replace(/(\\[nexus\\])/g, '<span class="log-label">$1</span>');
        html = html.replace(
          /(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z)/g,
          '<span class="log-ts">$1</span>',
        );
        html = html.replace(/\\b(worker\\[[^\\]\\s]+\\])/g, '<span class="log-agent-tag">$1</span>');
        html = html.replace(/\\b(tool_call|tool_result)\\b/g, '<span class="log-label">$1</span>');
        html = html.replace(/\\b(name=[^\\s]+)/g, '<span class="log-tool-name">$1</span>');
        html = html.replace(/\\b(id=[^\\s]+)/g, '<span class="log-call-id">$1</span>');
        html = html.replace(
          /\\b(status=(ok|error|failed|running|complete|budget_exhausted))\\b/gi,
          (_match, token, rawStatus) => {
            const normalized = String(rawStatus).toLowerCase();
            return '<span class="log-status log-status-' + normalized + '">' + token + '</span>';
          },
        );
        html = html.replace(/(ERROR:)/g, '<span class="log-token-error">$1</span>');
        return html;
      };

      const renderHighlightedLogs = (text) => {
        if (!text || !String(text).trim()) {
          return '<span class="log-empty">No logs found.</span>';
        }
        return String(text)
          .split(/\\r?\\n/)
          .map((line) => '<span class="' + classifyLogLine(line) + '">' + highlightLogLine(line) + "</span>")
          .join("\\n");
      };

      const fetchLogs = async () => {
        if (!logsPre) return;
        if (logsFetchInFlight) return;
        logsFetchInFlight = true;
        const maxChars = Math.min(200000, Math.max(200, Number(logsMaxInput?.value ?? 50000) || 50000));
        try {
          const res = await fetchWithAuth("/api/logs?maxChars=" + maxChars);
          if (!res.ok) {
            logsPre.innerHTML = renderHighlightedLogs("ERROR: " + res.status);
            return;
          }
          logsPre.innerHTML = renderHighlightedLogs(await res.text());
        } catch (err) {
          logsPre.innerHTML = renderHighlightedLogs("ERROR: " + (err instanceof Error ? err.message : String(err)));
        } finally {
          logsFetchInFlight = false;
        }
      };

      const llmState = {
        sessions: [],
        selectedSessionId: null,
        rows: [],
        hasMore: false,
        nextBeforeId: null,
      };
      const CLI_CHAT_DEFAULT_CHANNEL_KEY = "dashboard:chat";
      const CLI_CHAT_MESSAGE_LIMIT = 200;
      const MAX_LLM_ROWS = 1200;
      const MAX_NODE_AUDIT_EVENTS = 1500;
      const HOVER_RAYCAST_INTERVAL_MS = 50;
      const MAX_RENDER_PIXEL_RATIO = 1.5;
      const TARGET_RENDER_FPS = 30;
      const FRAME_INTERVAL_MS = 1000 / TARGET_RENDER_FPS;
      const NODE_ICOSAHEDRON_DETAIL = 0;
      const CORE_ICOSAHEDRON_DETAIL = 1;
      const FLOOR_GRID_COLOR = 0x004d1f;
      const ORBIT_RING_COLOR = 0xffc44d;
      const ORCHESTRATOR_COLOR = 0xff8c2f;
      const EXECUTION_NODE_COLOR = 0xf4f7fb;
      const EXECUTION_NODE_EMISSIVE = 0xd3dbe8;
      const ORCHESTRATOR_Y = 42;
      const FLOOR_Y = -66;
      const ORTHO_VIEW_HALF_HEIGHT = 250;
      const ORBIT_RING_SEGMENTS = 48;
      const AGENT_ORB_SPACING_PADDING = 3;
      const AGENT_RING_FILL_RATIO = 0.9;
      const AGENT_COLLISION_RELAXATION_PASSES = 6;
      let agentRefreshInFlight = false;
      let logsFetchInFlight = false;
      const cliState = {
        session: null,
        rows: [],
        loading: false,
        sending: false,
      };
      const federationState = {
        status: null,
        peers: [],
        tasks: [],
        loading: false,
      };
      const nodeAuditState = {
        events: [],
        nextCursorCreatedAt: null,
        nodeId: null,
      };

      const readBoundedInt = (input, fallback, min, max) => {
        const n = Number(input?.value ?? fallback);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, Math.floor(n)));
      };

      const readOptionalText = (input, maxChars) => {
        const raw = String(input?.value ?? "").trim();
        if (!raw) return null;
        return raw.length > maxChars ? raw.slice(0, maxChars) : raw;
      };

      const formatIso = (ms) => {
        if (!ms) return "-";
        try {
          return new Date(ms).toISOString();
        } catch {
          return "-";
        }
      };

      const updateLlmOlderButton = () => {
        if (!llmOlderBtn) return;
        llmOlderBtn.disabled = !llmState.hasMore || !llmState.selectedSessionId;
      };

      const updateNodeAuditOlderButton = () => {
        if (!nodeAuditOlderBtn) return;
        nodeAuditOlderBtn.disabled = !nodeAuditState.nodeId || !nodeAuditState.nextCursorCreatedAt;
      };

      const renderNodeAuditRows = () => {
        if (!nodeAuditViewer) return;
        if (!nodeAuditState.nodeId) {
          nodeAuditViewer.innerHTML = escapeLogHtml("Select a node and click Fetch to load node audit events.");
          updateNodeAuditOlderButton();
          return;
        }
        const header = [
          "node=" + nodeAuditState.nodeId,
          "events=" + nodeAuditState.events.length,
          "next_cursor_created_at=" + (nodeAuditState.nextCursorCreatedAt ?? "-"),
          "",
        ];
        if (!nodeAuditState.events.length) {
          nodeAuditViewer.innerHTML = escapeLogHtml(header.concat(["No audit events found for current query."]).join("\\n"));
          updateNodeAuditOlderButton();
          return;
        }
        const body = nodeAuditState.events
          .map((event) => {
            const row = event && typeof event === "object" ? event : {};
            const details =
              row.details && typeof row.details === "object" && !Array.isArray(row.details) ? row.details : null;
            const detailsJson = details ? JSON.stringify(details, null, 2) : "{}";
            return [
              "[" + formatIso(row.createdAt) + "] " + String(row.type ?? "unknown"),
              "event_id=" + String(row.eventId ?? "-"),
              "process_id=" + String(row.processId ?? "-"),
              "firewall_session=" + String(row.firewallSession ?? "-"),
              "actor=" + String(row.actor ?? "-"),
              "tool_name=" + String(row.toolName ?? "-"),
              "details=" + detailsJson,
            ].join("\\n");
          })
          .join("\\n\\n----------------------------------------\\n\\n");
        nodeAuditViewer.innerHTML = escapeLogHtml(header.join("\\n") + body);
        updateNodeAuditOlderButton();
      };

      const fetchNodeAudit = async ({ older = false } = {}) => {
        if (!nodeAuditViewer) return;
        const nodeId = String(nodeAuditNodeInput?.value ?? "").trim();
        if (!nodeId) {
          nodeAuditState.nodeId = null;
          nodeAuditState.events = [];
          nodeAuditState.nextCursorCreatedAt = null;
          renderNodeAuditRows();
          return;
        }
        const limit = readBoundedInt(nodeAuditLimitInput, 100, 1, 500);
        if (nodeAuditLimitInput) nodeAuditLimitInput.value = String(limit);
        const params = new URLSearchParams();
        params.set("limit", String(limit));
        const type = readOptionalText(nodeAuditTypeInput, 128);
        const processId = readOptionalText(nodeAuditProcessInput, 128);
        const firewallSession = readOptionalText(nodeAuditFirewallInput, 256);
        const actor = readOptionalText(nodeAuditActorInput, 256);
        if (type) params.set("type", type);
        if (processId) params.set("processId", processId);
        if (firewallSession) params.set("firewallSession", firewallSession);
        if (actor) params.set("actor", actor);

        const sameNode = nodeAuditState.nodeId === nodeId;
        const canAppend = older && sameNode && nodeAuditState.nextCursorCreatedAt;
        if (canAppend) {
          params.set("cursorCreatedAt", String(nodeAuditState.nextCursorCreatedAt));
        }

        try {
          const res = await fetchWithAuth("/api/nodes/" + encodeURIComponent(nodeId) + "/audit?" + params.toString());
          const payload = await res.json();
          if (!res.ok) {
            const code = payload?.code ? " code=" + String(payload.code) : "";
            nodeAuditViewer.innerHTML = escapeLogHtml(
              "ERROR: " + String(payload?.error ?? res.status) + code + "\\nnode=" + nodeId,
            );
            return;
          }

          const events = Array.isArray(payload?.events) ? payload.events : [];
          if (canAppend) {
            nodeAuditState.events = nodeAuditState.events.concat(events);
          } else {
            nodeAuditState.events = events;
          }
          if (nodeAuditState.events.length > MAX_NODE_AUDIT_EVENTS) {
            nodeAuditState.events = nodeAuditState.events.slice(0, MAX_NODE_AUDIT_EVENTS);
          }
          nodeAuditState.nextCursorCreatedAt =
            typeof payload?.nextCursorCreatedAt === "number" && Number.isFinite(payload.nextCursorCreatedAt)
              ? Math.floor(payload.nextCursorCreatedAt)
              : null;
          nodeAuditState.nodeId = nodeId;
          renderNodeAuditRows();
        } catch (err) {
          nodeAuditViewer.innerHTML = escapeLogHtml("ERROR: " + (err instanceof Error ? err.message : String(err)));
        }
      };

      const renderLlmRows = () => {
        if (!llmPre) return;
        const selected = llmState.sessions.find((s) => s.id === llmState.selectedSessionId) ?? null;
        const headerLines = [];
        if (selected) {
          headerLines.push(
            "session_id=" + selected.id,
            "channel=" + selected.channel + ":" + selected.channel_key,
            "agent_id=" + selected.agent_id,
            "last_message_at=" + formatIso(selected.last_message_at),
            "message_count=" + selected.message_count,
            "",
          );
        }
        if (!llmState.rows || llmState.rows.length === 0) {
          llmPre.innerHTML = '<span class="log-empty">' + escapeLogHtml(headerLines.concat(["No messages found."]).join("\\n")) + "</span>";
          updateLlmOlderButton();
          return;
        }
        const body = llmState.rows.map((row) => {
          let toolCalls = row.tool_calls_json;
          if (toolCalls) {
            try {
              toolCalls = JSON.stringify(JSON.parse(toolCalls), null, 2);
            } catch {
              // keep raw
            }
          }
          const chunks = [
            "#"+ row.id + " " + row.role + " created_at=" + formatIso(row.created_at),
            row.name ? "name=" + row.name : "",
            row.tool_call_id ? "tool_call_id=" + row.tool_call_id : "",
            "",
            "content:",
            row.content ?? "",
          ];
          if (toolCalls) {
            chunks.push("", "tool_calls_json:", toolCalls);
          }
          return chunks.filter((line) => line !== "").join("\\n");
        }).join("\\n\\n----------------------------------------\\n\\n");
        llmPre.innerHTML = escapeLogHtml(headerLines.join("\\n") + body);
        updateLlmOlderButton();
      };

      const renderLlmSessionOptions = () => {
        if (!llmSessionSelect) return;
        const sessions = llmState.sessions;
        if (!sessions || sessions.length === 0) {
          llmSessionSelect.innerHTML = "";
          return;
        }
        llmSessionSelect.innerHTML = sessions.map((session) => {
          const label = [
            session.channel + ":" + session.channel_key,
            session.agent_id,
            formatIso(session.last_message_at),
            session.message_count + " msgs",
            session.id.slice(0, 8),
          ].join(" | ");
          const selected = session.id === llmState.selectedSessionId ? ' selected="selected"' : "";
          return '<option value="' + escapeLogHtml(session.id) + '"' + selected + ">" + escapeLogHtml(label) + "</option>";
        }).join("");
      };

      const fetchLlmMessages = async (opts = { reset: true }) => {
        if (!llmPre) return;
        const sessionId = llmState.selectedSessionId;
        if (!sessionId) {
          llmState.rows = [];
          llmState.hasMore = false;
          llmState.nextBeforeId = null;
          llmPre.innerHTML = '<span class="log-empty">No sessions found.</span>';
          updateLlmOlderButton();
          return;
        }

        const limit = readBoundedInt(llmMessagesLimitInput, 200, 1, 500);
        if (llmMessagesLimitInput) llmMessagesLimitInput.value = String(limit);
        let url = "/api/llm/messages?sessionId=" + encodeURIComponent(sessionId) + "&limit=" + limit;
        if (!opts.reset && llmState.nextBeforeId) {
          url += "&beforeId=" + encodeURIComponent(String(llmState.nextBeforeId));
        }
        try {
          const res = await fetchWithAuth(url);
          if (!res.ok) {
            llmPre.innerHTML = escapeLogHtml("ERROR: " + res.status);
            return;
          }
          const payload = await res.json();
          const rows = Array.isArray(payload?.messages) ? payload.messages : [];
          if (opts.reset) {
            llmState.rows = rows;
          } else {
            llmState.rows = rows.concat(llmState.rows);
          }
          if (llmState.rows.length > MAX_LLM_ROWS) {
            llmState.rows = llmState.rows.slice(-MAX_LLM_ROWS);
          }
          llmState.hasMore = Boolean(payload?.hasMore);
          llmState.nextBeforeId = payload?.nextBeforeId ?? null;
          renderLlmRows();
        } catch (err) {
          llmPre.innerHTML = escapeLogHtml("ERROR: " + (err instanceof Error ? err.message : String(err)));
        }
      };

      const fetchLlmSessions = async (opts = { preserveSelection: true, refreshMessages: true }) => {
        if (!llmPre) return;
        const limit = readBoundedInt(llmSessionsLimitInput, 50, 1, 200);
        if (llmSessionsLimitInput) llmSessionsLimitInput.value = String(limit);
        const previousSessionId = llmState.selectedSessionId;
        try {
          const res = await fetchWithAuth("/api/llm/sessions?limit=" + limit);
          if (!res.ok) {
            llmPre.innerHTML = escapeLogHtml("ERROR: " + res.status);
            return;
          }
          const payload = await res.json();
          const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
          llmState.sessions = sessions;
          if (opts.preserveSelection && previousSessionId && sessions.some((s) => s.id === previousSessionId)) {
            llmState.selectedSessionId = previousSessionId;
          } else {
            llmState.selectedSessionId = sessions[0]?.id ?? null;
          }
          llmState.nextBeforeId = null;
          llmState.hasMore = false;
          renderLlmSessionOptions();
          if (opts.refreshMessages) {
            await fetchLlmMessages({ reset: true });
          } else {
            renderLlmRows();
          }
        } catch (err) {
          llmPre.innerHTML = escapeLogHtml("ERROR: " + (err instanceof Error ? err.message : String(err)));
        }
      };

      const getCliSession = () => cliState.session;

      const isCliSessionWritable = (session) => Boolean(session && session.channel === "cli");

      const updateCliComposerState = () => {
        const selected = getCliSession();
        const writable = isCliSessionWritable(selected);
        const busy = cliState.loading || cliState.sending;
        if (cliInput) {
          cliInput.disabled = !writable || busy;
          if (!selected) {
            cliInput.placeholder = "Preparing CLI chat session...";
          } else if (!writable) {
            cliInput.placeholder = "Current session is read-only.";
          } else {
            cliInput.placeholder = "Type a message and press Enter. Use Shift+Enter for a newline.";
          }
        }
        if (cliSendBtn) {
          cliSendBtn.disabled = !writable || busy;
          cliSendBtn.textContent = cliState.sending ? "Sending..." : "Send";
        }
        if (cliSessionHint) {
          if (!selected) {
            cliSessionHint.textContent = "Session: initializing...";
          } else {
            const shortId = String(selected.id ?? "").slice(0, 8);
            cliSessionHint.textContent =
              "Session " + shortId + " - " + String(selected.channel ?? "cli") + ":" + String(selected.channel_key ?? "-");
          }
        }
      };

      const normalizeCliRole = (role) => {
        const value = String(role ?? "").trim().toLowerCase();
        if (!value) return "system";
        if (value === "user" || value === "assistant" || value === "tool" || value === "system") return value;
        return "system";
      };

      const getCliRoleLabel = (role, row) => {
        if (role === "user") return "YOU";
        if (role === "assistant") return "NEXUS";
        if (role === "tool") {
          const toolName = String(row?.name ?? "").trim();
          return toolName ? "TOOL:" + toolName : "TOOL";
        }
        return "SYSTEM";
      };

      const renderCliRows = () => {
        if (!cliChatView) return;
        const selected = getCliSession();
        if (!selected) {
          cliChatView.innerHTML = '<span class="log-empty">Preparing CLI session...</span>';
          updateCliComposerState();
          return;
        }
        if (!cliState.rows || cliState.rows.length === 0) {
          cliChatView.innerHTML = '<span class="log-empty">No messages yet. Send one to start.</span>';
          updateCliComposerState();
          return;
        }
        const shouldStick =
          cliChatView.scrollTop + cliChatView.clientHeight >= cliChatView.scrollHeight - 80;
        const body = cliState.rows
          .map((row) => {
            const role = normalizeCliRole(row.role);
            const roleClass = role === "user" ? "user" : role === "assistant" ? "assistant" : role === "tool" ? "tool" : "system";
            const label = getCliRoleLabel(role, row);
            const timestamp = formatIso(row.created_at);
            const idText = Number.isFinite(row.id) ? "#" + String(row.id) : "";
            const content = String(row.content ?? "");
            return (
              '<article class="cli-chat-message ' + roleClass + '">' +
              '<div class="cli-chat-head">' +
              '<span class="cli-chat-role">' + escapeLogHtml(label) + '</span>' +
              '<span class="cli-chat-time">' + escapeLogHtml(timestamp) + "</span>" +
              "</div>" +
              '<div class="cli-chat-meta">' +
              escapeLogHtml(idText) +
              (row.tool_call_id ? ' <span>tool_call_id=' + escapeLogHtml(String(row.tool_call_id)) + "</span>" : "") +
              "</div>" +
              '<pre class="cli-chat-body">' + escapeLogHtml(content || "[empty]") + "</pre>" +
              "</article>"
            );
          })
          .join("");
        cliChatView.innerHTML = body;
        if (shouldStick || cliState.sending) cliChatView.scrollTop = cliChatView.scrollHeight;
        updateCliComposerState();
      };

      const ensureCliSession = async (opts = { forceNew: false }) => {
        if (!opts.forceNew && cliState.session) return cliState.session;
        const agentId = String(cliState.session?.agent_id ?? "main").trim() || "main";
        const channelKey = opts.forceNew
          ? "dashboard:chat:" + Date.now().toString(36)
          : CLI_CHAT_DEFAULT_CHANNEL_KEY;
        const res = await fetchWithAuth("/api/cli/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId, channelKey }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(String(payload?.error ?? res.status));
        }
        const session = payload?.session;
        if (!session || !session.id) {
          throw new Error("invalid cli session response");
        }
        cliState.session = session;
        return session;
      };

      const fetchCliMessages = async (opts = { forceNewSession: false }) => {
        if (!cliChatView) return;
        if (cliState.loading) return;
        cliState.loading = true;
        updateCliComposerState();
        try {
          const session = await ensureCliSession({ forceNew: opts.forceNewSession });
          const url =
            "/api/llm/messages?sessionId=" +
            encodeURIComponent(String(session.id)) +
            "&limit=" +
            String(CLI_CHAT_MESSAGE_LIMIT);
          const res = await fetchWithAuth(url);
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            cliChatView.innerHTML = escapeLogHtml("ERROR: " + String(payload?.error ?? res.status));
            return;
          }
          cliState.rows = Array.isArray(payload?.messages) ? payload.messages : [];
          renderCliRows();
        } catch (err) {
          cliChatView.innerHTML = escapeLogHtml("ERROR: " + (err instanceof Error ? err.message : String(err)));
        } finally {
          cliState.loading = false;
          updateCliComposerState();
        }
      };

      const createCliSession = async () => {
        await fetchCliMessages({ forceNewSession: true });
        if (cliInput) cliInput.focus();
      };

      const sendCliMessage = async () => {
        if (!cliChatView || !cliInput) return;
        if (cliState.sending || cliState.loading) return;
        const session = await ensureCliSession().catch((err) => {
          cliChatView.innerHTML = escapeLogHtml("ERROR: " + (err instanceof Error ? err.message : String(err)));
          return null;
        });
        if (!session) {
          updateCliComposerState();
          return;
        }
        if (!isCliSessionWritable(session)) {
          cliChatView.innerHTML = escapeLogHtml(
            "Current session is read-only (" + String(session.channel) + ").",
          );
          updateCliComposerState();
          return;
        }
        const text = String(cliInput.value ?? "").trim();
        if (!text) {
          cliInput.focus();
          return;
        }

        cliState.sending = true;
        updateCliComposerState();
        try {
          const res = await fetchWithAuth("/api/cli/messages", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: session.id, text }),
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            cliChatView.innerHTML = escapeLogHtml("ERROR: " + String(payload?.error ?? res.status));
            return;
          }
          cliInput.value = "";
          await fetchCliMessages();
        } catch (err) {
          cliChatView.innerHTML = escapeLogHtml("ERROR: " + (err instanceof Error ? err.message : String(err)));
        } finally {
          cliState.sending = false;
          updateCliComposerState();
        }
      };

      const appendFederationLog = (line) => {
        if (!federationLogViewer) return;
        const nextLine = "[" + new Date().toISOString() + "] " + String(line ?? "");
        const existing = String(federationLogViewer.textContent ?? "").trim();
        const lines = existing ? existing.split("\\n").slice(-160) : [];
        lines.push(nextLine);
        federationLogViewer.textContent = lines.join("\\n");
      };

      const setFederationCheckCell = (element, ok, label) => {
        if (!element) return;
        if (ok == null) {
          element.textContent = "-";
          return;
        }
        const badgeClass = ok ? "status-enabled" : "status-failed";
        const badgeLabel = ok ? "ok" : "fail";
        const suffix = label ? " " + escapeLogHtml(label) : "";
        element.innerHTML = '<span class="badge ' + badgeClass + '">' + badgeLabel + "</span>" + suffix;
      };

      const renderFederationChecklist = () => {
        const status = federationState.status;
        if (!status || typeof status !== "object") {
          setFederationCheckCell(federationCheckEnabled, null, "");
          setFederationCheckCell(federationCheckIdentity, null, "");
          setFederationCheckCell(federationCheckFirewall, null, "");
          setFederationCheckCell(federationCheckTrusted, null, "");
          setFederationCheckCell(federationCheckHealthyTrusted, null, "");
          if (federationCheckDerived) federationCheckDerived.textContent = "-";
          return;
        }
        const enabled = Boolean(status.enabled);
        const identityValid = Boolean(status.identityValid);
        const firewallActive = Boolean(status.firewallActive);
        const trustedPeerCount = Number(status.trustedPeerCount ?? 0);
        const healthyTrustedPeerCount = Number(status.healthyTrustedPeerCount ?? 0);
        const derivedState = String(status.derivedState ?? "unknown");

        setFederationCheckCell(federationCheckEnabled, enabled, enabled ? "federation enabled" : "federation disabled");
        setFederationCheckCell(federationCheckIdentity, identityValid, identityValid ? "identity key available" : "identity missing");
        setFederationCheckCell(federationCheckFirewall, firewallActive, firewallActive ? "firewall active" : "firewall inactive");
        setFederationCheckCell(
          federationCheckTrusted,
          trustedPeerCount > 0,
          trustedPeerCount + " trusted peer" + (trustedPeerCount === 1 ? "" : "s"),
        );
        setFederationCheckCell(
          federationCheckHealthyTrusted,
          healthyTrustedPeerCount > 0,
          healthyTrustedPeerCount + " healthy trusted peer" + (healthyTrustedPeerCount === 1 ? "" : "s"),
        );
        if (federationCheckDerived) {
          const derivedClass = derivedState === "active_federated" ? "status-enabled" : "status-budget_exhausted";
          federationCheckDerived.innerHTML =
            '<span class="badge ' + derivedClass + '">' + escapeLogHtml(derivedState) + "</span>";
        }
      };

      const renderFederationPeerTable = () => {
        if (!federationPeerTable) return;
        const tbody = federationPeerTable.querySelector("tbody");
        if (!tbody) return;
        const peers = Array.isArray(federationState.peers) ? federationState.peers : [];
        const statusPeers = Array.isArray(federationState.status?.peers) ? federationState.status.peers : [];
        const healthById = new Map();
        statusPeers.forEach((peer) => {
          const id = String(peer?.id ?? "").trim();
          if (!id) return;
          healthById.set(id, {
            routeHealthy: Boolean(peer?.routeHealthy),
            sessionHealthy: Boolean(peer?.sessionHealthy),
          });
        });

        if (peers.length === 0) {
          tbody.innerHTML = '<tr><td colspan="7" class="muted">No federation peers found.</td></tr>';
          return;
        }

        const trustStates = ["pending", "trusted", "quarantined", "revoked"];
        tbody.innerHTML = peers
          .map((peer) => {
            const peerId = String(peer?.id ?? "");
            const health = healthById.get(peerId) ?? { routeHealthy: false, sessionHealthy: false };
            const trustOptions = trustStates
              .map((state) => {
                const selected = String(peer?.trustState ?? "") === state ? ' selected="selected"' : "";
                return '<option value="' + state + '"' + selected + ">" + state + "</option>";
              })
              .join("");
            const routeBadge = health.routeHealthy
              ? '<span class="badge status-enabled">healthy</span>'
              : '<span class="badge status-failed">down</span>';
            const sessionBadge = health.sessionHealthy
              ? '<span class="badge status-enabled">active</span>'
              : '<span class="badge status-failed">stale</span>';
            return (
              "<tr>" +
              "<td>" +
              "<div>" + escapeLogHtml(peerId) + "</div>" +
              '<div class="muted">' + escapeLogHtml(String(peer?.label ?? "")) + "</div>" +
              "</td>" +
              "<td>" + escapeLogHtml(String(peer?.endpoint ?? "")) + "</td>" +
              '<td><select class="inline-input federation-peer-trust" data-peer-id="' + escapeLogHtml(peerId) + '">' + trustOptions + "</select></td>" +
              '<td><label style="display:flex; align-items:center; gap:6px;"><input class="federation-peer-enabled" data-peer-id="' +
              escapeLogHtml(peerId) +
              '" type="checkbox"' +
              (peer?.enabled ? ' checked="checked"' : "") +
              " />enabled</label></td>" +
              "<td>" + routeBadge + "</td>" +
              "<td>" + sessionBadge + "</td>" +
              '<td class="inline-actions">' +
              '<button class="graph-btn" data-peer-action="apply" data-peer-id="' + escapeLogHtml(peerId) + '">Apply</button>' +
              '<button class="graph-btn" data-peer-action="probe" data-peer-id="' + escapeLogHtml(peerId) + '">Queue Probe</button>' +
              "</td>" +
              "</tr>"
            );
          })
          .join("");
      };

      const renderFederationTaskTable = () => {
        if (!federationTaskTable) return;
        const tbody = federationTaskTable.querySelector("tbody");
        if (!tbody) return;
        const tasks = Array.isArray(federationState.tasks) ? federationState.tasks : [];
        if (tasks.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" class="muted">No federation tasks found.</td></tr>';
          return;
        }
        tbody.innerHTML = tasks
          .slice(0, 30)
          .map((task) => {
            const status = String(task?.status ?? "unknown");
            const statusClass =
              status === "completed"
                ? "status-enabled"
                : status === "running" || status === "pending"
                  ? "status-running"
                  : "status-failed";
            return (
              "<tr>" +
              "<td>" + escapeLogHtml(String(task?.id ?? "").slice(0, 12)) + "</td>" +
              "<td>" + escapeLogHtml(String(task?.peerId ?? "")) + "</td>" +
              '<td><span class="badge ' + statusClass + '">' + escapeLogHtml(status) + "</span></td>" +
              "<td>" + escapeLogHtml(String(task?.method ?? "")) + "</td>" +
              "<td>" + escapeLogHtml(formatIso(task?.updatedAt ?? null)) + "</td>" +
              "</tr>"
            );
          })
          .join("");
      };

      const renderFederationOnboarding = () => {
        renderFederationChecklist();
        renderFederationPeerTable();
        renderFederationTaskTable();
      };

      const fetchFederationOnboarding = async () => {
        if (federationState.loading) return;
        federationState.loading = true;
        if (federationRefreshBtn) federationRefreshBtn.disabled = true;
        try {
          const [statusRes, peersRes, tasksRes] = await Promise.all([
            fetchWithAuth("/api/federation/status"),
            fetchWithAuth("/api/federation/peers?limit=200"),
            fetchWithAuth("/api/federation/tasks?limit=50"),
          ]);
          if (!statusRes.ok) {
            const text = await statusRes.text();
            appendFederationLog("status fetch failed: " + statusRes.status + " " + text);
            return;
          }
          if (!peersRes.ok) {
            const text = await peersRes.text();
            appendFederationLog("peer fetch failed: " + peersRes.status + " " + text);
            return;
          }
          if (!tasksRes.ok) {
            const text = await tasksRes.text();
            appendFederationLog("task fetch failed: " + tasksRes.status + " " + text);
            return;
          }
          const statusPayload = await statusRes.json();
          const peersPayload = await peersRes.json();
          const tasksPayload = await tasksRes.json();
          federationState.status = statusPayload;
          federationState.peers = Array.isArray(peersPayload?.peers) ? peersPayload.peers : [];
          federationState.tasks = Array.isArray(tasksPayload?.tasks) ? tasksPayload.tasks : [];
          renderFederationOnboarding();
        } catch (err) {
          appendFederationLog("refresh failed: " + (err instanceof Error ? err.message : String(err)));
        } finally {
          federationState.loading = false;
          if (federationRefreshBtn) federationRefreshBtn.disabled = false;
        }
      };

      const upsertFederationPeerFromForm = async () => {
        const id = String(federationAddIdInput?.value ?? "").trim();
        const label = String(federationAddLabelInput?.value ?? "").trim();
        const endpoint = String(federationAddEndpointInput?.value ?? "").trim();
        const signingKey = String(federationAddSigningKeyInput?.value ?? "").trim();
        const signingKeyKid = String(federationAddSigningKidInput?.value ?? "").trim() || "kid-initial";
        const trustState = String(federationAddTrustStateInput?.value ?? "pending").trim() || "pending";
        const enabled = Boolean(federationAddEnabledInput?.checked);
        if (!id || !label || !endpoint || !signingKey) {
          appendFederationLog("add peer blocked: id, label, endpoint, signing key are required");
          return;
        }
        if (federationPeerAddBtn) federationPeerAddBtn.disabled = true;
        try {
          const res = await fetchWithAuth("/api/federation/peers", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id,
              label,
              endpoint,
              signingKey,
              signingKeyKid,
              trustState,
              enabled,
            }),
          });
          const payload = await res.json();
          if (!res.ok) {
            appendFederationLog("peer upsert failed: " + String(payload?.error ?? res.status));
            return;
          }
          appendFederationLog("peer upserted: " + id + " trust=" + trustState + " enabled=" + (enabled ? "1" : "0"));
          await fetchFederationOnboarding();
        } catch (err) {
          appendFederationLog("peer upsert error: " + (err instanceof Error ? err.message : String(err)));
        } finally {
          if (federationPeerAddBtn) federationPeerAddBtn.disabled = false;
        }
      };

      const applyFederationPeerTrustFromRow = async (peerId, row) => {
        const trustInput = row?.querySelector(".federation-peer-trust");
        const enabledInput = row?.querySelector(".federation-peer-enabled");
        const trustState = String(trustInput?.value ?? "").trim();
        const enabled = Boolean(enabledInput?.checked);
        if (!trustState) {
          appendFederationLog("peer trust apply blocked: missing trust state for peer " + peerId);
          return;
        }
        try {
          const res = await fetchWithAuth("/api/federation/peers/" + encodeURIComponent(peerId) + "/trust", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              trustState,
              enabled,
            }),
          });
          const payload = await res.json();
          if (!res.ok) {
            appendFederationLog("peer trust update failed for " + peerId + ": " + String(payload?.error ?? res.status));
            return;
          }
          appendFederationLog("peer trust updated: " + peerId + " trust=" + trustState + " enabled=" + (enabled ? "1" : "0"));
          await fetchFederationOnboarding();
        } catch (err) {
          appendFederationLog("peer trust update error for " + peerId + ": " + (err instanceof Error ? err.message : String(err)));
        }
      };

      const queueFederationPeerProbe = async (peerId) => {
        try {
          const res = await fetchWithAuth("/api/federation/tasks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              peerId,
              method: "submit_task",
              request: {
                kind: "onboarding.probe",
                source: "dashboard",
                issuedAt: Date.now(),
              },
            }),
          });
          const payload = await res.json();
          if (!res.ok) {
            appendFederationLog("probe enqueue failed for " + peerId + ": " + String(payload?.error ?? res.status));
            return;
          }
          appendFederationLog("probe task enqueued for " + peerId + " task=" + String(payload?.task?.id ?? "unknown"));
          await fetchFederationOnboarding();
        } catch (err) {
          appendFederationLog("probe enqueue error for " + peerId + ": " + (err instanceof Error ? err.message : String(err)));
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
        } else if (name === "llm-raw") {
          fetchLlmSessions({ preserveSelection: true, refreshMessages: true });
        } else if (name === "cli-chat") {
          fetchCliMessages();
        }
      };

      tabButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
          const name = btn.getAttribute("data-tab");
          if (name) setActiveTab(name);
        });
      });

      if (stopAllBtn) {
        stopAllBtn.addEventListener("click", async () => {
          const confirmed = window.confirm("Stop all sessions, processes, and agents now?");
          if (!confirmed) return;
          const raw = window.prompt(
            "Cooldown before heartbeat and scheduler resume (examples: 30s, 5m, 1h). Leave blank for default.",
            "5m",
          );
          if (raw === null) return;
          const cooldown = raw.trim();
          stopAllBtn.disabled = true;
          try {
            const res = await fetchWithAuth("/api/stopall", {
              method: "POST",
              headers: {
                "content-type": "application/json",
              },
              body: JSON.stringify(cooldown ? { cooldown } : {}),
            });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok || payload.ok !== true) {
              throw new Error(String(payload.error ?? "stopall request failed"));
            }
            window.alert(String(payload.summary ?? "Stop all executed."));
            window.location.reload();
          } catch (err) {
            window.alert("Stop all failed: " + (err instanceof Error ? err.message : String(err)));
          } finally {
            stopAllBtn.disabled = false;
          }
        });
      }

      if (logsRefreshBtn) {
        logsRefreshBtn.addEventListener("click", fetchLogs);
      }
      if (llmSessionsRefreshBtn) {
        llmSessionsRefreshBtn.addEventListener("click", () => {
          fetchLlmSessions({ preserveSelection: true, refreshMessages: true });
        });
      }
      if (llmMessagesRefreshBtn) {
        llmMessagesRefreshBtn.addEventListener("click", () => {
          fetchLlmMessages({ reset: true });
        });
      }
      if (llmOlderBtn) {
        llmOlderBtn.addEventListener("click", () => {
          fetchLlmMessages({ reset: false });
        });
      }
      if (llmSessionSelect) {
        llmSessionSelect.addEventListener("change", () => {
          llmState.selectedSessionId = llmSessionSelect.value || null;
          llmState.nextBeforeId = null;
          llmState.hasMore = false;
          fetchLlmMessages({ reset: true });
        });
      }
      if (cliRefreshBtn) {
        cliRefreshBtn.addEventListener("click", () => {
          fetchCliMessages();
        });
      }
      if (cliSessionNewBtn) {
        cliSessionNewBtn.addEventListener("click", () => {
          createCliSession();
        });
      }
      if (cliSendBtn) {
        cliSendBtn.addEventListener("click", () => {
          sendCliMessage();
        });
      }
      if (cliInput) {
        cliInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            sendCliMessage();
          }
        });
      }
      if (federationRefreshBtn) {
        federationRefreshBtn.addEventListener("click", () => {
          fetchFederationOnboarding();
        });
      }
      if (federationPeerAddBtn) {
        federationPeerAddBtn.addEventListener("click", () => {
          upsertFederationPeerFromForm();
        });
      }
      if (federationPeerTable) {
        federationPeerTable.addEventListener("click", (event) => {
          const target = event.target;
          const button =
            target instanceof Element ? target.closest("button[data-peer-action][data-peer-id]") : null;
          if (!button) return;
          const action = String(button.getAttribute("data-peer-action") ?? "").trim();
          const peerId = String(button.getAttribute("data-peer-id") ?? "").trim();
          if (!action || !peerId) return;
          const row = button.closest("tr");
          if (action === "apply") {
            void applyFederationPeerTrustFromRow(peerId, row);
            return;
          }
          if (action === "probe") {
            void queueFederationPeerProbe(peerId);
          }
        });
      }
      if (nodeAuditFetchBtn) {
        nodeAuditFetchBtn.addEventListener("click", () => {
          fetchNodeAudit({ older: false });
        });
      }
      if (nodeAuditOlderBtn) {
        nodeAuditOlderBtn.addEventListener("click", () => {
          fetchNodeAudit({ older: true });
        });
      }
      if (nodeAuditNodeInput) {
        nodeAuditNodeInput.addEventListener("change", () => {
          nodeAuditState.events = [];
          nodeAuditState.nextCursorCreatedAt = null;
          nodeAuditState.nodeId = String(nodeAuditNodeInput.value ?? "").trim() || null;
          fetchNodeAudit({ older: false });
        });
      }
      document.querySelectorAll("[data-node-audit-id]").forEach((element) => {
        element.addEventListener("click", () => {
          const nodeId = String(element.getAttribute("data-node-audit-id") ?? "").trim();
          if (!nodeId || !nodeAuditNodeInput) return;
          nodeAuditNodeInput.value = nodeId;
          nodeAuditState.events = [];
          nodeAuditState.nextCursorCreatedAt = null;
          nodeAuditState.nodeId = nodeId;
          fetchNodeAudit({ older: false });
          nodeAuditViewer?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });
      if (nodeAuditNodeInput && String(nodeAuditNodeInput.value ?? "").trim()) {
        fetchNodeAudit({ older: false });
      } else {
        renderNodeAuditRows();
      }
      fetchFederationOnboarding();
      updateCliComposerState();

      const isOrchestratorRun = (node) => String(node?.preset ?? "").trim().toLowerCase() === "orchestrator";
      const isRunVisible = (node, nowMs) => node.status === "running" || !node.ended_at || (nowMs - node.ended_at) < visibleNodeWindowMs;
      const normalizeExecutionNodes = (rows) =>
        (Array.isArray(rows) ? rows : [])
          .filter((row) => row && typeof row === "object")
          .map((row) => ({
            id: String(row.id ?? ""),
            label: String(row.label ?? ""),
            backend: String(row.backend ?? ""),
            status: String(row.status ?? "offline"),
            connected_at:
              typeof row.connected_at === "number"
                ? row.connected_at
                : typeof row.connectedAt === "number"
                  ? row.connectedAt
                  : null,
          }))
          .filter((row) => row.id);
      const filterConnectedExecutionNodes = (rows) =>
        normalizeExecutionNodes(rows).filter((row) => row.status === "online" || Boolean(row.connected_at));
      const buildDisplayedSubAgentNodes = (nodes) => {
        const now = Date.now();
        const visibleRuns = (Array.isArray(nodes) ? nodes : []).filter((node) => isRunVisible(node, now));
        const visibleById = new Map(visibleRuns.map((node) => [node.run_id, node]));
        const subAgentIds = new Set(visibleRuns.filter((node) => !isOrchestratorRun(node)).map((node) => node.run_id));
        return visibleRuns
          .filter((node) => !isOrchestratorRun(node))
          .map((node) => {
            let parentId = node.parent_run_id;
            while (parentId && !subAgentIds.has(parentId)) {
              const parent = visibleById.get(parentId);
              parentId = parent?.parent_run_id ?? null;
            }
            return { ...node, parent_run_id: parentId ?? null };
          });
      };
      const computeDisplayedAgentStats = (nodes) => ({
        running: nodes.filter((node) => node.status === "running").length,
        complete: nodes.filter((node) => node.status === "complete").length,
        failed: nodes.filter((node) => node.status === "failed" || node.status === "stopped").length,
        total: nodes.length,
      });

      // Update stats display
      const updateStats = (stats) => {
        const running = document.getElementById("stat-running");
        const complete = document.getElementById("stat-complete");
        const failed = document.getElementById("stat-failed");
        const total = document.getElementById("stat-total");
        if (running) running.textContent = String(stats.running);
        if (complete) complete.textContent = String(stats.complete);
        if (failed) failed.textContent = String(stats.failed);
        if (total) total.textContent = String(stats.total);
      };
      updateStats(computeDisplayedAgentStats(buildDisplayedSubAgentNodes(graphData)));

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
            const res = await fetchWithAuth("/api/proactive/pause", { method: "POST" });
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
            const res = await fetchWithAuth("/api/proactive/resume", { method: "POST" });
            if (res.ok) updateHeartbeatUI(false);
          } finally {
            heartbeatResumeBtn.disabled = false;
          }
        });
      }

      // Live data refresh countdown display
      let refreshCountdown = 5;
      let federationRefreshCountdown = 30;
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
        if (agentRefreshInFlight) return;
        agentRefreshInFlight = true;
        try {
          const [agentsRes, nodesRes] = await Promise.all([
            fetchWithAuth(\`/api/agents?agentWindowMinutes=\${agentWindowMinutes}&visibleNodeWindowSeconds=\${visibleNodeWindowSeconds}\`),
            fetchWithAuth(\`/api/nodes?limit=\${nodeLimit}\`),
          ]);
          if (!agentsRes.ok) return;
          const data = await agentsRes.json();
          graphData = data.nodes;
          const displayedSubAgentNodes = buildDisplayedSubAgentNodes(data.nodes);
          updateStats(computeDisplayedAgentStats(displayedSubAgentNodes));

          if (nodesRes.ok) {
            try {
              const nodePayload = await nodesRes.json();
              executionNodeData = normalizeExecutionNodes(nodePayload?.nodes);
            } catch (err) {
              console.warn("Failed to parse node payload:", err);
            }
          }

          if (data.tables) {
            updateTables(data.tables);
          }

          if (sceneState) {
            updateSceneWithNewData(sceneState, displayedSubAgentNodes, filterConnectedExecutionNodes(executionNodeData));
          }
        } catch (e) {
          console.warn("Failed to fetch agent data:", e);
        } finally {
          agentRefreshInFlight = false;
        }
      };

      const refreshTimer = window.setInterval(() => {
        if (document.hidden) return;
        refreshCountdown--;
        federationRefreshCountdown--;
        updateRefreshIndicator();
        if (refreshCountdown <= 0) {
          refreshCountdown = 5;
          fetchAndUpdate();
          if (logsAutoToggle?.checked && logsPanel?.classList.contains("active")) {
            fetchLogs();
          }
        }
        if (federationRefreshCountdown <= 0) {
          federationRefreshCountdown = 30;
          fetchFederationOnboarding();
        }
      }, 1000);

      // Status color mapping
      const statusColors = {
        running: 0x00ff41,
        complete: 0x00d4ff,
        failed: 0xff0040,
        stopped: 0xff0040,
        budget_exhausted: 0xffb800,
      };
      const baseOrbitRadius = 90;
      const orbitRadiusStep = 55;
      const orbitRingStep = orbitRadiusStep * 0.6;
      const connectedNodeOrbitRadius = baseOrbitRadius + Math.max(1, maxAgentLevels) * orbitRingStep;
      const connectedNodeOrbitY = ORCHESTRATOR_Y;
      const computeExecutionOrbitSpeedByRadius = (radius, seed = 0) => {
        const normalizedRadius = Math.max(1, radius / Math.max(1, baseOrbitRadius));
        const keplerFalloff = 1 / Math.sqrt(normalizedRadius);
        const baseSpeed = 0.00034; // Faster than before while keeping outer orbits slower than inner ones.
        const variation = (seed % 7) * 0.00001;
        return baseSpeed * keplerFalloff + variation;
      };
      const computeAgentOrbRadius = (depth) => Math.max(5, 9 - depth * 1.2);
      const computeMinimumAgentAngleSpacing = (depth, ringCount) => {
        const orbitRadius = baseOrbitRadius + depth * orbitRingStep;
        const orbDiameter = computeAgentOrbRadius(depth) * 2;
        const desiredLinearSpacing = orbDiameter + AGENT_ORB_SPACING_PADDING;
        const desiredAngle = desiredLinearSpacing / Math.max(1, orbitRadius);
        const maxFeasibleAngle = ((Math.PI * 2) * AGENT_RING_FILL_RATIO) / Math.max(1, ringCount);
        return Math.max(0.035, Math.min(desiredAngle, maxFeasibleAngle));
      };

      // Helper to create a sub-agent mesh (low-poly orb)
      const createNodeMesh = (node, THREE) => {
        const color = statusColors[node.status] ?? 0x00aa2a;
        const radius = computeAgentOrbRadius(node.depth);
        const geometry = new THREE.IcosahedronGeometry(radius, NODE_ICOSAHEDRON_DETAIL);
        const material = new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: node.status === 'running' ? 0.5 : 0.25,
          roughness: 0.35,
          metalness: 0.62,
          flatShading: true,
        });
        return new THREE.Mesh(geometry, material);
      };

      const createExecutionNodeMesh = (node, THREE) => {
        const color = EXECUTION_NODE_COLOR;
        const geometry = new THREE.TorusGeometry(10, 2.5, 6, 14);
        const material = new THREE.MeshStandardMaterial({
          color,
          emissive: EXECUTION_NODE_EMISSIVE,
          emissiveIntensity: 0.26,
          roughness: 0.38,
          metalness: 0.58,
          flatShading: true,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.rotation.x = Math.PI / 2;
        return mesh;
      };

      // Helper to create connection line
      const createAgentConnectionLine = (fromX, fromY, fromZ, toX, toY, toZ, opacity, THREE) => {
        const points = [
          new THREE.Vector3(fromX, fromY, fromZ),
          new THREE.Vector3(toX, toY, toZ),
        ];
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({ color: 0x00ff41, transparent: true, opacity });
        return new THREE.Line(geometry, material);
      };

      const createExecutionConnectionLine = (fromX, fromY, fromZ, toX, toY, toZ, THREE) => {
        const points = [
          new THREE.Vector3(fromX, fromY, fromZ),
          new THREE.Vector3(toX, toY, toZ),
        ];
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineDashedMaterial({
          color: 0xc4ccd6,
          transparent: true,
          opacity: 0.7,
          dashSize: 8,
          gapSize: 6,
        });
        const line = new THREE.Line(geometry, material);
        line.computeLineDistances();
        return line;
      };

      const updateLineGeometry = (line, fromX, fromY, fromZ, toX, toY, toZ) => {
        const positions = line.geometry.attributes.position.array;
        positions[0] = fromX;
        positions[1] = fromY;
        positions[2] = fromZ;
        positions[3] = toX;
        positions[4] = toY;
        positions[5] = toZ;
        line.geometry.attributes.position.needsUpdate = true;
        if (typeof line.computeLineDistances === "function") {
          line.computeLineDistances();
        }
      };

      const normalizeAngle = (angle) => {
        let a = angle % (Math.PI * 2);
        if (a < 0) a += Math.PI * 2;
        return a;
      };

      const computeAgentOrbitSpeed = (depth, seed, parentSpeed) => {
        if (typeof parentSpeed === "number") {
          const variation = ((seed % 5) - 2) * 0.0000015;
          return Math.max(0.00014, parentSpeed * 0.995 + variation);
        }
        const base = Math.max(0.0002, 0.00046 - depth * 0.00004);
        const variation = ((seed % 7) - 3) * 0.000008;
        return Math.max(0.00016, base + variation);
      };

      // Position a node in the ringed solar-system layout:
      // each depth level stays on its global ring, while children cluster around parent angle.
      const positionNode = (params) => {
        const { node, parent, depth, siblingIndex, siblingCount } = params;
        node.depth = depth;
        const orbitRadius = baseOrbitRadius + depth * orbitRingStep;
        let angle;
        if (!parent) {
          const rootBase = (siblingIndex / Math.max(1, siblingCount)) * Math.PI * 2;
          angle = typeof node.orbitAngle === "number" ? node.orbitAngle : rootBase;
        } else {
          const parentAngle =
            typeof parent.orbitAngle === "number" ? parent.orbitAngle : Math.atan2(parent.z ?? 0, parent.x ?? 0);
          const minSiblingAngle = computeMinimumAgentAngleSpacing(depth, siblingCount);
          const baseClusterSpan = 0.32 + Math.max(0, siblingCount - 1) * 0.11;
          const requiredClusterSpan =
            siblingCount <= 1 ? 0 : (minSiblingAngle * Math.max(0, siblingCount - 1)) / 2;
          const clusterSpan = Math.min(Math.PI - 0.12, Math.max(baseClusterSpan, requiredClusterSpan));
          const rel = siblingCount <= 1 ? 0 : (siblingIndex / (siblingCount - 1)) * 2 - 1;
          const clustered = parentAngle + rel * clusterSpan;
          angle = typeof node.orbitAngle === "number" ? node.orbitAngle : clustered;
        }
        node.orbitAngle = normalizeAngle(angle);
        node.x = Math.cos(node.orbitAngle) * orbitRadius;
        node.y = ORCHESTRATOR_Y;
        node.z = Math.sin(node.orbitAngle) * orbitRadius;
        if (typeof node.orbitSpeed !== "number") {
          const seed = siblingIndex + depth * 13 + siblingCount * 7;
          node.orbitSpeed = computeAgentOrbitSpeed(depth, seed, parent?.orbitSpeed);
        }
        node.orbitRadius = orbitRadius;
        node.orbitCenterX = 0;
        node.orbitCenterY = ORCHESTRATOR_Y;
        node.orbitCenterZ = 0;
      };

      const enforceSubAgentOrbSpacing = (nodesById) => {
        const nodesByDepth = new Map();
        for (const node of nodesById.values()) {
          if (typeof node.depth !== "number" || node.depth < 0 || typeof node.orbitAngle !== "number") continue;
          const depthNodes = nodesByDepth.get(node.depth) ?? [];
          depthNodes.push(node);
          nodesByDepth.set(node.depth, depthNodes);
        }

        for (const [depth, ringNodes] of nodesByDepth.entries()) {
          if (ringNodes.length <= 1) continue;
          const minAngleSpacing = computeMinimumAgentAngleSpacing(depth, ringNodes.length);
          for (let pass = 0; pass < AGENT_COLLISION_RELAXATION_PASSES; pass++) {
            let changed = false;
            ringNodes.sort((a, b) => a.orbitAngle - b.orbitAngle);
            for (let i = 0; i < ringNodes.length; i++) {
              const left = ringNodes[i];
              const right = ringNodes[(i + 1) % ringNodes.length];
              const rightAngle = i === ringNodes.length - 1 ? right.orbitAngle + Math.PI * 2 : right.orbitAngle;
              const gap = rightAngle - left.orbitAngle;
              if (gap >= minAngleSpacing) continue;
              const push = (minAngleSpacing - gap) * 0.5;
              left.orbitAngle = normalizeAngle(left.orbitAngle - push);
              right.orbitAngle = normalizeAngle(right.orbitAngle + push);
              changed = true;
            }
            if (!changed) break;
          }

          const orbitRadius = baseOrbitRadius + depth * orbitRingStep;
          for (const node of ringNodes) {
            node.x = Math.cos(node.orbitAngle) * orbitRadius;
            node.y = ORCHESTRATOR_Y;
            node.z = Math.sin(node.orbitAngle) * orbitRadius;
            node.orbitRadius = orbitRadius;
          }
        }
      };

      // Build node tree and position nodes
      const buildNodeTree = (nodes, previousNodesById = null) => {
        const nodesById = new Map(
          nodes.map((n) => {
            const previous = previousNodesById?.get(n.run_id);
            return [
              n.run_id,
              {
                ...n,
                orbitAngle: typeof previous?.orbitAngle === "number" ? previous.orbitAngle : undefined,
                orbitSpeed: typeof previous?.orbitSpeed === "number" ? previous.orbitSpeed : undefined,
                children: [],
              },
            ];
          }),
        );
        for (const node of nodesById.values()) {
          if (node.parent_run_id && nodesById.has(node.parent_run_id)) {
            nodesById.get(node.parent_run_id).children.push(node);
          }
        }
        const roots = [...nodesById.values()].filter((n) => !n.parent_run_id || !nodesById.has(n.parent_run_id));

        const positionChildren = (node, depth) => {
          node.children.forEach((child, idx) => {
            positionNode({
              node: child,
              parent: node,
              depth: depth + 1,
              siblingIndex: idx,
              siblingCount: node.children.length,
            });
            positionChildren(child, depth + 1);
          });
        };
        roots.forEach((root, idx) => {
          positionNode({
            node: root,
            parent: null,
            depth: 0,
            siblingIndex: idx,
            siblingCount: roots.length,
          });
          positionChildren(root, 0);
        });
        enforceSubAgentOrbSpacing(nodesById);
        return { nodesById, roots };
      };

      const applyConnectedNodeLayout = (state, connectedNodes) => {
        const { scene, executionNodesById, meshToNode, pickableMeshes, sunPosition, THREE } = state;
        const normalized = filterConnectedExecutionNodes(connectedNodes);
        const newIds = new Set(normalized.map((node) => node.id));

        for (const [nodeId, existingNode] of executionNodesById.entries()) {
          if (!newIds.has(nodeId)) {
            if (existingNode.mesh) {
              scene.remove(existingNode.mesh);
              meshToNode.delete(existingNode.mesh);
              const meshIndex = pickableMeshes.indexOf(existingNode.mesh);
              if (meshIndex >= 0) pickableMeshes.splice(meshIndex, 1);
              existingNode.mesh.geometry.dispose();
              existingNode.mesh.material.dispose();
            }
            if (existingNode.connectionLine) {
              scene.remove(existingNode.connectionLine);
              existingNode.connectionLine.geometry.dispose();
              existingNode.connectionLine.material.dispose();
            }
            executionNodesById.delete(nodeId);
          }
        }

        const total = Math.max(1, normalized.length);
        normalized.forEach((node, idx) => {
          const targetAngle = (idx / total) * Math.PI * 2;
          let existingNode = executionNodesById.get(node.id);

          if (!existingNode) {
            const mesh = createExecutionNodeMesh(node, THREE);
            scene.add(mesh);
            const tooltipNode = {
              agent_id: node.id,
              preset: "execution-node",
              status: node.status || "online",
              started_at: node.connected_at,
              ended_at: null,
              task: node.label || "Connected execution node",
              isExecutionNode: true,
            };
            existingNode = {
              ...node,
              tooltipNode,
              mesh,
              connectionLine: null,
              orbitAngle: targetAngle,
              orbitSpeed: computeExecutionOrbitSpeedByRadius(connectedNodeOrbitRadius, idx),
              orbitRadius: connectedNodeOrbitRadius,
              orbitCenterX: 0,
              orbitCenterY: connectedNodeOrbitY,
              orbitCenterZ: 0,
              spinSpeed: 0.012 + (idx % 4) * 0.003,
              spinPhase: (idx / Math.max(1, total)) * Math.PI * 2,
            };
            executionNodesById.set(node.id, existingNode);
            meshToNode.set(mesh, tooltipNode);
            pickableMeshes.push(mesh);
          } else {
            existingNode.status = node.status;
            existingNode.label = node.label;
            existingNode.connected_at = node.connected_at;
            existingNode.backend = node.backend;
            if (existingNode.tooltipNode) {
              existingNode.tooltipNode.status = node.status || "online";
              existingNode.tooltipNode.started_at = node.connected_at;
              existingNode.tooltipNode.task = node.label || "Connected execution node";
            }
            existingNode.mesh.material.color.setHex(EXECUTION_NODE_COLOR);
            existingNode.mesh.material.emissive.setHex(EXECUTION_NODE_EMISSIVE);
          }

          existingNode.orbitRadius = connectedNodeOrbitRadius;
          existingNode.orbitCenterX = 0;
          existingNode.orbitCenterY = connectedNodeOrbitY;
          existingNode.orbitCenterZ = 0;
          existingNode.orbitSpeed = computeExecutionOrbitSpeedByRadius(existingNode.orbitRadius, idx);
          if (typeof existingNode.spinSpeed !== "number") {
            existingNode.spinSpeed = 0.014;
          }
          if (typeof existingNode.spinPhase !== "number") {
            existingNode.spinPhase = 0;
          }
          if (typeof existingNode.orbitAngle !== "number") {
            existingNode.orbitAngle = targetAngle;
          }
          const x = existingNode.orbitCenterX + Math.cos(existingNode.orbitAngle) * existingNode.orbitRadius;
          const y = existingNode.orbitCenterY;
          const z = existingNode.orbitCenterZ + Math.sin(existingNode.orbitAngle) * existingNode.orbitRadius;
          existingNode.mesh.position.set(x, y, z);
          existingNode.x = x;
          existingNode.y = y;
          existingNode.z = z;

          if (!existingNode.connectionLine) {
            existingNode.connectionLine = createExecutionConnectionLine(
              sunPosition.x,
              sunPosition.y,
              sunPosition.z,
              x,
              y,
              z,
              THREE,
            );
            scene.add(existingNode.connectionLine);
          } else {
            updateLineGeometry(existingNode.connectionLine, sunPosition.x, sunPosition.y, sunPosition.z, x, y, z);
          }
        });
      };

      // Update scene with new data (add new nodes, update existing, remove old)
      const updateSceneWithNewData = (state, newNodes, connectedNodes) => {
        const { scene, nodesById, meshToNode, pickableMeshes, executionNodesById, sunPosition, THREE } = state;
        const newNodeIds = new Set(newNodes.map((n) => n.run_id));
        const { nodesById: newNodesById } = buildNodeTree(newNodes, nodesById);

        // Remove nodes that no longer exist
        for (const [runId, node] of nodesById.entries()) {
          if (!newNodeIds.has(runId)) {
            if (node.mesh) {
              scene.remove(node.mesh);
              meshToNode.delete(node.mesh);
              const meshIndex = pickableMeshes.indexOf(node.mesh);
              if (meshIndex >= 0) pickableMeshes.splice(meshIndex, 1);
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

        // Add or update sub-agent nodes
        for (const [runId, newNode] of newNodesById.entries()) {
          let existingNode = nodesById.get(runId);
          if (!existingNode) {
            const mesh = createNodeMesh(newNode, THREE);
            mesh.position.set(newNode.x ?? 0, newNode.y ?? 0, newNode.z ?? 0);
            scene.add(mesh);
            newNode.mesh = mesh;
            nodesById.set(runId, newNode);
            meshToNode.set(mesh, newNode);
            pickableMeshes.push(mesh);
            existingNode = newNode;
          } else {
            if (existingNode.status !== newNode.status) {
              const color = statusColors[newNode.status] ?? 0x00aa2a;
              existingNode.mesh.material.color.setHex(color);
              existingNode.mesh.material.emissive.setHex(color);
              existingNode.mesh.material.emissiveIntensity = newNode.status === 'running' ? 0.5 : 0.25;
              existingNode.status = newNode.status;
            }
            existingNode.parent_run_id = newNode.parent_run_id;
            existingNode.depth = newNode.depth;
            existingNode.ended_at = newNode.ended_at;
            existingNode.task = newNode.task;
            existingNode.orbitRadius = newNode.orbitRadius;
            existingNode.orbitCenterX = newNode.orbitCenterX;
            existingNode.orbitCenterY = newNode.orbitCenterY;
            existingNode.orbitCenterZ = newNode.orbitCenterZ;
            existingNode.y = newNode.y;
            existingNode.mesh.position.y = newNode.y;
          }

          let fromX = sunPosition.x;
          let fromY = sunPosition.y;
          let fromZ = sunPosition.z;
          if (existingNode.parent_run_id && nodesById.has(existingNode.parent_run_id)) {
            const parent = nodesById.get(existingNode.parent_run_id);
            fromX = parent.x;
            fromY = parent.y;
            fromZ = parent.z;
          }
          if (!existingNode.connectionLine) {
            const line = createAgentConnectionLine(fromX, fromY, fromZ, existingNode.x, existingNode.y, existingNode.z, 0.45, THREE);
            scene.add(line);
            existingNode.connectionLine = line;
          } else {
            updateLineGeometry(existingNode.connectionLine, fromX, fromY, fromZ, existingNode.x, existingNode.y, existingNode.z);
          }
        }

        applyConnectedNodeLayout({ scene, executionNodesById, meshToNode, pickableMeshes, sunPosition, THREE }, connectedNodes);
      };

      if (!container) {
        console.warn("Agent graph container missing");
      } else {
        const width = container.clientWidth || 800;
        const height = 480;
        const sunPosition = new THREE.Vector3(0, ORCHESTRATOR_Y, 0);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x050505);

        const cameraAspect = width / height;
        const camera = new THREE.OrthographicCamera(
          -ORTHO_VIEW_HALF_HEIGHT * cameraAspect,
          ORTHO_VIEW_HALF_HEIGHT * cameraAspect,
          ORTHO_VIEW_HALF_HEIGHT,
          -ORTHO_VIEW_HALF_HEIGHT,
          1,
          2500,
        );
        const defaultView = {
          position: new THREE.Vector3(420, 420, 420),
          target: new THREE.Vector3(0, ORCHESTRATOR_Y, 0),
          zoom: 1.2,
        };

        const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "low-power" });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_RENDER_PIXEL_RATIO));
        container.appendChild(renderer.domElement);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.minZoom = 0.55;
        controls.maxZoom = 3.4;
        controls.maxPolarAngle = Math.PI / 2.02;

        const applyDefaultView = () => {
          camera.position.copy(defaultView.position);
          controls.target.copy(defaultView.target);
          camera.zoom = defaultView.zoom;
          camera.updateProjectionMatrix();
          controls.update();
        };
        applyDefaultView();

        if (resetViewBtn) {
          resetViewBtn.addEventListener("click", applyDefaultView);
        }

        const ambientLight = new THREE.AmbientLight(0x00ff41, 0.18);
        scene.add(ambientLight);
        const pointLight = new THREE.PointLight(ORCHESTRATOR_COLOR, 1.6, 700);
        pointLight.position.set(sunPosition.x, sunPosition.y + 15, sunPosition.z);
        scene.add(pointLight);

        const floorGrid = new THREE.GridHelper(1200, 48, FLOOR_GRID_COLOR, FLOOR_GRID_COLOR);
        floorGrid.position.y = FLOOR_Y;
        const floorMaterials = Array.isArray(floorGrid.material) ? floorGrid.material : [floorGrid.material];
        floorMaterials.forEach((material) => {
          material.transparent = true;
          material.opacity = 0.36;
        });
        scene.add(floorGrid);

        // Create orbit rings
        const createOrbitRing = (radius, y, opacity = 0.35) => {
          const segments = ORBIT_RING_SEGMENTS;
          const points = [];
          for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            points.push(new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius));
          }
          const geometry = new THREE.BufferGeometry().setFromPoints(points);
          const material = new THREE.LineBasicMaterial({ color: ORBIT_RING_COLOR, transparent: true, opacity });
          return new THREE.Line(geometry, material);
        };
        for (let level = 0; level < Math.max(1, maxAgentLevels); level++) {
          const radius = baseOrbitRadius + level * orbitRingStep;
          scene.add(createOrbitRing(radius, ORCHESTRATOR_Y, 0.32));
        }
        scene.add(createOrbitRing(connectedNodeOrbitRadius, ORCHESTRATOR_Y, 0.45));

        // Create central orchestrator
        const orchestratorColor = ORCHESTRATOR_COLOR;
        const orchestratorRadius = 18;
        const orchestratorMesh = new THREE.Mesh(
          new THREE.IcosahedronGeometry(orchestratorRadius, CORE_ICOSAHEDRON_DETAIL),
          new THREE.MeshStandardMaterial({
            color: orchestratorColor,
            emissive: orchestratorColor,
            emissiveIntensity: 0.8,
            roughness: 0.25,
            metalness: 0.8,
            flatShading: true,
          })
        );
        orchestratorMesh.position.copy(sunPosition);
        scene.add(orchestratorMesh);

        const glow1 = new THREE.Mesh(
          new THREE.SphereGeometry(orchestratorRadius * 1.6, 12, 12),
          new THREE.MeshBasicMaterial({ color: orchestratorColor, transparent: true, opacity: 0.12 })
        );
        glow1.position.copy(sunPosition);
        scene.add(glow1);

        const glow2 = new THREE.Mesh(
          new THREE.SphereGeometry(orchestratorRadius * 2.4, 12, 12),
          new THREE.MeshBasicMaterial({ color: orchestratorColor, transparent: true, opacity: 0.05 })
        );
        glow2.position.copy(sunPosition);
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
        const pickableMeshes = [];
        meshToNode.set(orchestratorMesh, orchestratorNode);

        // Build initial node tree (sub-agents only; orchestrator is represented by the central sun)
        const { nodesById } = buildNodeTree(buildDisplayedSubAgentNodes(graphData));

        // Create initial node meshes
        for (const node of nodesById.values()) {
          const mesh = createNodeMesh(node, THREE);
          mesh.position.set(node.x ?? 0, node.y ?? 0, node.z ?? 0);
          scene.add(mesh);
          node.mesh = mesh;
          meshToNode.set(mesh, node);
          pickableMeshes.push(mesh);
        }

        // Create initial connection lines
        for (const node of nodesById.values()) {
          let fromX = sunPosition.x;
          let fromY = sunPosition.y;
          let fromZ = sunPosition.z;
          if (node.parent_run_id && nodesById.has(node.parent_run_id)) {
            const parent = nodesById.get(node.parent_run_id);
            fromX = parent.x;
            fromY = parent.y;
            fromZ = parent.z;
          }
          const line = createAgentConnectionLine(fromX, fromY, fromZ, node.x, node.y, node.z, 0.45, THREE);
          scene.add(line);
          node.connectionLine = line;
        }

        const executionNodesById = new Map();
        applyConnectedNodeLayout(
          { scene, executionNodesById, meshToNode, pickableMeshes, sunPosition, THREE },
          filterConnectedExecutionNodes(executionNodeData),
        );

        // Store scene state for live updates
        sceneState = { scene, nodesById, executionNodesById, meshToNode, pickableMeshes, sunPosition, THREE };

        // Raycaster for hover detection
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();
        let hoveredNode = null;
        let lastRaycastAt = 0;

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
          const now = performance.now();
          if (now - lastRaycastAt < HOVER_RAYCAST_INTERVAL_MS) return;
          lastRaycastAt = now;
          const rect = renderer.domElement.getBoundingClientRect();
          mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
          mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

          raycaster.setFromCamera(mouse, camera);
          const intersects = raycaster.intersectObjects(pickableMeshes, false);

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
          const aspect = w / h;
          camera.left = -ORTHO_VIEW_HALF_HEIGHT * aspect;
          camera.right = ORTHO_VIEW_HALF_HEIGHT * aspect;
          camera.top = ORTHO_VIEW_HALF_HEIGHT;
          camera.bottom = -ORTHO_VIEW_HALF_HEIGHT;
          camera.updateProjectionMatrix();
        };
        window.addEventListener("resize", resize);
        const onVisibilityChange = () => {
          if (document.hidden) hideTooltip();
        };
        document.addEventListener("visibilitychange", onVisibilityChange);

        // Animation loop
        let time = 0;
        let lastFrameAt = 0;
        let rafId = 0;
        const animate = (now = 0) => {
          rafId = requestAnimationFrame(animate);
          if (document.hidden) return;
          if (lastFrameAt !== 0 && now - lastFrameAt < FRAME_INTERVAL_MS) return;
          const deltaFrames = lastFrameAt === 0 ? 1 : Math.min(4, (now - lastFrameAt) / FRAME_INTERVAL_MS);
          lastFrameAt = now;
          time += deltaFrames;

          // Orchestrator glow pulse
          const glowPulse = 1 + Math.sin(time * 0.02) * 0.15;
          glow1.scale.setScalar(glowPulse);
          glow2.scale.setScalar(glowPulse * 0.95);
          orchestratorMesh.scale.setScalar(1 + Math.sin(time * 0.03) * 0.03);

          // Orbital animation (respects pause)
          if (!isPaused) {
            for (const node of nodesById.values()) {
              if (node.mesh && node.orbitRadius > 0) {
                node.orbitAngle += node.orbitSpeed * deltaFrames;
                const newX = node.orbitCenterX + Math.cos(node.orbitAngle) * node.orbitRadius;
                const newZ = node.orbitCenterZ + Math.sin(node.orbitAngle) * node.orbitRadius;
                node.mesh.position.x = newX;
                node.mesh.position.z = newZ;
                node.x = newX;
                node.z = newZ;

                if (node.connectionLine) {
                  const positions = node.connectionLine.geometry.attributes.position.array;
                  if (node.depth === 0) {
                    positions[0] = sunPosition.x;
                    positions[1] = sunPosition.y;
                    positions[2] = sunPosition.z;
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

            for (const node of executionNodesById.values()) {
              if (!node.mesh || node.orbitRadius <= 0) continue;
              node.orbitAngle += node.orbitSpeed * deltaFrames;
              const newX = node.orbitCenterX + Math.cos(node.orbitAngle) * node.orbitRadius;
              const newZ = node.orbitCenterZ + Math.sin(node.orbitAngle) * node.orbitRadius;
              node.mesh.position.x = newX;
              node.mesh.position.z = newZ;
              node.x = newX;
              node.z = newZ;
              node.mesh.rotation.z += (node.spinSpeed ?? 0.014) * deltaFrames;
              node.mesh.rotation.y = Math.sin(time * 0.01 + (node.spinPhase ?? 0)) * 0.18;
              if (node.connectionLine) {
                updateLineGeometry(node.connectionLine, sunPosition.x, sunPosition.y, sunPosition.z, node.x, node.y, node.z);
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

        const cleanup = () => {
          window.clearInterval(refreshTimer);
          window.removeEventListener("resize", resize);
          document.removeEventListener("visibilitychange", onVisibilityChange);
          renderer.domElement.removeEventListener("mousemove", onMouseMove);
          renderer.domElement.removeEventListener("mouseleave", hideTooltip);
          if (resetViewBtn) resetViewBtn.removeEventListener("click", applyDefaultView);
          if (rafId) cancelAnimationFrame(rafId);
          controls.dispose();
          scene.traverse((object) => {
            const anyObject = object;
            if (anyObject.geometry?.dispose) {
              anyObject.geometry.dispose();
            }
            const material = anyObject.material;
            if (Array.isArray(material)) {
              material.forEach((entry) => entry?.dispose?.());
            } else if (material?.dispose) {
              material.dispose();
            }
          });
          renderer.dispose();
          sceneState = null;
        };
        window.addEventListener("pagehide", cleanup, { once: true });
      }
    </script>
  </body>
</html>`;
  return injectHiddenInputIntoPostForms(page, csrfHiddenInput);
}

function injectHiddenInputIntoPostForms(html: string, hiddenInput: string): string {
  if (!hiddenInput) return html;
  return html.replace(/<form\b([^>]*\bmethod=(?:"post"|'post')[^>]*)>/gi, `<form$1>${hiddenInput}`);
}
