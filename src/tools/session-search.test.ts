import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase, type NexusDatabase } from "../storage/database.js";
import { appendMessage, getOrCreateSessionId } from "../storage/sessions.js";
import { sessionSearch } from "./session-search.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-session-search-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeCtx(params: {
  db: NexusDatabase;
  runId: string;
  sessionId: string;
  agentId: string;
}): any {
  return {
    workspaceDir: process.cwd(),
    stateDir: process.cwd(),
    codeDir: process.cwd(),
    db: params.db,
    request: {
      channel: "agent",
      channelKey: params.runId,
      agentId: params.agentId,
      preset: "coder",
      sessionId: params.sessionId,
      runId: params.runId,
    },
    nowMs: () => 1_700_000_500_000,
    log: () => {},
  };
}

function insertRun(params: {
  db: NexusDatabase;
  runId: string;
  parentRunId: string | null;
  sessionId: string;
  agentId: string;
  preset: string;
  startedAt: number;
}): void {
  params.db.db
    .prepare(
      `INSERT INTO agent_runs (
        run_id, parent_run_id, session_id, agent_id, preset, channel, channel_key, task, status, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.runId,
      params.parentRunId,
      params.sessionId,
      params.agentId,
      params.preset,
      "agent",
      params.runId,
      `${params.preset} task`,
      "running",
      params.startedAt,
    );
}

test("session_search scopes subagents to self and descendants only", async () => {
  await withDb(async (db) => {
    let nowMs = 1_700_000_000_000;
    const rootSession = getOrCreateSessionId({
      db,
      channel: "agent",
      channelKey: "run-root",
      agentId: "main",
      nowMs,
    });
    const childSession = getOrCreateSessionId({
      db,
      channel: "agent",
      channelKey: "run-child",
      agentId: "main:coder",
      nowMs: nowMs + 1,
    });
    const grandSession = getOrCreateSessionId({
      db,
      channel: "agent",
      channelKey: "run-grand",
      agentId: "main:coder:researcher",
      nowMs: nowMs + 2,
    });
    const siblingSession = getOrCreateSessionId({
      db,
      channel: "agent",
      channelKey: "run-sibling",
      agentId: "main:researcher",
      nowMs: nowMs + 3,
    });

    insertRun({
      db,
      runId: "run-root",
      parentRunId: null,
      sessionId: rootSession,
      agentId: "main",
      preset: "orchestrator",
      startedAt: nowMs,
    });
    insertRun({
      db,
      runId: "run-child",
      parentRunId: "run-root",
      sessionId: childSession,
      agentId: "main:coder",
      preset: "coder",
      startedAt: nowMs + 1,
    });
    insertRun({
      db,
      runId: "run-grand",
      parentRunId: "run-child",
      sessionId: grandSession,
      agentId: "main:coder:researcher",
      preset: "researcher",
      startedAt: nowMs + 2,
    });
    insertRun({
      db,
      runId: "run-sibling",
      parentRunId: "run-root",
      sessionId: siblingSession,
      agentId: "main:researcher",
      preset: "researcher",
      startedAt: nowMs + 3,
    });

    appendMessage({ db, sessionId: rootSession, message: { role: "user", content: "orchestrator secret context" }, nowMs: nowMs + 10 });
    appendMessage({ db, sessionId: childSession, message: { role: "user", content: "coder local work note" }, nowMs: nowMs + 11 });
    appendMessage({ db, sessionId: grandSession, message: { role: "assistant", content: "grandchild clue artifact" }, nowMs: nowMs + 12 });
    appendMessage({ db, sessionId: siblingSession, message: { role: "assistant", content: "sibling branch result" }, nowMs: nowMs + 13 });

    const childCtx = makeCtx({
      db,
      runId: "run-child",
      sessionId: childSession,
      agentId: "main:coder",
    });
    const childRaw = await sessionSearch.execute(
      { query: "clue", limit: 10, perSessionLimit: 10, includeContent: true, contentChars: 240 },
      childCtx,
    );
    const childResult = JSON.parse(childRaw) as {
      scope: { mode: string; scopedSessionCount: number };
      messages: Array<{ sessionId: string; contentPreview?: string }>;
    };
    assert.equal(childResult.scope.mode, "run_descendants");
    assert.equal(childResult.scope.scopedSessionCount, 2);
    assert.equal(childResult.messages.some((row) => row.sessionId === grandSession), true);
    assert.equal(childResult.messages.some((row) => row.sessionId === rootSession), false);
    assert.equal(childResult.messages.some((row) => row.sessionId === siblingSession), false);
  });
});

test("session_search lets parent runs recall spawned child sessions", async () => {
  await withDb(async (db) => {
    const nowMs = 1_700_000_100_000;
    const rootSession = getOrCreateSessionId({
      db,
      channel: "agent",
      channelKey: "root-parent",
      agentId: "main",
      nowMs,
    });
    const childSession = getOrCreateSessionId({
      db,
      channel: "agent",
      channelKey: "child-parent",
      agentId: "main:coder",
      nowMs: nowMs + 1,
    });
    insertRun({
      db,
      runId: "root-parent",
      parentRunId: null,
      sessionId: rootSession,
      agentId: "main",
      preset: "orchestrator",
      startedAt: nowMs,
    });
    insertRun({
      db,
      runId: "child-parent",
      parentRunId: "root-parent",
      sessionId: childSession,
      agentId: "main:coder",
      preset: "coder",
      startedAt: nowMs + 1,
    });

    appendMessage({
      db,
      sessionId: childSession,
      message: { role: "assistant", content: "child finding: websocket route remains node-local" },
      nowMs: nowMs + 2,
    });

    const rootCtx = makeCtx({
      db,
      runId: "root-parent",
      sessionId: rootSession,
      agentId: "main",
    });
    const raw = await sessionSearch.execute(
      { query: "websocket route", limit: 10, perSessionLimit: 10, includeContent: false, contentChars: 300 },
      rootCtx,
    );
    const parsed = JSON.parse(raw) as { messages: Array<{ sessionId: string; matchSnippet: string }> };
    assert.equal(parsed.messages.some((row) => row.sessionId === childSession), true);
    assert.equal(parsed.messages.some((row) => /websocket/i.test(row.matchSnippet)), true);
  });
});
