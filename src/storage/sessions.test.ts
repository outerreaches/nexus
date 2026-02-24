import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ChatMessage } from "../core/types.js";
import { openDatabase, type NexusDatabase } from "./database.js";
import { appendMessage, getOrCreateSessionId, loadRecentHistory } from "./sessions.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-sessions-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function assertToolMessage(message: ChatMessage | undefined): asserts message is Extract<ChatMessage, { role: "tool" }> {
  assert.ok(message, "expected tool message");
  assert.equal(message.role, "tool");
}

test("appendMessage compacts shell_interactive read payloads in persisted history", async () => {
  await withDb((db) => {
    const nowMs = 1_700_000_000_000;
    const sessionId = getOrCreateSessionId({
      db,
      channel: "cli",
      channelKey: "test-shell-history",
      agentId: "main",
      nowMs,
    });

    appendMessage({
      db,
      sessionId,
      nowMs,
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "shell_interactive", arguments: JSON.stringify({ action: "read" }) }],
      },
    });

    const originalOutput = "line-0123456789\n".repeat(300);
    appendMessage({
      db,
      sessionId,
      nowMs: nowMs + 1,
      message: {
        role: "tool",
        name: "shell_interactive",
        toolCallId: "call-1",
        content: JSON.stringify({
          ok: true,
          action: "read",
          session: "s1",
          output: originalOutput,
          nextCursor: 1234,
          totalBytes: 1234,
          truncated: true,
          running: true,
        }),
      },
    });

    const history = loadRecentHistory({
      db,
      sessionId,
      maxMessages: 20,
      nowMs: nowMs + 10,
    });

    const toolMessage = history.find((m) => m.role === "tool");
    assertToolMessage(toolMessage);

    const parsed = JSON.parse(toolMessage.content) as Record<string, unknown>;
    assert.equal(parsed.action, "read");
    assert.equal(parsed.outputCompactedForHistory, true);
    assert.equal(parsed.outputOriginalChars, originalOutput.length);
    assert.equal(typeof parsed.output, "string");
    assert.ok((parsed.output as string).length < originalOutput.length);
    assert.match(parsed.output as string, /\[\.\.\.history-compacted .* chars\.\.\.\]/);
  });
});

test("appendMessage leaves non-shell tool payloads unchanged", async () => {
  await withDb((db) => {
    const nowMs = 1_700_000_000_100;
    const sessionId = getOrCreateSessionId({
      db,
      channel: "cli",
      channelKey: "test-other-tool-history",
      agentId: "main",
      nowMs,
    });

    appendMessage({
      db,
      sessionId,
      nowMs,
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-2", name: "shell_exec", arguments: JSON.stringify({ command: "echo hi" }) }],
      },
    });

    const payload = JSON.stringify({
      ok: true,
      stdout: "hello",
      stderr: "",
    });
    appendMessage({
      db,
      sessionId,
      nowMs: nowMs + 1,
      message: {
        role: "tool",
        name: "shell_exec",
        toolCallId: "call-2",
        content: payload,
      },
    });

    const history = loadRecentHistory({
      db,
      sessionId,
      maxMessages: 20,
      nowMs: nowMs + 10,
    });

    const toolMessage = history.find((m) => m.role === "tool");
    assertToolMessage(toolMessage);
    assert.equal(toolMessage.content, payload);
  });
});

test("appendMessage compacts memory_recall payload values in persisted history", async () => {
  await withDb((db) => {
    const nowMs = 1_700_000_000_200;
    const sessionId = getOrCreateSessionId({
      db,
      channel: "cli",
      channelKey: "test-memory-recall-history",
      agentId: "main",
      nowMs,
    });

    appendMessage({
      db,
      sessionId,
      nowMs,
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-3", name: "memory_recall", arguments: JSON.stringify({ key: "k1" }) }],
      },
    });

    const originalValue = "value-0123456789\n".repeat(200);
    appendMessage({
      db,
      sessionId,
      nowMs: nowMs + 1,
      message: {
        role: "tool",
        name: "memory_recall",
        toolCallId: "call-3",
        content: JSON.stringify({
          key: "k1",
          value: originalValue,
          category: "observation",
          tags: [],
          access_count: 7,
        }),
      },
    });

    const history = loadRecentHistory({
      db,
      sessionId,
      maxMessages: 20,
      nowMs: nowMs + 10,
    });

    const toolMessage = history.find((m) => m.role === "tool");
    assertToolMessage(toolMessage);

    const parsed = JSON.parse(toolMessage.content) as Record<string, unknown>;
    assert.equal(parsed.key, "k1");
    assert.equal(parsed.value_compacted_for_history, true);
    assert.equal(parsed.value_original_chars, originalValue.length);
    assert.equal(typeof parsed.value, "string");
    assert.ok((parsed.value as string).length < originalValue.length);
    assert.equal(parsed.historyCompactedForTool, true);
  });
});

test("appendMessage compacts memory_search payloads in persisted history", async () => {
  await withDb((db) => {
    const nowMs = 1_700_000_000_300;
    const sessionId = getOrCreateSessionId({
      db,
      channel: "cli",
      channelKey: "test-memory-search-history",
      agentId: "main",
      nowMs,
    });

    appendMessage({
      db,
      sessionId,
      nowMs,
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-4", name: "memory_search", arguments: JSON.stringify({ query: "docker" }) }],
      },
    });

    const rows = Array.from({ length: 20 }, (_, idx) => ({
      key: `k-${idx + 1}`,
      value: "entry-0123456789\n".repeat(80),
      category: "observation",
      tags: ["demo"],
      access_count: idx,
    }));
    appendMessage({
      db,
      sessionId,
      nowMs: nowMs + 1,
      message: {
        role: "tool",
        name: "memory_search",
        toolCallId: "call-4",
        content: JSON.stringify(rows),
      },
    });

    const history = loadRecentHistory({
      db,
      sessionId,
      maxMessages: 20,
      nowMs: nowMs + 10,
    });

    const toolMessage = history.find((m) => m.role === "tool");
    assertToolMessage(toolMessage);

    const parsed = JSON.parse(toolMessage.content) as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(parsed));
    assert.ok(parsed.length >= 2);

    const first = parsed[0] ?? {};
    assert.equal(first.value_compacted_for_history, true);
    assert.equal(first.historyCompactedForTool, true);
    assert.equal(typeof first.value, "string");

    const marker = parsed[parsed.length - 1] ?? {};
    assert.equal(marker.historyCompactedForTool, true);
    assert.equal(typeof marker.omittedResults, "number");
    assert.ok((marker.omittedResults as number) >= 1);
    assert.equal(marker.originalResultCount, 20);
  });
});
