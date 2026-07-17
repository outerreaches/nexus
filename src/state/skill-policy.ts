import { getPreset } from "../core/presets.js";
import type { Tool } from "../core/tools.js";
import type { SkillsConfig } from "./config.js";

export type SkillAccessContext = {
  agentId?: string | null;
  preset?: string | null;
};

const SKILL_TOOL_NAMES = new Set(["skill_list", "skill_search", "skill_get", "skill_create", "skill_update"]);

function normalize(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function resolvePreset(ctx: SkillAccessContext) {
  const presetName = normalize(ctx.preset);
  if (!presetName) return undefined;
  return getPreset(presetName);
}

export function canInjectSkillsPrompt(config: SkillsConfig | undefined, ctx: SkillAccessContext): boolean {
  const preset = resolvePreset(ctx);
  if (config?.enabled === false || config?.prompt.enabled === false) return false;
  if (!preset) return true;
  return preset.skillAccess?.promptGlobal === true;
}

export function canInjectPresetScopedSkills(config: SkillsConfig | undefined, ctx: SkillAccessContext): boolean {
  const preset = resolvePreset(ctx);
  if (config?.enabled === false || config?.prompt.enabled === false) return false;
  if (!preset) return false;
  return preset.skillAccess?.promptPreset === true;
}

export function canUseSkillReadTools(config: SkillsConfig | undefined, _ctx: SkillAccessContext): boolean {
  return config?.enabled !== false;
}

export function canUseSkillManageTools(config: SkillsConfig | undefined, _ctx: SkillAccessContext): boolean {
  return config?.enabled !== false;
}

export function isSkillToolAllowed(params: {
  toolName: string;
  config: SkillsConfig | undefined;
  ctx: SkillAccessContext;
}): boolean {
  const toolName = normalize(params.toolName);
  if (!SKILL_TOOL_NAMES.has(toolName)) return true;
  return params.config?.enabled !== false;
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
