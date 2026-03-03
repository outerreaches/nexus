import assert from "node:assert/strict";
import test from "node:test";

import { parseControlCommandText } from "./control-command.js";

test("parseControlCommandText parses help commands", () => {
  const parsed = parseControlCommandText("/help");
  assert.ok(parsed);
  assert.equal(parsed.kind, "help");
  assert.equal(parsed.help.kind, "help");
});

test("parseControlCommandText parses stop commands", () => {
  const parsed = parseControlCommandText("/stopall 5m");
  assert.ok(parsed);
  assert.equal(parsed.kind, "stop");
  assert.equal(parsed.stop.kind, "stopall");
});

test("parseControlCommandText parses info commands", () => {
  const parsed = parseControlCommandText("/federation");
  assert.ok(parsed);
  assert.equal(parsed.kind, "info");
  assert.equal(parsed.info.topic, "federation");
});

test("parseControlCommandText parses home commands", () => {
  const parsed = parseControlCommandText("/sethome");
  assert.ok(parsed);
  assert.equal(parsed.kind, "home");
  assert.equal(parsed.home.kind, "sethome");
});

test("parseControlCommandText parses model settings commands", () => {
  const parsed = parseControlCommandText("/provider openrouter");
  assert.ok(parsed);
  assert.equal(parsed.kind, "model_settings");
  assert.equal(parsed.modelSettings.kind, "provider");
  assert.equal(parsed.modelSettings.action, "set");
});

test("parseControlCommandText ignores unknown commands", () => {
  assert.equal(parseControlCommandText("/theme"), null);
  assert.equal(parseControlCommandText("hello"), null);
});
