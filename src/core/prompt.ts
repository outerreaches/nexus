import { loadPersonalizationContext, readPersonalizationFile, type PersonalizationContext } from "../state/personalization.js";
import { loadSkills, formatSkillsPromptSection } from "../state/skills.js";
import type { SkillsConfig } from "../state/config.js";
import type { SkillScopes } from "../state/skill-policy.js";
import { formatPresetsForPrompt } from "./presets.js";

type SkillsPromptOptions = SkillsConfig["prompt"];

export async function buildSystemPrompt(params: {
  stateDir: string;
  agentId?: string;
  presetName?: string;
  presetSystemPrompt?: string;
  skillScopes?: SkillScopes;
  skillsOptions?: SkillsPromptOptions;
  /** Inbound channel name (telegram, cli, ...) for the routing hint. Stable per session. */
  channel?: string;
}): Promise<string> {
  const scopes = params.skillScopes ?? { global: true, preset: false };
  const shouldLoad = scopes.global || scopes.preset;
  const [ctx, skills] = await Promise.all([
    loadPersonalizationContext(params.stateDir, params.agentId),
    shouldLoad ? loadSkills(params.stateDir, params.agentId, scopes.preset ? params.presetName : undefined, { excludeGlobal: !scopes.global }) : Promise.resolve([]),
  ]);
  return formatSystemPrompt(
    ctx,
    shouldLoad ? formatSkillsPromptSection(skills, params.skillsOptions) : null,
    params.presetSystemPrompt,
    params.channel,
  );
}

export async function buildPresetSystemPrompt(params: {
  stateDir: string;
  agentId?: string;
  presetName?: string;
  promptFiles?: string[];
  systemPrompt?: string;
  includePresets?: boolean;
  /** When set, only these preset names are listed. Omit for full list. */
  presetFilter?: string[];
  skillScopes?: SkillScopes;
  skillsOptions?: SkillsPromptOptions;
  /** Inbound channel name (telegram, cli, ...) for the routing hint. Stable per session. */
  channel?: string;
}): Promise<string> {
  const promptFiles = params.promptFiles ?? [];
  const sections: string[] = [];
  const scopes = params.skillScopes ?? { global: false, preset: false };
  const shouldLoad = scopes.global || scopes.preset;
  const loadedPromptFilesPromise = promptFiles.length > 0
    ? Promise.all(promptFiles.map((filename) => readPersonalizationFile(params.stateDir, filename, params.agentId)))
    : Promise.resolve<string[]>([]);
  const loadedSkillsPromise = shouldLoad
    ? loadSkills(params.stateDir, params.agentId, scopes.preset ? params.presetName : undefined, { excludeGlobal: !scopes.global })
    : Promise.resolve([]);

  const [loadedPromptFiles, loadedSkills] = await Promise.all([loadedPromptFilesPromise, loadedSkillsPromise]);

  if (loadedPromptFiles.length > 0) {
    const loaded = loadedPromptFiles;
    for (const content of loaded) {
      if (content && content.trim()) {
        sections.push(content.trim());
      }
    }
  }
  if (params.systemPrompt?.trim()) {
    sections.push(params.systemPrompt.trim());
  }
  if (shouldLoad) {
    const skillsSection = formatSkillsPromptSection(loadedSkills, params.skillsOptions);
    if (skillsSection) {
      sections.push(skillsSection);
    }
  }
  if (params.includePresets) {
    sections.push(formatPresetsForPrompt(params.presetFilter));
  }
  const channelHint = formatChannelRoutingHint(params.channel);
  if (channelHint) sections.push(channelHint);
  return sections.filter(Boolean).join("\n\n---\n\n");
}

function formatChannelRoutingHint(channel?: string): string | null {
  // Stable per session — kept inside the cached system prompt rather than reshipped
  // as a per-turn ephemeral hint, so it lives behind the cache breakpoint.
  if (!channel) return null;
  const normalized = channel.trim();
  if (!normalized) return null;
  if (normalized !== "telegram" && normalized !== "cli") return null;
  return `## Channel\n\nCurrent inbound channel is ${normalized}; deliver your final user-facing response on this channel unless a tool explicitly sends output elsewhere.`;
}

function formatSystemPrompt(ctx: PersonalizationContext, skillsSection: string | null, presetSystemPrompt?: string, channel?: string): string {
  const sections: string[] = [];

  // Core identity and personality (SOUL.md)
  if (ctx.soul) {
    sections.push(ctx.soul.trim());
  }

  // Operating instructions (AGENTS.md)
  if (ctx.agents) {
    sections.push(ctx.agents.trim());
  }

  // User profile context (USER.md)
  if (ctx.user) {
    sections.push(ctx.user.trim());
  }

  // Learned skills (from stateDir/skills/*/SKILL.md)
  if (skillsSection) {
    sections.push(skillsSection);
  }

  // Multi-agent presets (always included so orchestrator knows what it can spawn)
  sections.push(formatPresetsForPrompt());

  // Proactive tasks (HEARTBEAT.md) - optional, only if non-empty
  if (ctx.heartbeat && ctx.heartbeat.trim().length > 50) {
    sections.push(ctx.heartbeat.trim());
  }

  // Preset-specific instructions (e.g. orchestrator.ts systemPrompt)
  if (presetSystemPrompt?.trim()) {
    sections.push(["## Preset Instructions", presetSystemPrompt.trim()].join("\n"));
  }

  // Stable per-session channel routing hint, kept inside the cached system prompt.
  const channelHint = formatChannelRoutingHint(channel);
  if (channelHint) sections.push(channelHint);

  // Runtime notes — keep this section minimal. Anything situation-specific
  // should live in a skill the agent can discover via `skill_search`.
  sections.push(
    [
      "## Runtime Notes",
      "- Tool availability is the runtime function-calling schema for this turn. If a tool you need isn't visible, call `tool_search` to find it and `tool_load` to surface it on the next turn — never claim a tool is unavailable from memory.",
      "- Tool errors include `[ERROR_CLASS=... retry=...]` tags. Do not retry `validation_error`/`not_found`/`capability_mismatch` without fixing inputs. Retry `transient_provider_error` once with reduced scope; back off for `rate_limited`.",
      "- Use absolute paths for file tools. Personality/state files (SOUL.md, etc.) live under the state directory.",
      "- Runtime clock context is provided as a per-run system message near the latest user turn. For current events/time-sensitive topics, use that year/date in searches and task planning.",
    ].join("\n"),
  );

  return sections.filter(Boolean).join("\n\n---\n\n");
}

export { loadPersonalizationContext, type PersonalizationContext };
