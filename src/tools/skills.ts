import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { getPreset } from "../core/presets.js";
import { defineTool, type ToolContext } from "../core/tools.js";
import { canUseSkillManageTools, canUseSkillReadTools } from "../state/skill-policy.js";
import { loadSkills, normalizeSkillReference, resolveSkillReferencePath } from "../state/skills.js";

const MAX_SKILL_REFERENCES = 20;
const DEFAULT_REFERENCE_CHAR_LIMIT = 1600;
const MAX_REFERENCE_CHAR_LIMIT = 16_000;
type SkillScope = "global" | "preset";

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function normalizeReferences(raw: string[] | undefined): { references: string[]; invalid: string[] } {
  if (!raw || raw.length === 0) return { references: [], invalid: [] };
  const references: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const normalized = normalizeSkillReference(entry);
    if (!normalized) {
      invalid.push(entry);
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    references.push(normalized);
  }
  return { references, invalid };
}

function buildSkillMd(params: {
  name: string;
  description: string;
  triggers: string[];
  references: string[];
  instructions: string;
}): string {
  const frontmatterLines = [
    "---",
    `name: ${params.name}`,
    `description: ${params.description}`,
    `triggers: ${params.triggers.join(", ")}`,
    ...(params.references.length > 0 ? [`references: ${params.references.join(", ")}`] : []),
    "---",
  ];
  return [...frontmatterLines, "", params.instructions, ""].join("\n");
}

function skillAccessContext(ctx: ToolContext): { agentId?: string; preset?: string } {
  return {
    agentId: ctx.request?.agentId,
    preset: ctx.request?.preset,
  };
}

function resolvePresetSkillTarget(ctx: ToolContext, targetPreset?: string): { presetName?: string; error?: string } {
  const requested = targetPreset?.trim();
  if (requested) {
    const preset = getPreset(requested);
    if (!preset) {
      return { error: `ERROR: target preset "${requested}" not found.` };
    }
    return { presetName: preset.name };
  }

  const callerPreset = ctx.request?.preset?.trim();
  if (callerPreset) {
    return { presetName: callerPreset };
  }

  return { error: "ERROR: preset-scoped skills require a preset context or targetPreset." };
}

function resolveSkillScopeTarget(
  ctx: ToolContext,
  scope: SkillScope,
  targetPreset?: string,
): { skillsRoot?: string; scopeLabel?: string; presetName?: string; error?: string } {
  if (scope === "global") {
    if (targetPreset?.trim()) {
      return { error: "ERROR: targetPreset is only valid when scope='preset'." };
    }
    return {
      skillsRoot: path.join(ctx.stateDir, "skills"),
      scopeLabel: "global",
    };
  }

  const resolved = resolvePresetSkillTarget(ctx, targetPreset);
  if (resolved.error) return resolved;
  return {
    presetName: resolved.presetName,
    skillsRoot: path.join(ctx.stateDir, "presets", resolved.presetName!, "skills"),
    scopeLabel: `preset:${resolved.presetName}`,
  };
}

function defaultScope(ctx: ToolContext): SkillScope {
  const preset = ctx.request?.preset;
  if (!preset || preset === "orchestrator") return "global";
  return "preset";
}

async function loadSkillsForScope(ctx: ToolContext, scope: SkillScope, targetPreset?: string) {
  if (scope === "global") {
    return loadSkills(ctx.stateDir);
  }
  const resolved = resolvePresetSkillTarget(ctx, targetPreset);
  if (resolved.error) {
    return resolved.error;
  }
  return loadSkills(ctx.stateDir, undefined, resolved.presetName, { excludeGlobal: true });
}

function requireSkillReadAccess(ctx: ToolContext): string | null {
  if (canUseSkillReadTools(ctx.skillsConfig, skillAccessContext(ctx))) return null;
  return "ERROR: skill read tools are disabled for this agent/preset.";
}

function requireSkillManageAccess(ctx: ToolContext): string | null {
  if (canUseSkillManageTools(ctx.skillsConfig, skillAccessContext(ctx))) return null;
  return "ERROR: skill management tools are disabled for this agent/preset.";
}

export const skillCreate = defineTool({
  name: "skill_create",
  description:
    "Create a reusable skill (playbook) that persists across sessions. Skills are loaded into the system prompt and can be triggered by keywords. Use this to teach yourself new capabilities.",
  parameters: z.object({
    name: z.string().min(1).max(60).describe("Skill name (lowercase, dashes allowed)"),
    description: z.string().min(1).max(200).describe("Short description of what the skill does"),
    triggers: z.array(z.string().max(50)).max(10).default([]).describe("Keywords that should activate this skill"),
    references: z
      .array(z.string().max(200))
      .max(MAX_SKILL_REFERENCES)
      .default([])
      .describe("Relative file paths under the skill directory (e.g. references/runbook.md)"),
    instructions: z.string().min(1).max(4000).describe("Detailed instructions for executing this skill"),
    scope: z.enum(["global", "preset"]).optional().describe("Skill scope: 'global' for shared skills, 'preset' for preset-specific. Defaults based on caller preset."),
    targetPreset: z.string().min(1).max(80).optional().describe("When scope='preset', write the skill for this preset instead of the caller preset."),
  }),
  execute: async (args, ctx) => {
    const blocked = requireSkillManageAccess(ctx);
    if (blocked) return blocked;

    const dirName = sanitizeName(args.name);
    if (!dirName) return "ERROR: invalid skill name";
    const refs = normalizeReferences(args.references);
    if (refs.invalid.length > 0) {
      return `ERROR: invalid reference path(s): ${refs.invalid.join(", ")}. Use relative paths under the skill directory.`;
    }

    const scope: SkillScope = args.scope ?? (args.targetPreset ? "preset" : defaultScope(ctx));
    const target = resolveSkillScopeTarget(ctx, scope, args.targetPreset);
    if (target.error) return target.error;
    const skillsRoot = target.skillsRoot!;
    const skillDir = path.join(skillsRoot, dirName);

    try {
      await fs.access(path.join(skillDir, "SKILL.md"));
      return `ERROR: skill "${dirName}" already exists. Use skill_update to modify it.`;
    } catch {
      // Does not exist — proceed
    }

    try {
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        buildSkillMd({
          name: dirName,
          description: args.description,
          triggers: args.triggers,
          references: refs.references,
          instructions: args.instructions,
        }),
        "utf8",
      );
      return `OK: created skill "${dirName}" (scope=${target.scopeLabel})`;
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

export const skillList = defineTool({
  name: "skill_list",
  description: "List learned skills with descriptions, triggers, and reference metadata.",
  parameters: z.object({}),
  execute: async (_args, ctx) => {
    const blocked = requireSkillReadAccess(ctx);
    if (blocked) return blocked;

    const agentId = ctx.request?.agentId;
    const presetName = ctx.request?.preset;
    const skills = await loadSkills(ctx.stateDir, agentId, presetName);

    if (skills.length === 0) return "No skills found. Use skill_create to teach reusable capabilities.";

    const entries = skills.map((s) => ({
      name: s.name,
      description: s.description,
      triggers: s.triggers,
      references: s.references,
      reference_count: s.references.length,
      instructions_preview: s.instructions.length > 200 ? s.instructions.slice(0, 200) + "..." : s.instructions,
    }));

    return JSON.stringify(entries);
  },
});

export const skillGet = defineTool({
  name: "skill_get",
  description:
    "Get full skill details. Optionally include referenced file contents resolved relative to the skill directory.",
  parameters: z.object({
    name: z.string().min(1).max(60).describe("Skill name"),
    includeInstructions: z.boolean().default(true).describe("Include full SKILL.md instructions body."),
    includeReferences: z.boolean().default(true).describe("Include reference path metadata."),
    includeReferenceContents: z.boolean().default(true).describe("When true, read and return referenced file contents."),
    maxReferenceChars: z
      .number()
      .int()
      .min(200)
      .max(MAX_REFERENCE_CHAR_LIMIT)
      .optional()
      .describe("Per-reference content cap when includeReferenceContents=true."),
  }),
  execute: async (args, ctx) => {
    const blocked = requireSkillReadAccess(ctx);
    if (blocked) return blocked;

    const dirName = sanitizeName(args.name);
    if (!dirName) return "ERROR: invalid skill name";

    const skills = await loadSkills(ctx.stateDir, ctx.request?.agentId, ctx.request?.preset);
    const skill =
      skills.find((entry) => sanitizeName(entry.name) === dirName) ??
      skills.find((entry) => entry.name.trim().toLowerCase() === dirName);
    if (!skill) return `ERROR: skill "${dirName}" not found`;

    const maxReferenceChars = Math.max(
      200,
      Math.min(
        args.maxReferenceChars ?? ctx.skillsConfig?.prompt.maxReferenceChars ?? DEFAULT_REFERENCE_CHAR_LIMIT,
        MAX_REFERENCE_CHAR_LIMIT,
      ),
    );

    const payload: Record<string, unknown> = {
      name: skill.name,
      description: skill.description,
      triggers: skill.triggers,
      reference_count: skill.references.length,
    };
    if (args.includeInstructions) {
      payload.instructions = skill.instructions;
    }

    if (args.includeReferences) {
      const references: Array<Record<string, unknown>> = [];
      for (const reference of skill.references) {
        const entry: Record<string, unknown> = { reference };
        const absolute = resolveSkillReferencePath(skill, reference);
        if (!absolute) {
          entry.status = "invalid";
          references.push(entry);
          continue;
        }
        entry.status = "ok";
        if (args.includeReferenceContents) {
          try {
            const content = await fs.readFile(absolute, "utf8");
            const trimmed = content.length > maxReferenceChars ? `${content.slice(0, maxReferenceChars)}\n…(truncated)` : content;
            entry.content = trimmed;
            entry.truncated = content.length > maxReferenceChars;
          } catch (err) {
            entry.status = "unreadable";
            entry.error = err instanceof Error ? err.message : String(err);
          }
        }
        references.push(entry);
      }
      payload.references = references;
      payload.max_reference_chars = maxReferenceChars;
    }

    return JSON.stringify(payload);
  },
});

export const skillUpdate = defineTool({
  name: "skill_update",
  description: "Update an existing skill's description, triggers, references, or instructions.",
  parameters: z.object({
    name: z.string().min(1).max(60).describe("Skill name to update"),
    description: z.string().min(1).max(200).optional(),
    triggers: z.array(z.string().max(50)).max(10).optional(),
    references: z.array(z.string().max(200)).max(MAX_SKILL_REFERENCES).optional(),
    instructions: z.string().min(1).max(4000).optional(),
    scope: z.enum(["global", "preset"]).optional().describe("Optional scope filter when updating a specific shared or preset-scoped skill."),
    targetPreset: z.string().min(1).max(80).optional().describe("When scope='preset', update the skill owned by this preset."),
  }),
  execute: async (args, ctx) => {
    const blocked = requireSkillManageAccess(ctx);
    if (blocked) return blocked;

    const dirName = sanitizeName(args.name);
    if (!dirName) return "ERROR: invalid skill name";

    const scope: SkillScope | undefined = args.scope ?? (args.targetPreset ? "preset" : undefined);
    const loadedSkills = scope
      ? await loadSkillsForScope(ctx, scope, args.targetPreset)
      : await loadSkills(ctx.stateDir, ctx.request?.agentId, ctx.request?.preset);
    if (typeof loadedSkills === "string") {
      return loadedSkills;
    }
    const skills = loadedSkills;
    const current = skills.find((s) => sanitizeName(s.name) === dirName);
    if (!current) return `ERROR: skill "${dirName}" not found or unparseable`;
    const refs = normalizeReferences(args.references ?? current.references);
    if (refs.invalid.length > 0) {
      return `ERROR: invalid reference path(s): ${refs.invalid.join(", ")}. Use relative paths under the skill directory.`;
    }

    const updated = buildSkillMd({
      name: dirName,
      description: args.description ?? current.description,
      triggers: args.triggers ?? current.triggers,
      references: refs.references,
      instructions: args.instructions ?? current.instructions,
    });

    try {
      await fs.writeFile(current.skillFile, updated, "utf8");
      return `OK: updated skill "${dirName}"`;
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});
