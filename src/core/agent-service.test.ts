import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveHistoryScopeForRequest, shouldAckPending } from "./agent-service.js";
import { openDatabase, type NexusDatabase } from "../storage/database.js";
import { appendMessage, getOrCreateSessionId } from "../storage/sessions.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-agent-service-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("shouldAckPending matches exact run id when present", () => {
  assert.equal(
    shouldAckPending(
      {
        triggerId: "trigger-1",
        expectedAckRunId: "run-123",
        request: {
          sessionId: "session-1",
          channel: "telegram",
          channelKey: "123",
          homeAgentId: "main",
        },
      },
      {
        runId: "run-123",
        sessionId: "session-2",
        channel: "cli",
        channelKey: "local",
        agentId: "other",
      },
    ),
    true,
  );
});

test("shouldAckPending falls back to exact session/channel correlation when run id is unavailable", () => {
  assert.equal(
    shouldAckPending(
      {
        triggerId: "trigger-2",
        request: {
          sessionId: "session-1",
          channel: "telegram",
          channelKey: "123",
          homeAgentId: "main",
        },
      },
      {
        runId: null,
        sessionId: "session-1",
        channel: "telegram",
        channelKey: "123",
        agentId: "main",
      },
    ),
    true,
  );
});

test("shouldAckPending does not ack on channel-only correlation", () => {
  assert.equal(
    shouldAckPending(
      {
        triggerId: "trigger-3",
        request: {
          channel: "telegram",
          channelKey: "123",
          homeAgentId: "main",
        },
      },
      {
        runId: null,
        sessionId: "other-session",
        channel: "telegram",
        channelKey: "123",
        agentId: "main",
      },
    ),
    false,
  );
});

test("shouldAckPending requires matching agent when session fallback is used", () => {
  assert.equal(
    shouldAckPending(
      {
        triggerId: "trigger-4",
        request: {
          sessionId: "session-1",
          channel: "telegram",
          channelKey: "123",
          homeAgentId: "main",
        },
      },
      {
        runId: null,
        sessionId: "session-1",
        channel: "telegram",
        channelKey: "123",
        agentId: "worker",
      },
    ),
    false,
  );
});

test("resolveHistoryScopeForRequest does not self-anchor internal_events when no telegram history exists", async () => {
  await withDb(async (db) => {
    const resolved = resolveHistoryScopeForRequest({
      db,
      channel: "internal_events",
      channelKey: "main",
      agentId: "main",
      historyScope: { mode: "latest_telegram_for_agent" },
    });
    assert.deepEqual(resolved, {
      channel: "agent",
      channelKey: "main",
      agentId: "main",
      source: "latest_telegram_for_agent:fallback:agent",
    });
  });
});

test("resolveHistoryScopeForRequest still prefers latest telegram history when available", async () => {
  await withDb(async (db) => {
    const now = Date.now();
    const sessionId = getOrCreateSessionId({
      db,
      channel: "telegram",
      channelKey: "1000000001",
      agentId: "main",
      nowMs: now,
    });
    appendMessage({
      db,
      sessionId,
      nowMs: now + 1,
      message: { role: "user", content: "hello" },
    });

    const resolved = resolveHistoryScopeForRequest({
      db,
      channel: "internal_events",
      channelKey: "main",
      agentId: "main",
      historyScope: { mode: "latest_telegram_for_agent" },
    });
    assert.deepEqual(resolved, {
      channel: "telegram",
      channelKey: "1000000001",
      agentId: "main",
      source: "latest_telegram_for_agent",
    });
  });
});
