import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startRunReportBroker } from "./run-report-broker.js";
import { openDatabase, type NexusDatabase } from "../storage/database.js";
import { enqueueRunReport, getRunReportById } from "../storage/run-reports.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-run-report-broker-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("run report broker only delivers to agent channel", async () => {
  await withDb(async (db) => {
    let agentCalls = 0;
    const broker = startRunReportBroker({
      db,
      agent: {
        handleUserMessage: async () => {
          agentCalls += 1;
          return {
            runId: null,
            sessionId: "internal",
            output: "IDLE",
            status: "complete",
            toolCallsUsed: 0,
            iterationsUsed: 0,
          };
        },
      } as any,
      log: () => {},
    });
    assert.ok(broker, "broker should start");

    const reportId = enqueueRunReport(db, {
      kind: "test",
      title: "Test Report",
      body: "hello",
      targetAgentId: "main",
      targetChannel: "agent",
      targetChannelKey: "test:key",
      metadata: { targetPreset: "orchestrator" },
      nowMs: Date.now(),
    });

    const processed = await broker.tick();
    broker.stop();

    assert.equal(processed, 1);
    assert.equal(agentCalls, 1);
    const row = getRunReportById(db, reportId);
    assert.equal(row?.status, "sent");
  });
});

test("run report broker dead-letters telegram target reports", async () => {
  await withDb(async (db) => {
    let agentCalls = 0;
    const broker = startRunReportBroker({
      db,
      agent: {
        handleUserMessage: async () => {
          agentCalls += 1;
          return {
            runId: null,
            sessionId: "internal",
            output: "IDLE",
            status: "complete",
            toolCallsUsed: 0,
            iterationsUsed: 0,
          };
        },
      } as any,
      log: () => {},
    });
    assert.ok(broker, "broker should start");

    const reportId = enqueueRunReport(db, {
      kind: "test",
      title: "Legacy Telegram Report",
      body: "hello",
      targetAgentId: "main",
      targetChannel: "telegram",
      targetChannelKey: "12345",
      nowMs: Date.now(),
    });

    const processed = await broker.tick();
    broker.stop();

    assert.equal(processed, 1);
    assert.equal(agentCalls, 0);
    const row = getRunReportById(db, reportId);
    assert.equal(row?.status, "dead_letter");
    assert.match(row?.lastError ?? "", /unsupported_target_channel:telegram/);
  });
});
