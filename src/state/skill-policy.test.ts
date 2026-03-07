import assert from "node:assert/strict";
import test from "node:test";

import { canInjectSkillsPrompt, canInjectPresetScopedSkills, resolveSkillScopes, canUseSkillManageTools, canUseSkillReadTools, filterToolsBySkillAccess } from "./skill-policy.js";
import type { SkillsConfig } from "./config.js";
import type { Tool } from "../core/tools.js";

function makeSkillsConfig(overrides?: Partial<SkillsConfig>): SkillsConfig {
  const base: SkillsConfig = {
    enabled: true,
    prompt: {
      enabled: true,
      maxInlineSkills: 5,
      includeReferences: true,
      maxReferencesPerSkill: 2,
      maxReferenceChars: 1600,
    },
  };
  return {
    ...base,
    ...overrides,
    prompt: {
      ...base.prompt,
      ...(overrides?.prompt ?? {}),
    },
  };
}

function fakeTool(name: string): Tool {
  return {
    name,
    description: name,
    jsonSchema: {},
    execute: async () => "ok",
  };
}

test("skill policy defaults to allow when config missing", () => {
  assert.equal(canInjectSkillsPrompt(undefined, { agentId: "main", preset: "orchestrator" }), true);
  assert.equal(canUseSkillReadTools(undefined, { agentId: "main", preset: "coder" }), true);
  assert.equal(canUseSkillManageTools(undefined, { agentId: "main", preset: "coder" }), true);
});

test("prompt skill injection follows preset metadata", () => {
  const config = makeSkillsConfig();
  assert.equal(canInjectSkillsPrompt(config, { agentId: "main", preset: "orchestrator" }), true);
  assert.equal(canInjectSkillsPrompt(config, { agentId: "main", preset: "coder" }), false);
});

test("skills enabled flag still gates read/manage tools", () => {
  const config = makeSkillsConfig({ enabled: false });
  assert.equal(canUseSkillReadTools(config, { agentId: "main", preset: "coder" }), false);
  assert.equal(canUseSkillManageTools(config, { agentId: "main", preset: "orchestrator" }), false);
});

test("tool filtering only strips skill tools when skills are disabled", () => {
  const tools = [
    fakeTool("file_read"),
    fakeTool("skill_list"),
    fakeTool("skill_get"),
    fakeTool("skill_create"),
    fakeTool("skill_update"),
  ];
  const filtered = filterToolsBySkillAccess({
    tools,
    config: makeSkillsConfig({ enabled: false }),
    ctx: { agentId: "main", preset: "coder" },
  });
  const names = new Set(filtered.map((tool) => tool.name));
  assert.equal(names.has("file_read"), true);
  assert.equal(names.has("skill_list"), false);
  assert.equal(names.has("skill_get"), false);
  assert.equal(names.has("skill_create"), false);
  assert.equal(names.has("skill_update"), false);
});

test("tool filtering keeps skill tools when runtime skills are enabled", () => {
  const tools = [
    fakeTool("file_read"),
    fakeTool("skill_list"),
    fakeTool("skill_get"),
    fakeTool("skill_create"),
    fakeTool("skill_update"),
  ];
  const filtered = filterToolsBySkillAccess({
    tools,
    config: makeSkillsConfig(),
    ctx: { agentId: "main", preset: "coder" },
  });
  const names = new Set(filtered.map((tool) => tool.name));
  assert.equal(names.has("file_read"), true);
  assert.equal(names.has("skill_list"), true);
  assert.equal(names.has("skill_get"), true);
  assert.equal(names.has("skill_create"), true);
  assert.equal(names.has("skill_update"), true);
});

test("canInjectPresetScopedSkills follows preset metadata", () => {
  const config = makeSkillsConfig();
  assert.equal(canInjectPresetScopedSkills(config, { agentId: "main", preset: "coder" }), true);
  assert.equal(canInjectPresetScopedSkills(config, { agentId: "main", preset: "security-researcher" }), true);
  assert.equal(canInjectPresetScopedSkills(config, { agentId: "main", preset: "orchestrator" }), true);
  assert.equal(canInjectPresetScopedSkills(config, { agentId: "main", preset: "process-manager" }), false);
});

test("canInjectPresetScopedSkills requires a preset name", () => {
  const config = makeSkillsConfig();
  assert.equal(canInjectPresetScopedSkills(config, { agentId: "main" }), false);
  assert.equal(canInjectPresetScopedSkills(config, { agentId: "main", preset: "" }), false);
});

test("resolveSkillScopes combines global and preset checks", () => {
  const config = makeSkillsConfig();
  assert.deepEqual(resolveSkillScopes(config, { agentId: "main", preset: "orchestrator" }), { global: true, preset: true });
  assert.deepEqual(resolveSkillScopes(config, { agentId: "main", preset: "coder" }), { global: false, preset: true });
  assert.deepEqual(resolveSkillScopes(config, { agentId: "main", preset: "process-manager" }), { global: false, preset: false });
  assert.deepEqual(resolveSkillScopes(config, { agentId: "main" }), { global: true, preset: false });
});
