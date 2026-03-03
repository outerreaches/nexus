import assert from "node:assert/strict";
import test from "node:test";

import { parseThemeCommandText } from "./theme-command.js";

test("parseThemeCommandText parses /theme without args", () => {
  assert.deepEqual(parseThemeCommandText("/theme"), { kind: "theme" });
});

test("parseThemeCommandText parses first arg as requested theme", () => {
  assert.deepEqual(parseThemeCommandText("/theme amber"), {
    kind: "theme",
    requestedTheme: "amber",
  });
  assert.deepEqual(parseThemeCommandText("/theme midnight-commander extra"), {
    kind: "theme",
    requestedTheme: "midnight-commander",
  });
});

test("parseThemeCommandText supports bot mention token", () => {
  assert.deepEqual(parseThemeCommandText("/theme@NexusBot dos"), {
    kind: "theme",
    requestedTheme: "dos",
  });
});

test("parseThemeCommandText ignores non-theme inputs", () => {
  assert.equal(parseThemeCommandText("theme amber"), null);
  assert.equal(parseThemeCommandText("/stop"), null);
});
