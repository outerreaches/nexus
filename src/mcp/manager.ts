import { Semaphore } from "../core/semaphore.js";
import type { Tool } from "../core/tools.js";
import { parseSecretReference, resolveSecretReference, revokeSecretLease } from "../secrets/provider.js";
import type { NexusDatabase } from "../storage/database.js";
import {
  appendMcpEvent,
  expireMcpGrant,
  getMcpGrant,
  getMcpServer,
  incrementMcpGrantCallCount,
  listMcpProfiles,
  listMcpServers,
  setMcpServerDiscoveredTools,
  setMcpServerError,
  touchMcpProfileUsed,
  touchMcpServerUsed,
  type McpServerRecord,
} from "./store.js";
import { McpStdioClient, type McpToolCallResult, type McpToolInfo } from "./stdio-client.js";

type ConnectedServer = {
  server: McpServerRecord;
  client: McpStdioClient;
  semaphore: Semaphore;
  discoveredTools: McpToolInfo[];
  lastActivatedAt: number;
};

type ManagedToolRecord = {
  localName: string;
  serverId: string;
  remoteName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const MCP_TOOL_PREFIX = "mcp";

function asError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

function normalizeSegment(segment: string): string {
  return segment.toLowerCase().replace(/[^a-z0-9._-]/g, "_");
}

function normalizeLocalToolName(serverId: string, remoteName: string): string {
  const serverPart = normalizeSegment(serverId);
  const toolPart = normalizeSegment(remoteName);
  return `${MCP_TOOL_PREFIX}.${serverPart}.${toolPart}`;
}

function safeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function formatToolResult(result: McpToolCallResult): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const textParts = content
    .filter((part) => part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string")
    .map((part) => String((part as any).text).trim())
    .filter(Boolean);
  if (textParts.length > 0 && result.isError !== true) {
    return textParts.join("\n\n");
  }
  const payload = {
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    ...(content.length > 0 ? { content } : {}),
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
  };
  const serialized = Object.keys(payload).length > 0
    ? JSON.stringify(payload, null, 2)
    : JSON.stringify(result, null, 2);
  if (result.isError === true) {
    return `ERROR: MCP tool call reported error\n${serialized}`;
  }
  return serialized;
}

export async function resolveMcpServerEnvSecrets(params: {
  db: NexusDatabase;
  stateDir: string;
  serverId: string;
  env: Record<string, string>;
  nowMs?: number;
}): Promise<Record<string, string>> {
  const rawEntries = Object.entries(params.env ?? {});
  if (rawEntries.length === 0) return {};

  const secretEntries = rawEntries.filter(([, value]) => parseSecretReference(value) !== null);
  if (secretEntries.length === 0) {
    return { ...params.env };
  }

  const stateDir = params.stateDir.trim();
  if (!stateDir) {
    throw new Error(`MCP server '${params.serverId}' cannot resolve secret references without stateDir`);
  }

  const nowMs = params.nowMs ?? Date.now();
  const resolvedEnv: Record<string, string> = { ...params.env };
  for (const [envKey, reference] of secretEntries) {
    try {
      const traceId = `mcp-env:${params.serverId}:${envKey}:${nowMs}`;
      const resolved = await resolveSecretReference({
        db: params.db,
        stateDir,
        reference,
        traceId,
        actor: `mcp_server:${params.serverId}:env:${envKey}`,
        nowMs,
      });
      resolvedEnv[envKey] = resolved.value;
      if (resolved.leaseId) {
        revokeSecretLease({
          db: params.db,
          leaseId: resolved.leaseId,
          nowMs: nowMs + 1,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`mcp_env_secret_resolution_failed:${params.serverId}:${envKey}:${message}`);
    }
  }
  return resolvedEnv;
}

export class McpManager {
  private readonly connected = new Map<string, ConnectedServer>();
  private managedTools: ManagedToolRecord[] = [];

  constructor(
    private readonly deps: {
      db: NexusDatabase;
      log: (line: string) => void;
      stateDir?: string;
    },
  ) {}

  async init(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    await this.disconnectAll();
    this.managedTools = [];
    const nowMs = Date.now();
    const activeServers = listMcpServers(this.deps.db, { includeDisabled: false }).filter((server) => server.active);
    for (const server of activeServers) {
      try {
        await this.connectServer(server, nowMs);
      } catch (err) {
        const error = asError(err);
        this.deps.log(`mcp: failed to activate ${server.id}: ${error.message}`);
        setMcpServerError(this.deps.db, server.id, error.message, nowMs);
      }
    }
  }

  async close(): Promise<void> {
    await this.disconnectAll();
  }

  listTools(): Tool[] {
    const tools: Tool[] = [];
    for (const record of this.managedTools) {
      tools.push({
        name: record.localName,
        description: record.description,
        jsonSchema: record.inputSchema,
        execute: async (args, _ctx) => this.executeTool(record.localName, safeObject(args)),
      });
    }
    return tools;
  }

  async activateServer(serverId: string): Promise<McpServerRecord> {
    const nowMs = Date.now();
    const server = getMcpServer(this.deps.db, serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}`);
    if (!server.enabled) throw new Error(`MCP server is disabled: ${serverId}`);
    const updated = this.updateServerFlags(serverId, { active: true }, nowMs);
    await this.reconnectServer(serverId);
    appendMcpEvent(this.deps.db, {
      serverId,
      kind: "server_activated",
      payload: { serverId },
      nowMs,
    });
    return updated;
  }

  async deactivateServer(serverId: string): Promise<McpServerRecord> {
    const nowMs = Date.now();
    const current = getMcpServer(this.deps.db, serverId);
    if (!current) throw new Error(`MCP server not found: ${serverId}`);
    await this.disconnectServer(serverId);
    const updated = this.updateServerFlags(serverId, { active: false }, nowMs);
    appendMcpEvent(this.deps.db, {
      serverId,
      kind: "server_deactivated",
      payload: { serverId },
      nowMs,
    });
    return updated;
  }

  async probeServer(serverId: string): Promise<{ server: McpServerRecord; tools: McpToolInfo[] }> {
    const nowMs = Date.now();
    const server = getMcpServer(this.deps.db, serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}`);
    const temporary = await this.connectTemporaryClient(server);
    try {
      const tools = await temporary.listTools();
      setMcpServerDiscoveredTools(this.deps.db, server.id, tools.map((t) => t.name), nowMs);
      setMcpServerError(this.deps.db, server.id, null, nowMs);
      appendMcpEvent(this.deps.db, {
        serverId: server.id,
        kind: "server_probed",
        payload: { toolCount: tools.length },
        nowMs,
      });
      const refreshed = getMcpServer(this.deps.db, serverId) ?? server;
      return { server: refreshed, tools };
    } catch (err) {
      const error = asError(err);
      setMcpServerError(this.deps.db, server.id, error.message, nowMs);
      throw error;
    } finally {
      await temporary.close();
    }
  }

  getToolNamesForServer(serverId: string): string[] {
    const connected = this.connected.get(serverId);
    if (connected) {
      return connected.discoveredTools.map((tool) => normalizeLocalToolName(serverId, tool.name));
    }
    const server = getMcpServer(this.deps.db, serverId);
    if (!server) return [];
    return server.lastDiscoveredTools.map((toolName) => normalizeLocalToolName(serverId, toolName));
  }

  getOverview(): {
    servers: Array<{
      id: string;
      label: string;
      enabled: boolean;
      active: boolean;
      connected: boolean;
      trustLevel: string;
      capabilityTags: string[];
      discoveredTools: number;
      lastError: string | null;
      lastErrorAt: number | null;
      lastUsedAt: number | null;
    }>;
    profiles: Array<{
      id: string;
      name: string;
      serverId: string;
      enabled: boolean;
      hidden: boolean;
      ephemeral: boolean;
      toolCount: number;
      updatedAt: number;
    }>;
  } {
    const servers = listMcpServers(this.deps.db, { includeDisabled: true }).map((server) => ({
      id: server.id,
      label: server.label,
      enabled: server.enabled,
      active: server.active,
      connected: this.connected.has(server.id),
      trustLevel: server.trustLevel,
      capabilityTags: server.capabilityTags,
      discoveredTools: server.lastDiscoveredTools.length,
      lastError: server.lastError,
      lastErrorAt: server.lastErrorAt,
      lastUsedAt: server.lastUsedAt,
    }));
    const profiles = listMcpProfiles(this.deps.db, { includeDisabled: true }).map((profile) => ({
      id: profile.id,
      name: profile.name,
      serverId: profile.serverId,
      enabled: profile.enabled,
      hidden: profile.hidden,
      ephemeral: profile.ephemeral,
      toolCount: profile.toolNames.length,
      updatedAt: profile.updatedAt,
    }));
    return { servers, profiles };
  }

  async executeTool(localToolName: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.managedTools.find((entry) => entry.localName === localToolName);
    if (!tool) return `ERROR: unknown MCP tool '${localToolName}'`;
    const connected = this.connected.get(tool.serverId);
    if (!connected) return `ERROR: MCP server '${tool.serverId}' is not active`;
    const nowMs = Date.now();
    try {
      const result = await connected.semaphore.withLock(async () => {
        return connected.client.callTool(tool.remoteName, args);
      });
      touchMcpServerUsed(this.deps.db, tool.serverId, nowMs);
      return formatToolResult(result);
    } catch (err) {
      const error = asError(err);
      setMcpServerError(this.deps.db, tool.serverId, error.message, nowMs);
      return `ERROR: MCP tool '${localToolName}' failed: ${error.message}`;
    }
  }

  touchProfileUsed(idOrName: string): void {
    touchMcpProfileUsed(this.deps.db, idOrName, Date.now());
  }

  listToolsForGrants(params: {
    grantIds: string[];
    presetName: string;
    runId: string | null;
  }): Tool[] {
    const uniqueGrantIds = Array.from(new Set(params.grantIds.map((id) => id.trim()).filter(Boolean)));
    const tools: Tool[] = [];
    const seen = new Set<string>();
    for (const grantId of uniqueGrantIds) {
      const grant = getMcpGrant(this.deps.db, grantId);
      if (!grant) {
        this.deps.log(`mcp: grant ${grantId} not found`);
        continue;
      }
      if (grant.status !== "active") {
        this.deps.log(`mcp: grant ${grantId} ignored (status=${grant.status})`);
        continue;
      }
      if (grant.expiresAt !== null && grant.expiresAt <= Date.now()) {
        expireMcpGrant(this.deps.db, grantId, Date.now());
        this.deps.log(`mcp: grant ${grantId} expired`);
        continue;
      }
      if (grant.targetPreset !== params.presetName) {
        this.deps.log(
          `mcp: grant ${grantId} ignored (target_preset=${grant.targetPreset}, preset=${params.presetName})`,
        );
        continue;
      }
      if (grant.runId && !params.runId) {
        this.deps.log(`mcp: grant ${grantId} ignored (requires bound run_id=${grant.runId})`);
        continue;
      }
      if (grant.runId && params.runId && grant.runId !== params.runId) {
        this.deps.log(
          `mcp: grant ${grantId} ignored (run_id=${grant.runId}, expected=${params.runId})`,
        );
        continue;
      }
      for (const localToolName of grant.toolNames) {
        if (seen.has(localToolName)) continue;
        const record = this.managedTools.find((entry) => entry.localName === localToolName);
        if (!record) continue;
        seen.add(localToolName);
        tools.push({
          name: localToolName,
          description: record.description,
          jsonSchema: record.inputSchema,
          execute: async (args, _ctx) => this.executeToolWithGrant({
            grantId,
            localToolName,
            args: safeObject(args),
            presetName: params.presetName,
            runId: params.runId,
          }),
        });
      }
    }
    return tools;
  }

  async executeToolWithGrant(params: {
    grantId: string;
    localToolName: string;
    args: Record<string, unknown>;
    presetName: string;
    runId: string | null;
  }): Promise<string> {
    const nowMs = Date.now();
    const grant = getMcpGrant(this.deps.db, params.grantId);
    if (!grant) return `ERROR: MCP grant '${params.grantId}' not found`;
    if (grant.status !== "active") return `ERROR: MCP grant '${params.grantId}' is ${grant.status}`;
    if (grant.expiresAt !== null && grant.expiresAt <= nowMs) {
      expireMcpGrant(this.deps.db, params.grantId, nowMs);
      return `ERROR: MCP grant '${params.grantId}' expired`;
    }
    if (grant.targetPreset !== params.presetName) {
      return `ERROR: MCP grant '${params.grantId}' does not allow preset '${params.presetName}'`;
    }
    if (grant.runId && !params.runId) {
      return `ERROR: MCP grant '${params.grantId}' requires a bound run`;
    }
    if (grant.runId && params.runId && grant.runId !== params.runId) {
      return `ERROR: MCP grant '${params.grantId}' is bound to another run`;
    }
    if (!grant.toolNames.includes(params.localToolName)) {
      return `ERROR: MCP grant '${params.grantId}' does not include tool '${params.localToolName}'`;
    }
    if (grant.maxCalls !== null && grant.callCount >= grant.maxCalls) {
      expireMcpGrant(this.deps.db, params.grantId, nowMs);
      return `ERROR: MCP grant '${params.grantId}' exceeded max calls`;
    }

    const updated = incrementMcpGrantCallCount(this.deps.db, params.grantId, nowMs);
    const result = await this.executeTool(params.localToolName, params.args);

    if (updated && updated.maxCalls !== null && updated.callCount >= updated.maxCalls) {
      expireMcpGrant(this.deps.db, params.grantId, Date.now());
    }

    return result;
  }

  private async reconnectServer(serverId: string): Promise<void> {
    await this.disconnectServer(serverId);
    const server = getMcpServer(this.deps.db, serverId);
    if (!server || !server.active || !server.enabled) {
      this.rebuildManagedTools();
      return;
    }
    await this.connectServer(server, Date.now());
  }

  private async connectServer(server: McpServerRecord, nowMs: number): Promise<void> {
    if (this.connected.has(server.id)) return;
    const client = await this.connectTemporaryClient(server);
    const tools = await client.listTools();
    const semaphore = new Semaphore(Math.max(1, server.maxConcurrency));
    this.connected.set(server.id, {
      server,
      client,
      semaphore,
      discoveredTools: tools,
      lastActivatedAt: nowMs,
    });
    setMcpServerDiscoveredTools(this.deps.db, server.id, tools.map((t) => t.name), nowMs);
    setMcpServerError(this.deps.db, server.id, null, nowMs);
    this.rebuildManagedTools();
  }

  private async connectTemporaryClient(server: McpServerRecord): Promise<McpStdioClient> {
    if (server.transport !== "stdio") {
      throw new Error(`Unsupported MCP transport '${server.transport}' for server '${server.id}'`);
    }
    if (!server.command) {
      throw new Error(`MCP server '${server.id}' is missing a command`);
    }
    const env = await resolveMcpServerEnvSecrets({
      db: this.deps.db,
      stateDir: this.deps.stateDir ?? "",
      serverId: server.id,
      env: server.env,
    });
    const client = new McpStdioClient({
      command: server.command,
      args: server.args,
      env,
      timeoutMs: server.timeoutMs,
      log: (line) => this.deps.log(`mcp[${server.id}] ${line}`),
    });
    await client.initialize();
    return client;
  }

  private rebuildManagedTools(): void {
    const next: ManagedToolRecord[] = [];
    for (const [serverId, connected] of this.connected.entries()) {
      for (const remote of connected.discoveredTools) {
        const localName = normalizeLocalToolName(serverId, remote.name);
        next.push({
          localName,
          serverId,
          remoteName: remote.name,
          description: remote.description?.trim() || `MCP tool '${remote.name}' from server '${serverId}'`,
          inputSchema: safeObject(remote.inputSchema),
        });
      }
    }
    this.managedTools = next.sort((a, b) => a.localName.localeCompare(b.localName));
  }

  private updateServerFlags(
    serverId: string,
    patch: { active?: boolean },
    nowMs: number,
  ): McpServerRecord {
    const active = patch.active;
    if (active !== undefined) {
      this.deps.db.db
        .prepare("UPDATE mcp_servers SET active = ?, updated_at = ? WHERE id = ?")
        .run(active ? 1 : 0, nowMs, serverId);
    }
    const updated = getMcpServer(this.deps.db, serverId);
    if (!updated) throw new Error(`MCP server not found: ${serverId}`);
    return updated;
  }

  private async disconnectServer(serverId: string): Promise<void> {
    const connected = this.connected.get(serverId);
    if (!connected) return;
    this.connected.delete(serverId);
    await connected.client.close();
    this.rebuildManagedTools();
  }

  private async disconnectAll(): Promise<void> {
    const ids = [...this.connected.keys()];
    for (const id of ids) {
      await this.disconnectServer(id);
    }
  }
}
