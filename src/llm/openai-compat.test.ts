import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAssistantContent } from "./openai-compat.js";

test("normalizeAssistantContent handles plain string content", () => {
  assert.equal(normalizeAssistantContent("hello"), "hello");
});

test("normalizeAssistantContent handles nested provider content shapes", () => {
  const raw = [
    { type: "output_text", text: "alpha" },
    { type: "text", text: { value: "beta" } },
    { content: [{ type: "text", text: "gamma" }] },
  ];
  assert.equal(normalizeAssistantContent(raw), "alpha\nbeta\ngamma");
});

test("normalizeAssistantContent returns null for non-text payloads", () => {
  const raw = [{ type: "tool_use", id: "x" }, { type: "reasoning", tokens: 12 }];
  assert.equal(normalizeAssistantContent(raw), null);
});
