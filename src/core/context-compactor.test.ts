import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compactContext, extractTieredRetentionCandidates, storeCompactionRetentionCandidates } from "./context-compactor.js";
import type { ChatMessage } from "./types.js";
import type { LLMClient } from "../llm/openai-compat.js";
import { openDatabase, type NexusDatabase } from "../storage/database.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-compactor-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

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

test("compactContext adds pinned context message and avoids duplicate auto-summary blocks", async () => {
  let summaryCalls = 0;
  const llm: LLMClient = {
    async completeChat() {
      summaryCalls += 1;
      return {
        content: [
          "## Goals and task",
          "- finish the migration",
          "## Constraints (must keep)",
          "- no insecure fallback storage",
          "## Decisions",
          "- keep sidecar secret references unchanged",
          "## Active execution state",
          "- session=pytorch-check",
          "## Open items and next steps",
          "- verify compaction behavior under load",
          "## Retention candidates (tiered)",
          "- Tier B -> prefer sidecar-only credential flow",
        ].join("\n"),
        toolCalls: [],
      };
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

  const first = await compactContext({
    messages,
    tools: [],
    llm,
    maxContextTokens: 220,
    minRecentMessages: 3,
  });

  assert.equal(first.compacted, true);
  assert.equal(summaryCalls, 1);
  const firstPinnedCount = first.messages.filter(
    (m) => m.role === "system" && m.content.startsWith("## Pinned Context (always keep)"),
  ).length;
  const firstSummaryCount = first.messages.filter(
    (m) => m.role === "system" && m.content.startsWith("## Conversation Summary (compacted)"),
  ).length;
  assert.equal(firstPinnedCount, 1);
  assert.equal(firstSummaryCount, 1);

  const second = await compactContext({
    messages: first.messages,
    tools: [],
    llm,
    maxContextTokens: 220,
    minRecentMessages: 3,
  });

  assert.equal(second.compacted, true);
  assert.equal(summaryCalls, 2);
  const secondPinnedCount = second.messages.filter(
    (m) => m.role === "system" && m.content.startsWith("## Pinned Context (always keep)"),
  ).length;
  const secondSummaryCount = second.messages.filter(
    (m) => m.role === "system" && m.content.startsWith("## Conversation Summary (compacted)"),
  ).length;
  assert.equal(secondPinnedCount, 1);
  assert.equal(secondSummaryCount, 1);
});

test("compactContext falls back to non-user boundary for long tool chains", async () => {
  let summaryCalls = 0;
  let summaryUserPrompt = "";
  const llm: LLMClient = {
    async completeChat(params) {
      summaryCalls += 1;
      summaryUserPrompt = typeof params.messages[1]?.content === "string" ? params.messages[1].content : "";
      return {
        content: [
          "## Goals and task",
          "- investigate shell output",
          "## Constraints (must keep)",
          "- none",
          "## Decisions",
          "- none",
          "## Active execution state",
          "- session=pytorch-check",
          "## Open items and next steps",
          "- continue reading with cursor",
          "## Retention candidates (tiered)",
          "- none",
        ].join("\n"),
        toolCalls: [],
      };
    },
  };

  const ansiPayload = "\u001b[38;5;197mHELLO\u001b[0m\n".repeat(600);
  const messages: ChatMessage[] = [
    { role: "system", content: "system-prompt" },
    { role: "user", content: "check the long-running shell session" },
    { role: "assistant", content: null, toolCalls: [{ id: "tc1", name: "shell_interactive", arguments: "{}" }] },
    { role: "tool", name: "shell_interactive", toolCallId: "tc1", content: ansiPayload },
    { role: "assistant", content: null, toolCalls: [{ id: "tc2", name: "shell_interactive", arguments: "{}" }] },
    { role: "tool", name: "shell_interactive", toolCallId: "tc2", content: ansiPayload },
    { role: "assistant", content: null, toolCalls: [{ id: "tc3", name: "shell_interactive", arguments: "{}" }] },
    { role: "tool", name: "shell_interactive", toolCallId: "tc3", content: ansiPayload },
  ];

  const result = await compactContext({
    messages,
    tools: [],
    llm,
    maxContextTokens: 300,
    minRecentMessages: 3,
  });

  assert.equal(result.compacted, true);
  assert.equal(summaryCalls, 1);
  assert.ok(result.messagesRemoved > 0);
  assert.equal(summaryUserPrompt.includes("\u001b["), false);
});

test("extractTieredRetentionCandidates parses tiered bullets and drops low-signal lines", () => {
  const summary = [
    "Some summary text",
    "",
    "Retention candidates (tiered)",
    "- Tier A -> Critical operator instructions belong in AGENTS.md",
    "- Tier B -> Node webhook ingress should remain node-local then route over websocket",
    "- Tier C -> none",
    "- Tier M: Confirmed infra runbook references with timestamps",
    "- Tier B: Persist preferred report title conventions",
  ].join("\n");

  const out = extractTieredRetentionCandidates(summary);
  assert.deepEqual(
    out.map((item) => item.tier),
    ["A", "B", "M", "B"],
  );
  assert.equal(out.some((item) => item.text.toLowerCase() === "none"), false);
});

test("storeCompactionRetentionCandidates upserts tier-b candidates only", async () => {
  await withDb((db) => {
    const summary = [
      "Retention candidates (tiered)",
      "- Tier A -> Keep this in AGENTS.md only",
      "- Tier B -> Preferred blackboard title format uses concise prefixes",
      "- Tier B -> Node webhook ingress must stay node-local",
      "- Tier C -> scratch reminder",
    ].join("\n");

    const first = storeCompactionRetentionCandidates({
      db,
      agentId: "main",
      sessionId: "session-1",
      summary,
      nowMs: 1_700_000_000_000,
    });
    assert.equal(first.detected, 4);
    assert.equal(first.stored, 2);

    const second = storeCompactionRetentionCandidates({
      db,
      agentId: "main",
      sessionId: "session-1",
      summary,
      nowMs: 1_700_000_010_000,
    });
    assert.equal(second.detected, 4);
    assert.equal(second.stored, 2);

    const rows = db.db
      .prepare("SELECT key, value, tags_json FROM memories WHERE agent_id = ? AND key LIKE ? ORDER BY key")
      .all("main", "retention:session-1:%") as Array<{ key: string; value: string; tags_json: string }>;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.match(row.key, /^retention:session-1:/);
      const tags = JSON.parse(row.tags_json) as string[];
      assert.deepEqual(tags, ["retention-pass", "tier-b", "source:compaction"]);
      assert.ok(row.value.length > 10);
    }
  });
});
