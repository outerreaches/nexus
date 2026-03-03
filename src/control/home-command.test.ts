import assert from "node:assert/strict";
import test from "node:test";

import { parseHomeCommandText } from "./home-command.js";

test("parseHomeCommandText parses sethome command", () => {
  assert.deepEqual(parseHomeCommandText("/sethome"), { kind: "sethome" });
});

test("parseHomeCommandText parses unsethome command", () => {
  assert.deepEqual(parseHomeCommandText("/unsethome"), { kind: "unsethome" });
});

test("parseHomeCommandText supports bot mention token", () => {
  assert.deepEqual(parseHomeCommandText("/sethome@NexusBot"), { kind: "sethome" });
});

test("parseHomeCommandText ignores non-home commands", () => {
  assert.equal(parseHomeCommandText("sethome"), null);
  assert.equal(parseHomeCommandText("/help"), null);
});
