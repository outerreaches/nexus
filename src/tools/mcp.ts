import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import type { McpManager } from "../mcp/manager.js";
import {
  createMcpProfile,
  createMcpServer,
  deleteMcpProfile,
  deleteMcpServer,
  getMcpProfile,
  getMcpServer,
  listMcpProfiles,
  listMcpServers,
  updateMcpProfile,
  updateMcpServer,
} from "../mcp/store.js";

function requireManager(ctx: { mcp?: unknown }): McpManager {
  const manager = ctx.mcp as McpManager | undefined;
  if (!manager) throw new Error("MCP manager unavailable");
  return manager;
}

function requireRegistry(ctx: { registry?: unknown }): ToolRegistry | null {
  return (ctx.registry as ToolRegistry | undefined) ?? null;
}

async function reloadRegistry(ctx: { registry?: unknown }): Promise<void> {
  const registry = requireRegistry(ctx);
  if (!registry) return;
  await registry.reload();
}

const McpTransportSchema = z.enum(["stdio"]);
const McpTrustSchema = z.enum(["read_only", "mutating"]);

const McpServerAddSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  label: z.string().min(1).max(160),
  transport: McpTransportSchema.default("stdio"),
  command: z.string().min(1).max(400).optional(),
  args: z.array(z.string()).max(100).default([]),
  env: z.record(z.string()).default({}),
  capabilityTags: z.array(z.string()).max(40).default([]),
  trustLevel: McpTrustSchema.default("read_only"),
  timeoutMs: z.number().int().min(5000).max(600000).optional(),
  maxConcurrency: z.number().int().min(1).max(16).optional(),
  idleTtlMs: z.number().int().min(10000).max(86400000).optional(),
  enabled: z.boolean().default(true),
  active: z.boolean().default(false),
});

const McpServerUpdateSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(160).optional(),
  command: z.string().max(400).nullable().optional(),
  args: z.array(z.string()).max(100).optional(),
  env: z.record(z.string()).optional(),
  capabilityTags: z.array(z.string()).max(40).optional(),
  trustLevel: McpTrustSchema.optional(),
  timeoutMs: z.number().int().min(5000).max(600000).optional(),
  maxConcurrency: z.number().int().min(1).max(16).optional(),
  idleTtlMs: z.number().int().min(10000).max(86400000).optional(),
  enabled: z.boolean().optional(),
  active: z.boolean().optional(),
});

const McpProfileLlmSchema = z.object({
  primaryProvider: z.string().min(1).optional(),
  primaryModel: z.string().min(1).optional(),
  fallbackProvider: z.string().min(1).optional(),
  fallbackModel: z.string().min(1).optional(),
  disableFallback: z.boolean().optional(),
}).optional();

const McpProfileBudgetSchema = z.object({
  maxToolCalls: z.number().int().min(1).max(500).optional(),
  maxIterations: z.number().int().min(1).max(100).optional(),
}).optional();

const McpProfileCreateSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  name: z.string().min(1).max(80),
  serverId: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  toolNames: z.array(z.string().min(1)).min(1).max(200),
  allowNonMcpTools: z.boolean().default(false),
  hidden: z.boolean().default(true),
  ephemeral: z.boolean().default(true),
  enabled: z.boolean().default(true),
  llm: McpProfileLlmSchema,
  budget: McpProfileBudgetSchema,
});

const McpProfileUpdateSchema = z.object({
  idOrName: z.string().min(1),
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(400).optional(),
  toolNames: z.array(z.string().min(1)).max(200).optional(),
  allowNonMcpTools: z.boolean().optional(),
  hidden: z.boolean().optional(),
  ephemeral: z.boolean().optional(),
  enabled: z.boolean().optional(),
  llm: McpProfileLlmSchema,
  budget: McpProfileBudgetSchema,
});

function normalizeRequestedToolNames(params: {
  toolNames: string[];
  allowNonMcpTools: boolean;
  registry: ToolRegistry | null;
}): { toolNames: string[]; error?: string } {
  const normalized = Array.from(
    new Set(
      params.toolNames
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  );
  if (normalized.length === 0) {
    return {
      toolNames: [],
      error: "at least one tool name is required.",
    };
  }

  const nonMcp = normalized.filter((name) => !name.startsWith("mcp."));
  if (!params.allowNonMcpTools && nonMcp.length > 0) {
    return {
      toolNames: normalized,
      error:
        `non-MCP tools are disabled by default. Re-run with allowNonMcpTools=true to include: ${nonMcp.join(", ")}`,
    };
  }

  if (params.allowNonMcpTools && nonMcp.length > 0 && params.registry) {
    const known = new Set(params.registry.list().map((t) => t.name));
    const unknownNonMcp = nonMcp.filter((name) => !known.has(name));
    if (unknownNonMcp.length > 0) {
      return {
        toolNames: normalized,
        error: `unknown non-MCP tools: ${unknownNonMcp.join(", ")}`,
      };
    }
  }

  return { toolNames: normalized };
}

function normalizeDelegateTask(task: string, blackboardTitle?: string): string {
  const clean = task.trim();
  if (!blackboardTitle) return clean;
  if (/\bBlackboard title\s*:/i.test(clean)) return clean;
  return `${clean}\n\nBlackboard title: ${blackboardTitle.trim()}`;
}

const McpDelegateSchema = z.object({
  task: z.string().min(1).max(8000),
  inputBlackboardId: z.string().min(1).optional(),
  context: z.array(z.string().min(1)).max(20).default([]),
  serverId: z.string().min(1).optional(),
  profile: z.string().min(1).optional(),
  toolNames: z.array(z.string().min(1)).max(200).optional(),
  allowNonMcpTools: z.boolean().default(false),
  profileName: z.string().min(1).max(80).optional(),
  blackboardTitle: z.string().min(1).max(200).optional(),
  budget: z.object({
    maxToolCalls: z.number().int().min(1).max(200).optional(),
    maxIterations: z.number().int().min(1).max(80).optional(),
  }).optional(),
  modelMode: z.enum(["default", "local_only"]).optional(),
  cleanupPolicy: z.enum(["keep_active", "deactivate", "deactivate_and_delete_ephemeral_profile"]).default("deactivate_and_delete_ephemeral_profile"),
});

export const mcpOverview = defineTool({
  name: "mcp_overview",
  description: "Read-only summary of MCP servers/profiles and active status for delegation planning.",
  parameters: z.object({}),
  execute: async (_args, ctx) => {
    try {
      const manager = requireManager(ctx);
      return JSON.stringify(manager.getOverview(), null, 2);
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

export const mcpServerList = defineTool({
  name: "mcp_server_list",
  description: "List configured MCP servers and status.",
  parameters: z.object({
    includeDisabled: z.boolean().default(true),
  }),
  execute: async (args, ctx) => {
    const db = ctx.db as any;
    if (!db) return "ERROR: database unavailable";
    const rows = listMcpServers(db, { includeDisabled: args.includeDisabled });
    return JSON.stringify({ total: rows.length, servers: rows }, null, 2);
  },
});

export const mcpServerAdd = defineTool({
  name: "mcp_server_add",
  description: "Add a configured MCP server (inactive by default unless active=true).",
  parameters: McpServerAddSchema,
  execute: async (args, ctx) => {
    try {
      const manager = requireManager(ctx);
      const db = ctx.db as any;
      if (!db) return "ERROR: database unavailable";
      const nowMs = ctx.nowMs();
      const created = createMcpServer(db, {
        id: args.id,
        label: args.label,
        transport: args.transport,
        command: args.command,
        args: args.args,
        env: args.env,
        capabilityTags: args.capabilityTags,
        trustLevel: args.trustLevel,
        timeoutMs: args.timeoutMs,
        maxConcurrency: args.maxConcurrency,
        idleTtlMs: args.idleTtlMs,
        enabled: args.enabled,
        active: args.active,
      }, nowMs);
      if (created.active) {
        await manager.activateServer(created.id);
      }
      await reloadRegistry(ctx);
      return JSON.stringify({
        ok: true,
        server: getMcpServer(db, created.id),
      }, null, 2);
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

export const mcpServerUpdate = defineTool({
  name: "mcp_server_update",
  description: "Update MCP server settings and optionally activate/deactivate.",
  parameters: McpServerUpdateSchema,
  execute: async (args, ctx) => {
    try {
      const manager = requireManager(ctx);
      const db = ctx.db as any;
      if (!db) return "ERROR: database unavailable";
      const updated = updateMcpServer(db, args.id, {
        label: args.label,
        command: args.command,
        args: args.args,
        env: args.env,
        capabilityTags: args.capabilityTags,
        trustLevel: args.trustLevel,
        timeoutMs: args.timeoutMs,
        maxConcurrency: args.maxConcurrency,
        idleTtlMs: args.idleTtlMs,
        enabled: args.enabled,
        active: args.active,
      }, ctx.nowMs());
      if (!updated) return `ERROR: MCP server not found: ${args.id}`;
      if (args.active === true) {
        await manager.activateServer(updated.id);
      } else if (args.active === false) {
        await manager.deactivateServer(updated.id);
      } else if (args.enabled === false && updated.active) {
        await manager.deactivateServer(updated.id);
      } else {
        await reloadRegistry(ctx);
      }
      return JSON.stringify({
        ok: true,
        server: getMcpServer(db, updated.id),
      }, null, 2);
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

export const mcpServerProbe = defineTool({
  name: "mcp_server_probe",
  description: "Probe an MCP server connection and discover available tools.",
  parameters: z.object({
    id: z.string().min(1),
  }),
  execute: async (args, ctx) => {
    try {
      const manager = requireManager(ctx);
      const res = await manager.probeServer(args.id);
      const normalizedTools = res.tools.map((tool) => ({
        remoteName: tool.name,
        localName: manager.getToolNamesForServer(res.server.id).find((name) => name.endsWith(`.${tool.name.toLowerCase().replace(/[^a-z0-9._-]/g, "_")}`)) ?? null,
        description: tool.description ?? "",
      }));
      await reloadRegistry(ctx);
      return JSON.stringify({
        ok: true,
        server: res.server,
        totalTools: normalizedTools.length,
        tools: normalizedTools,
      }, null, 2);
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

export const mcpServerActivate = defineTool({
  name: "mcp_server_activate",
  description: "Activate and connect a configured MCP server.",
  parameters: z.object({
    id: z.string().min(1),
  }),
  execute: async (args, ctx) => {
    try {
      const manager = requireManager(ctx);
      const updated = await manager.activateServer(args.id);
      await reloadRegistry(ctx);
      return JSON.stringify({ ok: true, server: updated }, null, 2);
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

export const mcpServerDeactivate = defineTool({
  name: "mcp_server_deactivate",
  description: "Deactivate an MCP server and disconnect it from runtime.",
  parameters: z.object({
    id: z.string().min(1),
  }),
  execute: async (args, ctx) => {
    try {
      const manager = requireManager(ctx);
      const updated = await manager.deactivateServer(args.id);
      await reloadRegistry(ctx);
      return JSON.stringify({ ok: true, server: updated }, null, 2);
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

export const mcpServerRemove = defineTool({
  name: "mcp_server_remove",
  description: "Remove an MCP server and associated profiles.",
  parameters: z.object({
    id: z.string().min(1),
  }),
  execute: async (args, ctx) => {
    try {
      const manager = requireManager(ctx);
      const db = ctx.db as any;
      if (!db) return "ERROR: database unavailable";
      const existing = getMcpServer(db, args.id);
      if (!existing) return `ERROR: MCP server not found: ${args.id}`;
      await manager.deactivateServer(existing.id);
      const ok = deleteMcpServer(db, existing.id);
      if (!ok) return `ERROR: failed to remove MCP server: ${existing.id}`;
      await reloadRegistry(ctx);
      return JSON.stringify({ ok: true, removed: existing.id }, null, 2);
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

export const mcpProfileList = defineTool({
  name: "mcp_profile_list",
  description: "List MCP runtime profiles used for dynamic worker presets.",
  parameters: z.object({
    includeDisabled: z.boolean().default(true),
  }),
  execute: async (args, ctx) => {
    const db = ctx.db as any;
    if (!db) return "ERROR: database unavailable";
    const rows = listMcpProfiles(db, { includeDisabled: args.includeDisabled });
    return JSON.stringify({ total: rows.length, profiles: rows }, null, 2);
  },
});

export const mcpProfileCreate = defineTool({
  name: "mcp_profile_create",
  description: "Create an MCP profile mapped to a dynamic (usually hidden) worker preset.",
  parameters: McpProfileCreateSchema,
  execute: async (args, ctx) => {
    try {
      const db = ctx.db as any;
      const registry = requireRegistry(ctx);
      if (!db) return "ERROR: database unavailable";
      const normalized = normalizeRequestedToolNames({
        toolNames: args.toolNames,
        allowNonMcpTools: args.allowNonMcpTools,
        registry,
      });
      if (normalized.error) {
        return `ERROR: ${normalized.error}`;
      }
      const created = createMcpProfile(db, {
        id: args.id,
        name: args.name,
        serverId: args.serverId,
        description: args.description,
        toolNames: normalized.toolNames,
        hidden: args.hidden,
        ephemeral: args.ephemeral,
        enabled: args.enabled,
        llmPrimaryProvider: args.llm?.primaryProvider ?? null,
        llmPrimaryModel: args.llm?.primaryModel ?? null,
        llmFallbackProvider: args.llm?.fallbackProvider ?? null,
        llmFallbackModel: args.llm?.fallbackModel ?? null,
        llmDisableFallback: args.llm?.disableFallback ?? false,
        budgetMaxToolCalls: args.budget?.maxToolCalls ?? null,
        budgetMaxIterations: args.budget?.maxIterations ?? null,
      }, ctx.nowMs());
      await reloadRegistry(ctx);
      return JSON.stringify({
        ok: true,
        profile: created,
      }, null, 2);
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

export const mcpProfileUpdate = defineTool({
  name: "mcp_profile_update",
  description: "Update MCP profile settings and dynamic preset mapping.",
  parameters: McpProfileUpdateSchema,
  execute: async (args, ctx) => {
    try {
      const db = ctx.db as any;
      const registry = requireRegistry(ctx);
      if (!db) return "ERROR: database unavailable";
      let normalizedToolNames: string[] | undefined;
      if (args.toolNames) {
        const normalized = normalizeRequestedToolNames({
          toolNames: args.toolNames,
          allowNonMcpTools: args.allowNonMcpTools ?? false,
          registry,
        });
        if (normalized.error) {
          return `ERROR: ${normalized.error}`;
        }
        normalizedToolNames = normalized.toolNames;
      }
      const updated = updateMcpProfile(db, args.idOrName, {
        name: args.name,
        description: args.description,
        toolNames: normalizedToolNames,
        hidden: args.hidden,
        ephemeral: args.ephemeral,
        enabled: args.enabled,
        llmPrimaryProvider: args.llm?.primaryProvider,
        llmPrimaryModel: args.llm?.primaryModel,
        llmFallbackProvider: args.llm?.fallbackProvider,
        llmFallbackModel: args.llm?.fallbackModel,
        llmDisableFallback: args.llm?.disableFallback,
        budgetMaxToolCalls: args.budget?.maxToolCalls,
        budgetMaxIterations: args.budget?.maxIterations,
      }, ctx.nowMs());
      if (!updated) return `ERROR: MCP profile not found: ${args.idOrName}`;
      await reloadRegistry(ctx);
      return JSON.stringify({
        ok: true,
        profile: updated,
      }, null, 2);
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

export const mcpProfileDelete = defineTool({
  name: "mcp_profile_delete",
  description: "Delete an MCP profile (dynamic worker preset).",
  parameters: z.object({
    idOrName: z.string().min(1),
  }),
  execute: async (args, ctx) => {
    try {
      const db = ctx.db as any;
      if (!db) return "ERROR: database unavailable";
      const existing = getMcpProfile(db, args.idOrName);
      if (!existing) return `ERROR: MCP profile not found: ${args.idOrName}`;
      const ok = deleteMcpProfile(db, existing.id);
      if (!ok) return `ERROR: failed to delete MCP profile: ${args.idOrName}`;
      await reloadRegistry(ctx);
      return JSON.stringify({
        ok: true,
        removed: existing.name,
      }, null, 2);
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

export const mcpDelegate = defineTool({
  name: "mcp_delegate",
  description:
    "MCP orchestration helper: activate/provision profile, spawn scoped worker for task, and optionally cleanup server/profile.",
  parameters: McpDelegateSchema,
  execute: async (args, ctx) => {
    try {
      const manager = requireManager(ctx);
      const registry = requireRegistry(ctx);
      const db = ctx.db as any;
      if (!db) return "ERROR: database unavailable";
      if (!registry) return "ERROR: tool registry unavailable";

      let profile = args.profile ? getMcpProfile(db, args.profile) : null;
      let createdProfileId: string | null = null;

      if (!profile) {
        if (!args.serverId) return "ERROR: mcp_delegate requires either `profile` or `serverId`.";
        const server = getMcpServer(db, args.serverId);
        if (!server) return `ERROR: MCP server not found: ${args.serverId}`;
        const toolNames = (args.toolNames && args.toolNames.length > 0)
          ? (() => {
            const normalized = normalizeRequestedToolNames({
              toolNames: args.toolNames,
              allowNonMcpTools: args.allowNonMcpTools,
              registry,
            });
            if (normalized.error) {
              throw new Error(normalized.error);
            }
            return normalized.toolNames;
          })()
          : manager.getToolNamesForServer(server.id);
        if (toolNames.length === 0) {
          return `ERROR: no MCP tools available for server '${server.id}'. Activate/probe first or pass toolNames.`;
        }
        const profileName = (args.profileName?.trim() || `mcp-${server.id}-delegate-${ctx.nowMs()}`).slice(0, 80);
        profile = createMcpProfile(db, {
          name: profileName,
          serverId: server.id,
          description: `Ephemeral delegate profile for server '${server.label}'`,
          toolNames,
          hidden: true,
          ephemeral: true,
          enabled: true,
        }, ctx.nowMs());
        createdProfileId = profile.id;
      }

      const server = getMcpServer(db, profile.serverId);
      if (!server) return `ERROR: MCP server missing for profile '${profile.name}'.`;
      if (profile.toolNames.length === 0) {
        return `ERROR: MCP profile '${profile.name}' has no tools configured.`;
      }
      if (!server.active) {
        await manager.activateServer(server.id);
      }
      await reloadRegistry(ctx);

      const spawnTool = registry.list().find((tool) => tool.name === "spawn_agent");
      if (!spawnTool) return "ERROR: spawn_agent tool unavailable";

      const contextIds = Array.from(new Set([
        ...args.context,
        ...(args.inputBlackboardId ? [args.inputBlackboardId] : []),
      ]));

      const spawnTask = normalizeDelegateTask(args.task, args.blackboardTitle);
      const spawnResult = await spawnTool.execute({
        preset: profile.name,
        task: spawnTask,
        context: contextIds,
        ...(args.budget ? { budget: args.budget } : {}),
        ...(args.modelMode ? { modelMode: args.modelMode } : {}),
      }, ctx);

      manager.touchProfileUsed(profile.id);

      if (args.cleanupPolicy === "deactivate" || args.cleanupPolicy === "deactivate_and_delete_ephemeral_profile") {
        await manager.deactivateServer(profile.serverId);
      }
      if (args.cleanupPolicy === "deactivate_and_delete_ephemeral_profile") {
        const current = getMcpProfile(db, profile.id);
        if (current?.ephemeral || createdProfileId) {
          deleteMcpProfile(db, profile.id);
        }
      }

      await reloadRegistry(ctx);

      return JSON.stringify({
        ok: !spawnResult.trimStart().startsWith("ERROR:"),
        profile: profile.name,
        serverId: profile.serverId,
        createdEphemeralProfile: createdProfileId !== null,
        cleanupPolicy: args.cleanupPolicy,
        output: spawnResult,
      }, null, 2);
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
