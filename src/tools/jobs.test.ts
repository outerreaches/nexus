import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { jobCreate, jobManage } from "./jobs.js";
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

test("job_manage accepts nested jobId for run_now", async () => {
  await withDb(async (db) => {
    const now = Date.now();
    db.db
      .prepare(
        "INSERT INTO jobs (id, owner_agent_id, name, cron, timezone, enabled, spec_json, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "JALIAS1",
        "main",
        "alias test",
        "*/10 * * * *",
        "UTC",
        1,
        JSON.stringify({ mode: "agent_task", task: "test", deliveryMode: "report_only" }),
        now + 60_000,
        now,
        now,
      );

    const raw = await jobManage.execute(
      {
        action: "run_now",
        args: { jobId: "JALIAS1" },
      },
      {
        db,
        nowMs: () => now,
        log: () => {},
      } as any,
    );

    assert.equal(raw, "OK");
    const row = db.db.prepare("SELECT next_run_at FROM jobs WHERE id = ?").get("JALIAS1") as { next_run_at: number };
    assert.equal(row.next_run_at, now);
  });
});

test("job_manage update can directly replace spec_json", async () => {
  await withDb(async (db) => {
    const now = Date.now();
    db.db
      .prepare(
        "INSERT INTO jobs (id, owner_agent_id, name, cron, timezone, enabled, spec_json, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "JSPEC1",
        "main",
        "spec repair",
        "*/10 * * * *",
        "UTC",
        1,
        JSON.stringify({
          mode: "tool_call",
          tool: "data_intake_run",
          args: {
            mode: "tool_call",
            tool: "data_intake_manage",
            args: { action: "run", args: { instanceId: "DINST1" } },
          },
        }),
        now + 60_000,
        now,
        now,
      );

    const raw = await jobManage.execute(
      {
        action: "update",
        id: "JSPEC1",
        spec: {
          mode: "tool_call",
          tool: "data_intake_manage",
          args: { action: "run", args: { instanceId: "DINST1" } },
        },
      },
      {
        db,
        nowMs: () => now,
        log: () => {},
      } as any,
    );

    const row = JSON.parse(raw) as { spec_json: string };
    const spec = JSON.parse(row.spec_json) as Record<string, unknown>;
    assert.deepEqual(spec, {
      mode: "tool_call",
      tool: "data_intake_manage",
      args: { action: "run", args: { instanceId: "DINST1" } },
    });
  });
});

test("job_manage list adds operational status", async () => {
  await withDb(async (db) => {
    const now = Date.now();
    db.db
      .prepare(
        "INSERT INTO jobs (id, owner_agent_id, name, cron, timezone, enabled, spec_json, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "JSTATUS1",
        "main",
        "pending one-shot",
        "@once",
        "UTC",
        1,
        JSON.stringify({
          mode: "agent_task",
          task: "check",
          oneShotAtMs: now + 60_000,
          scheduleKind: "one_shot",
          autoDeleteAfterRun: true,
          deliveryMode: "report_only",
        }),
        now + 60_000,
        now,
        now,
      );

    const raw = await jobManage.execute(
      {
        action: "list",
        limit: 1,
      },
      {
        db,
        nowMs: () => now,
        log: () => {},
      } as any,
    );

    const rows = JSON.parse(raw) as Array<{ id: string; status: string }>;
    assert.equal(rows[0]?.id, "JSTATUS1");
    assert.equal(rows[0]?.status, "pending");
  });
});

test("job_manage run_history aliases runs with nested args", async () => {
  await withDb(async (db) => {
    const now = Date.now();
    db.db
      .prepare(
        "INSERT INTO jobs (id, owner_agent_id, name, cron, timezone, enabled, spec_json, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "JHIST1",
        "main",
        "history",
        "*/10 * * * *",
        "UTC",
        1,
        JSON.stringify({ mode: "agent_task", task: "test", deliveryMode: "report_only" }),
        now + 60_000,
        now,
        now,
      );
    db.db
      .prepare(
        "INSERT INTO job_runs (id, job_id, owner_agent_id, scheduled_for, started_at, ended_at, status, error, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("JR1", "JHIST1", "main", now, now, now + 1, "failed", "Budget exhausted while iterating (maxIterations=100).", "details");

    const raw = await jobManage.execute(
      {
        action: "run_history",
        args: { jobId: "JHIST1", limit: 5 },
      },
      {
        db,
        nowMs: () => now,
        log: () => {},
      } as any,
    );

    const rows = JSON.parse(raw) as Array<{ id: string; error: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, "JR1");
    assert.match(rows[0]?.error ?? "", /maxIterations=100/);
  });
});
