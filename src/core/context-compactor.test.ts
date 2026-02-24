import assert from "node:assert/strict";
import test from "node:test";

import { compactContext } from "./context-compactor.js";
import type { ChatMessage } from "./types.js";
import type { LLMClient } from "../llm/openai-compat.js";

function longText(label: string, repeat: number = 120): string {
  return `${label} ${"x".repeat(repeat)} ${label}`;
}

test("compactContext boundary counts non-system messages and preserves required recent user boundary", async () => {
  let summaryCalls = 0;
  const llm: LLMClient = {
    async completeChat() {
      summaryCalls += 1;
      return { content: "summary-from-llm", toolCalls: [] };
    },
  };

  const messages: ChatMessage[] = [
    { role: "system", content: "system-prompt" },
    { role: "user", content: longText("U0") },
    { role: "assistant", content: longText("A0") },
    { role: "user", content: longText("U1") },
    { role: "assistant", content: longText("A1") },
    { role: "user", content: longText("U2") },
    { role: "assistant", content: longText("A2") },
    { role: "system", content: "runtime-hint-1" },
    { role: "system", content: "runtime-hint-2" },
    { role: "user", content: longText("U3") },
  ];

  const result = await compactContext({
    messages,
    tools: [],
    llm,
    maxContextTokens: 180,
    minRecentMessages: 4,
  });

  assert.equal(result.compacted, true);
  assert.equal(result.summary, "summary-from-llm");
  assert.equal(summaryCalls, 1);
  assert.equal(result.messagesRemoved, 2);
  const keptUserLabels = result.messages
    .filter((m): m is Extract<ChatMessage, { role: "user" }> => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
  assert.match(keptUserLabels, /U1/);
  assert.match(keptUserLabels, /U2/);
  assert.match(keptUserLabels, /U3/);
  assert.doesNotMatch(keptUserLabels, /U0/);
});

test("compactContext aggressive truncation compacts oversized user payloads when no boundary exists", async () => {
  let summaryCalls = 0;
  const llm: LLMClient = {
    async completeChat() {
      summaryCalls += 1;
      return { content: "unused", toolCalls: [] };
    },
  };

  const hugeDataUrl = `data:image/png;base64,${"A".repeat(50_000)}`;
  const messages: ChatMessage[] = [
    { role: "system", content: "system-prompt" },
    {
      role: "user",
      content: [
        { type: "text", text: "please analyze this image payload and continue" },
        { type: "image_url", image_url: { url: hugeDataUrl } },
      ],
    },
  ];

  const result = await compactContext({
    messages,
    tools: [],
    llm,
    maxContextTokens: 1_000,
  });

  assert.equal(result.compacted, true);
  assert.equal(result.summary, null);
  assert.equal(result.messagesRemoved, 0);
  assert.equal(summaryCalls, 0);

  const compactedUser = result.messages[1];
  assert.ok(compactedUser && compactedUser.role === "user");
  assert.equal(typeof compactedUser.content, "string");
  const content = compactedUser.content as string;
  assert.match(content, /user content compacted for context/);
  assert.doesNotMatch(content, /data:image\/png;base64/);
  assert.ok(content.length < 5000);
});

test("compactContext summary prompt requests tiered retention candidates", async () => {
  let summarySystemPrompt = "";
  const llm: LLMClient = {
    async completeChat(params) {
      summarySystemPrompt = typeof params.messages[0]?.content === "string" ? params.messages[0].content : "";
      return { content: "summary-with-retention", toolCalls: [] };
    },
  };

  const messages: ChatMessage[] = [
    { role: "system", content: "system-prompt" },
    { role: "user", content: longText("U0", 400) },
    { role: "assistant", content: longText("A0", 500) },
    { role: "user", content: longText("U1", 400) },
    { role: "assistant", content: longText("A1", 500) },
    { role: "user", content: longText("U2", 400) },
  ];

  const result = await compactContext({
    messages,
    tools: [],
    llm,
    maxContextTokens: 220,
    minRecentMessages: 3,
  });

  assert.equal(result.compacted, true);
  assert.equal(result.summary, "summary-with-retention");
  assert.match(summarySystemPrompt, /Retention candidates \(tiered\)/);
  assert.match(summarySystemPrompt, /Tier A -> AGENTS\.md/);
  assert.match(summarySystemPrompt, /Tier M -> MEMORY\.md/);
  assert.match(summarySystemPrompt, /Tier B -> memory_store/);
  assert.match(summarySystemPrompt, /Tier C -> NOTES\.md/);
});
