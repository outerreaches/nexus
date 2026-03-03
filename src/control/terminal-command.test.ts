import assert from "node:assert/strict";
import test from "node:test";

import { parseTerminalCommandText } from "./terminal-command.js";

test("parseTerminalCommandText parses help commands", () => {
  const parsed = parseTerminalCommandText("/help");
  assert.ok(parsed);
  assert.equal(parsed.kind, "control");
  assert.equal(parsed.control.kind, "help");
});

test("parseTerminalCommandText parses stop commands", () => {
  const parsed = parseTerminalCommandText("/stop");
  assert.ok(parsed);
  assert.equal(parsed.kind, "control");
  assert.equal(parsed.control.kind, "stop");
  assert.equal(parsed.control.stop.kind, "stop");
});

test("parseTerminalCommandText parses theme commands", () => {
  const parsed = parseTerminalCommandText("/theme terminal-amber");
  assert.ok(parsed);
  assert.equal(parsed.kind, "theme");
  assert.equal(parsed.theme.requestedTheme, "terminal-amber");
});

test("parseTerminalCommandText parses info commands", () => {
  const parsed = parseTerminalCommandText("/tools");
  assert.ok(parsed);
  assert.equal(parsed.kind, "control");
  assert.equal(parsed.control.kind, "info");
  assert.equal(parsed.control.info.topic, "tools");
});

test("parseTerminalCommandText parses home commands", () => {
  const parsed = parseTerminalCommandText("/unsethome");
  assert.ok(parsed);
  assert.equal(parsed.kind, "control");
  assert.equal(parsed.control.kind, "home");
  assert.equal(parsed.control.home.kind, "unsethome");
});

test("parseTerminalCommandText ignores non-control text", () => {
  assert.equal(parseTerminalCommandText("hello"), null);
});
