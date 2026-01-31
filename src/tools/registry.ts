import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { ToolRegistry } from "../core/tool-registry.js";

export const toolsReload = defineTool({
  name: "tools_reload",
  description: "Reload custom tools from the state directory.",
  parameters: z.object({}),
  execute: async (_args, ctx) => {
    const registry = ctx.registry as ToolRegistry | undefined;
    if (!registry) return "ERROR: tool registry unavailable";
    await registry.reload();
    return "OK: tools reloaded";
  },
});

