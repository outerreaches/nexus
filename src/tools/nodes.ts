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

const nodeSetPolicyRoutingTool: Tool = {
  name: "node_set_policy",
  description: "Internal routing shim for policy.update dispatch.",
  jsonSchema: {},
  execute: async () => "ERROR: node_set_policy should be routed via node transport.",
};

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

export const nodeSetPolicy = defineTool({
  name: "node_set_policy",
  description:
    "Push a Hermes policy document to a Nexus node via protocol method policy.update and persist it in node-local state.",
  parameters: z.object({
    id: z.string().min(1).max(128),
    policy: z
      .record(z.string(), z.unknown())
      .refine((value) => Object.keys(value).length > 0, "policy must include at least one field"),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";
    const row = getNodeById(db, args.id);
    if (!row) return "ERROR: node not found";
    if (row.backend !== "nexus") return `ERROR: node backend ${row.backend} does not support policy.update`;
    if (!ctx.nodeRouter) return "ERROR: node routing transport is not available";

    try {
      return await ctx.nodeRouter.routeToolExecution(
        nodeSetPolicyRoutingTool,
        { policy: args.policy },
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
