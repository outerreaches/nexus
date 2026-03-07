import type { Tool } from "../core/tools.js";
import type { SkillsConfig } from "./config.js";

export type SkillAccessContext = {
  agentId?: string | null;
  preset?: string | null;
};

const SKILL_READ_TOOLS = new Set(["skill_list", "skill_get"]);
const SKILL_MANAGE_TOOLS = new Set(["skill_create", "skill_update"]);
const SKILL_TOOL_NAMES = new Set([...SKILL_READ_TOOLS, ...SKILL_MANAGE_TOOLS]);

function normalize(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hasMatch(values: string[], candidate: string): boolean {
  if (!candidate) return false;
  return values.some((value) => normalize(value) === candidate);
}

function isSkillAccessBlocked(config: SkillsConfig | undefined, ctx: SkillAccessContext): boolean {
  if (!config) return false;
  if (!config.enabled) return true;
  const agentId = normalize(ctx.agentId);
  const preset = normalize(ctx.preset);
  if (hasMatch(config.access.blockedAgents, agentId)) return true;
  if (hasMatch(config.access.blockedPresets, preset)) return true;
  return false;
}

function isPresetAllowed(allowList: string[], preset: string): boolean {
  if (allowList.length === 0) return true;
  if (!preset) return false;
  return hasMatch(allowList, preset);
}

export function canInjectSkillsPrompt(config: SkillsConfig | undefined, ctx: SkillAccessContext): boolean {
  if (!config) return true;
  if (!config.prompt.enabled) return false;
  if (isSkillAccessBlocked(config, ctx)) return false;
  const preset = normalize(ctx.preset);
  return isPresetAllowed(config.access.promptAllowedPresets, preset);
}

/**
 * Whether a preset can see its own preset-scoped skills in the prompt,
 * even if not listed in promptAllowedPresets. Requires presetSelfAccess=true
 * and the preset must not be blocked.
 */
export function canInjectPresetScopedSkills(config: SkillsConfig | undefined, ctx: SkillAccessContext): boolean {
  if (!config) return true;
  if (!config.prompt.enabled) return false;
  if (!config.access.presetSelfAccess) return false;
  if (isSkillAccessBlocked(config, ctx)) return false;
  return Boolean(normalize(ctx.preset));
}

export function canUseSkillReadTools(config: SkillsConfig | undefined, ctx: SkillAccessContext): boolean {
  if (!config) return true;
  if (isSkillAccessBlocked(config, ctx)) return false;
  const preset = normalize(ctx.preset);
  return isPresetAllowed(config.access.readAllowedPresets, preset);
}

export function canUseSkillManageTools(config: SkillsConfig | undefined, ctx: SkillAccessContext): boolean {
  if (!config) return true;
  if (isSkillAccessBlocked(config, ctx)) return false;
  const preset = normalize(ctx.preset);
  return isPresetAllowed(config.access.manageAllowedPresets, preset);
}

export function isSkillToolAllowed(params: {
  toolName: string;
  config: SkillsConfig | undefined;
  ctx: SkillAccessContext;
}): boolean {
  const toolName = normalize(params.toolName);
  if (!SKILL_TOOL_NAMES.has(toolName)) return true;
  if (SKILL_READ_TOOLS.has(toolName)) {
    return canUseSkillReadTools(params.config, params.ctx);
  }
  if (SKILL_MANAGE_TOOLS.has(toolName)) {
    return canUseSkillManageTools(params.config, params.ctx);
  }
  return false;
}

export type SkillScopes = { global: boolean; preset: boolean };

/**
 * Resolve which skill scopes a caller can see in the prompt.
 * Collapses canInjectSkillsPrompt + canInjectPresetScopedSkills into one call.
 */
export function resolveSkillScopes(config: SkillsConfig | undefined, ctx: SkillAccessContext): SkillScopes {
  return {
    global: canInjectSkillsPrompt(config, ctx),
    preset: canInjectPresetScopedSkills(config, ctx),
  };
}

export function filterToolsBySkillAccess(params: {
  tools: Tool[];
  config: SkillsConfig | undefined;
  ctx: SkillAccessContext;
}): Tool[] {
  return params.tools.filter((tool) =>
    isSkillToolAllowed({
      toolName: tool.name,
      config: params.config,
      ctx: params.ctx,
    }),
  );
}
