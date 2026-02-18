import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Hono } from "hono";
import { parseNodePublicKey } from "../nodes/auth.js";
import { registerApiRoutes } from "../gateway/routes/api.js";
import type { GatewayHttpDeps } from "../gateway/http.js";
import { openDatabase, type NexusDatabase } from "../storage/database.js";
import {
  enqueueFederationOutbox,
  federationPeerIdentityScope,
  getFederationPeerById,
  listFederationEvents,
  listFederationOutbox,
  rotateIdentityKeyForScope,
  upsertFederationPeer,
  updateFederationOutboxStatus,
  type FederationOutboxRecord,
} from "../storage/federation.js";
import { createFederationHttpDispatcher } from "./dispatcher.js";
import { startFederationOutboxWorker } from "./outbox-worker.js";
import { createFederationTransportRouter } from "./transport.js";

type TestInstance = {
  instanceId: string;
  endpointHost: string;
  stateDir: string;
  db: NexusDatabase;
  app: Hono;
  privateKey: KeyObject;
  publicKeyRaw: string;
  keyId: string;
  close: () => Promise<void>;
};

function resolveFetchUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

async function createTestInstance(params: {
  instanceId: string;
  endpointHost: string;
  runtimeProfile: GatewayHttpDeps["runtimeProfile"];
}): Promise<TestInstance> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `nexus-federation-int-${params.instanceId}-`));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  const app = new Hono();
  let globalDisable = false;
  const deps: GatewayHttpDeps = {
    port: 0,
    stateDir: dir,
    runtimeProfile: params.runtimeProfile,
    federationLocalInstanceId: params.instanceId,
    getFederationBreakglassState: () => ({ globalDisable }),
    setFederationGlobalDisable: (disabled: boolean) => {
      globalDisable = disabled;
      return { globalDisable };
    },
    db,
    getStatus: () => ({
      ok: true,
      runtime: { profile: params.runtimeProfile },
      federation: {
        enabled: true,
        derivedState: "federated_degraded",
        trustedPeerCount: 0,
        healthyTrustedPeerCount: 0,
      },
    }),
    log: () => {},
  };
  registerApiRoutes(app, deps);

  const pair = generateKeyPairSync("ed25519");
  const publicPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const parsed = parseNodePublicKey(publicPem);
  assert.ok(parsed);
  const keyId = `kid-${params.instanceId}`;

  return {
    instanceId: params.instanceId,
    endpointHost: params.endpointHost,
    stateDir: dir,
    db,
    app,
    privateKey: pair.privateKey,
    publicKeyRaw: parsed.raw,
    keyId,
    close: async () => {
      db.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

async function addTrustedPeer(local: TestInstance, remote: TestInstance): Promise<void> {
  const res = await local.app.request("http://localhost/api/federation/peers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: remote.instanceId,
      label: remote.instanceId,
      endpoint: `https://${remote.endpointHost}`,
      signingKey: remote.publicKeyRaw,
      signingKeyKid: remote.keyId,
      trustState: "trusted",
    }),
  });
  if (res.status === 200) return;
  if (res.status !== 403) {
    assert.equal(res.status, 200);
    return;
  }

  // Monetization profile blocks control-plane mutations at API level.
  // Seed trusted peers through bootstrap/storage path for integration tests.
  const nowMs = Date.now();
  upsertFederationPeer(local.db, {
    id: remote.instanceId,
    label: remote.instanceId,
    endpoint: `https://${remote.endpointHost}`,
    signingKey: remote.publicKeyRaw,
    trustState: "trusted",
    enabled: true,
    metadata: {},
    nowMs,
  });
  rotateIdentityKeyForScope(local.db, {
    scope: federationPeerIdentityScope(remote.instanceId),
    kid: remote.keyId,
    publicKey: remote.publicKeyRaw,
    metadata: { source: "integration_test_seed" },
    overlapMs: 60_000,
    nowMs,
  });
}

function createRoutedFetch(hostMap: Record<string, TestInstance>): typeof fetch {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = resolveFetchUrl(input);
    const target = hostMap[url.hostname];
    if (!target) {
      return new Response("unknown host", { status: 404 });
    }
    return await target.app.request(url.toString(), init);
  };
  return fetchImpl;
}

function startOutboxWorker(params: {
  instance: TestInstance;
  fetchImpl: typeof fetch;
}) {
  const dispatcher = createFederationHttpDispatcher({
    localInstanceId: params.instance.instanceId,
    getPeerById: (peerId) => getFederationPeerById(params.instance.db, peerId),
    getSigningMaterial: () => ({
      privateKey: params.instance.privateKey,
      keyId: params.instance.keyId,
      publicKeyRaw: params.instance.publicKeyRaw,
    }),
    requireMtls: true,
    allowInsecureSignedOnlyDev: false,
    requestTimeoutMs: 5_000,
    fetchImpl: params.fetchImpl,
  });
  return startFederationOutboxWorker({
    db: params.instance.db,
    dispatch: dispatcher,
    intervalMs: 60_000,
    maxBatch: 50,
  });
}

function findPendingStatusOutboxRow(instance: TestInstance, taskId: string): FederationOutboxRecord {
  const rows = listFederationOutbox(instance.db, { limit: 200 });
  const row = rows.find((item) => {
    const envelope = item.envelope as Record<string, unknown>;
    return envelope.method === "task_status" && envelope.taskId === taskId;
  });
  assert.ok(row);
  return row;
}

test("integration: primary submits task, service completes, primary receives task_status result", async () => {
  const primary = await createTestInstance({
    instanceId: "primary-inst",
    endpointHost: "primary.internal",
    runtimeProfile: "primary",
  });
  const service = await createTestInstance({
    instanceId: "service-inst",
    endpointHost: "service.internal",
    runtimeProfile: "monetization",
  });
  try {
    await addTrustedPeer(primary, service);
    await addTrustedPeer(service, primary);

    const taskId = "task-integration-1";
    const submitRes = await primary.app.request("http://localhost/api/federation/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: taskId,
        peerId: service.instanceId,
        method: "submit_task",
        request: { strategy: "paper_trade", symbol: "BTC-USD" },
      }),
    });
    assert.equal(submitRes.status, 200);

    const fetchImpl = createRoutedFetch({
      [primary.endpointHost]: primary,
      [service.endpointHost]: service,
    });
    const primaryOutbox = startOutboxWorker({
      instance: primary,
      fetchImpl,
    });
    await primaryOutbox.tick();
    primaryOutbox.stop();

    const serviceTaskRes = await service.app.request(`http://localhost/api/federation/tasks/${taskId}`);
    assert.equal(serviceTaskRes.status, 200);
    const serviceTaskBody = await serviceTaskRes.json() as { task: { status: string } };
    assert.equal(serviceTaskBody.task.status, "pending");

    const serviceCompleteLocalRes = await service.app.request(`http://localhost/api/federation/tasks/${taskId}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        result: { pnlUsd: 12.5, exchange: "demo" },
      }),
    });
    assert.equal(serviceCompleteLocalRes.status, 200);

    const emitStatusRes = await service.app.request("http://localhost/api/federation/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        peerId: primary.instanceId,
        method: "task_status",
        taskId,
        status: "completed",
        result: { pnlUsd: 12.5, exchange: "demo" },
      }),
    });
    assert.equal(emitStatusRes.status, 200);

    const serviceOutbox = startOutboxWorker({
      instance: service,
      fetchImpl,
    });
    await serviceOutbox.tick();
    serviceOutbox.stop();

    const primaryTaskRes = await primary.app.request(`http://localhost/api/federation/tasks/${taskId}`);
    assert.equal(primaryTaskRes.status, 200);
    const primaryTaskBody = await primaryTaskRes.json() as {
      task: { status: string; result: Record<string, unknown> | null };
    };
    assert.equal(primaryTaskBody.task.status, "completed");
    assert.equal(primaryTaskBody.task.result?.pnlUsd, 12.5);

    const inboundEvents = listFederationEvents(primary.db, {
      direction: "inbound",
      limit: 200,
    });
    const statusEvent = inboundEvents.find((row) => {
      const payload = row.payload as Record<string, unknown>;
      return row.eventType === "task_status" && payload.taskId === taskId;
    });
    assert.ok(statusEvent);
  } finally {
    await Promise.all([primary.close(), service.close()]);
  }
});

test("failure: dropped response triggers retry and duplicate-safe single finalization", async () => {
  const primary = await createTestInstance({
    instanceId: "primary-inst",
    endpointHost: "primary.internal",
    runtimeProfile: "primary",
  });
  const service = await createTestInstance({
    instanceId: "service-inst",
    endpointHost: "service.internal",
    runtimeProfile: "monetization",
  });
  try {
    await addTrustedPeer(primary, service);
    await addTrustedPeer(service, primary);

    const taskId = "task-integration-2";
    const submitRes = await primary.app.request("http://localhost/api/federation/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: taskId,
        peerId: service.instanceId,
        method: "submit_task",
        request: { strategy: "paper_trade", symbol: "ETH-USD" },
      }),
    });
    assert.equal(submitRes.status, 200);

    const baseFetch = createRoutedFetch({
      [primary.endpointHost]: primary,
      [service.endpointHost]: service,
    });
    const primaryOutbox = startOutboxWorker({
      instance: primary,
      fetchImpl: baseFetch,
    });
    await primaryOutbox.tick();
    primaryOutbox.stop();

    const localCompleteRes = await service.app.request(`http://localhost/api/federation/tasks/${taskId}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        result: { pnlUsd: 4.2 },
      }),
    });
    assert.equal(localCompleteRes.status, 200);

    const emitStatusRes = await service.app.request("http://localhost/api/federation/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        peerId: primary.instanceId,
        method: "task_status",
        taskId,
        status: "completed",
        result: { pnlUsd: 4.2 },
      }),
    });
    assert.equal(emitStatusRes.status, 200);

    const statusOutboxRow = findPendingStatusOutboxRow(service, taskId);
    let dropAfterDelivery = true;
    const flakyFetch: typeof fetch = async (input, init) => {
      const url = resolveFetchUrl(input);
      if (url.hostname === primary.endpointHost && dropAfterDelivery) {
        dropAfterDelivery = false;
        await baseFetch(input, init);
        throw new Error("simulated_network_drop_after_delivery");
      }
      return await baseFetch(input, init);
    };

    const serviceOutbox = startOutboxWorker({
      instance: service,
      fetchImpl: flakyFetch,
    });
    await serviceOutbox.tick();

    const afterFirstAttempt = listFederationOutbox(service.db, { limit: 200 }).find((row) => row.id === statusOutboxRow.id);
    assert.ok(afterFirstAttempt);
    assert.equal(afterFirstAttempt.status, "failed");
    assert.equal(afterFirstAttempt.attempts, 1);

    updateFederationOutboxStatus(service.db, {
      id: statusOutboxRow.id,
      status: "failed",
      attempts: afterFirstAttempt.attempts,
      nextAttemptAt: Date.now() - 1,
      nowMs: Date.now(),
    });

    await serviceOutbox.tick();
    serviceOutbox.stop();

    const afterRetry = listFederationOutbox(service.db, { limit: 200 }).find((row) => row.id === statusOutboxRow.id);
    assert.ok(afterRetry);
    assert.equal(afterRetry.status, "sent");
    assert.equal(afterRetry.attempts, 2);

    const primaryTaskRes = await primary.app.request(`http://localhost/api/federation/tasks/${taskId}`);
    assert.equal(primaryTaskRes.status, 200);
    const primaryTaskBody = await primaryTaskRes.json() as {
      task: { status: string; result: Record<string, unknown> | null };
    };
    assert.equal(primaryTaskBody.task.status, "completed");
    assert.equal(primaryTaskBody.task.result?.pnlUsd, 4.2);

    const inboundEvents = listFederationEvents(primary.db, {
      direction: "inbound",
      limit: 200,
    });
    const matchingEnvelopeEvents = inboundEvents.filter((row) => row.envelopeId === statusOutboxRow.id);
    assert.equal(matchingEnvelopeEvents.length, 1);
  } finally {
    await Promise.all([primary.close(), service.close()]);
  }
});

test("integration: outbox worker routes mixed adapters through unified transport router", async () => {
  const instance = await createTestInstance({
    instanceId: "router-int",
    endpointHost: "router.internal",
    runtimeProfile: "primary",
  });
  try {
    const nowMs = Date.now();
    upsertFederationPeer(instance.db, {
      id: "peer-http",
      label: "Peer HTTP",
      endpoint: "https://peer-http.internal",
      signingKey: "ed25519:peer-http",
      trustState: "trusted",
      enabled: true,
      nowMs,
    });
    upsertFederationPeer(instance.db, {
      id: "peer-node",
      label: "Peer Node",
      endpoint: "node://peer-node",
      signingKey: "ed25519:peer-node",
      trustState: "trusted",
      enabled: true,
      nowMs: nowMs + 1,
    });

    const adapterCalls: string[] = [];
    const router = createFederationTransportRouter({
      adapterDispatchers: {
        federation_http: async (item) => {
          adapterCalls.push(`federation_http:${item.id}`);
          return { ok: true };
        },
        node_ws: async (item) => {
          adapterCalls.push(`node_ws:${item.id}`);
          return { ok: true };
        },
      },
    });

    enqueueFederationOutbox(instance.db, {
      id: "outbox-http-1",
      peerId: "peer-http",
      transportKind: "federation_http",
      envelope: { method: "submit_task", request: { symbol: "BTC-USD" } },
      traceId: "trace-http-1",
      nowMs,
    });
    enqueueFederationOutbox(instance.db, {
      id: "outbox-node-1",
      peerId: "peer-node",
      transportKind: "node_ws",
      envelope: { method: "transport.request.send", request: { op: "ping" } },
      traceId: "trace-node-1",
      nowMs: nowMs + 1,
    });

    const worker = startFederationOutboxWorker({
      db: instance.db,
      dispatch: router.dispatch,
      intervalMs: 60_000,
      maxBatch: 50,
    });
    await worker.tick();
    worker.stop();

    assert.deepEqual(adapterCalls.sort(), [
      "federation_http:outbox-http-1",
      "node_ws:outbox-node-1",
    ]);

    const rows = listFederationOutbox(instance.db, { limit: 20 });
    const httpRow = rows.find((row) => row.id === "outbox-http-1");
    const nodeRow = rows.find((row) => row.id === "outbox-node-1");
    assert.equal(httpRow?.status, "sent");
    assert.equal(nodeRow?.status, "sent");
  } finally {
    await instance.close();
  }
});

test("integration: failover path primary->standby->primary preserves mixed-adapter outbox dispatch", async () => {
  const instance = await createTestInstance({
    instanceId: "failover-int",
    endpointHost: "failover.internal",
    runtimeProfile: "primary",
  });
  try {
    const nowMs = Date.now();
    upsertFederationPeer(instance.db, {
      id: "peer-http",
      label: "Peer HTTP",
      endpoint: "https://peer-http.internal",
      signingKey: "ed25519:peer-http",
      trustState: "trusted",
      enabled: true,
      nowMs,
    });
    upsertFederationPeer(instance.db, {
      id: "peer-node",
      label: "Peer Node",
      endpoint: "node://peer-node",
      signingKey: "ed25519:peer-node",
      trustState: "trusted",
      enabled: true,
      nowMs: nowMs + 1,
    });

    const adapterCalls: string[] = [];
    let activeSlot: "primary" | "standby" = "primary";
    const router = createFederationTransportRouter({
      adapterDispatchers: {
        federation_http: async (item) => {
          adapterCalls.push(`${activeSlot}:federation_http:${item.id}`);
          return { ok: true };
        },
        node_ws: async (item) => {
          adapterCalls.push(`${activeSlot}:node_ws:${item.id}`);
          return { ok: true };
        },
      },
    });

    const enqueuePhase = (phase: "p1" | "p2" | "p3", phaseNowMs: number) => {
      enqueueFederationOutbox(instance.db, {
        id: `${phase}-http`,
        peerId: "peer-http",
        transportKind: "federation_http",
        envelope: { method: "submit_task", request: { phase } },
        traceId: `${phase}-trace-http`,
        nowMs: phaseNowMs,
      });
      enqueueFederationOutbox(instance.db, {
        id: `${phase}-node`,
        peerId: "peer-node",
        transportKind: "node_ws",
        envelope: { method: "transport.request.send", request: { phase } },
        traceId: `${phase}-trace-node`,
        nowMs: phaseNowMs + 1,
      });
    };

    const runTick = async () => {
      const worker = startFederationOutboxWorker({
        db: instance.db,
        dispatch: router.dispatch,
        intervalMs: 60_000,
        maxBatch: 100,
      });
      await worker.tick();
      worker.stop();
    };

    enqueuePhase("p1", nowMs + 10);
    activeSlot = "primary";
    await runTick();

    enqueuePhase("p2", nowMs + 20);
    activeSlot = "standby";
    await runTick();

    enqueuePhase("p3", nowMs + 30);
    activeSlot = "primary";
    await runTick();

    assert.deepEqual(adapterCalls.sort(), [
      "primary:federation_http:p1-http",
      "primary:federation_http:p3-http",
      "primary:node_ws:p1-node",
      "primary:node_ws:p3-node",
      "standby:federation_http:p2-http",
      "standby:node_ws:p2-node",
    ]);

    const rows = listFederationOutbox(instance.db, { limit: 40 });
    const expectedIds = new Set(["p1-http", "p1-node", "p2-http", "p2-node", "p3-http", "p3-node"]);
    for (const row of rows) {
      if (!expectedIds.has(row.id)) continue;
      assert.equal(row.status, "sent");
    }
  } finally {
    await instance.close();
  }
});
