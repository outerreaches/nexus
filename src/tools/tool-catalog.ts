import { z } from "zod";

import { defineTool, type Tool } from "../core/tools.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import { getPreset, getPresetNames } from "../core/presets.js";

function matchesName(name: string, query?: string): boolean {
  if (!query) return true;
  return name.toLowerCase().includes(query.toLowerCase());
}

function matchesQuery(tool: Tool, query?: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return tool.name.toLowerCase().includes(q) || (tool.description ?? "").toLowerCase().includes(q);
}

function summarizeDescription(description: string | undefined, maxChars = 140): string {
  if (!description) return "";
  const collapsed = description.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1)}…`;
}

export const toolCatalog = defineTool({
  name: "tool_catalog",
  description:
    "Inspect available tools without executing them. " +
    "Use this to discover tool names, descriptions, and optional schemas for a given preset (default: orchestrator).",
  parameters: z.object({
    preset: z.string().min(1).default("orchestrator").describe("Preset whose tool whitelist should be inspected."),
    nameLike: z.string().min(1).optional().describe("Optional case-insensitive substring filter on tool name."),
    includeSchema: z.boolean().default(false).describe("Include JSON schema for each tool."),
    limit: z.number().int().min(1).max(500).default(200).describe("Maximum tools to return."),
  }),
  execute: async (args, ctx) => {
    const registry = ctx.registry as ToolRegistry | undefined;
    if (!registry) return "ERROR: tool registry unavailable";

    const preset = getPreset(args.preset);
    if (!preset) {
      return `ERROR: unknown preset '${args.preset}'. Available presets: ${getPresetNames().join(", ")}`;
    }

    const allowed = new Set(preset.tools);
    const rows = registry
      .list()
      .filter((tool) => allowed.has(tool.name))
      .filter((tool) => matchesName(tool.name, args.nameLike))
      .slice(0, args.limit)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        ...(args.includeSchema ? { jsonSchema: tool.jsonSchema } : {}),
      }));

    const payload = {
      preset: preset.name,
      total: rows.length,
      tools: rows,
    };
    return JSON.stringify(payload);
  },
});

export const toolSearch = defineTool({
  name: "tool_search",
  description:
    "Search this run's tool catalog (kernel + discoverable). Returns matching tool names + short descriptions. " +
    "Use this to find a tool you want to call, then `tool_load` to make it available in the next turn.",
  parameters: z.object({
    query: z.string().min(1).max(200).optional().describe("Case-insensitive substring matched against name + description. Omit to list everything."),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  execute: async (args, ctx) => {
    const registry = ctx.registry as ToolRegistry | undefined;
    if (!registry) return "ERROR: tool registry unavailable";
    const runState = ctx.runState;
    if (!runState) {
      return JSON.stringify({ note: "lazy-loading not enabled for this run", tools: [] });
    }

    const matches = registry
      .list()
      .filter((tool) => runState.availableToolNames.has(tool.name))
      .filter((tool) => matchesQuery(tool, args.query))
      .slice(0, args.limit)
      .map((tool) => ({
        name: tool.name,
        description: summarizeDescription(tool.description),
        loaded:
          runState.kernelToolNames.has(tool.name) || runState.loadedToolNames.has(tool.name),
        kernel: runState.kernelToolNames.has(tool.name),
      }));

    return JSON.stringify({
      total: matches.length,
      kernel_size: runState.kernelToolNames.size,
      loaded_extras: runState.loadedToolNames.size,
      catalog_size:
        runState.availableToolNames.size - runState.kernelToolNames.size,
      tools: matches,
    });
  },
});

export const toolLoad = defineTool({
  name: "tool_load",
  description:
    "Materialize one or more discoverable tools into the LLM tool schema for the rest of this run. " +
    "Tools already in the kernel are no-ops. After this call, the next turn sees the loaded tools. " +
    "Call `tool_unload` to drop them again.",
  parameters: z.object({
    names: z.array(z.string().min(1).max(80)).min(1).max(20).describe("Tool names to load."),
  }),
  execute: async (args, ctx) => {
    const runState = ctx.runState;
    if (!runState) return "ERROR: lazy tool-loading is not enabled for this run";

    const loaded: string[] = [];
    const alreadyKernel: string[] = [];
    const alreadyLoaded: string[] = [];
    const unknown: string[] = [];

    for (const raw of args.names) {
      const name = raw.trim();
      if (!name) continue;
      if (!runState.availableToolNames.has(name)) {
        unknown.push(name);
        continue;
      }
      if (runState.kernelToolNames.has(name)) {
        alreadyKernel.push(name);
        continue;
      }
      if (runState.loadedToolNames.has(name)) {
        alreadyLoaded.push(name);
        continue;
      }
      runState.loadedToolNames.add(name);
      loaded.push(name);
    }

    return JSON.stringify({
      loaded,
      already_kernel: alreadyKernel,
      already_loaded: alreadyLoaded,
      unknown,
      visible_total: runState.kernelToolNames.size + runState.loadedToolNames.size,
    });
  },
});

export const toolUnload = defineTool({
  name: "tool_unload",
  description:
    "Drop previously-loaded discoverable tools from the LLM tool schema. Kernel tools cannot be unloaded.",
  parameters: z.object({
    names: z.array(z.string().min(1).max(80)).min(1).max(20),
  }),
  execute: async (args, ctx) => {
    const runState = ctx.runState;
    if (!runState) return "ERROR: lazy tool-loading is not enabled for this run";

    const unloaded: string[] = [];
    const refusedKernel: string[] = [];
    const notLoaded: string[] = [];

    for (const raw of args.names) {
      const name = raw.trim();
      if (!name) continue;
      if (runState.kernelToolNames.has(name)) {
        refusedKernel.push(name);
        continue;
      }
      if (!runState.loadedToolNames.has(name)) {
        notLoaded.push(name);
        continue;
      }
      runState.loadedToolNames.delete(name);
      unloaded.push(name);
    }

    return JSON.stringify({
      unloaded,
      refused_kernel: refusedKernel,
      not_loaded: notLoaded,
      visible_total: runState.kernelToolNames.size + runState.loadedToolNames.size,
    });
  },
});
