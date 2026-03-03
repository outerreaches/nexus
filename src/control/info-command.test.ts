import assert from "node:assert/strict";
import test from "node:test";

import { parseInfoCommandText } from "./info-command.js";

test("parseInfoCommandText parses dashboard info commands with default limit", () => {
  const parsed = parseInfoCommandText("/tools");
  assert.deepEqual(parsed, { kind: "info", topic: "tools", limit: 20 });
});

test("parseInfoCommandText parses explicit numeric limit", () => {
  const parsed = parseInfoCommandText("/nodes 12");
  assert.deepEqual(parsed, { kind: "info", topic: "nodes", limit: 12, rawLimit: "12" });
});

test("parseInfoCommandText supports bot mention token", () => {
  const parsed = parseInfoCommandText("/jobs@NexusBot 5");
  assert.deepEqual(parsed, { kind: "info", topic: "jobs", limit: 5, rawLimit: "5" });
});

test("parseInfoCommandText returns rawLimit when value is invalid", () => {
  const parsed = parseInfoCommandText("/mcp banana");
  assert.deepEqual(parsed, { kind: "info", topic: "mcp", rawLimit: "banana" });
});

test("parseInfoCommandText ignores non-info inputs", () => {
  assert.equal(parseInfoCommandText("tools"), null);
  assert.equal(parseInfoCommandText("/stopall"), null);
});
