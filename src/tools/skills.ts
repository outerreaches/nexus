import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import { loadSkills } from "../state/skills.js";

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function buildSkillMd(params: { name: string; description: string; triggers: string[]; instructions: string }): string {
  return [
    "---",
    `name: ${params.name}`,
    `description: ${params.description}`,
    `triggers: ${params.triggers.join(", ")}`,
    "---",
    "",
    params.instructions,
    "",
  ].join("\n");
}

export const skillCreate = defineTool({
  name: "skill_create",
  description:
    "Create a reusable skill (playbook) that persists across sessions. Skills are loaded into the system prompt and can be triggered by keywords. Use this to teach yourself new capabilities.",
  parameters: z.object({
    name: z.string().min(1).max(60).describe("Skill name (lowercase, dashes allowed)"),
    description: z.string().min(1).max(200).describe("Short description of what the skill does"),
    triggers: z.array(z.string().max(50)).max(10).default([]).describe("Keywords that should activate this skill"),
    instructions: z.string().min(1).max(4000).describe("Detailed instructions for executing this skill"),
  }),
  execute: async (args, ctx) => {
    const dirName = sanitizeName(args.name);
    if (!dirName) return "ERROR: invalid skill name";

    const skillDir = path.join(ctx.workspaceDir, "skills", dirName);

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
        buildSkillMd({ name: dirName, description: args.description, triggers: args.triggers, instructions: args.instructions }),
        "utf8",
      );
      return `OK: created skill "${dirName}" at skills/${dirName}/SKILL.md`;
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

export const skillList = defineTool({
  name: "skill_list",
  description: "List all learned skills with their descriptions and triggers.",
  parameters: z.object({}),
  execute: async (_args, ctx) => {
    const agentId = ctx.request?.agentId;
    const skills = await loadSkills(ctx.workspaceDir, agentId);

    if (skills.length === 0) return "No skills found. Use skill_create to teach yourself new capabilities.";

    const entries = skills.map((s) => ({
      name: s.name,
      description: s.description,
      triggers: s.triggers,
      instructions_preview: s.instructions.length > 200 ? s.instructions.slice(0, 200) + "..." : s.instructions,
    }));

    return JSON.stringify(entries, null, 2);
  },
});

export const skillUpdate = defineTool({
  name: "skill_update",
  description: "Update an existing skill's description, triggers, or instructions.",
  parameters: z.object({
    name: z.string().min(1).max(60).describe("Skill name to update"),
    description: z.string().min(1).max(200).optional(),
    triggers: z.array(z.string().max(50)).max(10).optional(),
    instructions: z.string().min(1).max(4000).optional(),
  }),
  execute: async (args, ctx) => {
    const dirName = sanitizeName(args.name);
    if (!dirName) return "ERROR: invalid skill name";

    const skillFile = path.join(ctx.workspaceDir, "skills", dirName, "SKILL.md");

    let existing: string;
    try {
      existing = await fs.readFile(skillFile, "utf8");
    } catch {
      return `ERROR: skill "${dirName}" not found`;
    }

    // Parse existing
    const agentId = ctx.request?.agentId;
    const skills = await loadSkills(ctx.workspaceDir, agentId);
    const current = skills.find((s) => s.name === dirName);
    if (!current) return `ERROR: skill "${dirName}" not found or unparseable`;

    const updated = buildSkillMd({
      name: dirName,
      description: args.description ?? current.description,
      triggers: args.triggers ?? current.triggers,
      instructions: args.instructions ?? current.instructions,
    });

    try {
      await fs.writeFile(skillFile, updated, "utf8");
      return `OK: updated skill "${dirName}"`;
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});
