import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { formatSkillsPromptSection, loadSkills, resolveSkillReferencePath } from "./skills.js";

test("loadSkills parses references and resolves safe reference paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-skills-state-"));
  try {
    const skillDir = path.join(root, "skills", "codex-cli");
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: codex-cli",
        "description: Run codex workflows",
        "triggers: codex, cli",
        "references: references/usage.md, references/examples.md",
        "---",
        "",
        "Use codex for deep repo tasks.",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(path.join(skillDir, "references", "usage.md"), "usage", "utf8");

    const skills = await loadSkills(root);
    assert.equal(skills.length, 1);
    const skill = skills[0]!;
    assert.equal(skill.name, "codex-cli");
    assert.deepEqual(skill.references, ["references/usage.md", "references/examples.md"]);
    assert.equal(skill.categoryPath, null);

    const resolved = resolveSkillReferencePath(skill, "references/usage.md");
    assert.equal(resolved, path.join(skillDir, "references", "usage.md"));
    assert.equal(resolveSkillReferencePath(skill, "../secrets.txt"), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("formatSkillsPromptSection emits a compact category index pointing at skill_search/skill_get", () => {
  const skills = [
    {
      name: "a",
      description: "first",
      triggers: ["alpha"],
      instructions: "do A",
      references: ["references/a.md"],
      categoryPath: "operations",
      skillDir: "/tmp/skills/a",
      skillFile: "/tmp/skills/a/SKILL.md",
    },
    {
      name: "b",
      description: "second",
      triggers: [],
      instructions: "do B",
      references: [],
      categoryPath: null,
      skillDir: "/tmp/skills/b",
      skillFile: "/tmp/skills/b/SKILL.md",
    },
  ];

  const section = formatSkillsPromptSection(skills);
  assert.match(section ?? "", /skill_search/);
  assert.match(section ?? "", /skill_get/);
  // Categories appear as bullets with their member skill names.
  assert.match(section ?? "", /\*\*operations\*\*: a/);
  assert.match(section ?? "", /\*\*root\*\*: b/);
  // Instructions body must not leak into the system prompt.
  assert.equal(/do A/.test(section ?? ""), false);
  assert.equal(/do B/.test(section ?? ""), false);
});

test("loadSkills discovers nested categorized skill directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-skills-nested-"));
  try {
    const nestedSkillDir = path.join(root, "skills", "operations", "node-ops");
    await fs.mkdir(nestedSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(nestedSkillDir, "SKILL.md"),
      [
        "---",
        "name: node-ops",
        "description: Operate remote nodes",
        "triggers: node, deploy",
        "---",
        "",
        "Use this to manage node lifecycle and diagnostics.",
        "",
      ].join("\n"),
      "utf8",
    );

    const skills = await loadSkills(root);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.name, "node-ops");
    assert.equal(skills[0]?.categoryPath, "operations");
    assert.equal(skills[0]?.skillDir, nestedSkillDir);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
