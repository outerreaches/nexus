import assert from "node:assert/strict";
import test from "node:test";

import { parseHelpCommandText } from "./help-command.js";

test("parseHelpCommandText parses /help", () => {
  assert.deepEqual(parseHelpCommandText("/help"), { kind: "help" });
});

test("parseHelpCommandText supports bot mention token", () => {
  assert.deepEqual(parseHelpCommandText("/help@NexusBot"), { kind: "help" });
});

test("parseHelpCommandText ignores non-help inputs", () => {
  assert.equal(parseHelpCommandText("/stop"), null);
  assert.equal(parseHelpCommandText("help"), null);
});
