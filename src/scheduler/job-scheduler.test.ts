import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startJobScheduler } from "./job-scheduler.js";
import { openDatabase, type NexusDatabase } from "../storage/database.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-job-scheduler-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function schedulerConfig() {
  return {
    channels: { telegram: { enabled: true } },
    scheduler: {
      enabled: true,
      tickIntervalMs: 60_000,
      maxRunsPerTick: 5,
      concurrency: 1,
      leaseTtlMs: 60_000,
      maxConsecutiveFailures: 5,
      notifyAgentOnFailure: true,
      notifyCooldownMs: 0,
    },
  } as any;
}

test("scheduler resumes one-shot telegram follow-up jobs in the original session without queuing a report", async () => {
  await withDb(async (db) => {
    const now = Date.now();
    db.db
      .prepare(
        "INSERT INTO jobs (id, owner_agent_id, name, cron, timezone, enabled, spec_json, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "JRESUME1",
        "main",
        "check download",
        "@once",
        "UTC",
        1,
        JSON.stringify({
          mode: "agent_task",
          task: "Check if the download finished.",
          oneShotAtMs: now - 1_000,
          scheduleKind: "one_shot",
          autoDeleteAfterRun: true,
          deliveryMode: "session_resume",
          originChannel: "telegram",
          originChannelKey: "1000000001",
          originSessionId: "telegram-session-1",
          originAgentId: "main",
          originRunId: "run-telegram-parent",
          originPreset: "orchestrator",
          originTelegramChatId: 1000000001,
          originRecoveredFrom: "direct_request",
        }),
        now - 1_000,
        now - 2_000,
        now - 2_000,
      );

    const agentCalls: any[] = [];
    const acks: any[] = [];
    const sent: Array<{ chatId: number; output: string }> = [];
    const scheduler = startJobScheduler({
      config: schedulerConfig(),
      db,
      log: () => {},
      workspaceDir: process.cwd(),
      getTools: () => [],
      toolContext: {
        nowMs: () => Date.now(),
        log: () => {},
        telegram: {
          sendOutput: async (chatId: number, output: string) => {
            sent.push({ chatId, output });
          },
        },
      } as any,
      agent: {
        handleUserMessage: async (params: any) => {
          agentCalls.push(params);
          return {
            runId: "agent-run-1",
            sessionId: "telegram-session-1",
            output: "Download finished successfully.",
            status: "complete",
            toolCallsUsed: 1,
            iterationsUsed: 1,
          };
        },
        ackDeployIfPending: (params: any) => {
          acks.push(params);
        },
        withTelegramDeliveryAck: async (
          ackContext: { chatId: number; runId: string | null; sessionId: string; agentId: string },
          deliver: () => Promise<unknown>,
        ) => {
          try {
            return await deliver();
          } finally {
            acks.push({
              runId: ackContext.runId,
              sessionId: ackContext.sessionId,
              channel: "telegram",
              channelKey: String(ackContext.chatId),
              agentId: ackContext.agentId,
            });
          }
        },
      } as any,
    });
    assert.ok(scheduler);
    await scheduler.tick();
    scheduler.stop();

    assert.equal(agentCalls.length, 1);
    assert.equal(agentCalls[0]?.channel, "telegram");
    assert.equal(agentCalls[0]?.channelKey, "1000000001");
    assert.deepEqual(agentCalls[0]?.historyScope, {
      mode: "exact",
      channel: "telegram",
      channelKey: "1000000001",
      agentId: "main",
    });
    assert.deepEqual(agentCalls[0]?.writeSession, {
      channel: "telegram",
      channelKey: "1000000001",
      agentId: "main",
    });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { chatId: 1000000001, output: "Download finished successfully." });
    assert.equal(acks.length, 1);

    const reportCount = db.db.prepare("SELECT COUNT(*) AS count FROM run_reports").get() as { count: number };
    assert.equal(reportCount.count, 0);
    const remainingJob = db.db.prepare("SELECT id FROM jobs WHERE id = ?").get("JRESUME1");
    assert.equal(remainingJob, undefined);
  });
});

test("scheduler keeps legacy one-shot report_only agent tasks on the report pipeline", async () => {
  await withDb(async (db) => {
    const now = Date.now();
    db.db
      .prepare(
        "INSERT INTO jobs (id, owner_agent_id, name, cron, timezone, enabled, spec_json, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "JREPORT1",
        "main",
        "legacy check",
        "@once",
        "UTC",
        1,
        JSON.stringify({
          mode: "agent_task",
          task: "Check the old background task.",
          oneShotAtMs: now - 1_000,
          scheduleKind: "one_shot",
          autoDeleteAfterRun: true,
          deliveryMode: "report_only",
          resumeUnavailable: true,
        }),
        now - 1_000,
        now - 2_000,
        now - 2_000,
      );

    const scheduler = startJobScheduler({
      config: schedulerConfig(),
      db,
      log: () => {},
      workspaceDir: process.cwd(),
      getTools: () => [],
      toolContext: {
        nowMs: () => Date.now(),
        log: () => {},
      } as any,
      agent: {
        handleUserMessage: async () => ({
          runId: "agent-run-2",
          sessionId: "job-session-1",
          output: "Checked.\nJOB_STATUS: ok\nJOB_REPORT: update",
          status: "complete",
          toolCallsUsed: 1,
          iterationsUsed: 1,
        }),
        ackDeployIfPending: () => {},
        withTelegramDeliveryAck: async (_ctx: unknown, deliver: () => Promise<unknown>) => deliver(),
      } as any,
    });
    assert.ok(scheduler);
    await scheduler.tick();
    scheduler.stop();

    const reportCount = db.db.prepare("SELECT COUNT(*) AS count FROM run_reports").get() as { count: number };
    assert.equal(reportCount.count, 1);
  });
});
