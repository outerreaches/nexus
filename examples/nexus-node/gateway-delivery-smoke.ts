#!/usr/bin/env tsx
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { NodeRegistry } from "../../src/nodes/registry.js";
import { NodeToolRouter } from "../../src/nodes/router.js";
import { createNodeProcessDeliveryHandler } from "../../src/nodes/process-delivery.js";
import { startProcessNotifier } from "../../src/process/notifier.js";
import { openDatabase } from "../../src/storage/database.js";

type NotifierHandle = { stop: () => void } | null;

function asNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

async function waitForCondition(params: {
  timeoutMs: number;
  intervalMs: number;
  message: string;
  predicate: () => boolean;
}): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    if (params.predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, params.intervalMs));
  }
  throw new Error(params.message);
}

async function main(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-delivery-smoke-"));
  const stateDir = path.join(tempDir, "state");
  const dbPath = path.join(stateDir, "gateway.db");
  const logLines: string[] = [];
  const sentOutputs: Array<{ chatId: number; output: string }> = [];
  const agentCalls: Array<{ channel: string; channelKey: string; preset: string; executionLane: string }> = [];

  const envKeys = [
    "NEXUS_PROCESS_NOTIFIER",
    "NEXUS_PROCESS_NOTIFIER_TICK_MS",
    "NEXUS_PROCESS_NOTIFIER_MAX_PER_TICK",
    "NEXUS_PROCESS_NOTIFIER_LOCK_MS",
  ] as const;
  const previousEnv = new Map<string, string | undefined>();
  for (const key of envKeys) previousEnv.set(key, process.env[key]);

  let db: Awaited<ReturnType<typeof openDatabase>> | null = null;
  let notifierA: NotifierHandle = null;
  let notifierB: NotifierHandle = null;

  try {
    db = await openDatabase(dbPath);

    const routeRegistry = new NodeRegistry({ log: () => undefined });
    const routeNodeId = "route-constraint-node";
    const routeNowMs = Date.now();
    routeRegistry.registerOrUpdate({
      id: routeNodeId,
      label: "Routing Constraint Smoke Node",
      publicKey: "pub_route_node",
      fingerprint: "fp_route_node",
      status: "online",
      backend: "nexus",
      trustLevel: "standard",
      firewallMode: "transparent",
      capabilities: ["system.run", "backend.nexus", "hermes.mode.transparent"],
      tags: [],
      metadata: {},
      connectedAt: routeNowMs,
      lastSeenAt: routeNowMs,
      nowMs: routeNowMs,
    });
    const routeTool = {
      name: "shell_exec",
      description: "routing smoke tool",
      jsonSchema: {},
      execute: async () => "unused",
    };
    const router = new NodeToolRouter({
      registry: routeRegistry,
      log: () => undefined,
      executeOnNode: async () => "ROUTED_OK",
    });
    await assert.rejects(
      () =>
        router.routeToolExecution(
          routeTool,
          { command: "echo route-smoke", security: { requireHermesMode: true } },
          {
            workspaceDir: process.cwd(),
            stateDir,
            codeDir: process.cwd(),
            executionMode: "remote",
            nowMs: () => Date.now(),
            log: () => undefined,
          },
        ),
      (err: unknown) => {
        const code =
          err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
        assert.equal(code, "SECURITY_CONSTRAINT_UNSATISFIED");
        return true;
      },
      "routing constraint should hard-fail when hermes.mode.hermes is required but unavailable",
    );
    routeRegistry.registerOrUpdate({
      id: routeNodeId,
      label: "Routing Constraint Smoke Node",
      publicKey: "pub_route_node",
      fingerprint: "fp_route_node",
      status: "online",
      backend: "nexus",
      trustLevel: "standard",
      firewallMode: "hermes",
      capabilities: ["system.run", "backend.nexus", "hermes.mode.hermes", "hermes.enabled"],
      tags: [],
      metadata: {},
      connectedAt: routeNowMs,
      lastSeenAt: routeNowMs,
      nowMs: routeNowMs,
    });
    const routedResult = await router.routeToolExecution(
      routeTool,
      { command: "echo route-smoke", security: { requireHermesMode: true } },
      {
        workspaceDir: process.cwd(),
        stateDir,
        codeDir: process.cwd(),
        executionMode: "remote",
        nowMs: () => Date.now(),
        log: () => undefined,
      },
    );
    assert.equal(routedResult, "ROUTED_OK");

    const delivery = createNodeProcessDeliveryHandler({
      db,
      stateDir,
      log: (line) => logLines.push(line),
    });

    const nodeId = "smoke-node-gateway";
    const processId = "proc_terminal_smoke";
    const nowMs = Date.now();

    await delivery.handleLogAppend({
      nodeId,
      receivedAt: nowMs,
      payload: {
        processId: "proc_logonly_smoke",
        stream: "stdout",
        chunk: "  hello from log.append  \n\n",
      },
    });

    const logOnlyRow = db.db
      .prepare("SELECT id, backend, status, log_path, notify_mode FROM process_runs WHERE id = ?")
      .get("proc_logonly_smoke") as
      | {
          id: string;
          backend: string;
          status: string;
          log_path: string;
          notify_mode: string;
        }
      | undefined;
    assert.ok(logOnlyRow, "log.append should create/seed process_runs row");
    assert.equal(logOnlyRow.backend, "node_process");
    assert.equal(logOnlyRow.status, "running");
    assert.equal(logOnlyRow.notify_mode, "never");
    const logOnlyText = await fs.readFile(logOnlyRow.log_path, "utf8");
    assert.match(logOnlyText, /  hello from log\.append  \n\n/);

    const terminalPayload = {
      processId,
      status: "failed",
      startedAt: nowMs - 4_000,
      endedAt: nowMs - 1_000,
      exitCode: 2,
      signal: null,
      summary: "terminal failure summary",
      deliveryId: "dlv_smoke_terminal_1",
      hermes: {
        mode: "hermes",
        sanitized: true,
        references: [
          {
            refId: "ref_smoke_1",
            sourceType: "process.output",
            title: "terminal summary ref",
          },
        ],
      },
      routing: {
        runId: "run-smoke-1",
        parentRunId: null,
        sessionId: "sess-smoke-1",
        channel: "telegram",
        channelKey: "12345",
        firewallSession: "fw-smoke-1",
        notify: {
          mode: "on_failure",
          chatId: 12345,
          preset: "process-manager",
        },
      },
    };
    const persisted = await delivery.handleProcessUpdate({
      nodeId,
      receivedAt: nowMs,
      payload: terminalPayload,
    });
    assert.equal(persisted, true, "terminal process.update should persist successfully");

    const row = db.db
      .prepare(
        `SELECT
           id, backend, status, node_id, node_execution_id, request_channel, request_channel_key,
           request_session_id, request_run_id, request_parent_run_id, notify_mode, notify_chat_id, notify_preset,
          exit_code, signal, ended_at, log_path, metadata_json
         FROM process_runs
         WHERE id = ?`,
      )
      .get(processId) as
      | {
          id: string;
          backend: string;
          status: string;
          node_id: string | null;
          node_execution_id: string | null;
          request_channel: string | null;
          request_channel_key: string | null;
          request_session_id: string | null;
          request_run_id: string | null;
          request_parent_run_id: string | null;
          notify_mode: string;
          notify_chat_id: number | null;
          notify_preset: string | null;
          exit_code: number | null;
          signal: string | null;
          ended_at: number | null;
          log_path: string;
          metadata_json: string;
        }
      | undefined;
    assert.ok(row, "terminal process row should exist");
    assert.equal(row.backend, "node_process");
    assert.equal(row.status, "exited");
    assert.equal(row.node_id, nodeId);
    assert.equal(row.node_execution_id, processId);
    assert.equal(row.request_channel, "telegram");
    assert.equal(row.request_channel_key, "12345");
    assert.equal(row.request_session_id, "sess-smoke-1");
    assert.equal(row.request_run_id, "run-smoke-1");
    assert.equal(row.request_parent_run_id, null);
    assert.equal(row.notify_mode, "on_failure");
    assert.equal(row.notify_chat_id, 12345);
    assert.equal(row.notify_preset, "process-manager");
    assert.equal(row.exit_code, 2);
    assert.equal(row.signal, null);
    assert.ok(asNumber(row.ended_at), "ended_at should be set for terminal process");
    assert.ok(!row.metadata_json.includes("terminal failure summary"), "raw summary must not be persisted in metadata");
    const metadataObj = JSON.parse(row.metadata_json) as Record<string, unknown>;
    const routingMeta = (metadataObj.routing ?? {}) as Record<string, unknown>;
    const hermesMeta = (metadataObj.hermes ?? {}) as Record<string, unknown>;
    assert.equal("notify" in routingMeta, false, "routing.notify should not be persisted in metadata");
    assert.equal(hermesMeta.mode, "hermes");
    assert.equal(hermesMeta.sanitized, true);

    await delivery.handleProcessUpdate({
      nodeId,
      receivedAt: nowMs + 100,
      payload: {
        ...terminalPayload,
        deliveryId: "dlv_smoke_terminal_2",
      },
    });
    const rowCount = db.db
      .prepare("SELECT COUNT(*) as count FROM process_runs WHERE id = ?")
      .get(processId) as { count: number } | undefined;
    assert.equal(rowCount?.count ?? 0, 1, "duplicate process.update should not create duplicate rows");

    const terminalLogText = await fs.readFile(row.log_path, "utf8");
    assert.match(terminalLogText, /terminal failure summary/);

    process.env.NEXUS_PROCESS_NOTIFIER = "1";
    process.env.NEXUS_PROCESS_NOTIFIER_TICK_MS = "100";
    process.env.NEXUS_PROCESS_NOTIFIER_MAX_PER_TICK = "5";
    process.env.NEXUS_PROCESS_NOTIFIER_LOCK_MS = "3000";

    const processManager = {
      reconcileDetachedRunning: async () => ({ checked: 0, updated: 0 }),
    };
    const agent = {
      handleUserMessage: async (params: {
        channel: string;
        channelKey: string;
        preset: string;
        executionLane: string;
      }) => {
        agentCalls.push({
          channel: params.channel,
          channelKey: params.channelKey,
          preset: params.preset,
          executionLane: params.executionLane,
        });
        return {
          status: "complete",
          output: "Gateway notifier smoke summary",
        };
      },
    };
    const telegram = {
      sendOutput: async (chatId: number, output: string) => {
        sentOutputs.push({ chatId, output });
      },
      allowFrom: [] as number[],
      allowAll: true,
    };

    notifierA = startProcessNotifier({
      db,
      agent: agent as any,
      processManager: processManager as any,
      telegram,
      log: (line) => logLines.push(line),
    });
    notifierB = startProcessNotifier({
      db,
      agent: agent as any,
      processManager: processManager as any,
      telegram,
      log: (line) => logLines.push(line),
    });
    assert.ok(notifierA && notifierB, "notifier should start in smoke test");

    await waitForCondition({
      timeoutMs: 8_000,
      intervalMs: 100,
      message: "process notifier did not mark process as notified",
      predicate: () => {
        const row = db!.db
          .prepare("SELECT notified_at FROM process_runs WHERE id = ?")
          .get(processId) as { notified_at?: number | null } | undefined;
        return typeof row?.notified_at === "number" && row.notified_at > 0;
      },
    });

    notifierA?.stop();
    notifierB?.stop();
    notifierA = null;
    notifierB = null;

    assert.equal(agentCalls.length, 1, "duplicate notifier runners should not execute summary callback twice");
    assert.equal(sentOutputs.length, 0, "process notifier should not send direct Telegram messages");

    const queuedReport = db.db
      .prepare(
        `SELECT kind, target_channel, target_channel_key, title, body, metadata_json
         FROM run_reports
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get() as
      | {
          kind: string;
          target_channel: string;
          target_channel_key: string | null;
          title: string;
          body: string;
          metadata_json: string;
        }
      | undefined;
    assert.ok(queuedReport, "expected a queued run report");
    assert.equal(queuedReport?.kind, "process");
    assert.equal(queuedReport?.target_channel, "agent");
    assert.equal(queuedReport?.target_channel_key, "12345");
    assert.match(queuedReport?.title ?? "", /PROCESS ALERT/);
    assert.match(queuedReport?.body ?? "", /Gateway notifier smoke summary/);
    const reportMeta = JSON.parse(queuedReport?.metadata_json ?? "{}") as Record<string, unknown>;
    assert.equal(reportMeta.targetPreset, "orchestrator");
    assert.equal(reportMeta.preferredTelegramChatId, 12345);

    process.stdout.write(
      "[gateway-smoke] PASS: gateway delivery persistence + hermes metadata sanitization + routing security constraints + notifier duplicate suppression verified\n",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gateway-smoke] FAIL: ${message}\n`);
    if (logLines.length > 0) {
      process.stderr.write("[gateway-smoke] logs:\n");
      process.stderr.write(`${logLines.join("\n")}\n`);
    }
    process.exitCode = 1;
  } finally {
    notifierA?.stop();
    notifierB?.stop();
    for (const key of envKeys) {
      const prev = previousEnv.get(key);
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
    db?.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

void main();
