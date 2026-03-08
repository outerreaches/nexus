import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase, type NexusDatabase } from "../storage/database.js";
import { getRunReportById } from "../storage/run-reports.js";
import { setHomeSession } from "../storage/sessions.js";
import { startDeployCompletionWorker } from "./deploy-completion-worker.js";
import { startRunReportBroker } from "./run-report-broker.js";

async function withDbAndState(
  fn: (params: { db: NexusDatabase; stateDir: string }) => Promise<void> | void,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-deploy-completion-worker-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const stateDir = path.join(dir, "state");
  await fs.mkdir(stateDir, { recursive: true });
  const db = await openDatabase(dbPath);
  try {
    await fn({ db, stateDir });
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function latestRunReportId(db: NexusDatabase): string | null {
  const row = db.db
    .prepare("SELECT id FROM run_reports ORDER BY created_at DESC LIMIT 1")
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

test("deploy completion worker enqueues and broker delivers home-channel completion notifications", async () => {
  await withDbAndState(async ({ db, stateDir }) => {
    const nowMs = Date.now();
    setHomeSession({
      db,
      agentId: "main",
      channel: "telegram",
      channelKey: "12345",
      nowMs,
    });

    const completionsDir = path.join(stateDir, "deploy-completions");
    await fs.mkdir(completionsDir, { recursive: true });
    await fs.writeFile(
      path.join(completionsDir, "completion.json"),
      JSON.stringify(
        {
          id: "DC_TEST_001",
          action: "apply",
          status: "applied_local",
          triggerId: "trigger-1",
          approvalId: "HATEST123",
          candidateId: "cand-1",
          effectiveSha: "abc123",
          lastGoodSha: "def456",
          request: {
            channel: "telegram",
            channelKey: "12345",
            agentId: "main:coder",
            homeAgentId: "main",
            sessionId: "session-1",
            runId: "run-1",
            parentRunId: null,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const worker = startDeployCompletionWorker({
      db,
      stateDir,
      log: () => {},
    });
    assert.ok(worker, "worker should start");

    const sent: Array<{ chatId: number; text: string }> = [];
    const broker = startRunReportBroker({
      db,
      agent: null,
      telegram: {
        sendOutput: async (chatId: number, output: string) => {
          sent.push({ chatId, text: output });
        },
        allowFrom: [12345],
        allowAll: false,
      },
      log: () => {},
    });
    assert.ok(broker, "broker should start");

    const workerProcessed = await worker.tick();
    const brokerProcessed = await broker.tick();

    worker.stop();
    broker.stop();

    assert.equal(workerProcessed, 1);
    assert.equal(brokerProcessed, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.chatId, 12345);
    assert.match(sent[0]?.text ?? "", /Deploy applied successfully and the active gateway switched/i);
    assert.match(sent[0]?.text ?? "", /Background finalization of the old primary may still continue/i);
    assert.match(sent[0]?.text ?? "", /Approval ID: HATEST123/i);
    assert.match(sent[0]?.text ?? "", /Effective SHA: abc123/i);

    const reportId = latestRunReportId(db);
    assert.ok(reportId, "expected a run report");
    const report = getRunReportById(db, reportId!);
    assert.equal(report?.kind, "deploy_completion");
    assert.equal(report?.targetChannel, "home_channel");
    assert.equal(report?.targetAgentId, "main");
    assert.equal(report?.status, "sent");

    await assert.rejects(fs.access(path.join(completionsDir, "completion.json")));
  });
});

test("deploy completion worker delivers deploy-started notifications", async () => {
  await withDbAndState(async ({ db, stateDir }) => {
    const nowMs = Date.now();
    setHomeSession({
      db,
      agentId: "main",
      channel: "telegram",
      channelKey: "12345",
      nowMs,
    });

    const completionsDir = path.join(stateDir, "deploy-completions");
    await fs.mkdir(completionsDir, { recursive: true });
    await fs.writeFile(
      path.join(completionsDir, "started.json"),
      JSON.stringify(
        {
          id: "DC_TEST_002",
          action: "apply",
          status: "started",
          triggerId: "trigger-2",
          approvalId: "HASTART123",
          candidateId: "cand-2",
          lastGoodSha: "def456",
          request: {
            channel: "telegram",
            channelKey: "12345",
            agentId: "main:coder",
            homeAgentId: "main",
            sessionId: "session-1",
            runId: "run-2",
            parentRunId: null,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const worker = startDeployCompletionWorker({
      db,
      stateDir,
      log: () => {},
    });
    assert.ok(worker, "worker should start");

    const sent: Array<{ chatId: number; text: string }> = [];
    const broker = startRunReportBroker({
      db,
      agent: null,
      telegram: {
        sendOutput: async (chatId: number, output: string) => {
          sent.push({ chatId, text: output });
        },
        allowFrom: [12345],
        allowAll: false,
      },
      log: () => {},
    });
    assert.ok(broker, "broker should start");

    const workerProcessed = await worker.tick();
    const brokerProcessed = await broker.tick();

    worker.stop();
    broker.stop();

    assert.equal(workerProcessed, 1);
    assert.equal(brokerProcessed, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.chatId, 12345);
    assert.match(sent[0]?.text ?? "", /Deploy started on the host/i);
    assert.match(sent[0]?.text ?? "", /building the inactive slot/i);
    assert.match(sent[0]?.text ?? "", /Approval ID: HASTART123/i);

    const reportId = latestRunReportId(db);
    assert.ok(reportId, "expected a run report");
    const report = getRunReportById(db, reportId!);
    assert.equal(report?.kind, "deploy_completion");
    assert.equal(report?.title, "Deploy started");
    assert.equal(report?.status, "sent");
  });
});
