import { loadPersonalizationContext, readPersonalizationFile, type PersonalizationContext } from "../state/personalization.js";
import { loadSkills, formatSkillsPromptSection } from "../state/skills.js";
import type { SkillsConfig } from "../state/config.js";
import { formatPresetsForPrompt } from "./presets.js";

type SkillsPromptOptions = SkillsConfig["prompt"];

export async function buildSystemPrompt(params: {
  stateDir: string;
  agentId?: string;
  presetSystemPrompt?: string;
  includeSkills?: boolean;
  skillsOptions?: SkillsPromptOptions;
}): Promise<string> {
  const includeSkills = params.includeSkills ?? true;
  const [ctx, skills] = await Promise.all([
    loadPersonalizationContext(params.stateDir, params.agentId),
    includeSkills ? loadSkills(params.stateDir, params.agentId) : Promise.resolve([]),
  ]);
  return formatSystemPrompt(
    ctx,
    includeSkills ? formatSkillsPromptSection(skills, params.skillsOptions) : null,
    params.presetSystemPrompt,
  );
}

export async function buildPresetSystemPrompt(params: {
  stateDir: string;
  agentId?: string;
  promptFiles?: string[];
  systemPrompt?: string;
  includePresets?: boolean;
  /** When set, only these preset names are listed. Omit for full list. */
  presetFilter?: string[];
  includeSkills?: boolean;
  skillsOptions?: SkillsPromptOptions;
}): Promise<string> {
  const promptFiles = params.promptFiles ?? [];
  const sections: string[] = [];
  const includeSkills = params.includeSkills ?? false;
  const loadedPromptFilesPromise = promptFiles.length > 0
    ? Promise.all(promptFiles.map((filename) => readPersonalizationFile(params.stateDir, filename, params.agentId)))
    : Promise.resolve<string[]>([]);
  const loadedSkillsPromise = includeSkills
    ? loadSkills(params.stateDir, params.agentId)
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
  if (includeSkills) {
    const skillsSection = formatSkillsPromptSection(loadedSkills, params.skillsOptions);
    if (skillsSection) {
      sections.push(skillsSection);
    }
  }
  if (params.includePresets) {
    sections.push(formatPresetsForPrompt(params.presetFilter));
  }
  return sections.filter(Boolean).join("\n\n---\n\n");
}

function formatSystemPrompt(ctx: PersonalizationContext, skillsSection: string | null, presetSystemPrompt?: string): string {
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

  // Runtime notes (always appended — routing/delegation rules live in the orchestrator preset)
  sections.push(
    [
      "## Runtime Notes",
      "- **Blackboard hygiene**: When switching between unrelated tasks, prune the blackboard. Use `blackboard_manage` with `action=\"delete\"` for specific IDs, `action=\"clear\"` for scope resets, or `action=\"prune\"` for age/TTL cleanup.",
      "- Credential vault management is operator-only via sidecar workflows (`infra/scripts/ha-secretctl.sh` / `infra/scripts/ha-secrets-onboard.sh`). Never ask users for raw secrets in chat; use secret refs and runbook handoff (`infra/internal-doc`).",
      "- MCP profiles are MCP-only by default. If a task truly requires extra non-MCP tools, explicitly opt in with `allowNonMcpTools=true` and only the minimum specific tools.",
      "- Use `memory_store`/`memory_recall`/`memory_search` to persist learnings; use `skill_create` for reusable playbooks.",
      "- Tool availability is determined by the runtime function-calling schema for this run. Do not claim a tool is unavailable from memory; if uncertain, attempt the tool call and rely on explicit runtime errors.",
      "- Tool errors include `[ERROR_CLASS=... retry=...]` tags. Do not retry `validation_error`/`not_found`/`capability_mismatch` without fixing inputs. Retry `transient_provider_error` once with reduced scope; back off for `rate_limited`.",
      "- For exploratory shell probes, use non-fatal commands (`|| true`) with explicit YES/NO markers.",
      "- To notify users from non-telegram contexts, use `telegram_send`. For human help (OTP/MFA/CAPTCHA), call `human_action` with `action=\"request\"`.",
      "- Use absolute paths for file tools. Personality/state files (SOUL.md, etc.) live under the state directory; prefer `file_edit`/`file_edit_lines` for updates.",
      "- Memory tiers: keep hot critical facts in `AGENTS.md`; use `MEMORY.md` as an authoritative archive with timestamps/source; keep temporary scratch in `NOTES.md`.",
      "- When you change your own prompts, tools, or code, leave a short note in `NOTES.md`.",
      "- Runtime clock context is provided as a per-run system message near the latest user turn. For current events/time-sensitive topics, use that year/date in searches and task planning.",
    ].join("\n"),
  );

  return sections.filter(Boolean).join("\n\n---\n\n");
}

export { loadPersonalizationContext, type PersonalizationContext };
