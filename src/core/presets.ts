import { preset as analyst } from "./presets/analyst.js";
import { preset as coder } from "./presets/coder.js";
import { preset as graphicDesigner } from "./presets/graphic-designer.js";
import { preset as intakeManager } from "./presets/intake-manager.js";
import { preset as orchestrator } from "./presets/orchestrator.js";
import { preset as processManager } from "./presets/process-manager.js";
import { preset as researcher } from "./presets/researcher.js";
import { preset as securityResearcher } from "./presets/security-researcher.js";
import { preset as trader } from "./presets/trader.js";

// ─────────────────────────────────────────────────────────────────────────────
// Agent Presets — define roles with tool whitelists and budgets
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentPreset {
  name: string;
  description: string;
  /** Optional source tag for runtime-managed presets. */
  source?: string;
  /** Hide from generic preset listings/prompt injection when true. */
  hidden?: boolean;
  /** Optional default image model for image tools used by this preset. */
  imageModel?: string;
  /** Optional provider name for image tools (resolved from llm.providers). When set, image
   *  generation uses this provider's base URL and API key instead of the agent's LLM route. */
  imageProvider?: string;
  /** Optional default video model for video analysis tools used by this preset. */
  videoModel?: string;
  /** Optional provider name for video tools (resolved from llm.providers). When set, video
   *  analysis uses this provider's base URL and API key instead of the agent's LLM route. */
  videoProvider?: string;
  /** Optional OpenRouter provider slug ordering for video requests (e.g. ["google-ai-studio"]).
   *  Passed as `provider.order` in the OpenRouter API payload. */
  videoProviderOrder?: string[];
  /** Optional LLM routing override for this preset. Omit to use global default route. */
  llm?: {
    primary?: {
      provider?: string;
      model?: string;
    };
    /** Set to null to disable fallback for this preset. */
    fallback?: {
      provider?: string;
      model?: string;
    } | null;
  };
  /** Extra system prompt appended after any preset prompt files. */
  systemPrompt?: string;
  /** Optional prompt files to append to this preset's system prompt. */
  promptFiles?: string[];
  /** Tool name whitelist — only these tools are available to this preset. */
  tools: string[];
  /** Optional per-run hard caps for specific tool names (enforced by AgentRunner). */
  toolCallCaps?: Record<string, number>;
  /** Optional whitelist of preset names this agent may spawn via `spawn_agent`. */
  spawnAllowlist?: string[];
  /** When true, node-pinned runs of this preset may spawn sub-agents outside the current node.
   *  Default is false (node-pinned runs must keep child spawns on the same node). */
  allowPinnedSpawnEscape?: boolean;
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
  "process-manager": processManager,
  coder,
  researcher,
  "security-researcher": securityResearcher,
  trader,
  analyst,
  "graphic-designer": graphicDesigner,
  "intake-manager": intakeManager,
};

const DYNAMIC_PRESETS = new Map<string, AgentPreset>();

export function getPreset(name: string): AgentPreset | undefined {
  return DYNAMIC_PRESETS.get(name) ?? PRESETS[name];
}

export function listPresets(): AgentPreset[] {
  return [...Object.values(PRESETS), ...DYNAMIC_PRESETS.values()];
}

export function getPresetNames(opts: { includeHidden?: boolean } = {}): string[] {
  const includeHidden = opts.includeHidden ?? false;
  return listPresets()
    .filter((p) => includeHidden || !p.hidden)
    .map((p) => p.name);
}

export function registerDynamicPreset(preset: AgentPreset): void {
  DYNAMIC_PRESETS.set(preset.name, { ...preset });
}

export function unregisterDynamicPreset(name: string): void {
  DYNAMIC_PRESETS.delete(name);
}

export function clearDynamicPresetsBySource(source: string): void {
  for (const [name, preset] of DYNAMIC_PRESETS.entries()) {
    if (preset.source === source) {
      DYNAMIC_PRESETS.delete(name);
    }
  }
}

/** Format presets list for injection into system prompts. When `filter` is
 *  provided, only presets in the filter are listed (used for workers with a
 *  spawnAllowlist). When omitted, all non-hidden presets are listed. */
export function formatPresetsForPrompt(filter?: string[]): string {
  const lines = [
    "## Available Agent Presets",
    "",
    "Use `spawn_agent` to delegate tasks to specialized workers:",
    "",
  ];
  for (const p of listPresets()) {
    if (p.name === "orchestrator" || p.hidden) continue;
    if (filter && !filter.includes(p.name)) continue;
    lines.push(`- **${p.name}**: ${p.description}`);
  }
  lines.push("");
  lines.push("For simple questions, answer directly without spawning agents unless the user explicitly asks for delegation.");
  lines.push("If the user explicitly asks to spawn/delegate to a specific preset, do it unless blocked by policy or missing capabilities; if blocked, explain the constraint.");
  lines.push("For complex multi-step tasks, spawn the appropriate worker(s).");
  lines.push("Workers share data via the Blackboard — use `write_to_blackboard` / `read_from_blackboard`.");
  return lines.join("\n");
}
