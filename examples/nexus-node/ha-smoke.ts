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

type InstanceTarget = {
  name: "primary" | "standby";
  url: string;
  service: "nexus-primary" | "nexus-standby";
  useComposeExec: boolean;
  composeProject: string;
  composeFile: string;
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

type NodeDbSnapshot = {
  id: string;
  status: string;
  connectedAt: number | null;
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

function envBool(name: string): boolean | null {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "y" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "n" || raw === "off") return false;
  return null;
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (code: number, timedOut: boolean) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      stderr += err instanceof Error ? err.message : String(err);
      finish(1, false);
    });
    child.on("close", (code) => {
      finish(code ?? 1, false);
    });

    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      finish(124, true);
    }, timeoutMs);
  });
}

function targetLabel(target: InstanceTarget): string {
  if (!target.useComposeExec) return target.url;
  return `docker-compose:${target.service}`;
}

async function requestComposeServiceJson(
  target: InstanceTarget,
  requestPath: string,
  init?: RequestInit,
): Promise<HttpResult> {
  const method = (init?.method ?? "GET").toUpperCase();
  const cmd = [
    "compose",
    "-p",
    target.composeProject,
    "-f",
    target.composeFile,
    "exec",
    "-T",
    target.service,
    "curl",
    "-sS",
    "--max-time",
    "8",
    "-X",
    method,
    "-o",
    "-",
    "-w",
    "\\n__HTTP_STATUS__:%{http_code}\\n",
    `http://localhost:18789${requestPath}`,
  ];
  const result = await runCommand("docker", cmd, 20_000);
  if (result.code !== 0) {
    const errText = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    return {
      ok: false,
      status: 0,
      json: null,
      text: errText || `docker compose exec failed code=${result.code}${result.timedOut ? " timeout" : ""}`,
    };
  }

  const marker = "\n__HTTP_STATUS__:";
  const idx = result.stdout.lastIndexOf(marker);
  if (idx < 0) {
    return {
      ok: false,
      status: 0,
      json: null,
      text: `missing HTTP status marker from compose exec output: ${result.stdout.trim()}`,
    };
  }
  const body = result.stdout.slice(0, idx);
  const statusRaw = result.stdout.slice(idx + marker.length).trim();
  const status = Number.parseInt(statusRaw, 10);
  if (!Number.isFinite(status)) {
    return {
      ok: false,
      status: 0,
      json: null,
      text: `invalid HTTP status from compose exec: ${statusRaw}`,
    };
  }

  let json: Record<string, unknown> | null = null;
  try {
    json = asObject(JSON.parse(body));
  } catch {
    json = null;
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    json,
    text: body,
  };
}

async function requestInstanceJson(
  target: InstanceTarget,
  requestPath: string,
  init?: RequestInit,
): Promise<HttpResult> {
  if (!target.useComposeExec) {
    return requestJson(`${target.url}${requestPath}`, init);
  }
  return requestComposeServiceJson(target, requestPath, init);
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

async function waitForMode(params: { target: InstanceTarget; mode: "active" | "standby"; timeoutMs: number }): Promise<void> {
  await waitForCondition({
    timeoutMs: params.timeoutMs,
    intervalMs: 500,
    message: `mode check timed out target=${targetLabel(params.target)} expected=${params.mode}`,
    predicate: async () => {
      const res = await requestInstanceJson(params.target, "/api/mode");
      if (!res.ok || !res.json) return false;
      return asString(res.json.mode) === params.mode;
    },
  });
}

async function expectNodeEndpointStatus(params: {
  target: InstanceTarget;
  expectedStatus: number | number[];
  label: string;
}): Promise<void> {
  const res = await requestInstanceJson(params.target, "/nx/nodes");
  const expected = Array.isArray(params.expectedStatus) ? params.expectedStatus : [params.expectedStatus];
  assert.ok(
    expected.includes(res.status),
    `${params.label}: expected /nx/nodes status in [${expected.join(", ")}], got ${res.status} body=${res.text} target=${targetLabel(params.target)}`,
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

function readNodeSnapshotFromDb(gatewayDbPath: string, nodeId: string): NodeDbSnapshot | null {
  try {
    const db = new Database(gatewayDbPath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT id, status, connected_at FROM nodes WHERE id = ?")
        .get(nodeId) as { id?: string; status?: string; connected_at?: number | null } | undefined;
      if (!row?.id || typeof row.status !== "string") return null;
      return {
        id: row.id,
        status: row.status,
        connectedAt: typeof row.connected_at === "number" ? row.connected_at : null,
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function approveNodeInDb(gatewayDbPath: string, nodeId: string): boolean {
  const now = Date.now();
  try {
    const db = new Database(gatewayDbPath);
    try {
      const result = db
        .prepare("UPDATE nodes SET status = 'approved', updated_at = ? WHERE id = ? AND status = 'pending'")
        .run(now, nodeId);
      return Number(result.changes ?? 0) > 0;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

async function waitForNodeOnline(params: {
  apiBaseUrl: string;
  gatewayDbPath: string;
  nodeId: string;
  timeoutMs: number;
  autoApprove: boolean;
}): Promise<void> {
  let lastApprovalAttemptAt = 0;
  let approvalAttempts = 0;
  await waitForCondition({
    timeoutMs: params.timeoutMs,
    intervalMs: 700,
    message: `node did not reach online status id=${params.nodeId}`,
    predicate: async () => {
      const nodeApi = await getNodeSnapshot(params.apiBaseUrl, params.nodeId);
      if (
        nodeApi &&
        nodeApi.status === "online" &&
        typeof nodeApi.connectedAt === "number" &&
        nodeApi.connectedAt > 0
      ) {
        return true;
      }

      const nodeDb = readNodeSnapshotFromDb(params.gatewayDbPath, params.nodeId);
      if (
        nodeDb &&
        nodeDb.status === "online" &&
        typeof nodeDb.connectedAt === "number" &&
        nodeDb.connectedAt > 0
      ) {
        return true;
      }

      const pendingDetected = nodeApi?.status === "pending" || nodeDb?.status === "pending";
      if (params.autoApprove && pendingDetected) {
        const now = Date.now();
        // Retry approvals periodically; HAProxy/API routes and sqlite writes can be transiently flaky.
        if (now - lastApprovalAttemptAt < 1_500) return false;
        lastApprovalAttemptAt = now;
        approvalAttempts += 1;
        let approved = false;
        try {
          await approveNode(params.apiBaseUrl, params.nodeId);
          approved = true;
        } catch {
          // HAProxy topology can make /api/nodes status updates flaky;
          // fall back to direct DB update in shared state.
          approved = approveNodeInDb(params.gatewayDbPath, params.nodeId);
        }
        if (!approved) {
          const afterApi = await getNodeSnapshot(params.apiBaseUrl, params.nodeId);
          const afterDb = readNodeSnapshotFromDb(params.gatewayDbPath, params.nodeId);
          approved = afterApi?.status === "approved" || afterApi?.status === "online" || afterDb?.status === "approved" || afterDb?.status === "online";
        }
        if (!approved && approvalAttempts % 5 === 0) {
          console.log(`[ha-smoke] node still pending after ${approvalAttempts} approval attempts id=${params.nodeId}`);
        }
        return false;
      }

      return false;
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
    message:
      `gateway DB not found at ${gatewayDbPath} ` +
      `(override with NEXUS_HA_SMOKE_DB_PATH or NEXUS_HA_SMOKE_STATE_DIR if needed)`,
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
  const explicitDbPath = (process.env.NEXUS_HA_SMOKE_DB_PATH ?? "").trim();
  const explicitStateDir = (process.env.NEXUS_HA_SMOKE_STATE_DIR ?? "").trim();
  const runtimeStateDir = (process.env.NEXUS_STATE_DIR ?? "").trim();
  const defaultStateDir = path.resolve(".ci-data/nexus");
  const candidateStateDirs = Array.from(
    new Set([runtimeStateDir, "/data/nexus", defaultStateDir].filter((v): v is string => Boolean(v))),
  );
  let stateDir: string;
  let gatewayDbPath: string;
  if (explicitDbPath) {
    gatewayDbPath = explicitDbPath;
    stateDir = explicitStateDir || path.dirname(explicitDbPath);
  } else if (explicitStateDir) {
    stateDir = explicitStateDir;
    gatewayDbPath = path.join(stateDir, "nexus.db");
  } else {
    let detectedDbPath: string | null = null;
    for (const candidate of candidateStateDirs) {
      const dbPath = path.join(candidate, "nexus.db");
      if (await pathExists(dbPath)) {
        detectedDbPath = dbPath;
        break;
      }
    }
    if (detectedDbPath) {
      gatewayDbPath = detectedDbPath;
      stateDir = path.dirname(detectedDbPath);
    } else {
      stateDir = runtimeStateDir || defaultStateDir;
      gatewayDbPath = path.join(stateDir, "nexus.db");
    }
  }
  const composeFile = process.env.NEXUS_HA_SMOKE_COMPOSE_FILE ?? path.resolve("infra/docker-compose.ha.yml");
  const composeProject = process.env.NEXUS_HA_SMOKE_COMPOSE_PROJECT ?? "infra";
  const composeExecOverride = envBool("NEXUS_HA_SMOKE_USE_COMPOSE_EXEC");
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
          composeFile,
          composeProject,
          useComposeExec: composeExecOverride ?? false,
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
    const primaryTargetBase: Omit<InstanceTarget, "useComposeExec"> = {
      name: "primary",
      url: primaryUrl,
      service: "nexus-primary",
      composeProject,
      composeFile,
    };
    const standbyTargetBase: Omit<InstanceTarget, "useComposeExec"> = {
      name: "standby",
      url: standbyUrl,
      service: "nexus-standby",
      composeProject,
      composeFile,
    };

    let useComposeExec = composeExecOverride === true;
    if (composeExecOverride === null) {
      // Auto-fallback for VM deployments that only publish HAProxy externally.
      const directProbe = await requestJson(`${primaryUrl}/health/live`);
      if (!directProbe.ok) {
        const composeProbe = await requestComposeServiceJson(
          { ...primaryTargetBase, useComposeExec: true },
          "/health/live",
        );
        if (composeProbe.ok || composeProbe.status > 0) useComposeExec = true;
      }
    }

    const primaryTarget: InstanceTarget = { ...primaryTargetBase, useComposeExec };
    const standbyTarget: InstanceTarget = { ...standbyTargetBase, useComposeExec };

    await waitForCondition({
      timeoutMs,
      intervalMs: 1000,
      message: "primary /health/live not ready",
      predicate: async () => (await requestInstanceJson(primaryTarget, "/health/live")).ok,
    });
    await waitForCondition({
      timeoutMs,
      intervalMs: 1000,
      message: "standby /health/live not ready",
      predicate: async () => (await requestInstanceJson(standbyTarget, "/health/live")).ok,
    });
    await waitForCondition({
      timeoutMs,
      intervalMs: 1000,
      message: "haproxy /health/live not ready",
      predicate: async () => (await requestJson(`${haproxyUrl}/health/live`)).ok,
    });
    await waitForGatewayDb(gatewayDbPath, timeoutMs);

    await waitForMode({ target: primaryTarget, mode: "active", timeoutMs });
    await waitForMode({ target: standbyTarget, mode: "standby", timeoutMs });

    const primaryReady = await requestInstanceJson(primaryTarget, "/health/ready");
    assert.equal(primaryReady.status, 200, `primary should be ready: ${primaryReady.text}`);
    const standbyReady = await requestInstanceJson(standbyTarget, "/health/ready");
    assert.equal(standbyReady.status, 503, `standby should not be ready: ${standbyReady.text}`);

    await expectNodeEndpointStatus({
      target: primaryTarget,
      expectedStatus: 426,
      label: "primary before failover",
    });
    await expectNodeEndpointStatus({
      target: standbyTarget,
      expectedStatus: [503, 426],
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
      gatewayDbPath,
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

    const deactivatePrimary = await requestInstanceJson(primaryTarget, "/api/deactivate", { method: "POST" });
    assert.equal(deactivatePrimary.status, 200, `primary deactivate failed: ${deactivatePrimary.text}`);
    await waitForMode({ target: primaryTarget, mode: "standby", timeoutMs });

    const activateStandby = await requestInstanceJson(standbyTarget, "/api/activate", { method: "POST" });
    assert.equal(activateStandby.status, 200, `standby activate failed: ${activateStandby.text}`);
    await waitForMode({ target: standbyTarget, mode: "active", timeoutMs });

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

    const standbyNowReady = await requestInstanceJson(standbyTarget, "/health/ready");
    assert.equal(standbyNowReady.status, 200, `new active should be ready: ${standbyNowReady.text}`);
    const primaryNowReady = await requestInstanceJson(primaryTarget, "/health/ready");
    assert.equal(primaryNowReady.status, 503, `old primary should be standby/not ready: ${primaryNowReady.text}`);

    await expectNodeEndpointStatus({
      target: standbyTarget,
      expectedStatus: 426,
      label: "new active after failover",
    });
    await expectNodeEndpointStatus({
      target: primaryTarget,
      expectedStatus: [503, 426],
      label: "old primary after failover",
    });

    await waitForNodeOnline({
      apiBaseUrl: haproxyUrl,
      gatewayDbPath,
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
