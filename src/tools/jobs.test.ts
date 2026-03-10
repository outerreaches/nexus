import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { jobCreate } from "./jobs.js";
import { openDatabase, type NexusDatabase } from "../storage/database.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-jobs-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("job_create defaults telegram one-shot agent tasks to session_resume", async () => {
  await withDb(async (db) => {
    const raw = await jobCreate.execute(
      {
        name: "check download",
        at: Date.now() + 60_000,
        mode: "agent_task",
        task: "Check whether the download finished.",
      },
      {
        db,
        nowMs: () => Date.now(),
        log: () => {},
        request: {
          channel: "telegram",
          channelKey: "1000000001",
          sessionId: "session-telegram-1",
          agentId: "main",
          runId: "run-telegram-1",
          preset: "orchestrator",
        },
      } as any,
    );
    const row = JSON.parse(raw) as { spec_json: string };
    const spec = JSON.parse(row.spec_json) as Record<string, unknown>;
    assert.equal(spec.deliveryMode, "session_resume");
    assert.equal(spec.originChannel, "telegram");
    assert.equal(spec.originChannelKey, "1000000001");
    assert.equal(spec.originSessionId, "session-telegram-1");
    assert.equal(spec.originAgentId, "main");
    assert.equal(spec.originRunId, "run-telegram-1");
    assert.equal(spec.originPreset, "orchestrator");
  });
});

test("job_create defaults heartbeat one-shot agent tasks to report_only", async () => {
  await withDb(async (db) => {
    const raw = await jobCreate.execute(
      {
        name: "check service",
        at: Date.now() + 60_000,
        mode: "agent_task",
        task: "Check whether the service is back up.",
      },
      {
        db,
        nowMs: () => Date.now(),
        log: () => {},
        request: {
          channel: "heartbeat",
          channelKey: "gateway",
          sessionId: "session-heartbeat-1",
          agentId: "main",
          runId: "run-heartbeat-1",
          preset: "orchestrator",
        },
      } as any,
    );
    const row = JSON.parse(raw) as { spec_json: string };
    const spec = JSON.parse(row.spec_json) as Record<string, unknown>;
    assert.equal(spec.deliveryMode, "report_only");
    assert.equal(spec.resumeUnavailable, true);
    assert.equal(spec.originChannel, undefined);
  });
});

test("job_create recovers telegram ancestor origin for nested runs", async () => {
  await withDb(async (db) => {
    db.db
      .prepare(
        "INSERT INTO agent_runs (run_id, parent_run_id, session_id, agent_id, preset, channel, channel_key, task, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("run-parent-telegram", null, "session-telegram-2", "main", "orchestrator", "telegram", "1000000001", "parent", "complete", Date.now() - 1_000);
    db.db
      .prepare(
        "INSERT INTO agent_runs (run_id, parent_run_id, session_id, agent_id, preset, channel, channel_key, task, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("run-child-job", "run-parent-telegram", "session-child", "coder", "coder", "job", "J123", "child", "complete", Date.now());

    const raw = await jobCreate.execute(
      {
        name: "nested follow-up",
        at: Date.now() + 60_000,
        mode: "agent_task",
        task: "Check again later.",
      },
      {
        db,
        nowMs: () => Date.now(),
        log: () => {},
        request: {
          channel: "job",
          channelKey: "J123",
          sessionId: "session-child",
          agentId: "coder",
          runId: "run-child-job",
          preset: "coder",
        },
      } as any,
    );
    const row = JSON.parse(raw) as { spec_json: string };
    const spec = JSON.parse(row.spec_json) as Record<string, unknown>;
    assert.equal(spec.deliveryMode, "session_resume");
    assert.equal(spec.originChannel, "telegram");
    assert.equal(spec.originChannelKey, "1000000001");
    assert.equal(spec.originSessionId, "session-telegram-2");
    assert.equal(spec.originAgentId, "main");
    assert.equal(spec.originRunId, "run-parent-telegram");
    assert.equal(spec.originPreset, "orchestrator");
    assert.equal(spec.originRecoveredFrom, "telegram_ancestor");
  });
});
