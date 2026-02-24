import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import { getPreset, getPresetNames } from "../core/presets.js";

function matchesName(name: string, query?: string): boolean {
  if (!query) return true;
  return name.toLowerCase().includes(query.toLowerCase());
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

