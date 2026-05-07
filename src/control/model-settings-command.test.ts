import assert from "node:assert/strict";
import test from "node:test";

import { parseModelSettingsCommandText } from "./model-settings-command.js";

test("parseModelSettingsCommandText parses provider default show", () => {
  const parsed = parseModelSettingsCommandText("/provider");
  assert.ok(parsed);
  assert.equal(parsed.kind, "provider");
  assert.equal(parsed.action, "show");
  assert.equal(parsed.target.kind, "orchestrator");
});

test("parseModelSettingsCommandText parses model default set", () => {
  const parsed = parseModelSettingsCommandText("/model gpt-4o");
  assert.ok(parsed);
  assert.equal(parsed.kind, "model");
  assert.equal(parsed.action, "set");
  assert.equal(parsed.target.kind, "orchestrator");
  assert.equal(parsed.value, "gpt-4o");
});

test("parseModelSettingsCommandText parses target set", () => {
  const parsed = parseModelSettingsCommandText("/provider preset:coder openrouter");
  assert.ok(parsed);
  assert.equal(parsed.kind, "provider");
  assert.equal(parsed.action, "set");
  assert.equal(parsed.target.kind, "preset");
  assert.equal(parsed.target.preset, "coder");
  assert.equal(parsed.value, "openrouter");
});

test("parseModelSettingsCommandText parses reset and show target", () => {
  const resetParsed = parseModelSettingsCommandText("/provider reset tool:image_generate");
  assert.ok(resetParsed);
  assert.equal(resetParsed.kind, "provider");
  assert.equal(resetParsed.action, "reset");
  assert.equal(resetParsed.target.kind, "tool");
  assert.equal(resetParsed.target.tool, "image_generate");

  const showParsed = parseModelSettingsCommandText("/model show preset:analyst");
  assert.ok(showParsed);
  assert.equal(showParsed.kind, "model");
  assert.equal(showParsed.action, "show");
  assert.equal(showParsed.target.kind, "preset");
  assert.equal(showParsed.target.preset, "analyst");
});

test("parseModelSettingsCommandText parses presets command", () => {
  const parsed = parseModelSettingsCommandText("/presets coder");
  assert.ok(parsed);
  assert.equal(parsed.kind, "presets");
  assert.equal(parsed.presetName, "coder");
});

test("parseModelSettingsCommandText reports invalid arguments", () => {
  const invalidTarget = parseModelSettingsCommandText("/provider badtarget value");
  assert.ok(invalidTarget);
  assert.equal(invalidTarget.kind, "provider");
  assert.equal(invalidTarget.action, "set");
  assert.match(invalidTarget.error ?? "", /invalid target/);
});

test("parseModelSettingsCommandText parses --preset flag form", () => {
  const parsed = parseModelSettingsCommandText("/provider --preset coder openrouter");
  assert.ok(parsed);
  assert.equal(parsed.kind, "provider");
  assert.equal(parsed.action, "set");
  assert.equal(parsed.target.kind, "preset");
  assert.equal(parsed.target.preset, "coder");
  assert.equal(parsed.value, "openrouter");
  assert.equal(parsed.error, undefined);
});

test("parseModelSettingsCommandText parses --tool with preset:tool", () => {
  const parsed = parseModelSettingsCommandText("/model --tool coder:code_search openrouter");
  assert.ok(parsed);
  assert.equal(parsed.kind, "model");
  assert.equal(parsed.action, "set");
  assert.equal(parsed.target.kind, "toolPreset");
  assert.equal(parsed.target.preset, "coder");
  assert.equal(parsed.target.tool, "code_search");
  assert.equal(parsed.value, "openrouter");
});

test("parseModelSettingsCommandText parses --reset --preset", () => {
  const parsed = parseModelSettingsCommandText("/provider --reset --preset coder");
  assert.ok(parsed);
  assert.equal(parsed.kind, "provider");
  assert.equal(parsed.action, "reset");
  assert.equal(parsed.target.kind, "preset");
  assert.equal(parsed.target.preset, "coder");
});

test("parseModelSettingsCommandText rejects unknown flag", () => {
  const parsed = parseModelSettingsCommandText("/provider --bogus foo");
  assert.ok(parsed);
  assert.match(parsed.error ?? "", /unknown flag/);
});

test("parseModelSettingsCommandText rejects --preset and --tool together", () => {
  const parsed = parseModelSettingsCommandText("/provider --preset coder --tool image_generate openrouter");
  assert.ok(parsed);
  assert.match(parsed.error ?? "", /either --preset or --tool/);
});

test("parseModelSettingsCommandText flag form with no value reads as show", () => {
  const parsed = parseModelSettingsCommandText("/provider --preset coder");
  assert.ok(parsed);
  assert.equal(parsed.kind, "provider");
  assert.equal(parsed.action, "show");
  assert.equal(parsed.target.kind, "preset");
  assert.equal(parsed.target.preset, "coder");
  assert.equal(parsed.value, undefined);
});

