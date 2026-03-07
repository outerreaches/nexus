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
    access: {
      blockedAgents: [],
      blockedPresets: [],
      promptAllowedPresets: ["orchestrator"],
      manageAllowedPresets: ["orchestrator"],
      readAllowedPresets: [],
      presetSelfAccess: true,
    },
  };
  return {
    ...base,
    ...overrides,
    prompt: {
      ...base.prompt,
      ...(overrides?.prompt ?? {}),
    },
    access: {
      ...base.access,
      ...(overrides?.access ?? {}),
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

test("prompt skill injection defaults to orchestrator only", () => {
  const config = makeSkillsConfig();
  assert.equal(canInjectSkillsPrompt(config, { agentId: "main", preset: "orchestrator" }), true);
  assert.equal(canInjectSkillsPrompt(config, { agentId: "main", preset: "coder" }), false);
});

test("blocked agents and presets deny prompt/read/manage access", () => {
  const config = makeSkillsConfig({
    access: {
      blockedAgents: ["main"],
      blockedPresets: ["coder"],
      promptAllowedPresets: ["orchestrator"],
      manageAllowedPresets: ["orchestrator"],
      readAllowedPresets: [],
      presetSelfAccess: true,
    },
  });

  assert.equal(canInjectSkillsPrompt(config, { agentId: "main", preset: "orchestrator" }), false);
  assert.equal(canUseSkillReadTools(config, { agentId: "other", preset: "coder" }), false);
  assert.equal(canUseSkillManageTools(config, { agentId: "main", preset: "orchestrator" }), false);
});

test("manage allowlist applies independently from read allowlist", () => {
  const config = makeSkillsConfig({
    access: {
      blockedAgents: [],
      blockedPresets: [],
      promptAllowedPresets: ["orchestrator", "coder"],
      manageAllowedPresets: ["orchestrator"],
      readAllowedPresets: ["orchestrator", "coder"],
      presetSelfAccess: true,
    },
  });

  assert.equal(canInjectSkillsPrompt(config, { agentId: "main", preset: "coder" }), true);
  assert.equal(canUseSkillReadTools(config, { agentId: "main", preset: "coder" }), true);
  assert.equal(canUseSkillManageTools(config, { agentId: "main", preset: "coder" }), false);
  assert.equal(canUseSkillManageTools(config, { agentId: "main", preset: "orchestrator" }), true);
});

test("tool filtering removes disallowed skill tools but keeps non-skill tools", () => {
  const tools = [
    fakeTool("file_read"),
    fakeTool("skill_list"),
    fakeTool("skill_get"),
    fakeTool("skill_create"),
    fakeTool("skill_update"),
  ];
  const config = makeSkillsConfig({
    access: {
      blockedAgents: [],
      blockedPresets: [],
      promptAllowedPresets: ["orchestrator"],
      manageAllowedPresets: ["orchestrator"],
      readAllowedPresets: ["orchestrator"],
      presetSelfAccess: true,
    },
  });

  const filtered = filterToolsBySkillAccess({
    tools,
    config,
    ctx: { agentId: "main", preset: "coder" },
  });
  const names = new Set(filtered.map((tool) => tool.name));
  assert.equal(names.has("file_read"), true);
  assert.equal(names.has("skill_list"), false);
  assert.equal(names.has("skill_get"), false);
  assert.equal(names.has("skill_create"), false);
  assert.equal(names.has("skill_update"), false);
});

test("canInjectPresetScopedSkills allows non-orchestrator presets with presetSelfAccess", () => {
  const config = makeSkillsConfig();
  // coder is not in promptAllowedPresets, but presetSelfAccess=true
  assert.equal(canInjectPresetScopedSkills(config, { agentId: "main", preset: "coder" }), true);
  assert.equal(canInjectPresetScopedSkills(config, { agentId: "main", preset: "security-researcher" }), true);
  assert.equal(canInjectPresetScopedSkills(config, { agentId: "main", preset: "orchestrator" }), true);
});

test("canInjectPresetScopedSkills denied when presetSelfAccess is false", () => {
  const config = makeSkillsConfig({ access: { ...makeSkillsConfig().access, presetSelfAccess: false } });
  assert.equal(canInjectPresetScopedSkills(config, { agentId: "main", preset: "coder" }), false);
});

test("canInjectPresetScopedSkills denied for blocked presets even with presetSelfAccess", () => {
  const config = makeSkillsConfig({
    access: { ...makeSkillsConfig().access, blockedPresets: ["coder"], presetSelfAccess: true },
  });
  assert.equal(canInjectPresetScopedSkills(config, { agentId: "main", preset: "coder" }), false);
  assert.equal(canInjectPresetScopedSkills(config, { agentId: "main", preset: "researcher" }), true);
});

test("canInjectPresetScopedSkills requires a preset name", () => {
  const config = makeSkillsConfig();
  assert.equal(canInjectPresetScopedSkills(config, { agentId: "main" }), false);
  assert.equal(canInjectPresetScopedSkills(config, { agentId: "main", preset: "" }), false);
});

test("resolveSkillScopes combines global and preset checks", () => {
  const config = makeSkillsConfig();
  // orchestrator: global=true (in promptAllowedPresets), preset=true (presetSelfAccess)
  assert.deepEqual(resolveSkillScopes(config, { agentId: "main", preset: "orchestrator" }), { global: true, preset: true });
  // coder: global=false (not in promptAllowedPresets), preset=true (presetSelfAccess)
  assert.deepEqual(resolveSkillScopes(config, { agentId: "main", preset: "coder" }), { global: false, preset: true });
  // no preset: global=false (empty preset fails allowlist), preset=false (no preset name)
  assert.deepEqual(resolveSkillScopes(config, { agentId: "main" }), { global: false, preset: false });
});
