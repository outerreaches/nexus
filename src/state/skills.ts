import fs from "node:fs/promises";
import path from "node:path";

export type SkillEntry = {
  name: string;
  description: string;
  triggers: string[];
  instructions: string;
};

/**
 * Parse a SKILL.md file with simple frontmatter.
 *
 * Expected format:
 * ```
 * ---
 * name: skill-name
 * description: What this skill does
 * triggers: keyword1, keyword2
 * ---
 * Instructions body here...
 * ```
 */
function parseSkillMd(raw: string): SkillEntry | null {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = match[2].trim();

  let name = "";
  let description = "";
  let triggers: string[] = [];

  for (const line of frontmatter.split("\n")) {
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (!key || !value) continue;
    const k = key.trim().toLowerCase();
    if (k === "name") name = value;
    else if (k === "description") description = value;
    else if (k === "triggers") triggers = value.split(",").map((t) => t.trim()).filter(Boolean);
  }

  if (!name) return null;
  return { name, description, triggers, instructions: body };
}

/**
 * Load all skills from `{stateDir}/skills/` (or agent-specific override).
 * Each skill is a directory containing a SKILL.md file.
 */
export async function loadSkills(stateDir: string, agentId?: string): Promise<SkillEntry[]> {
  const dirs = [
    ...(agentId ? [path.join(stateDir, "agents", agentId, "skills")] : []),
    path.join(stateDir, "skills"),
  ];

  const skills: SkillEntry[] = [];
  const seen = new Set<string>();

  for (const skillsDir of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(skillsDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const skillPath = path.join(skillsDir, entry, "SKILL.md");
      try {
        const raw = await fs.readFile(skillPath, "utf8");
        const skill = parseSkillMd(raw);
        if (skill && !seen.has(skill.name)) {
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
 * If ≤5 skills, include full instructions. Otherwise, just list names + triggers.
 */
export function formatSkillsPromptSection(skills: SkillEntry[]): string | null {
  if (skills.length === 0) return null;

  const lines: string[] = ["## Learned Skills"];

  if (skills.length <= 5) {
    for (const s of skills) {
      lines.push("");
      lines.push(`### ${s.name}`);
      if (s.description) lines.push(s.description);
      if (s.triggers.length > 0) lines.push(`Triggers: ${s.triggers.join(", ")}`);
      if (s.instructions) {
        lines.push("");
        lines.push(s.instructions);
      }
    }
  } else {
    lines.push("Use `skill_list` to see full details. Available skills:");
    lines.push("");
    for (const s of skills) {
      const triggerHint = s.triggers.length > 0 ? ` (triggers: ${s.triggers.join(", ")})` : "";
      lines.push(`- **${s.name}**: ${s.description}${triggerHint}`);
    }
  }

  return lines.join("\n");
}
