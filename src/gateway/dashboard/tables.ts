import type {
  AgentRunInfo,
  ManagedProcessInfo,
  JobRow,
  JobRunRow,
  NodeRow,
  BlackboardRow,
  DataIntakePanelState,
  DataIntakeCatalogEntry,
  HAEventRow,
} from "./types.js";

export function renderAgentTable(rows: AgentRunInfo[]): string {
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

export function renderProcessTable(rows: ManagedProcessInfo[]): string {
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

export function renderJobsTable(rows: JobRow[]): string {
  if (rows.length === 0) return `<div class="no-data">No jobs found.</div>`;
  const oneShotCron = "@once";
  return `<table>
    <thead>
      <tr>
        <th>Status</th>
        <th>Mode</th>
        <th>ID</th>
        <th>Name</th>
        <th>Cron</th>
        <th>Timezone</th>
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
        let scheduleLabel = j.cron;
        let timezoneLabel = j.timezone;
        try {
          const spec = JSON.parse(j.spec_json || "{}");
          if (spec.mode) mode = spec.mode;
          if (j.cron === oneShotCron) {
            const atMs = Number(spec.oneShotAtMs);
            scheduleLabel = Number.isFinite(atMs) ? `one-shot @ ${formatTime(Math.floor(atMs))}` : "one-shot";
            timezoneLabel = "-";
          }
        } catch { }

        const modeBadgeClass = mode === "agent_task" ? "status-running" : mode === "tool_call" ? "status-enabled" : "status-complete";

        return `<tr>
            <td><span class="badge ${enabled ? "status-enabled" : "status-disabled"}">${enabled ? "enabled" : "disabled"}</span></td>
            <td><span class="badge ${modeBadgeClass}">${escapeHtml(mode)}</span></td>
            <td>${escapeHtml(j.id)}</td>
            <td>${escapeHtml(j.name)}</td>
            <td>${escapeHtml(scheduleLabel)}</td>
            <td>${escapeHtml(timezoneLabel)}</td>
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

export function renderJobRunsTable(rows: JobRunRow[]): string {
  if (rows.length === 0) return `<div class="no-data">No jobs currently running.</div>`;
  return `<table>
    <thead>
      <tr>
        <th>Status</th>
        <th>Run ID</th>
        <th>Job ID</th>
        <th>Agent</th>
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
            <td>${escapeHtml(r.agent_id)}</td>
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

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function renderNodeStatusAction(params: {
  nodeId: string;
  nextStatus: "pending" | "approved" | "blocked";
  label: string;
  danger?: boolean;
  confirmMessage?: string;
}): string {
  const confirmAttr = params.confirmMessage
    ? ` onsubmit="return confirm('${escapeHtml(params.confirmMessage)}')"`
    : "";
  return `<form method="post" action="/dashboard/nodes/status"${confirmAttr}>
    <input type="hidden" name="id" value="${escapeHtml(params.nodeId)}" />
    <input type="hidden" name="status" value="${params.nextStatus}" />
    <button type="submit" class="graph-btn${params.danger ? " btn-danger" : ""}">${escapeHtml(params.label)}</button>
  </form>`;
}

function renderNodeDeleteAction(nodeId: string, disabled = false): string {
  const disabledAttr = disabled ? " disabled" : "";
  const confirmAttr = disabled
    ? ""
    : ` onsubmit="return confirm('Delete node ${escapeHtml(nodeId)} and purge associated records? This cannot be undone.')"`;
  return `<form method="post" action="/dashboard/nodes/delete"${confirmAttr}>
    <input type="hidden" name="id" value="${escapeHtml(nodeId)}" />
    <button type="submit" class="graph-btn btn-danger"${disabledAttr}>Delete</button>
  </form>`;
}

function renderNodeActions(row: NodeRow): string {
  const nodeId = row.id;
  const deleteAction = renderNodeDeleteAction(nodeId, row.status === "online");
  const blockAction = renderNodeStatusAction({
    nodeId,
    nextStatus: "blocked",
    label: "Block",
    danger: true,
    confirmMessage: `Block node ${nodeId}?`,
  });
  switch (row.status) {
    case "pending":
      return `${renderNodeStatusAction({
        nodeId,
        nextStatus: "approved",
        label: "Approve",
      })}${blockAction}${deleteAction}`;
    case "approved":
      return `<button type="button" class="graph-btn" disabled>Approved</button>${renderNodeStatusAction({
        nodeId,
        nextStatus: "pending",
        label: "Set Pending",
      })}${deleteAction}`;
    case "blocked":
      return `${renderNodeStatusAction({
        nodeId,
        nextStatus: "approved",
        label: "Approve",
      })}${renderNodeStatusAction({
        nodeId,
        nextStatus: "pending",
        label: "Set Pending",
      })}${deleteAction}`;
    case "online":
      return `<button type="button" class="graph-btn" disabled>Online</button>${blockAction}${deleteAction}`;
    case "offline":
      return `<button type="button" class="graph-btn" disabled>Offline</button>${renderNodeStatusAction({
        nodeId,
        nextStatus: "pending",
        label: "Set Pending",
      })}${deleteAction}`;
    default:
      return `${renderNodeStatusAction({
        nodeId,
        nextStatus: "approved",
        label: "Approve",
      })}${blockAction}${deleteAction}`;
  }
}

export function renderNodesTable(rows: NodeRow[]): string {
  if (rows.length === 0) return `<div class="no-data">No nodes registered.</div>`;
  return `<table>
    <thead>
      <tr>
        <th>Status</th>
        <th>ID</th>
        <th>Label</th>
        <th>Backend</th>
        <th>Trust</th>
        <th>Firewall</th>
        <th>Last Seen</th>
        <th>Connected</th>
        <th>Endpoint</th>
        <th>Capabilities</th>
        <th>Tags</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      ${rows
      .map((row) => {
        const capabilities = parseStringArray(row.capabilities_json);
        const tags = parseStringArray(row.tags_json);
        const statusClass = escapeClass(row.status);
        return `<tr>
            <td><span class="badge status-${statusClass}">${escapeHtml(row.status)}</span></td>
            <td>${escapeHtml(row.id)}</td>
            <td>${escapeHtml(row.label)}</td>
            <td>${escapeHtml(row.backend)}</td>
            <td>${escapeHtml(row.trust_level)}</td>
            <td>${escapeHtml(row.firewall_mode)}</td>
            <td>${escapeHtml(row.last_seen_at ? formatTime(row.last_seen_at) : "-")}</td>
            <td>${escapeHtml(row.connected_at ? formatTime(row.connected_at) : "-")}</td>
            <td>${escapeHtml(row.endpoint ?? "-")}</td>
            <td>${escapeHtml(capabilities.length > 0 ? truncate(capabilities.join(", "), 96) : "-")}</td>
            <td>${escapeHtml(tags.length > 0 ? truncate(tags.join(", "), 64) : "-")}</td>
            <td>
              <div class="inline-actions">
                ${renderNodeActions(row)}
              </div>
            </td>
          </tr>`;
      })
      .join("")}
    </tbody>
  </table>`;
}

export function renderDataIntakeTable(params: DataIntakePanelState, catalog: DataIntakeCatalogEntry[]): string {
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

export function renderBlackboardTable(rows: BlackboardRow[]): string {
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

export function renderHAEventsTable(events: HAEventRow[]): string {
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

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeJsonForScript(value: unknown): string {
  if (value === undefined) return "null";
  const json = JSON.stringify(value);
  if (json === undefined) return "null";
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\\\u2028")
    .replace(/\u2029/g, "\\\\u2029");
}

export function escapeClass(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…(+${text.length - maxChars} chars)`;
}

export function formatTime(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    return String(ms);
  }
}
