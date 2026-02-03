import { preset as analyst } from "./presets/analyst.js";
import { preset as coder } from "./presets/coder.js";
import { preset as intakeManager } from "./presets/intake-manager.js";
import { preset as orchestrator } from "./presets/orchestrator.js";
import { preset as researcher } from "./presets/researcher.js";
import { preset as trader } from "./presets/trader.js";

// ─────────────────────────────────────────────────────────────────────────────
// Agent Presets — define roles with tool whitelists and budgets
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentPreset {
  name: string;
  description: string;
  /** Extra system prompt appended after any preset prompt files. */
  systemPrompt?: string;
  /** Optional prompt files to append to this preset's system prompt. */
  promptFiles?: string[];
  /** Tool name whitelist — only these tools are available to this preset. */
  tools: string[];
  budget?: {
    maxToolCalls?: number;
    maxIterations?: number;
  };
  /** If true, spawn_agent will fork a child process for crash isolation. */
  isolated?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Default presets (loaded from plugin-style files)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

const PRESETS: Record<string, AgentPreset> = {
  orchestrator,
  coder,
  researcher,
  trader,
  analyst,
  "intake-manager": intakeManager,
};

export function getPreset(name: string): AgentPreset | undefined {
  return PRESETS[name];
}

export function listPresets(): AgentPreset[] {
  return Object.values(PRESETS);
}

export function getPresetNames(): string[] {
  return Object.keys(PRESETS);
}

/** Format presets list for injection into the orchestrator system prompt. */
export function formatPresetsForPrompt(): string {
  const lines = [
    "## Available Agent Presets",
    "",
    "Use `spawn_agent` to delegate tasks to specialized workers:",
    "",
  ];
  for (const p of Object.values(PRESETS)) {
    if (p.name === "orchestrator") continue; // Don't list self
    lines.push(`- **${p.name}**: ${p.description} (tools: ${p.tools.filter(t => t !== "read_from_blackboard" && t !== "write_to_blackboard").join(", ")})`);
  }
  lines.push("");
  lines.push("For simple questions, answer directly without spawning agents.");
  lines.push("For complex multi-step tasks, spawn the appropriate worker(s).");
  lines.push("Workers share data via the Blackboard — use `write_to_blackboard` / `read_from_blackboard`.");
  return lines.join("\n");
}
