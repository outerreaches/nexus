import assert from "node:assert/strict";
import test from "node:test";

import { collapseConsecutiveSystemMessages, normalizeAssistantContent, parseChatCompletionResponseBody } from "./openai-compat.js";

test("collapseConsecutiveSystemMessages merges adjacent system prompts", () => {
  const collapsed = collapseConsecutiveSystemMessages([
    { role: "system", content: "System A" },
    { role: "system", content: "System B", cacheControl: { type: "ephemeral" } },
    { role: "user", content: "hello" },
    { role: "system", content: "System C" },
    { role: "assistant", content: "done" },
  ]);

  assert.deepEqual(collapsed, [
    { role: "system", content: "System A\n\nSystem B", cacheControl: { type: "ephemeral" } },
    { role: "user", content: "hello" },
    { role: "system", content: "System C" },
    { role: "assistant", content: "done" },
  ]);
});

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

test("parseChatCompletionResponseBody parses non-stream JSON", () => {
  const parsed = parseChatCompletionResponseBody(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content: "ok" },
        },
      ],
    }),
    false,
  );
  const message = (parsed.choices as Array<{ message?: { content?: string } }>)[0]?.message;
  assert.equal(message?.content, "ok");
});

test("parseChatCompletionResponseBody reconstructs streaming text deltas", () => {
  const raw = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const parsed = parseChatCompletionResponseBody(raw, true);
  const message = (parsed.choices as Array<{ message?: { content?: string } }>)[0]?.message;
  assert.equal(message?.content, "Hello");
});

test("parseChatCompletionResponseBody reconstructs streaming tool calls", () => {
  const raw = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"file_read","arguments":"{\\"path\\":"}}]}}]}',
    "",
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"arguments":"\\"/tmp/a\\"}"}}]}}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const parsed = parseChatCompletionResponseBody(raw, true);
  const choice = (parsed.choices as Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>)[0];
  const tool = choice?.message?.tool_calls?.[0];
  assert.equal(tool?.function?.name, "file_read");
  assert.equal(tool?.function?.arguments, '{"path":"/tmp/a"}');
});
