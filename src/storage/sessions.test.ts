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
