import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";
import { deleteNodeById, getNodeById, listNodes } from "../storage/nodes.js";

function requireDb(ctx: { db?: unknown }): NexusDatabase | null {
  const db = ctx.db as NexusDatabase | undefined;
  return db ?? null;
}

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
    const removed = deleteNodeById(db, args.id);
    if (!removed) return "ERROR: node not found";
    return JSON.stringify({ ok: true, id: args.id, deleted: true }, null, 2);
  },
});
