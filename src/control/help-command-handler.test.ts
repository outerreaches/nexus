import assert from "node:assert/strict";
import test from "node:test";

import { renderHelpText } from "./help-command-handler.js";

test("renderHelpText includes terminal-only commands for terminal channel", () => {
  const text = renderHelpText("terminal");
  assert.match(text, /\/theme/);
  assert.match(text, /\/exit/);
  assert.match(text, /Alt\+Enter\/Ctrl\+J/);
  assert.match(text, /\/sethome/);
  assert.match(text, /\/provider/);
  assert.match(text, /\/model/);
  assert.match(text, /\/presets/);
});

test("renderHelpText includes telegram commands for telegram channel", () => {
  const text = renderHelpText("telegram");
  assert.match(text, /\/sethome/);
  assert.match(text, /\/act <id> <response>/);
  assert.doesNotMatch(text, /\/theme/);
});
