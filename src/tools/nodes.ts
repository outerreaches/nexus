import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { defineTool, type Tool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";
import { deleteNodeCascadeById, getNodeById, listNodes, setNodeStatus } from "../storage/nodes.js";
import type { NodeDrainResult } from "../nodes/types.js";

function requireDb(ctx: { db?: unknown }): NexusDatabase | null {
  const db = ctx.db as NexusDatabase | undefined;
  return db ?? null;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
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

function extractBase64Payload(value: string): { base64: string; mimeType: string | null } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    const mimeType = match[1]?.trim() ?? null;
    const base64 = match[2] ?? "";
    return { base64, mimeType: mimeType && mimeType.length > 0 ? mimeType : null };
  }
  return { base64: trimmed, mimeType: null };
}

function decodeBase64Loose(value: string): Buffer | null {
  const normalized = value.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized) return null;
  if (/[^A-Za-z0-9+/=]/.test(normalized)) return null;
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Buffer.from(padded, "base64");
  } catch {
    return null;
  }
}

function guessExtensionFromMimeType(mimeType: string | null): string {
  switch ((mimeType ?? "").toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

function sanitizePathSegment(value: string, maxLen: number = 80): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_");
  const trimmed = normalized.replace(/^_+|_+$/g, "");
  const collapsed = trimmed.length > 0 ? trimmed : "artifact";
  return collapsed.length > maxLen ? collapsed.slice(0, maxLen) : collapsed;
}

async function persistGatewayArtifact(params: {
  ctx: { stateDir: string };
  nodeId: string;
  serverId: string;
  toolName: string;
  mimeType: string | null;
  bytes: Buffer;
  nameHint?: string | null;
}): Promise<{ path: string; sizeBytes: number; sha256: string; mimeType: string }> {
  const sha256 = createHash("sha256").update(params.bytes).digest("hex");
  const ext = guessExtensionFromMimeType(params.mimeType);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const hint = sanitizePathSegment(params.nameHint ?? params.toolName);
  const dir = path.resolve(params.ctx.stateDir, "mcp-artifacts", "nodes", params.nodeId, params.serverId);
  await fs.mkdir(dir, { recursive: true });
  const fullPath = path.join(dir, `${stamp}-${hint}-${sha256.slice(0, 12)}.${ext}`);
  await fs.writeFile(fullPath, params.bytes, { mode: 0o600 });
  return {
    path: fullPath,
    sizeBytes: params.bytes.length,
    sha256: `sha256:${sha256}`,
    mimeType: params.mimeType ?? "application/octet-stream",
  };
}

function hermesNonTextFilteringEnabled(): boolean {
  // Default-on: disable only when explicitly set to 0/false/off.
  const raw = (process.env.NEXUS_MCP_FILTER_NON_TEXT ?? "").trim().toLowerCase();
  if (!raw) return true;
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  return true;
}

const nodeSymbolsListRoutingTool: Tool = {
  name: "node_symbols_list",
  description: "Internal routing shim for symbols.list dispatch.",
  jsonSchema: {},
  execute: async () => "ERROR: node_symbols_list should be routed via node transport.",
};

const nodeAuditQueryRoutingTool: Tool = {
  name: "node_audit_query",
  description: "Internal routing shim for audit.query dispatch.",
  jsonSchema: {},
  execute: async () => "ERROR: node_audit_query should be routed via node transport.",
};

const nodeMcpListRoutingTool: Tool = {
  name: "node_mcp_list",
  description: "Internal routing shim for mcp.list dispatch.",
  jsonSchema: {},
  execute: async () => "ERROR: node_mcp_list should be routed via node transport.",
};

const nodeMcpCallRoutingTool: Tool = {
  name: "node_mcp_call",
  description: "Internal routing shim for mcp.call dispatch.",
  jsonSchema: {},
  execute: async () => "ERROR: node_mcp_call should be routed via node transport.",
};

const nodeMcpResourcesRoutingTool: Tool = {
  name: "node_mcp_resources",
  description: "Internal routing shim for mcp.resources dispatch.",
  jsonSchema: {},
  execute: async () => "ERROR: node_mcp_resources should be routed via node transport.",
};

const nodeFilePullRoutingTool: Tool = {
  name: "node_file_pull",
  description: "Internal routing shim for file.pull dispatch.",
  jsonSchema: {},
  execute: async () => "ERROR: node_file_pull should be routed via node transport.",
};

const nodeFilePushRoutingTool: Tool = {
  name: "node_file_push",
  description: "Internal routing shim for file.push dispatch.",
  jsonSchema: {},
  execute: async () => "ERROR: node_file_push should be routed via node transport.",
};

const nodeSystemRunRoutingTool: Tool = {
  name: "shell_exec",
  description: "Internal routing shim for system.run dispatch.",
  jsonSchema: {},
  execute: async () => "ERROR: node_system_run should be routed via node transport.",
};

const nodeSystemWhichRoutingTool: Tool = {
  name: "system.which",
  description: "Internal routing shim for system.which dispatch.",
  jsonSchema: {},
  execute: async () => "ERROR: node_system_which should be routed via node transport.",
};

const nodeProcessStartRoutingTool: Tool = {
  name: "process_start",
  description: "Internal routing shim for process.start dispatch.",
  jsonSchema: {},
  execute: async () => "ERROR: node_process_start should be routed via node transport.",
};

const nodeProcessStatusRoutingTool: Tool = {
  name: "process_status",
  description: "Internal routing shim for process.status dispatch.",
  jsonSchema: {},
  execute: async () => "ERROR: node_process_status should be routed via node transport.",
};

const nodeProcessLogsRoutingTool: Tool = {
  name: "process_logs",
  description: "Internal routing shim for process.logs dispatch.",
  jsonSchema: {},
  execute: async () => "ERROR: node_process_logs should be routed via node transport.",
};

const nodeProcessStopRoutingTool: Tool = {
  name: "process_stop",
  description: "Internal routing shim for process.cancel dispatch.",
  jsonSchema: {},
  execute: async () => "ERROR: node_process_stop should be routed via node transport.",
};

const remoteSecuritySchema = z
  .object({
    requireNexusBackend: z.boolean().optional(),
    requireHermesMode: z.boolean().optional(),
  })
  .optional();

export const nodeList = defineTool({
  name: "node_list",
  description: "List registered execution nodes with backend, status, capabilities, and firewall mode.",
  parameters: z.object({
    limit: z.number().int().min(1).max(500).default(200),
    status: z.enum(["pending", "approved", "blocked", "offline", "online", "draining"]).optional(),
    backend: z.enum(["nexus", "openclaw"]).optional(),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    let rows = listNodes(db, args.limit);
    if (args.status) rows = rows.filter((node) => node.status === args.status);
    if (args.backend) rows = rows.filter((node) => node.backend === args.backend);
    return JSON.stringify(
      {
        count: rows.length,
        nodes: rows,
      },
      null,
      2,
    );
  },
});

export const nodeGet = defineTool({
  name: "node_get",
  description: "Get detailed information for a registered node.",
  parameters: z.object({
    id: z.string().min(1).max(128),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = getNodeById(db, args.id);
    if (!row) return "ERROR: node not found";
    return JSON.stringify(row);
  },
});

export const nodeDelete = defineTool({
  name: "node_delete",
  description: "Unregister a node and revoke its pairing from the gateway registry.",
  parameters: z.object({
    id: z.string().min(1).max(128),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const result = deleteNodeCascadeById(db, args.id);
    if (!result.deleted) return "ERROR: node not found";
    return JSON.stringify({ ok: true, ...result });
  },
});

export const nodeSetStatus = defineTool({
  name: "node_set_status",
  description:
    "Set node approval/lifecycle status. Use status=approved to allow pending nodes to connect, or blocked to revoke access.",
  parameters: z.object({
    id: z.string().min(1).max(128),
    status: z.enum(["pending", "approved", "blocked", "offline", "online", "draining"]),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = getNodeById(db, args.id);
    if (!row) return "ERROR: node not found";

    const nowMs = ctx.nowMs();
    const connectedAt =
      args.status === "blocked" || args.status === "pending"
        ? null
        : args.status === "offline"
          ? null
          : row.connectedAt;
    setNodeStatus(db, {
      id: args.id,
      status: args.status,
      connectedAt,
      nowMs,
    });
    const updated = getNodeById(db, args.id);
    return JSON.stringify(
      {
        ok: true,
        node: updated,
      },
      null,
      2,
    );
  },
});

export const nodeDrain = defineTool({
  name: "node_drain",
  description:
    "Mark a node as draining ahead of a code update/restart. The gateway stops routing new work to a draining node; in-flight work continues. Undrain (or a reconnect after restart) returns it to service.",
  parameters: z.object({
    id: z.string().min(1).max(128),
    deadlineMs: z
      .number()
      .int()
      .min(0)
      .max(600_000)
      .optional()
      .describe("Max time to wait for in-flight work to finish before reporting drain status (default 60s)."),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = getNodeById(db, args.id);
    if (!row) return "ERROR: node not found";
    if (row.status === "pending" || row.status === "blocked") {
      return `ERROR: node ${row.id} is ${row.status}; only an approved/online node can be drained.`;
    }
    // Gateway-enforced stop: flip status so the router stops routing new work.
    // Preserve connectedAt so undrain can tell whether a live session exists.
    setNodeStatus(db, { id: row.id, status: "draining", connectedAt: row.connectedAt, nowMs: ctx.nowMs() });
    const updated = getNodeById(db, row.id);

    // Best-effort handshake: ask the node (or gateway pending-count fallback)
    // whether in-flight work has finished, so we can tell the operator if it's
    // safe to restart.
    let drain: NodeDrainResult | null = null;
    let drainHandshakeError: string | null = null;
    if (ctx.nodeRouter?.awaitNodeDrained) {
      try {
        drain = await ctx.nodeRouter.awaitNodeDrained(
          row.id,
          args.deadlineMs !== undefined ? { deadlineMs: args.deadlineMs } : undefined,
        );
      } catch (err) {
        drainHandshakeError = err instanceof Error ? err.message : String(err);
      }
    }

    const note = drain
      ? drain.drained
        ? "Drained: no in-flight work remains. Safe to restart the node now."
        : `Draining: ${drain.remaining} item(s) still in flight at the deadline. Wait and re-run drain, or restart anyway (in-flight work will be interrupted and reported as failed).`
      : "Node marked draining (the gateway will stop routing new work). Drain handshake unavailable; confirm in-flight work is done before restarting.";

    return JSON.stringify(
      {
        ok: true,
        node: updated,
        drained: drain ? drain.drained : false,
        ...(drain ? { remaining: drain.remaining, nodeAcked: drain.nodeAcked } : {}),
        ...(drainHandshakeError ? { drainHandshakeError } : {}),
        note,
      },
      null,
      2,
    );
  },
});

export const nodeUndrain = defineTool({
  name: "node_undrain",
  description:
    "Cancel a drain and return a node to service. Only valid for a node in 'draining' status.",
  parameters: z.object({
    id: z.string().min(1).max(128),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = getNodeById(db, args.id);
    if (!row) return "ERROR: node not found";
    if (row.status !== "draining") {
      return `ERROR: node ${row.id} is ${row.status}, not draining; nothing to undrain.`;
    }
    // If a live session is still attached (connectedAt set), restore online;
    // otherwise fall back to approved and let the next connect flip it online.
    const nextStatus = row.connectedAt ? "online" : "approved";
    setNodeStatus(db, { id: row.id, status: nextStatus, connectedAt: row.connectedAt, nowMs: ctx.nowMs() });
    const updated = getNodeById(db, row.id);
    return JSON.stringify({ ok: true, node: updated }, null, 2);
  },
});

export const nodeUpdate = defineTool({
  name: "node_update",
  description:
    "Coordinated node code update: drain the node, send node.update (default strategy 'local'), wait for it to restart and reconnect, then verify it is online. The node must opt in (NEXUS_NODE_ALLOW_UPDATE) and advertise update.<strategy>.",
  parameters: z.object({
    id: z.string().min(1).max(128),
    strategy: z.string().min(1).max(40).optional().describe("Update strategy (default 'local')."),
    ref: z.string().min(1).max(200).optional().describe("Optional git ref/version for the update."),
    deadlineMs: z
      .number()
      .int()
      .min(10_000)
      .max(600_000)
      .optional()
      .describe("Max time to wait for the node to restart and reconnect (default 180s)."),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = getNodeById(db, args.id);
    if (!row) return "ERROR: node not found";
    if (!ctx.nodeRouter?.updateNode) {
      return "ERROR: coordinated update transport is not available on this gateway";
    }
    // Stop routing new work for the duration of the update (gateway-enforced).
    setNodeStatus(db, { id: row.id, status: "draining", connectedAt: row.connectedAt, nowMs: ctx.nowMs() });
    let result;
    try {
      result = await ctx.nodeRouter.updateNode(row.id, {
        ...(args.strategy ? { strategy: args.strategy } : {}),
        ...(args.ref ? { ref: args.ref } : {}),
        ...(args.deadlineMs !== undefined ? { deadlineMs: args.deadlineMs } : {}),
      });
    } catch (err) {
      // Update transport failed outright; the node may need manual recovery.
      return JSON.stringify(
        { ok: false, stage: "update", error: err instanceof Error ? err.message : String(err), node: getNodeById(db, row.id) },
        null,
        2,
      );
    }
    // On success the node already reconnected online (prove flow restored status).
    // On failure leave the current status for the operator to investigate/undrain.
    return JSON.stringify({ ...result, node: getNodeById(db, row.id) }, null, 2);
  },
});

export const nodeSymbolsList = defineTool({
  name: "node_symbols_list",
  description:
    "Fetch a node-local Hermes symbols catalog (kinds/keys/fields only; no values) via protocol method symbols.list.",
  parameters: z.object({
    id: z.string().min(1).max(128),
    kind: z.enum(["contact", "account", "secret", "user"]).optional(),
    includeFields: z.boolean().default(true),
    preferCache: z.boolean().default(false),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = getNodeById(db, args.id);
    if (!row) return "ERROR: node not found";
    if (row.backend !== "nexus") return `ERROR: node backend ${row.backend} does not support symbols.list`;
    if (!ctx.nodeRouter) return "ERROR: node routing transport is not available";
    const cachedCatalog = asObject(row.metadata.symbolCatalogCache);
    if (args.preferCache && Object.keys(cachedCatalog).length > 0) {
      return JSON.stringify(
        {
          ok: true,
          source: "cache",
          nodeId: args.id,
          ...cachedCatalog,
        },
        null,
        2,
      );
    }

    try {
      return await ctx.nodeRouter.routeToolExecution(
        nodeSymbolsListRoutingTool,
        {
          id: args.id,
          ...(args.kind ? { kind: args.kind } : {}),
          includeFields: args.includeFields,
        },
        {
          ...ctx,
          executionNode: args.id,
          executionMode: "remote",
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (Object.keys(cachedCatalog).length > 0) {
        return JSON.stringify(
          {
            ok: true,
            source: "cache",
            stale: true,
            nodeId: args.id,
            warning: `Remote symbols.list failed; returning cached catalog: ${message}`,
            ...cachedCatalog,
          },
          null,
          2,
        );
      }
      if (message.includes("does not advertise tool capability symbols.list")) {
        return `ERROR: ${message} (hint: restart the node with symbols.list in NEXUS_NODE_CAPS, or use preferCache=true if catalog metadata was previously cached)`;
      }
      return `ERROR: ${message}`;
    }
  },
});

export const nodeAuditQuery = defineTool({
  name: "node_audit_query",
  description:
    "Query append-only node-local audit events via protocol method audit.query with optional filters and pagination.",
  parameters: z.object({
    id: z.string().min(1).max(128),
    limit: z.number().int().min(1).max(500).default(100),
    cursorCreatedAt: z.number().int().optional(),
    type: z.string().min(1).max(128).optional(),
    processId: z.string().min(1).max(128).optional(),
    firewallSession: z.string().min(1).max(256).optional(),
    actor: z.string().min(1).max(256).optional(),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = getNodeById(db, args.id);
    if (!row) return "ERROR: node not found";
    if (row.backend !== "nexus") return `ERROR: node backend ${row.backend} does not support audit.query`;
    if (!ctx.nodeRouter) return "ERROR: node routing transport is not available";

    try {
      return await ctx.nodeRouter.routeToolExecution(
        nodeAuditQueryRoutingTool,
        {
          id: args.id,
          limit: args.limit,
          ...(args.cursorCreatedAt !== undefined ? { cursorCreatedAt: args.cursorCreatedAt } : {}),
          ...(args.type ? { type: args.type } : {}),
          ...(args.processId ? { processId: args.processId } : {}),
          ...(args.firewallSession ? { firewallSession: args.firewallSession } : {}),
          ...(args.actor ? { actor: args.actor } : {}),
        },
        {
          ...ctx,
          executionNode: args.id,
          executionMode: "remote",
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: ${message}`;
    }
  },
});

export const nodeMcpList = defineTool({
  name: "node_mcp_list",
  description:
    "List per-node MCP bridge servers and allowlisted tools/resources via protocol method mcp.list. By default returns tool names and descriptions without full JSON schemas; use includeSchemas=true (optionally with toolName filter) to fetch full inputSchema for constructing node_mcp_call arguments.",
  parameters: z.object({
    id: z.string().min(1).max(128),
    serverId: z.string().min(1).max(128).optional(),
    toolName: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("Filter to a specific tool by name. Requires includeTools=true."),
    includeTools: z.boolean().default(true),
    includeSchemas: z
      .boolean()
      .default(false)
      .describe(
        "Include full inputSchema for each tool. Default false for lightweight discovery; set true (with optional serverId/toolName filter) when you need argument details for node_mcp_call.",
      ),
    includeResources: z.boolean().default(false),
    security: remoteSecuritySchema,
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = getNodeById(db, args.id);
    if (!row) return "ERROR: node not found";
    if (row.backend !== "nexus") return `ERROR: node backend ${row.backend} does not support MCP bridge`;
    if (!ctx.nodeRouter) return "ERROR: node routing transport is not available";
    try {
      const raw = await ctx.nodeRouter.routeToolExecution(
        nodeMcpListRoutingTool,
        {
          ...(args.serverId ? { serverId: args.serverId } : {}),
          includeTools: args.includeTools,
          includeResources: args.includeResources,
          ...(args.security ? { security: args.security } : {}),
        },
        {
          ...ctx,
          executionNode: args.id,
          executionMode: "remote",
        },
      );

      // Post-process: strip schemas and/or filter by toolName
      if (args.includeTools && (!args.includeSchemas || args.toolName)) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const obj = parsed as Record<string, unknown>;
            const changed = stripMcpListSchemas(obj, !args.includeSchemas, args.toolName);
            if (changed) return JSON.stringify(obj);
          }
        } catch {
          // Parse failed — return raw response as-is
        }
      }
      return raw;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: ${message}`;
    }
  },
});

/**
 * Walk an mcp.list response and optionally strip inputSchema from tools
 * and/or filter to a specific toolName. Returns true if any mutation occurred.
 */
function stripMcpListSchemas(
  obj: Record<string, unknown>,
  removeSchemas: boolean,
  toolName?: string,
): boolean {
  let changed = false;

  // Response may have top-level `servers` array or `tools` array depending on format
  const containers: unknown[] = [];

  // Case 1: { servers: [{ tools: [...] }] }
  if (Array.isArray(obj.servers)) {
    for (const server of obj.servers) {
      const s = server && typeof server === "object" && !Array.isArray(server) ? server : null;
      if (s && Array.isArray((s as Record<string, unknown>).tools)) {
        containers.push(s);
      }
    }
  }

  // Case 2: { tools: [...] } (single-server response)
  if (Array.isArray(obj.tools)) {
    containers.push(obj);
  }

  // Case 3: { result: { servers: [...] } } or { result: { tools: [...] } }
  const result = obj.result && typeof obj.result === "object" && !Array.isArray(obj.result)
    ? (obj.result as Record<string, unknown>)
    : null;
  if (result) {
    if (Array.isArray(result.servers)) {
      for (const server of result.servers) {
        const s = server && typeof server === "object" && !Array.isArray(server) ? server : null;
        if (s && Array.isArray((s as Record<string, unknown>).tools)) {
          containers.push(s);
        }
      }
    }
    if (Array.isArray(result.tools)) {
      containers.push(result);
    }
  }

  for (const container of containers) {
    const c = container as Record<string, unknown>;
    let tools = c.tools as Array<Record<string, unknown>>;

    if (toolName) {
      const filtered = tools.filter(
        (t) => typeof t.name === "string" && t.name === toolName,
      );
      if (filtered.length !== tools.length) {
        c.tools = filtered;
        tools = filtered;
        changed = true;
      }
    }

    if (removeSchemas) {
      for (const tool of tools) {
        if ("inputSchema" in tool) {
          delete tool.inputSchema;
          changed = true;
        }
      }
    }
  }

  return changed;
}

export const nodeMcpCall = defineTool({
  name: "node_mcp_call",
  description:
    "Invoke an allowlisted MCP tool on a specific node via mcp.call. Non-text payloads (e.g., screenshots) are persisted as gateway-local files by default to avoid context bloat; set NEXUS_MCP_FILTER_NON_TEXT=0 to disable.",
  parameters: z.object({
    id: z.string().min(1).max(128),
    serverId: z.string().min(1).max(128),
    tool: z.string().min(1).max(256),
    arguments: z.record(z.unknown()).default({}),
    timeoutMs: z.number().int().positive().max(300_000).default(60_000),
    security: remoteSecuritySchema,
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = getNodeById(db, args.id);
    if (!row) return "ERROR: node not found";
    if (row.backend !== "nexus") return `ERROR: node backend ${row.backend} does not support MCP bridge`;
    if (!ctx.nodeRouter) return "ERROR: node routing transport is not available";
    try {
      const raw = await ctx.nodeRouter.routeToolExecution(
        nodeMcpCallRoutingTool,
        {
          serverId: args.serverId,
          tool: args.tool,
          arguments: asObject(args.arguments),
          timeoutMs: args.timeoutMs,
          ...(args.security ? { security: args.security } : {}),
        },
        {
          ...ctx,
          executionNode: args.id,
          executionMode: "remote",
        },
      );
      // Default behavior: sanitize non-text payloads to avoid context bloat and prevent
      // binary data from landing in transcripts. Set NEXUS_MCP_FILTER_NON_TEXT=0 to disable.
      if (!hermesNonTextFilteringEnabled()) return raw;

      const parsed = parseJsonObject(raw);
      if (!parsed) return raw;
      const resultObj = asObject(parsed.result);
      const contentRaw = resultObj.content;
      if (!Array.isArray(contentRaw) || contentRaw.length === 0) return raw;

      const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
      const callArgs = asObject(args.arguments);
      const nameHint = typeof callArgs.name === "string" ? callArgs.name : args.tool;
      const savedFiles: Array<Record<string, unknown>> = [];
      const nextContent: Array<Record<string, unknown>> = [];
      let changed = false;

      for (const part of contentRaw) {
        const obj = asObject(part);
        const type = typeof obj.type === "string" ? obj.type : null;
        if (type !== "image") {
          nextContent.push(obj);
          continue;
        }
        const dataRaw = typeof obj.data === "string" ? obj.data : null;
        if (!dataRaw) {
          nextContent.push(obj);
          continue;
        }
        const extracted = extractBase64Payload(dataRaw);
        if (!extracted) {
          nextContent.push({ ...obj, data: undefined, error: "empty_image_payload" });
          changed = true;
          continue;
        }
        const mimeTypeFromPart = typeof obj.mimeType === "string" ? obj.mimeType : null;
        const mimeType = mimeTypeFromPart ?? extracted.mimeType;
        const bytes = decodeBase64Loose(extracted.base64);
        if (!bytes) {
          nextContent.push({ type: "image", mimeType: mimeType ?? "application/octet-stream", error: "invalid_base64" });
          changed = true;
          continue;
        }
        if (bytes.length > MAX_ARTIFACT_BYTES) {
          nextContent.push({
            type: "image",
            mimeType: mimeType ?? "application/octet-stream",
            error: `artifact_too_large (${bytes.length} bytes)`,
          });
          changed = true;
          continue;
        }
        const saved = await persistGatewayArtifact({
          ctx,
          nodeId: args.id,
          serverId: args.serverId,
          toolName: args.tool,
          mimeType,
          bytes,
          nameHint,
        });
        savedFiles.push(saved);
        nextContent.push({
          type: "image",
          mimeType: saved.mimeType,
          savedPath: saved.path,
          sizeBytes: saved.sizeBytes,
          sha256: saved.sha256,
        });
        changed = true;
      }

      if (!changed) return raw;
      return JSON.stringify(
        {
          ...parsed,
          savedFiles,
          result: {
            ...resultObj,
            content: nextContent,
          },
        },
        null,
        2,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: ${message}`;
    }
  },
});

export const nodeMcpResources = defineTool({
  name: "node_mcp_resources",
  description:
    "List or read allowlisted MCP resources on a specific node via mcp.resources. Blob payloads are persisted as gateway-local files by default to avoid context bloat; set NEXUS_MCP_FILTER_NON_TEXT=0 to disable.",
  parameters: z.object({
    id: z.string().min(1).max(128),
    serverId: z.string().min(1).max(128),
    action: z.enum(["list", "read"]).default("list"),
    uri: z.string().max(2048).optional(),
    cursor: z.string().max(512).optional(),
    limit: z.number().int().min(1).max(500).default(200),
    timeoutMs: z.number().int().positive().max(300_000).default(60_000),
    security: remoteSecuritySchema,
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = getNodeById(db, args.id);
    if (!row) return "ERROR: node not found";
    if (row.backend !== "nexus") return `ERROR: node backend ${row.backend} does not support MCP bridge`;
    if (!ctx.nodeRouter) return "ERROR: node routing transport is not available";
    if (args.action === "read" && !args.uri) {
      return "ERROR: node_mcp_resources with action=read requires `uri`";
    }
    try {
      const raw = await ctx.nodeRouter.routeToolExecution(
        nodeMcpResourcesRoutingTool,
        {
          serverId: args.serverId,
          action: args.action,
          ...(args.uri ? { uri: args.uri } : {}),
          ...(args.cursor ? { cursor: args.cursor } : {}),
          limit: args.limit,
          timeoutMs: args.timeoutMs,
          ...(args.security ? { security: args.security } : {}),
        },
        {
          ...ctx,
          executionNode: args.id,
          executionMode: "remote",
        },
      );
      if (args.action !== "read") return raw;
      if (!hermesNonTextFilteringEnabled()) return raw;

      const parsed = parseJsonObject(raw);
      if (!parsed) return raw;
      const resultObj = asObject(parsed.result);
      const contentsRaw = resultObj.contents;
      if (!Array.isArray(contentsRaw) || contentsRaw.length === 0) return raw;

      const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
      const savedFiles: Array<Record<string, unknown>> = [];
      const nextContents: Array<Record<string, unknown>> = [];
      let changed = false;
      for (const item of contentsRaw) {
        const obj = asObject(item);
        const blobRaw = typeof obj.blob === "string" ? obj.blob : null;
        if (!blobRaw) {
          nextContents.push(obj);
          continue;
        }
        const mimeType = typeof obj.mimeType === "string" ? obj.mimeType : null;
        const extracted = extractBase64Payload(blobRaw);
        if (!extracted) {
          nextContents.push({ ...obj, blob: undefined, error: "empty_blob" });
          changed = true;
          continue;
        }
        const bytes = decodeBase64Loose(extracted.base64);
        if (!bytes) {
          nextContents.push({ ...obj, blob: undefined, error: "invalid_base64" });
          changed = true;
          continue;
        }
        if (bytes.length > MAX_ARTIFACT_BYTES) {
          nextContents.push({ ...obj, blob: undefined, error: `artifact_too_large (${bytes.length} bytes)` });
          changed = true;
          continue;
        }
        const uriHint = typeof obj.uri === "string" ? obj.uri : args.uri ?? "resource";
        const saved = await persistGatewayArtifact({
          ctx,
          nodeId: args.id,
          serverId: args.serverId,
          toolName: "mcp.resources.read",
          mimeType: mimeType ?? extracted.mimeType,
          bytes,
          nameHint: uriHint,
        });
        savedFiles.push(saved);
        nextContents.push({
          ...obj,
          blob: undefined,
          savedPath: saved.path,
          sizeBytes: saved.sizeBytes,
          sha256: saved.sha256,
        });
        changed = true;
      }

      if (!changed) return raw;
      return JSON.stringify(
        {
          ...parsed,
          savedFiles,
          result: {
            ...resultObj,
            contents: nextContents,
          },
        },
        null,
        2,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: ${message}`;
    }
  },
});

export const nodeFilePull = defineTool({
  name: "node_file_pull",
  description:
    "Pull a small file from a node (file.pull) and save it locally on the gateway. Requires node allowlist `file_pull`; may be denied by Hermes `denyCommands` in `firewallMode=hermes`. Returns JSON with the saved `localPath` + `sha256`.",
  parameters: z.object({
    id: z.string().min(1).max(128).describe("Target node id."),
    remotePath: z
      .string()
      .min(1)
      .max(4096)
      .describe("Absolute path on node. Must be within node `NEXUS_NODE_FILE_TRANSFER_ROOTS`."),
    localPath: z
      .string()
      .max(4096)
      .optional()
      .describe(
        "Absolute gateway path to save. Must be within gateway roots (stateDir/workspace/code). If omitted, auto-saves under stateDir/node-transfers/<nodeId>/.",
      ),
    overwrite: z.boolean().default(false).describe("If false, fail when destination exists."),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(50 * 1024 * 1024)
      .default(5 * 1024 * 1024)
      .describe("Max bytes to accept from node (size check + decode check)."),
    timeoutMs: z.number().int().positive().max(300_000).default(120_000).describe("Remote request timeout."),
    security: remoteSecuritySchema.describe("Optional routing constraints (backend=nexus, hermes mode)."),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = getNodeById(db, args.id);
    if (!row) return "ERROR: node not found";
    if (row.backend !== "nexus") return `ERROR: node backend ${row.backend} does not support file transfer`;
    if (!ctx.nodeRouter) return "ERROR: node routing transport is not available";
    try {
      return await ctx.nodeRouter.routeToolExecution(
        nodeFilePullRoutingTool,
        {
          remotePath: args.remotePath,
          ...(args.localPath ? { localPath: args.localPath } : {}),
          overwrite: args.overwrite,
          maxBytes: args.maxBytes,
          timeoutMs: args.timeoutMs,
          ...(args.security ? { security: args.security } : {}),
        },
        {
          ...ctx,
          executionNode: args.id,
          executionMode: "remote",
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: ${message}`;
    }
  },
});

export const nodeFilePush = defineTool({
  name: "node_file_push",
  description:
    "Push a small gateway-local file to a node (file.push). Requires node allowlist `file_push`; may be denied by Hermes `denyCommands` in `firewallMode=hermes`. Returns JSON with `sha256` + remote path.",
  parameters: z.object({
    id: z.string().min(1).max(128).describe("Target node id."),
    localPath: z
      .string()
      .min(1)
      .max(4096)
      .describe("Absolute gateway path to read. Must be within gateway roots (stateDir/workspace/code)."),
    remotePath: z
      .string()
      .min(1)
      .max(4096)
      .describe("Absolute path on node. Must be within node `NEXUS_NODE_FILE_TRANSFER_ROOTS`."),
    overwrite: z.boolean().default(false).describe("If false, fail when remotePath already exists on node."),
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(50 * 1024 * 1024)
      .default(5 * 1024 * 1024)
      .describe("Max bytes to upload (local file size must be <= maxBytes)."),
    timeoutMs: z.number().int().positive().max(300_000).default(120_000).describe("Remote request timeout."),
    security: remoteSecuritySchema.describe("Optional routing constraints (backend=nexus, hermes mode)."),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = getNodeById(db, args.id);
    if (!row) return "ERROR: node not found";
    if (row.backend !== "nexus") return `ERROR: node backend ${row.backend} does not support file transfer`;
    if (!ctx.nodeRouter) return "ERROR: node routing transport is not available";
    try {
      return await ctx.nodeRouter.routeToolExecution(
        nodeFilePushRoutingTool,
        {
          localPath: args.localPath,
          remotePath: args.remotePath,
          overwrite: args.overwrite,
          maxBytes: args.maxBytes,
          timeoutMs: args.timeoutMs,
          ...(args.security ? { security: args.security } : {}),
        },
        {
          ...ctx,
          executionNode: args.id,
          executionMode: "remote",
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: ${message}`;
    }
  },
});

export const nodeSystemRun = defineTool({
  name: "node_system_run",
  description:
    "Run an allowlisted command on a specific Nexus node via protocol method system.run (tool.execute).",
  parameters: z.object({
    id: z.string().min(1).max(128),
    command: z.string().min(1).max(4000),
    timeoutMs: z.number().int().positive().max(300_000).default(60_000),
    security: remoteSecuritySchema,
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = getNodeById(db, args.id);
    if (!row) return "ERROR: node not found";
    if (row.backend !== "nexus") return `ERROR: node backend ${row.backend} does not support system.run`;
    if (!ctx.nodeRouter) return "ERROR: node routing transport is not available";
    try {
      return await ctx.nodeRouter.routeToolExecution(
        nodeSystemRunRoutingTool,
        {
          command: args.command,
          timeoutMs: args.timeoutMs,
          ...(args.security ? { security: args.security } : {}),
        },
        {
          ...ctx,
          executionNode: args.id,
          executionMode: "remote",
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: ${message}`;
    }
  },
});

export const nodeSystemWhich = defineTool({
  name: "node_system_which",
  description: "Check whether a command exists on a specific Nexus node via system.which.",
  parameters: z.object({
    id: z.string().min(1).max(128),
    command: z.string().min(1).max(256),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = getNodeById(db, args.id);
    if (!row) return "ERROR: node not found";
    if (row.backend !== "nexus") return `ERROR: node backend ${row.backend} does not support system.which`;
    if (!ctx.nodeRouter) return "ERROR: node routing transport is not available";
    try {
      return await ctx.nodeRouter.routeToolExecution(
        nodeSystemWhichRoutingTool,
        { command: args.command },
        {
          ...ctx,
          executionNode: args.id,
          executionMode: "remote",
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: ${message}`;
    }
  },
});

export const nodeProcessStart = defineTool({
  name: "node_process_start",
  description:
    "Start a process on a specific Nexus node via process.start and return its remote process id.",
  parameters: z.object({
    id: z.string().min(1).max(128),
    command: z.string().min(1).max(4000),
    cwd: z.string().max(2000).optional(),
    timeoutMs: z.number().int().positive().max(300_000).optional(),
    security: remoteSecuritySchema,
    notify: z
      .object({
        mode: z.enum(["never", "on_failure", "on_exit"]).optional(),
        chatId: z.number().int().positive().optional(),
        preset: z.string().min(1).max(64).optional(),
      })
      .optional(),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = getNodeById(db, args.id);
    if (!row) return "ERROR: node not found";
    if (row.backend !== "nexus") return `ERROR: node backend ${row.backend} does not support process.start`;
    if (!ctx.nodeRouter) return "ERROR: node routing transport is not available";
    try {
      return await ctx.nodeRouter.routeToolExecution(
        nodeProcessStartRoutingTool,
        {
          command: args.command,
          ...(args.cwd ? { cwd: args.cwd } : {}),
          ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
          ...(args.notify ? { notify: args.notify } : {}),
          ...(args.security ? { security: args.security } : {}),
        },
        {
          ...ctx,
          executionNode: args.id,
          executionMode: "remote",
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: ${message}`;
    }
  },
});

export const nodeProcessStatus = defineTool({
  name: "node_process_status",
  description: "Get remote process status from a specific Nexus node via process.status.",
  parameters: z.object({
    id: z.string().min(1).max(128),
    processId: z.string().min(1).max(128),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = getNodeById(db, args.id);
    if (!row) return "ERROR: node not found";
    if (row.backend !== "nexus") return `ERROR: node backend ${row.backend} does not support process.status`;
    if (!ctx.nodeRouter) return "ERROR: node routing transport is not available";
    try {
      return await ctx.nodeRouter.routeToolExecution(
        nodeProcessStatusRoutingTool,
        { id: args.processId },
        {
          ...ctx,
          executionNode: args.id,
          executionMode: "remote",
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: ${message}`;
    }
  },
});

export const nodeProcessLogs = defineTool({
  name: "node_process_logs",
  description: "Fetch remote process logs from a specific Nexus node via process.logs.",
  parameters: z.object({
    id: z.string().min(1).max(128),
    processId: z.string().min(1).max(128),
    maxChars: z.number().int().min(200).max(50_000).default(8_000),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = getNodeById(db, args.id);
    if (!row) return "ERROR: node not found";
    if (row.backend !== "nexus") return `ERROR: node backend ${row.backend} does not support process.logs`;
    if (!ctx.nodeRouter) return "ERROR: node routing transport is not available";
    try {
      return await ctx.nodeRouter.routeToolExecution(
        nodeProcessLogsRoutingTool,
        {
          id: args.processId,
          maxChars: args.maxChars,
        },
        {
          ...ctx,
          executionNode: args.id,
          executionMode: "remote",
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: ${message}`;
    }
  },
});

export const nodeProcessStop = defineTool({
  name: "node_process_stop",
  description: "Stop a remote process on a specific Nexus node via process.cancel.",
  parameters: z.object({
    id: z.string().min(1).max(128),
    processId: z.string().min(1).max(128),
    signal: z.enum(["SIGTERM", "SIGINT", "SIGKILL"]).default("SIGTERM"),
    killAfterMs: z.number().int().min(0).max(60_000).default(5_000),
    reason: z.string().min(1).max(200).optional(),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = getNodeById(db, args.id);
    if (!row) return "ERROR: node not found";
    if (row.backend !== "nexus") return `ERROR: node backend ${row.backend} does not support process.cancel`;
    if (!ctx.nodeRouter) return "ERROR: node routing transport is not available";
    try {
      return await ctx.nodeRouter.routeToolExecution(
        nodeProcessStopRoutingTool,
        {
          id: args.processId,
          signal: args.signal,
          killAfterMs: args.killAfterMs,
          ...(args.reason ? { reason: args.reason } : {}),
        },
        {
          ...ctx,
          executionNode: args.id,
          executionMode: "remote",
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: ${message}`;
    }
  },
});

export const nodeManage = defineTool({
  name: "node_manage",
  description:
    "Unified node operations for node registry, system/process control, and file transfer.",
  parameters: z.object({
    action: z
      .enum([
        "list",
        "get",
        "delete",
        "set_status",
        "drain",
        "undrain",
        "update",
        "system_run",
        "system_which",
        "process_start",
        "process_status",
        "process_logs",
        "process_stop",
        "file_pull",
        "file_push",
      ])
      .default("list"),
    id: z.string().min(1).max(128).optional(),
    status: z.enum(["pending", "approved", "blocked", "offline", "online", "draining"]).optional(),
    backend: z.enum(["nexus", "openclaw"]).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    command: z.string().min(1).max(4000).optional(),
    cwd: z.string().max(2000).optional(),
    timeoutMs: z.number().int().positive().max(300_000).optional(),
    processId: z.string().min(1).max(128).optional(),
    maxChars: z.number().int().min(200).max(50_000).optional(),
    signal: z.enum(["SIGTERM", "SIGINT", "SIGKILL"]).optional(),
    killAfterMs: z.number().int().min(0).max(60_000).optional(),
    reason: z.string().min(1).max(200).optional(),
    strategy: z.string().min(1).max(40).optional(),
    ref: z.string().min(1).max(200).optional(),
    localPath: z.string().min(1).max(4096).optional(),
    remotePath: z.string().min(1).max(4096).optional(),
    overwrite: z.boolean().optional(),
    maxBytes: z.number().int().positive().max(50 * 1024 * 1024).optional(),
    notify: z
      .object({
        mode: z.enum(["never", "on_failure", "on_exit"]).optional(),
        chatId: z.number().int().positive().optional(),
        preset: z.string().min(1).max(64).optional(),
      })
      .optional(),
    security: remoteSecuritySchema,
  }).superRefine((value, issueCtx) => {
    const requiresId = new Set([
      "get",
      "delete",
      "set_status",
      "drain",
      "undrain",
      "update",
      "system_run",
      "system_which",
      "process_start",
      "process_status",
      "process_logs",
      "process_stop",
      "file_pull",
      "file_push",
    ]);
    if (requiresId.has(value.action) && !value.id) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `id is required when action='${value.action}'`,
        path: ["id"],
      });
    }
    if (value.action === "set_status" && !value.status) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "status is required when action='set_status'",
        path: ["status"],
      });
    }
    if (value.action === "system_run" && !value.command) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "command is required when action='system_run'",
        path: ["command"],
      });
    }
    if (value.action === "system_which" && !value.command) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "command is required when action='system_which'",
        path: ["command"],
      });
    }
    if (value.action === "process_start" && !value.command) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "command is required when action='process_start'",
        path: ["command"],
      });
    }
    if ((value.action === "process_status" || value.action === "process_logs" || value.action === "process_stop") && !value.processId) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `processId is required when action='${value.action}'`,
        path: ["processId"],
      });
    }
    if (value.action === "file_pull" && !value.remotePath) {
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "remotePath is required when action='file_pull'",
        path: ["remotePath"],
      });
    }
    if (value.action === "file_push") {
      if (!value.remotePath) {
        issueCtx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "remotePath is required when action='file_push'",
          path: ["remotePath"],
        });
      }
      if (!value.localPath) {
        issueCtx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "localPath is required when action='file_push'",
          path: ["localPath"],
        });
      }
    }
  }),
  execute: async (args, ctx) => {
    switch (args.action) {
      case "list":
        return nodeList.execute(
          {
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(args.backend !== undefined ? { backend: args.backend } : {}),
          },
          ctx,
        );
      case "get":
        return nodeGet.execute({ id: args.id ?? "" }, ctx);
      case "delete":
        return nodeDelete.execute({ id: args.id ?? "" }, ctx);
      case "set_status":
        return nodeSetStatus.execute({ id: args.id ?? "", status: args.status ?? "pending" }, ctx);
      case "drain":
        return nodeDrain.execute(
          { id: args.id ?? "", ...(args.timeoutMs !== undefined ? { deadlineMs: args.timeoutMs } : {}) },
          ctx,
        );
      case "undrain":
        return nodeUndrain.execute({ id: args.id ?? "" }, ctx);
      case "update":
        return nodeUpdate.execute(
          {
            id: args.id ?? "",
            ...(args.strategy ? { strategy: args.strategy } : {}),
            ...(args.ref ? { ref: args.ref } : {}),
            ...(args.timeoutMs !== undefined ? { deadlineMs: args.timeoutMs } : {}),
          },
          ctx,
        );
      case "system_run":
        return nodeSystemRun.execute(
          {
            id: args.id ?? "",
            command: args.command ?? "",
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
            ...(args.security ? { security: args.security } : {}),
          },
          ctx,
        );
      case "system_which":
        return nodeSystemWhich.execute({ id: args.id ?? "", command: args.command ?? "" }, ctx);
      case "process_start":
        return nodeProcessStart.execute(
          {
            id: args.id ?? "",
            command: args.command ?? "",
            ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
            ...(args.security ? { security: args.security } : {}),
            ...(args.notify ? { notify: args.notify } : {}),
          },
          ctx,
        );
      case "process_status":
        return nodeProcessStatus.execute({ id: args.id ?? "", processId: args.processId ?? "" }, ctx);
      case "process_logs":
        return nodeProcessLogs.execute(
          {
            id: args.id ?? "",
            processId: args.processId ?? "",
            ...(args.maxChars !== undefined ? { maxChars: args.maxChars } : {}),
          },
          ctx,
        );
      case "process_stop":
        return nodeProcessStop.execute(
          {
            id: args.id ?? "",
            processId: args.processId ?? "",
            ...(args.signal !== undefined ? { signal: args.signal } : {}),
            ...(args.killAfterMs !== undefined ? { killAfterMs: args.killAfterMs } : {}),
            ...(args.reason !== undefined ? { reason: args.reason } : {}),
          },
          ctx,
        );
      case "file_pull":
        return nodeFilePull.execute(
          {
            id: args.id ?? "",
            remotePath: args.remotePath ?? "",
            ...(args.localPath !== undefined ? { localPath: args.localPath } : {}),
            ...(args.overwrite !== undefined ? { overwrite: args.overwrite } : {}),
            ...(args.maxBytes !== undefined ? { maxBytes: args.maxBytes } : {}),
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
            ...(args.security ? { security: args.security } : {}),
          },
          ctx,
        );
      case "file_push":
        return nodeFilePush.execute(
          {
            id: args.id ?? "",
            localPath: args.localPath ?? "",
            remotePath: args.remotePath ?? "",
            ...(args.overwrite !== undefined ? { overwrite: args.overwrite } : {}),
            ...(args.maxBytes !== undefined ? { maxBytes: args.maxBytes } : {}),
            ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
            ...(args.security ? { security: args.security } : {}),
          },
          ctx,
        );
      default:
        return `ERROR: unsupported action '${args.action}'`;
    }
  },
});
