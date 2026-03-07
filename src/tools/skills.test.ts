import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ToolContext } from "../core/tools.js";
import { skillCreate, skillUpdate } from "./skills.js";

async function withSkillContext(
  fn: (params: {
    root: string;
    stateDir: string;
    ctx: ToolContext;
  }) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-skills-test-"));
  const stateDir = path.join(root, "state");
  const codeDir = path.join(root, "code");
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(codeDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });

  const ctx: ToolContext = {
    stateDir,
    codeDir,
    workspaceDir,
    request: {
      channel: "cli",
      channelKey: "local",
      agentId: "agent:main",
      preset: "orchestrator",
      sessionId: "session-1",
      runId: "run-1",
    },
    nowMs: () => Date.now(),
    log: () => undefined,
  };

  try {
    await fn({ root, stateDir, ctx });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("skill_create can target another preset", async () => {
  await withSkillContext(async ({ stateDir, ctx }) => {
    const result = await skillCreate.execute(
      {
        name: "chart-qa",
        description: "Review chart output",
        triggers: ["chart"],
        instructions: "Inspect the chart before publishing.",
        scope: "preset",
        targetPreset: "graphic-designer",
        references: [],
      },
      ctx,
    );

    assert.match(result, /scope=preset:graphic-designer/);
    const skillPath = path.join(stateDir, "presets", "graphic-designer", "skills", "chart-qa", "SKILL.md");
    const created = await fs.readFile(skillPath, "utf8");
    assert.match(created, /name: chart-qa/);
    assert.match(created, /Review chart output/);
  });
});

test("skill_update can target another preset", async () => {
  await withSkillContext(async ({ stateDir, ctx }) => {
    const skillDir = path.join(stateDir, "presets", "coder", "skills", "build-hygiene");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "name: build-hygiene",
        "description: Original",
        "triggers: build",
        "---",
        "",
        "Old instructions.",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await skillUpdate.execute(
      {
        name: "build-hygiene",
        description: "Updated",
        instructions: "Run build checks before deploy.",
        scope: "preset",
        targetPreset: "coder",
      },
      ctx,
    );

    assert.match(result, /updated skill "build-hygiene"/);
    const updated = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    assert.match(updated, /description: Updated/);
    assert.match(updated, /Run build checks before deploy\./);
  });
});

test("skill_create rejects unknown target presets", async () => {
  await withSkillContext(async ({ ctx }) => {
    const result = await skillCreate.execute(
      {
        name: "bad-target",
        description: "Should fail",
        triggers: [],
        instructions: "Nope.",
        scope: "preset",
        targetPreset: "not-a-real-preset",
        references: [],
      },
      ctx,
    );

    assert.match(result, /target preset "not-a-real-preset" not found/i);
  });
});
