#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { ReferenceNodeStateStore } from "./state-store.js";

type HttpResult = {
  ok: boolean;
  status: number;
  json: Record<string, unknown> | null;
  text: string;
};

type ParsedArgs = {
  dryRun: boolean;
};

type NodeRuntime = {
  child: ChildProcessWithoutNullStreams;
  logs: string[];
};

type NodeSnapshot = {
  id: string;
  status: string;
  connectedAt: number | null;
};

type OutboxProgress = {
  total: number;
  delivered: number;
};

type ProcessRunSnapshot = {
  count: number;
  updatedAt: number | null;
  nodeId: string | null;
  status: string | null;
};

type SeededReplayState = {
  processId: string;
  deliveryIds: string[];
  nodeDbPath: string;
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  return { dryRun: argv.includes("--dry-run") };
}

function toWsUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/nx/nodes";
  u.search = "";
  u.hash = "";
  return u.toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url: string, init?: RequestInit): Promise<HttpResult> {
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = asObject(JSON.parse(text));
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    return { ok: false, status: 0, json: null, text: err instanceof Error ? err.message : String(err) };
  }
}

async function waitForCondition(params: {
  timeoutMs: number;
  intervalMs: number;
  message: string;
  predicate: () => Promise<boolean>;
}): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    if (await params.predicate()) return;
    await sleep(params.intervalMs);
  }
  throw new Error(params.message);
}

async function waitForMode(params: {
  url: string;
  mode: "active" | "standby";
  timeoutMs: number;
}): Promise<void> {
  await waitForCondition({
    timeoutMs: params.timeoutMs,
    intervalMs: 500,
    message: `mode check timed out url=${params.url} expected=${params.mode}`,
    predicate: async () => {
      const res = await requestJson(`${params.url}/api/mode`);
      if (!res.ok || !res.json) return false;
      return asString(res.json.mode) === params.mode;
    },
  });
}

async function expectNodeEndpointStatus(params: { url: string; expectedStatus: number; label: string }): Promise<void> {
  const res = await requestJson(`${params.url}/nx/nodes`);
  assert.equal(
    res.status,
    params.expectedStatus,
    `${params.label}: expected /nx/nodes status ${params.expectedStatus}, got ${res.status} body=${res.text}`,
  );
}

async function getNodeSnapshot(apiBaseUrl: string, nodeId: string): Promise<NodeSnapshot | null> {
  const res = await requestJson(`${apiBaseUrl}/api/nodes`);
  if (!res.ok || !res.json) return null;
  const rawNodes = Array.isArray(res.json.nodes) ? res.json.nodes : [];
  for (const rawNode of rawNodes) {
    const node = asObject(rawNode);
    if (asString(node.id) !== nodeId) continue;
    return {
      id: nodeId,
      status: asString(node.status) ?? "unknown",
      connectedAt: asNumber(node.connectedAt),
    };
  }
  return null;
}

async function approveNode(apiBaseUrl: string, nodeId: string): Promise<void> {
  const res = await requestJson(`${apiBaseUrl}/api/nodes/${encodeURIComponent(nodeId)}/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status: "approved" }),
  });
  assert.equal(res.status, 200, `node approval failed for ${nodeId}: ${res.text}`);
}

async function waitForNodeOnline(params: {
  apiBaseUrl: string;
  nodeId: string;
  timeoutMs: number;
  autoApprove: boolean;
}): Promise<void> {
  let approvalAttempted = false;
  await waitForCondition({
    timeoutMs: params.timeoutMs,
    intervalMs: 700,
    message: `node did not reach online status id=${params.nodeId}`,
    predicate: async () => {
      const node = await getNodeSnapshot(params.apiBaseUrl, params.nodeId);
      if (!node) return false;
      if (params.autoApprove && node.status === "pending" && !approvalAttempted) {
        approvalAttempted = true;
        await approveNode(params.apiBaseUrl, params.nodeId);
        return false;
      }
      return node.status === "online" && typeof node.connectedAt === "number" && node.connectedAt > 0;
    },
  });
}

function readOutboxProgress(nodeDbPath: string, processId: string): OutboxProgress {
  const db = new Database(nodeDbPath);
  try {
    const row = db
      .prepare(
        `
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN delivered = 1 THEN 1 ELSE 0 END), 0) AS delivered
        FROM node_outbox
        WHERE process_id = ?
      `,
      )
      .get(processId) as { total?: number; delivered?: number } | undefined;
    const total = Number(row?.total ?? 0);
    const delivered = Number(row?.delivered ?? 0);
    return {
      total: Number.isFinite(total) ? total : 0,
      delivered: Number.isFinite(delivered) ? delivered : 0,
    };
  } finally {
    db.close();
  }
}

async function resetOutboxDeliveries(nodeDbPath: string, processId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const db = new Database(nodeDbPath);
      try {
        db.prepare(
          `
          UPDATE node_outbox
          SET delivered = 0, delivered_at = NULL
          WHERE process_id = ?
        `,
        ).run(processId);
      } finally {
        db.close();
      }
      return;
    } catch (err) {
      lastError = err;
      await sleep(150);
    }
  }
  throw new Error(
    `failed to reset node outbox deliveries: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function readProcessRunSnapshot(gatewayDbPath: string, processId: string): ProcessRunSnapshot {
  const db = new Database(gatewayDbPath);
  try {
    const countRow = db
      .prepare("SELECT COUNT(*) as count FROM process_runs WHERE id = ?")
      .get(processId) as { count?: number } | undefined;
    const row = db
      .prepare("SELECT updated_at, node_id, status FROM process_runs WHERE id = ?")
      .get(processId) as { updated_at?: number | null; node_id?: string | null; status?: string | null } | undefined;
    const count = Number(countRow?.count ?? 0);
    return {
      count: Number.isFinite(count) ? count : 0,
      updatedAt: row?.updated_at ?? null,
      nodeId: row?.node_id ?? null,
      status: row?.status ?? null,
    };
  } finally {
    db.close();
  }
}

async function waitForGatewayDb(gatewayDbPath: string, timeoutMs: number): Promise<void> {
  await waitForCondition({
    timeoutMs,
    intervalMs: 500,
    message: `gateway DB not found at ${gatewayDbPath}`,
    predicate: async () => {
      try {
        await fs.access(gatewayDbPath);
        return true;
      } catch {
        return false;
      }
    },
  });
}

async function seedReplayOutbox(params: {
  nodeStateDir: string;
  deliveryCount: number;
}): Promise<SeededReplayState> {
  const now = Date.now();
  const processId = `ha_replay_${now.toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const routing = {
    runId: `ha-run-${processId}`,
    parentRunId: null,
    sessionId: `ha-session-${processId}`,
    channel: "telegram",
    channelKey: "12345",
    firewallSession: "ha-smoke-fw",
    notify: {
      mode: "on_exit",
      chatId: 12345,
      preset: "process-manager",
    },
  };

  const store = await ReferenceNodeStateStore.open(params.nodeStateDir);
  const deliveryIds: string[] = [];
  try {
    store.upsertProcess(
      {
        processId,
        status: "completed",
        command: "echo ha-smoke-complete",
        cwd: "/tmp",
        startedAt: now - 3_000,
        endedAt: now - 1_000,
        exitCode: 0,
        signal: null,
        cancelRequested: false,
        timeoutMs: 30_000,
        logs: "ha-smoke completed process\n",
        routing,
      },
      now,
    );

    for (let i = 0; i < params.deliveryCount; i += 1) {
      const deliveryId = `dlv_ha_${i.toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
      const payload: Record<string, unknown> = {
        processId,
        status: "completed",
        startedAt: now - 3_000,
        endedAt: now - 1_000,
        exitCode: 0,
        signal: null,
        summary: `ha-smoke replay payload #${i + 1}`,
        deliveryId,
        deliveryReason: "ha_smoke_seed",
        ts: now + i,
        routing,
      };
      store.enqueueOutbox({
        deliveryId,
        processId,
        payload,
        createdAt: now + i,
      });
      deliveryIds.push(deliveryId);
    }
  } finally {
    store.close();
  }

  return {
    processId,
    deliveryIds,
    nodeDbPath: path.join(params.nodeStateDir, "state", "reference-node.db"),
  };
}

function startReferenceNode(params: {
  repoRoot: string;
  gatewayWsUrl: string;
  nodeId: string;
  nodeName: string;
  nodeStateDir: string;
}): NodeRuntime {
  const logs: string[] = [];
  const child = spawn(
    "npm",
    [
      "run",
      "node:reference",
      "--",
      "--gateway",
      params.gatewayWsUrl,
      "--node-id",
      params.nodeId,
      "--name",
      params.nodeName,
      "--state-dir",
      params.nodeStateDir,
    ],
    {
      cwd: params.repoRoot,
      env: {
        ...process.env,
        NEXUS_NODE_RECONNECT_MIN_MS: "500",
        NEXUS_NODE_RECONNECT_MAX_MS: "2000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const push = (stream: "stdout" | "stderr", chunk: Buffer) => {
    const lines = chunk
      .toString("utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `[node:${stream}] ${line}`);
    logs.push(...lines);
    if (logs.length > 500) logs.splice(0, logs.length - 500);
  };

  child.stdout.on("data", (chunk: Buffer) => push("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => push("stderr", chunk));
  return { child, logs };
}

async function stopReferenceNode(runtime: NodeRuntime | null): Promise<void> {
  if (!runtime) return;
  const child = runtime.child;
  if (child.exitCode !== null || child.signalCode) return;

  child.kill("SIGTERM");
  const exited = Promise.race([
    once(child, "exit"),
    sleep(8_000).then(async () => {
      if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
      return once(child, "exit");
    }),
  ]);
  await exited.catch(() => undefined);
}

function renderNodeLogs(logs: string[]): string {
  if (logs.length === 0) return "  <no node logs captured>";
  const tail = logs.slice(-80);
  return tail.map((line) => `  ${line}`).join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const haproxyUrl = process.env.NEXUS_HA_SMOKE_HAPROXY_URL ?? "http://127.0.0.1:18789";
  const primaryUrl = process.env.NEXUS_HA_SMOKE_PRIMARY_URL ?? "http://127.0.0.1:18891";
  const standbyUrl = process.env.NEXUS_HA_SMOKE_STANDBY_URL ?? "http://127.0.0.1:18892";
  const timeoutMs = Number(process.env.NEXUS_HA_SMOKE_TIMEOUT_MS ?? 90_000);
  const replayDeliveryCount = Math.max(6, Math.min(120, Number(process.env.NEXUS_HA_SMOKE_REPLAY_DELIVERIES ?? 24)));
  const stateDir = process.env.NEXUS_HA_SMOKE_STATE_DIR ?? path.resolve(".ci-data/nexus");
  const gatewayDbPath = process.env.NEXUS_HA_SMOKE_DB_PATH ?? path.join(stateDir, "nexus.db");
  const gatewayWsUrl = toWsUrl(haproxyUrl);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

  if (args.dryRun) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          mode: "dry-run",
          haproxyUrl,
          primaryUrl,
          standbyUrl,
          gatewayWsUrl,
          timeoutMs,
          replayDeliveryCount,
          gatewayDbPath,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  let tempDir: string | null = null;
  let nodeRunA: NodeRuntime | null = null;
  let nodeRunB: NodeRuntime | null = null;

  try {
    await waitForCondition({
      timeoutMs,
      intervalMs: 1000,
      message: "primary /health/live not ready",
      predicate: async () => (await requestJson(`${primaryUrl}/health/live`)).ok,
    });
    await waitForCondition({
      timeoutMs,
      intervalMs: 1000,
      message: "standby /health/live not ready",
      predicate: async () => (await requestJson(`${standbyUrl}/health/live`)).ok,
    });
    await waitForCondition({
      timeoutMs,
      intervalMs: 1000,
      message: "haproxy /health/live not ready",
      predicate: async () => (await requestJson(`${haproxyUrl}/health/live`)).ok,
    });
    await waitForGatewayDb(gatewayDbPath, timeoutMs);

    await waitForMode({ url: primaryUrl, mode: "active", timeoutMs });
    await waitForMode({ url: standbyUrl, mode: "standby", timeoutMs });

    const primaryReady = await requestJson(`${primaryUrl}/health/ready`);
    assert.equal(primaryReady.status, 200, `primary should be ready: ${primaryReady.text}`);
    const standbyReady = await requestJson(`${standbyUrl}/health/ready`);
    assert.equal(standbyReady.status, 503, `standby should not be ready: ${standbyReady.text}`);

    await expectNodeEndpointStatus({
      url: primaryUrl,
      expectedStatus: 426,
      label: "primary before failover",
    });
    await expectNodeEndpointStatus({
      url: standbyUrl,
      expectedStatus: 503,
      label: "standby before failover",
    });

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-ha-smoke-node-"));
    const nodeStateDir = path.join(tempDir, "state");
    const nodeId = `ha-smoke-node-${Date.now().toString(36)}`;
    const nodeName = "HA Smoke Replay Node";
    const seeded = await seedReplayOutbox({
      nodeStateDir,
      deliveryCount: replayDeliveryCount,
    });

    nodeRunA = startReferenceNode({
      repoRoot,
      gatewayWsUrl,
      nodeId,
      nodeName,
      nodeStateDir,
    });

    await waitForNodeOnline({
      apiBaseUrl: haproxyUrl,
      nodeId,
      timeoutMs,
      autoApprove: true,
    });

    await waitForCondition({
      timeoutMs,
      intervalMs: 500,
      message: "seeded process row not persisted during first delivery",
      predicate: async () => readProcessRunSnapshot(gatewayDbPath, seeded.processId).count === 1,
    });

    await waitForCondition({
      timeoutMs,
      intervalMs: 500,
      message: "first outbox drain did not complete",
      predicate: async () => {
        const progress = readOutboxProgress(seeded.nodeDbPath, seeded.processId);
        return progress.total === replayDeliveryCount && progress.delivered === replayDeliveryCount;
      },
    });

    const firstRun = readProcessRunSnapshot(gatewayDbPath, seeded.processId);
    assert.equal(firstRun.count, 1, "first run should create exactly one process_runs row");
    assert.equal(firstRun.nodeId, nodeId, "process_runs row should be attributed to seeded HA smoke node");

    await stopReferenceNode(nodeRunA);
    nodeRunA = null;

    // Simulate undelivered terminal payloads and replay them while active role changes.
    await resetOutboxDeliveries(seeded.nodeDbPath, seeded.processId);

    nodeRunB = startReferenceNode({
      repoRoot,
      gatewayWsUrl,
      nodeId,
      nodeName,
      nodeStateDir,
    });

    const deactivatePrimary = await requestJson(`${primaryUrl}/api/deactivate`, { method: "POST" });
    assert.equal(deactivatePrimary.status, 200, `primary deactivate failed: ${deactivatePrimary.text}`);
    await waitForMode({ url: primaryUrl, mode: "standby", timeoutMs });

    const activateStandby = await requestJson(`${standbyUrl}/api/activate`, { method: "POST" });
    assert.equal(activateStandby.status, 200, `standby activate failed: ${activateStandby.text}`);
    await waitForMode({ url: standbyUrl, mode: "active", timeoutMs });

    await waitForCondition({
      timeoutMs,
      intervalMs: 500,
      message: "haproxy did not route to active backend",
      predicate: async () => {
        const res = await requestJson(`${haproxyUrl}/api/mode`);
        if (!res.ok || !res.json) return false;
        return asString(res.json.mode) === "active";
      },
    });

    const standbyNowReady = await requestJson(`${standbyUrl}/health/ready`);
    assert.equal(standbyNowReady.status, 200, `new active should be ready: ${standbyNowReady.text}`);
    const primaryNowReady = await requestJson(`${primaryUrl}/health/ready`);
    assert.equal(primaryNowReady.status, 503, `old primary should be standby/not ready: ${primaryNowReady.text}`);

    await expectNodeEndpointStatus({
      url: standbyUrl,
      expectedStatus: 426,
      label: "new active after failover",
    });
    await expectNodeEndpointStatus({
      url: primaryUrl,
      expectedStatus: 503,
      label: "old primary after failover",
    });

    await waitForNodeOnline({
      apiBaseUrl: haproxyUrl,
      nodeId,
      timeoutMs,
      autoApprove: false,
    });

    await waitForCondition({
      timeoutMs,
      intervalMs: 500,
      message: "replayed outbox deliveries were not acked after failover",
      predicate: async () => {
        const progress = readOutboxProgress(seeded.nodeDbPath, seeded.processId);
        return progress.total === replayDeliveryCount && progress.delivered === replayDeliveryCount;
      },
    });

    const secondRun = readProcessRunSnapshot(gatewayDbPath, seeded.processId);
    assert.equal(
      secondRun.count,
      1,
      "duplicate replay across failover should still map to a single process_runs row",
    );
    assert.equal(secondRun.nodeId, nodeId, "process_runs node_id should remain stable after replay");
    if (firstRun.updatedAt && secondRun.updatedAt) {
      assert.ok(
        secondRun.updatedAt >= firstRun.updatedAt,
        "expected replay/update timestamp to be monotonic for same process row",
      );
    }

    process.stdout.write(
      "[ha-smoke] PASS: active/standby transition + node endpoint gating + replay dedupe window verified\n",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ha-smoke] FAIL: ${message}\n`);
    process.stderr.write("[ha-smoke] node logs (run A):\n");
    process.stderr.write(`${renderNodeLogs(nodeRunA?.logs ?? [])}\n`);
    process.stderr.write("[ha-smoke] node logs (run B):\n");
    process.stderr.write(`${renderNodeLogs(nodeRunB?.logs ?? [])}\n`);
    process.exitCode = 1;
  } finally {
    await stopReferenceNode(nodeRunA);
    await stopReferenceNode(nodeRunB);
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  }
}

void main();
