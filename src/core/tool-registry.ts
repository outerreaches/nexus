import type { Tool } from "./tools.js";
import { loadCustomTools } from "../tools/custom.js";
import type { McpManager } from "../mcp/manager.js";

export class ToolRegistry {
  private tools: Tool[] = [];

  constructor(
    private readonly deps: {
      builtIns: Tool[];
      stateDir: string;
      mcp?: McpManager;
    },
  ) {}

  async init(): Promise<void> {
    await this.reload();
  }

  list(): Tool[] {
    return this.tools;
  }

  async reload(): Promise<void> {
    if (this.deps.mcp) {
      await this.deps.mcp.reload();
    }
    const custom = await loadCustomTools(this.deps.stateDir);
    const mcpTools = this.deps.mcp ? this.deps.mcp.listTools() : [];
    const combined = [...this.deps.builtIns, ...custom, ...mcpTools];
    const byName = new Map<string, Tool>();
    for (const t of combined) byName.set(t.name, t);
    this.tools = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}
