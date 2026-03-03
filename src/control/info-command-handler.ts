import type { AgentTracker } from "../core/agent-tracker.js";
import type { ProcessManager } from "../process/manager.js";
import type { NexusDatabase } from "../storage/database.js";
import { listNodes as listNodeRecords } from "../storage/nodes.js";
import { listFederationPeers, listFederationTasks } from "../storage/federation.js";
import { listMcpGrants, listMcpProfiles, listMcpServers } from "../mcp/store.js";
import {
  listBlackboard,
  listBlackboardScopes,
  listDataIntake,
  listJobs,
  listRunningJobRuns,
} from "../gateway/dashboard/queries.js";
import type { ParsedInfoCommand } from "./info-command.js";

type ToolLike = {
  name: string;
  description?: string;
};

export type InfoCommandHandlerDeps = {
  db?: NexusDatabase;
  processManager?: ProcessManager;
  agentTracker?: AgentTracker;
  listTools?: () => ToolLike[];
  mcp?: {
    getOverview: () => {
      servers: Array<{
        id: string;
        label: string;
        enabled: boolean;
        active: boolean;
        connected: boolean;
        trustLevel: string;
        discoveredTools: number;
        lastError: string | null;
      }>;
      profiles: Array<{
        id: string;
        name: string;
        serverId: string;
        enabled: boolean;
        hidden: boolean;
        ephemeral: boolean;
        toolCount: number;
      }>;
    };
  };
  nowMs?: () => number;
  federationEnabled?: boolean;
};

export async function executeInfoCommand(params: {
  command: ParsedInfoCommand;
  deps: InfoCommandHandlerDeps;
}): Promise<string> {
  const { command, deps } = params;
  if (command.rawLimit && command.limit === undefined) {
    return `ERROR: invalid limit "${command.rawLimit}". Use an integer between 1 and 100.`;
  }
  const limit = command.limit ?? 20;
  const nowMs = deps.nowMs ? deps.nowMs() : Date.now();

  switch (command.topic) {
    case "tools":
      return renderTools(limit, deps);
    case "nodes":
      return renderNodes(limit, deps);
    case "jobs":
      return renderJobs(limit, deps);
    case "intakes":
      return renderIntakes(limit, nowMs, deps);
    case "processes":
      return renderProcesses(limit, deps);
    case "mcp":
      return renderMcp(limit, deps);
    case "federation":
      return renderFederation(limit, deps);
    case "blackboard":
      return renderBlackboard(limit, deps);
    default:
      return "ERROR: unsupported info command.";
  }
}

function renderTools(limit: number, deps: InfoCommandHandlerDeps): string {
  if (!deps.listTools) return "ERROR: tool registry unavailable.";
  const tools = deps.listTools();
  const mcpCount = tools.filter((tool) => tool.name.startsWith("mcp.")).length;
  const lines = [
    `Tools: total=${tools.length} mcp=${mcpCount} non_mcp=${Math.max(0, tools.length - mcpCount)}`,
    `Showing up to ${limit}:`,
  ];
  for (const tool of tools.slice(0, limit)) {
    const desc = tool.description ? ` - ${truncate(tool.description, 96)}` : "";
    lines.push(`- ${tool.name}${desc}`);
  }
  if (tools.length === 0) lines.push("- none");
  return lines.join("\n");
}

function renderNodes(limit: number, deps: InfoCommandHandlerDeps): string {
  if (!deps.db) return "ERROR: node inventory unavailable (database not available).";
  const rows = listNodeRecords(deps.db, limit);
  const byStatus = new Map<string, number>();
  for (const row of rows) {
    byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
  }
  const statusSummary = [...byStatus.entries()].map(([status, count]) => `${status}=${count}`).join(" ");
  const lines = [
    `Nodes: count=${rows.length}${statusSummary ? ` ${statusSummary}` : ""}`,
    `Showing up to ${limit}:`,
  ];
  for (const row of rows) {
    lines.push(
      `- ${row.id} [${row.status}] backend=${row.backend} trust=${row.trustLevel} fw=${row.firewallMode} lastSeen=${formatTime(row.lastSeenAt)}`,
    );
  }
  if (rows.length === 0) lines.push("- none");
  return lines.join("\n");
}

function renderJobs(limit: number, deps: InfoCommandHandlerDeps): string {
  if (!deps.db) return "ERROR: job inventory unavailable (database not available).";
  const jobs = listJobs(deps.db, limit);
  const running = listRunningJobRuns(deps.db).slice(0, limit);
  const lines = [
    `Jobs: configured=${jobs.length} running=${running.length}`,
    "Configured jobs:",
  ];
  for (const job of jobs) {
    lines.push(
      `- ${job.id} name="${truncate(job.name, 48)}" enabled=${job.enabled === 1 ? "yes" : "no"} next=${formatTime(job.next_run_at)} failures=${job.consecutive_failures}`,
    );
  }
  if (jobs.length === 0) lines.push("- none");
  lines.push("Running job runs:");
  for (const run of running) {
    lines.push(`- ${run.id} job=${run.job_id} agent=${run.agent_id} started=${formatTime(run.started_at)} status=${run.status}`);
  }
  if (running.length === 0) lines.push("- none");
  return lines.join("\n");
}

function renderIntakes(limit: number, nowMs: number, deps: InfoCommandHandlerDeps): string {
  if (!deps.db) return "ERROR: intake inventory unavailable (database not available).";
  const intake = listDataIntake(deps.db, nowMs, limit, false);
  const sources = intake.sources.slice(0, limit);
  const rows = intake.rows.slice(0, limit);
  const lines = [
    `Intakes: sources=${sources.length} latest_rows=${rows.length}`,
    "Sources:",
  ];
  for (const source of sources) {
    lines.push(
      `- ${source.id} source=${source.source_id} enabled=${source.enabled === 1 ? "yes" : "no"} every=${Math.max(1, Math.floor(source.interval_ms / 60_000))}m lastRun=${formatTime(source.last_run_at)}${source.last_error ? ` error="${truncate(source.last_error, 60)}"` : ""}`,
    );
  }
  if (sources.length === 0) lines.push("- none");
  lines.push("Latest data by source:");
  for (const row of rows) {
    lines.push(`- ${row.source_id} subject="${truncate(row.subject, 44)}" collected=${formatTime(row.collected_at)}`);
  }
  if (rows.length === 0) lines.push("- none");
  return lines.join("\n");
}

function renderProcesses(limit: number, deps: InfoCommandHandlerDeps): string {
  if (!deps.processManager) return "ERROR: process inventory unavailable (process manager not available).";
  const processes = deps.processManager.list().slice(0, limit);
  const lines = [
    `Processes: count=${processes.length}`,
    `Showing up to ${limit}:`,
  ];
  for (const proc of processes) {
    lines.push(
      `- ${proc.id} [${proc.status}] pid=${proc.pid ?? "-"} started=${formatTime(proc.startedAt)} cmd="${truncate(proc.command, 64)}"`,
    );
  }
  if (processes.length === 0) lines.push("- none");
  return lines.join("\n");
}

function renderMcp(limit: number, deps: InfoCommandHandlerDeps): string {
  if (!deps.db) return "ERROR: MCP inventory unavailable (database not available).";
  const overview = deps.mcp
    ? deps.mcp.getOverview()
    : {
      servers: listMcpServers(deps.db, { includeDisabled: true }).map((server) => ({
        id: server.id,
        label: server.label,
        enabled: server.enabled,
        active: server.active,
        connected: false,
        trustLevel: server.trustLevel,
        discoveredTools: server.lastDiscoveredTools.length,
        lastError: server.lastError,
      })),
      profiles: listMcpProfiles(deps.db, { includeDisabled: true }).map((profile) => ({
        id: profile.id,
        name: profile.name,
        serverId: profile.serverId,
        enabled: profile.enabled,
        hidden: profile.hidden,
        ephemeral: profile.ephemeral,
        toolCount: profile.toolNames.length,
      })),
    };
  const activeGrants = listMcpGrants(deps.db, { includeExpired: false, includeRevoked: false }).filter((grant) => grant.status === "active");
  const lines = [
    `MCP: servers=${overview.servers.length} profiles=${overview.profiles.length} active_grants=${activeGrants.length}`,
    "Servers:",
  ];
  for (const server of overview.servers.slice(0, limit)) {
    lines.push(
      `- ${server.id} enabled=${server.enabled ? "yes" : "no"} active=${server.active ? "yes" : "no"} connected=${server.connected ? "yes" : "no"} tools=${server.discoveredTools}${server.lastError ? ` error="${truncate(server.lastError, 52)}"` : ""}`,
    );
  }
  if (overview.servers.length === 0) lines.push("- none");
  lines.push("Profiles:");
  for (const profile of overview.profiles.slice(0, limit)) {
    lines.push(
      `- ${profile.id} name="${truncate(profile.name, 32)}" server=${profile.serverId} enabled=${profile.enabled ? "yes" : "no"} tools=${profile.toolCount}`,
    );
  }
  if (overview.profiles.length === 0) lines.push("- none");
  return lines.join("\n");
}

function renderFederation(limit: number, deps: InfoCommandHandlerDeps): string {
  if (!deps.db) return "ERROR: federation inventory unavailable (database not available).";
  const peers = listFederationPeers(deps.db, limit);
  const tasks = listFederationTasks(deps.db, limit);
  const trusted = peers.filter((peer) => peer.trustState === "trusted").length;
  const healthyTrusted = peers.filter((peer) => peer.trustState === "trusted" && peer.enabled).length;
  const statusText = deps.federationEnabled === undefined ? "unknown" : deps.federationEnabled ? "enabled" : "disabled";
  const lines = [
    `Federation: ${statusText} peers=${peers.length} trusted=${trusted} trusted_enabled=${healthyTrusted} tasks=${tasks.length}`,
    "Peers:",
  ];
  for (const peer of peers.slice(0, limit)) {
    lines.push(`- ${peer.id} trust=${peer.trustState} enabled=${peer.enabled ? "yes" : "no"} endpoint=${truncate(peer.endpoint, 56)}`);
  }
  if (peers.length === 0) lines.push("- none");
  lines.push("Tasks:");
  for (const task of tasks.slice(0, limit)) {
    lines.push(`- ${task.id} peer=${task.peerId} status=${task.status} method=${task.method} updated=${formatTime(task.updatedAt)}`);
  }
  if (tasks.length === 0) lines.push("- none");
  return lines.join("\n");
}

function renderBlackboard(limit: number, deps: InfoCommandHandlerDeps): string {
  if (!deps.db) return "ERROR: blackboard inventory unavailable (database not available).";
  const entries = listBlackboard(deps.db, limit, null);
  const scopes = listBlackboardScopes(deps.db, limit);
  const lines = [
    `Blackboard: entries=${entries.length} scopes=${scopes.length}`,
    `Scopes: ${scopes.length > 0 ? scopes.join(", ") : "-"}`,
    `Showing up to ${limit} entries:`,
  ];
  for (const entry of entries) {
    lines.push(
      `- ${entry.id} scope=${entry.session_scope} type=${entry.type} title="${truncate(entry.title, 40)}" created=${formatTime(entry.created_at)} expires=${formatTime(entry.expires_at)}`,
    );
  }
  if (entries.length === 0) lines.push("- none");
  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return `${value.slice(0, max - 3)}...`;
}

function formatTime(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return "-";
  return new Date(value).toISOString();
}
