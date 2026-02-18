import assert from "node:assert/strict";
import test from "node:test";

import type { FederationOutboxRecord, TransportRouteRecord } from "../storage/federation.js";
import type { NodeWebSocketGateway, NodeTransportOperationResult } from "../nodes/ws-gateway.js";
import { NodeRoutingError } from "../nodes/types.js";
import { createNodeWsDispatcher } from "./node-dispatcher.js";

function makeOutbox(overrides: Partial<FederationOutboxRecord> = {}): FederationOutboxRecord {
  return {
    id: "outbox-1",
    peerId: "peer-1",
    transportKind: "node_ws",
    envelope: { method: "transport.request.send", request: { action: "ping" } },
    status: "pending",
    attempts: 0,
    nextAttemptAt: null,
    lastAttemptAt: null,
    lastError: null,
    traceId: "trace-1",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeRoute(overrides: Partial<TransportRouteRecord> = {}): TransportRouteRecord {
  return {
    routeId: "route-1",
    peerId: "peer-1",
    adapter: "node_ws",
    endpoint: "node-a",
    healthy: true,
    lastCheckedAt: 1_700_000_000_000,
    lastError: null,
    metadata: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeGateway(
  impl: (params: { nodeId: string; method: string; params?: unknown; timeoutMs?: number }) =>
    Promise<NodeTransportOperationResult>,
): NodeWebSocketGateway {
  return {
    requestTransportOperation: impl,
  } as unknown as NodeWebSocketGateway;
}

test("node dispatcher sends request payload to node_ws adapter", async () => {
  const calls: Array<{ nodeId: string; method: string; params?: unknown }> = [];
  const observations: Array<{ peerId: string; endpoint: string; healthy: boolean }> = [];
  const dispatch = createNodeWsDispatcher({
    nodeGateway: makeGateway(async (params) => {
      calls.push({ nodeId: params.nodeId, method: params.method, params: params.params });
      return { ok: true, payload: { accepted: true } };
    }),
    getRouteForPeer: () => makeRoute({ endpoint: "node-route-target" }),
    observeRouteHealth: async (entry) => {
      observations.push({ peerId: entry.peerId, endpoint: entry.endpoint, healthy: entry.healthy });
    },
  });

  const result = await dispatch(
    makeOutbox({
      envelope: {
        method: "federation.task.submit",
        request: { symbol: "BTC-USD" },
      },
    }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      nodeId: "node-route-target",
      method: "federation.task.submit",
      params: { symbol: "BTC-USD" },
    },
  ]);
  assert.deepEqual(observations, [
    { peerId: "peer-1", endpoint: "node-route-target", healthy: true },
  ]);
});

test("node dispatcher maps canonical event messages to transport.event.publish", async () => {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const dispatch = createNodeWsDispatcher({
    nodeGateway: makeGateway(async (params) => {
      calls.push({ method: params.method, params: params.params });
      return { ok: true };
    }),
  });

  const result = await dispatch(
    makeOutbox({
      envelope: {
        eventType: "shared.blackboard.updated",
        payload: { key: "alpha", value: 42 },
      },
    }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      method: "transport.event.publish",
      params: {
        eventType: "shared.blackboard.updated",
        payload: { key: "alpha", value: 42 },
      },
    },
  ]);
});

test("node dispatcher retries on retryable node transport failures", async () => {
  const observations: Array<{ healthy: boolean; error?: string | null }> = [];
  const dispatch = createNodeWsDispatcher({
    nodeGateway: makeGateway(async () => ({
      ok: false,
      error: {
        code: "NODE_SOCKET_UNAVAILABLE",
        message: "socket down",
      },
    })),
    observeRouteHealth: async (entry) => {
      observations.push({ healthy: entry.healthy, error: entry.error ?? null });
    },
  });

  const result = await dispatch(makeOutbox());
  assert.equal(result.ok, false);
  assert.equal(result.terminal, undefined);
  assert.ok(typeof result.retryAt === "number");
  assert.match(result.error ?? "", /node_ws_error:NODE_SOCKET_UNAVAILABLE:socket down/);
  assert.deepEqual(observations, [
    {
      healthy: false,
      error: "node_ws_error:NODE_SOCKET_UNAVAILABLE:socket down",
    },
  ]);
});

test("node dispatcher marks terminal on non-retryable routing errors", async () => {
  const dispatch = createNodeWsDispatcher({
    nodeGateway: makeGateway(async () => {
      throw new NodeRoutingError("NODE_PROTOCOL_ERROR", "bad payload");
    }),
  });

  const result = await dispatch(makeOutbox());
  assert.equal(result.ok, false);
  assert.equal(result.terminal, true);
  assert.equal(result.error, "node_ws_error:NODE_PROTOCOL_ERROR:bad payload");
});
