import { preset as analyst } from "./presets/analyst.js";
import { preset as coder } from "./presets/coder.js";
import { preset as graphicDesigner } from "./presets/graphic-designer.js";
import { preset as orchestrator } from "./presets/orchestrator.js";
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
  /** Skill prompt loading policy for this preset. Tool access remains controlled by `tools`. */
  skillAccess?: {
    /** Include shared/global skills from stateDir/skills in this preset's prompt. */
    promptGlobal?: boolean;
    /** Include preset-scoped skills from stateDir/presets/<name>/skills in this preset's prompt. */
    promptPreset?: boolean;
  };
  /** Tool name whitelist — only these tools are available to this preset.
   *  Acts as the full pool the agent may load on demand. */
  tools: string[];
  /** Subset of `tools` always loaded into the LLM schema. Tools in `tools` but
   *  not in `kernel` are discoverable via `tool_search` and materialized via
   *  `tool_load`. If `kernel` is omitted, the entire `tools` list is loaded
   *  (legacy behavior). */
  kernel?: string[];
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
  coder,
  researcher,
  "security-researcher": securityResearcher,
  trader,
  analyst,
  "graphic-designer": graphicDesigner,
};

const DYNAMIC_PRESETS = new Map<string, AgentPreset>();

// Operator-configured per-preset kernel additions (nexus.json `presets.<name>.
// kernelExtra`). Promoting a tool into the kernel makes it visible to the LLM
// every turn, skipping the `tool_load` discovery round-trip — useful on
// large-context deployments where the extra schema tokens are cheap relative to
// the per-turn latency saved. Applied at process startup via
// `setPresetKernelOverrides`; the isolated worker re-applies its preset's entry
// from the serialized worker config so sub-agents honor the same tuning.
let kernelOverrides: Record<string, readonly string[]> = {};

export function setPresetKernelOverrides(overrides: Record<string, readonly string[]>): void {
  kernelOverrides = { ...overrides };
}

/** The configured kernelExtra list for a preset (empty if none). Used by the
 *  spawn path to forward the relevant entry into the isolated worker config. */
export function getPresetKernelExtra(name: string): readonly string[] {
  return kernelOverrides[name] ?? [];
}

/** Apply the nexus.json `presets` config (per-preset `kernelExtra`) to the
 *  kernel-override registry. Call once at process startup after config load. */
export function applyPresetConfigOverrides(
  presetsConfig: Record<string, { kernelExtra?: readonly string[] }> | undefined,
): void {
  const map: Record<string, readonly string[]> = {};
  for (const [name, cfg] of Object.entries(presetsConfig ?? {})) {
    const extra = cfg?.kernelExtra;
    if (extra && extra.length > 0) map[name] = [...extra];
  }
  setPresetKernelOverrides(map);
}

/** Merge configured kernelExtra into a preset's kernel. Only tools the preset
 *  is actually allowed (`tools`) can be promoted, and only when lazy loading is
 *  active (a non-empty `kernel`); otherwise the override is a no-op and the base
 *  preset is returned unchanged (preserving object identity). */
function applyKernelOverride(preset: AgentPreset): AgentPreset {
  const extra = kernelOverrides[preset.name];
  if (!extra || extra.length === 0) return preset;
  if (!preset.kernel || preset.kernel.length === 0) return preset;
  const allowed = new Set(preset.tools);
  const promoted = extra.filter((t) => allowed.has(t) && !preset.kernel!.includes(t));
  if (promoted.length === 0) return preset;
  return { ...preset, kernel: [...preset.kernel, ...promoted] };
}

export function getPreset(name: string): AgentPreset | undefined {
  const base = DYNAMIC_PRESETS.get(name) ?? PRESETS[name];
  if (!base) return undefined;
  return applyKernelOverride(base);
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
