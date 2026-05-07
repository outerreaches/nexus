import assert from "node:assert/strict";
import test from "node:test";

import { parseStatusCommandText } from "./status-command.js";

test("parseStatusCommandText recognizes /status", () => {
  assert.deepEqual(parseStatusCommandText("/status"), { kind: "status" });
});

test("parseStatusCommandText recognizes telegram bot mention suffix", () => {
  assert.deepEqual(parseStatusCommandText("/status@mybot"), { kind: "status" });
});

test("parseStatusCommandText ignores leading whitespace", () => {
  assert.deepEqual(parseStatusCommandText("  /status  "), { kind: "status" });
});

test("parseStatusCommandText returns null for unrelated input", () => {
  assert.equal(parseStatusCommandText("/help"), null);
  assert.equal(parseStatusCommandText("status"), null);
  assert.equal(parseStatusCommandText(""), null);
  assert.equal(parseStatusCommandText("/statusbar"), null);
});
