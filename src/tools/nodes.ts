import { z } from "zod";

import { defineTool, type Tool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";
import { deleteNodeCascadeById, getNodeById, listNodes, setNodeStatus } from "../storage/nodes.js";

function requireDb(ctx: { db?: unknown }): NexusDatabase | null {
  const db = ctx.db as NexusDatabase | undefined;
  return db ?? null;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
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
    status: z.enum(["pending", "approved", "blocked", "offline", "online"]).optional(),
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
    return JSON.stringify(row, null, 2);
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
    return JSON.stringify({ ok: true, ...result }, null, 2);
  },
});

export const nodeSetStatus = defineTool({
  name: "node_set_status",
  description:
    "Set node approval/lifecycle status. Use status=approved to allow pending nodes to connect, or blocked to revoke access.",
  parameters: z.object({
    id: z.string().min(1).max(128),
    status: z.enum(["pending", "approved", "blocked", "offline", "online"]),
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
  description: "List per-node MCP bridge servers and allowlisted tools/resources via protocol method mcp.list.",
  parameters: z.object({
    id: z.string().min(1).max(128),
    serverId: z.string().min(1).max(128).optional(),
    includeTools: z.boolean().default(true),
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
      return await ctx.nodeRouter.routeToolExecution(
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: ${message}`;
    }
  },
});

export const nodeMcpCall = defineTool({
  name: "node_mcp_call",
  description: "Invoke an allowlisted MCP tool on a specific node via protocol method mcp.call.",
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
      return await ctx.nodeRouter.routeToolExecution(
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `ERROR: ${message}`;
    }
  },
});

export const nodeMcpResources = defineTool({
  name: "node_mcp_resources",
  description: "List or read allowlisted MCP resources on a specific node via protocol method mcp.resources.",
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
      return await ctx.nodeRouter.routeToolExecution(
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
