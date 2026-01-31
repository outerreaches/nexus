import type { Tool } from "./tools.js";
import { loadCustomTools } from "../tools/custom.js";

export class ToolRegistry {
  private tools: Tool[] = [];

  constructor(
    private readonly deps: {
      builtIns: Tool[];
      stateDir: string;
    },
  ) {}

  async init(): Promise<void> {
    await this.reload();
  }

  list(): Tool[] {
    return this.tools;
  }

  async reload(): Promise<void> {
    const custom = await loadCustomTools(this.deps.stateDir);
    const combined = [...this.deps.builtIns, ...custom];
    const byName = new Map<string, Tool>();
    for (const t of combined) byName.set(t.name, t);
    this.tools = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

