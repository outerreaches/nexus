import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase, type NexusDatabase } from "./database.js";
import { beginSessionTurnNudges, completeSessionTurnNudges } from "./nudges.js";
import { getOrCreateSessionId } from "./sessions.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-nudges-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("nudge state tracks memory and skill cadence per session", async () => {
  await withDb((db) => {
    let nowMs = 1_700_001_000_000;
    const sessionId = getOrCreateSessionId({
      db,
      channel: "cli",
      channelKey: "local",
      agentId: "main",
      nowMs,
    });

    const turn1 = beginSessionTurnNudges({
      db,
      sessionId,
      nowMs,
      memoryTurnInterval: 2,
      skillIterationInterval: 3,
    });
    assert.equal(turn1.state.userTurnCount, 1);
    assert.equal(turn1.memoryNudgeDue, false);
    assert.equal(turn1.skillNudgeDue, false);
    completeSessionTurnNudges({
      db,
      sessionId,
      nowMs: nowMs + 1,
      userTurnCount: turn1.state.userTurnCount,
      iterationsUsed: 1,
      memoryActionUsed: false,
      skillActionUsed: false,
    });

    nowMs += 10;
    const turn2 = beginSessionTurnNudges({
      db,
      sessionId,
      nowMs,
      memoryTurnInterval: 2,
      skillIterationInterval: 3,
    });
    assert.equal(turn2.memoryNudgeDue, true);
    assert.equal(turn2.skillNudgeDue, false);
    completeSessionTurnNudges({
      db,
      sessionId,
      nowMs: nowMs + 1,
      userTurnCount: turn2.state.userTurnCount,
      iterationsUsed: 1,
      memoryActionUsed: false,
      skillActionUsed: false,
    });

    nowMs += 10;
    const turn3 = beginSessionTurnNudges({
      db,
      sessionId,
      nowMs,
      memoryTurnInterval: 2,
      skillIterationInterval: 3,
    });
    assert.equal(turn3.memoryNudgeDue, false);
    assert.equal(turn3.skillNudgeDue, false);
    completeSessionTurnNudges({
      db,
      sessionId,
      nowMs: nowMs + 1,
      userTurnCount: turn3.state.userTurnCount,
      iterationsUsed: 1,
      memoryActionUsed: false,
      skillActionUsed: false,
    });

    nowMs += 10;
    const turn4 = beginSessionTurnNudges({
      db,
      sessionId,
      nowMs,
      memoryTurnInterval: 2,
      skillIterationInterval: 3,
    });
    assert.equal(turn4.memoryNudgeDue, true);
    assert.equal(turn4.skillNudgeDue, true);
  });
});

test("nudge completion resets skill counter when skill action is used", async () => {
  await withDb((db) => {
    const nowMs = 1_700_001_100_000;
    const sessionId = getOrCreateSessionId({
      db,
      channel: "cli",
      channelKey: "skill-reset",
      agentId: "main",
      nowMs,
    });

    const turn = beginSessionTurnNudges({
      db,
      sessionId,
      nowMs,
      memoryTurnInterval: 10,
      skillIterationInterval: 20,
    });
    const completed = completeSessionTurnNudges({
      db,
      sessionId,
      nowMs: nowMs + 1,
      userTurnCount: turn.state.userTurnCount,
      iterationsUsed: 12,
      memoryActionUsed: false,
      skillActionUsed: true,
    });
    assert.equal(completed.skillIterationsSinceAction, 0);
  });
});
