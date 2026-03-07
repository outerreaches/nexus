import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

export type SkillEntry = {
  name: string;
  description: string;
  triggers: string[];
  instructions: string;
  references: string[];
  categoryPath: string | null;
  skillDir: string;
  skillFile: string;
};

type SkillPromptFormatOptions = {
  maxInlineSkills?: number;
  includeReferences?: boolean;
  maxReferencesPerSkill?: number;
};

export function normalizeSkillReference(input: string): string | null {
  const trimmed = input.trim().replace(/\\/g, "/");
  if (!trimmed) return null;
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return null;
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

export function resolveSkillReferencePath(skill: SkillEntry, reference: string): string | null {
  const normalized = normalizeSkillReference(reference);
  if (!normalized) return null;
  const absolute = path.resolve(skill.skillDir, normalized);
  const relative = path.relative(skill.skillDir, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return absolute;
}

/**
 * Parse a SKILL.md file with simple frontmatter.
 *
 * Expected format:
 * ```
 * ---
 * name: skill-name
 * description: What this skill does
 * triggers: keyword1, keyword2
 * references: references/runbook.md, references/examples.txt
 * ---
 * Instructions body here...
 * ```
 */
function parseSkillMd(raw: string, paths: { skillDir: string; skillFile: string }): SkillEntry | null {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = match[2].trim();

  let name = "";
  let description = "";
  let triggers: string[] = [];
  let references: string[] = [];

  for (const line of frontmatter.split("\n")) {
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (!key || !value) continue;
    const k = key.trim().toLowerCase();
    if (k === "name") name = value;
    else if (k === "description") description = value;
    else if (k === "triggers") triggers = value.split(",").map((t) => t.trim()).filter(Boolean);
    else if (k === "references") {
      references = value
        .split(",")
        .map((item) => normalizeSkillReference(item))
        .filter((item): item is string => Boolean(item));
    }
  }

  if (!name) return null;
  return {
    name,
    description,
    triggers,
    instructions: body,
    references,
    categoryPath: null,
    skillDir: paths.skillDir,
    skillFile: paths.skillFile,
  };
}

function resolveSkillCategoryPath(skillDir: string, skillsRoot: string): string | null {
  const relative = path.relative(skillsRoot, skillDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join("/");
}

async function discoverSkillDirs(rootDir: string, maxDepth: number = 6): Promise<string[]> {
  const discovered: string[] = [];

  async function walk(currentDir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    // Deterministic traversal makes prompt/debug behavior less surprising.
    entries.sort((a, b) => a.name.localeCompare(b.name));

    const hasSkillFile = entries.some((entry) => entry.isFile() && entry.name === "SKILL.md");
    if (hasSkillFile) {
      discovered.push(currentDir);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      await walk(path.join(currentDir, entry.name), depth + 1);
    }
  }

  await walk(rootDir, 0);
  return discovered;
}

/**
 * Load all skills from `{stateDir}/skills/` (or agent/preset-specific override).
 * Skills are discovered recursively so categorized trees like
 * `skills/operations/node-ops/SKILL.md` are supported.
 *
 * Lookup order (first match wins via dedup):
 * 1. `{stateDir}/agents/{agentId}/skills/` (agent override)
 * 2. `{stateDir}/presets/{presetName}/skills/` (preset-scoped)
 * 3. `{stateDir}/skills/` (global)
 */
export async function loadSkills(stateDir: string, agentId?: string, presetName?: string, opts?: { excludeGlobal?: boolean }): Promise<SkillEntry[]> {
  const roots = [
    ...(agentId ? [path.join(stateDir, "agents", agentId, "skills")] : []),
    ...(presetName ? [path.join(stateDir, "presets", presetName, "skills")] : []),
    ...(!opts?.excludeGlobal ? [path.join(stateDir, "skills")] : []),
  ];

  const skills: SkillEntry[] = [];
  const seen = new Set<string>();

  for (const skillsRoot of roots) {
    const skillDirs = await discoverSkillDirs(skillsRoot);
    for (const skillDir of skillDirs) {
      const skillPath = path.join(skillDir, "SKILL.md");
      try {
        const raw = await fs.readFile(skillPath, "utf8");
        const skill = parseSkillMd(raw, { skillDir, skillFile: skillPath });
        if (skill && !seen.has(skill.name)) {
          skill.categoryPath = resolveSkillCategoryPath(skillDir, skillsRoot);
          seen.add(skill.name);
          skills.push(skill);
        }
      } catch {
        // Not a valid skill directory, skip
      }
    }
  }

  return skills;
}

/**
 * Format skills into a prompt section.
 * If within maxInlineSkills, include full instructions. Otherwise, list concise summaries.
 */
export function formatSkillsPromptSection(skills: SkillEntry[], opts: SkillPromptFormatOptions = {}): string | null {
  if (skills.length === 0) return null;
  const maxInlineSkills = Math.max(0, Math.floor(opts.maxInlineSkills ?? 5));
  const includeReferences = opts.includeReferences ?? true;
  const maxReferencesPerSkill = Math.max(0, Math.floor(opts.maxReferencesPerSkill ?? 2));

  const lines: string[] = ["## Learned Skills"];

  if (skills.length <= maxInlineSkills) {
    for (const s of skills) {
      lines.push("");
      lines.push(`### ${s.name}`);
      if (s.description) lines.push(s.description);
      lines.push(`Category: ${s.categoryPath ?? "root"}`);
      if (s.triggers.length > 0) lines.push(`Triggers: ${s.triggers.join(", ")}`);
      if (includeReferences && s.references.length > 0) {
        const refs = s.references.slice(0, maxReferencesPerSkill);
        const remaining = s.references.length - refs.length;
        lines.push(
          `References: ${refs.join(", ")}${remaining > 0 ? ` (+${remaining} more)` : ""}`,
        );
      }
      if (s.instructions) {
        lines.push("");
        lines.push(s.instructions);
      }
    }
  } else {
    lines.push("Use `skill_list` to browse skills and `skill_get` for full instructions/references.");
    lines.push("Available skills:");
    lines.push("");
    for (const s of skills) {
      const triggerHint = s.triggers.length > 0 ? ` (triggers: ${s.triggers.join(", ")})` : "";
      const referenceHint = includeReferences && s.references.length > 0 ? ` [refs: ${s.references.length}]` : "";
      const categoryHint = ` [category: ${s.categoryPath ?? "root"}]`;
      lines.push(`- **${s.name}**: ${s.description}${categoryHint}${triggerHint}${referenceHint}`);
    }
  }

  return lines.join("\n");
}
