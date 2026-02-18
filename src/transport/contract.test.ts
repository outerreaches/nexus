import assert from "node:assert/strict";
import test from "node:test";

import type { FederationOutboxRecord } from "../storage/federation.js";
import { parseCanonicalTransportMessage, TRANSPORT_ADAPTER_CONTRACT } from "./contract.js";

function makeOutbox(overrides: Partial<FederationOutboxRecord> = {}): FederationOutboxRecord {
  return {
    id: "outbox-1",
    peerId: "peer-1",
    transportKind: "federation_http",
    envelope: {
      method: "submit_task",
      request: {
        symbol: "BTC-USD",
      },
    },
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

test("contract map defines node and federation adapter mappings", () => {
  assert.equal(TRANSPORT_ADAPTER_CONTRACT.federation_http.request, "POST /api/federation/inbox");
  assert.equal(TRANSPORT_ADAPTER_CONTRACT.node_ws.request, "protocol.request.send");
});

test("parseCanonicalTransportMessage recognizes request envelopes", () => {
  const parsed = parseCanonicalTransportMessage(makeOutbox());
  assert.ok(parsed);
  assert.equal(parsed?.kind, "request");
  if (parsed?.kind === "request") {
    assert.equal(parsed.method, "submit_task");
    assert.equal(parsed.idempotencyKey, "trace-1");
  }
});

test("parseCanonicalTransportMessage recognizes event envelopes", () => {
  const parsed = parseCanonicalTransportMessage(
    makeOutbox({
      envelope: {
        eventType: "federation.task.updated",
        payload: {
          taskId: "task-1",
        },
      },
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed?.kind, "event");
});

test("parseCanonicalTransportMessage recognizes ack envelopes", () => {
  const parsed = parseCanonicalTransportMessage(
    makeOutbox({
      envelope: {
        status: "ack",
        reason: "ok",
      },
    }),
  );
  assert.ok(parsed);
  assert.equal(parsed?.kind, "ack");
});

test("transport conformance: request/event/ack semantics are adapter-agnostic", () => {
  const adapters: FederationOutboxRecord["transportKind"][] = ["federation_http", "node_ws"];
  for (const transportKind of adapters) {
    const requestParsed = parseCanonicalTransportMessage(
      makeOutbox({
        transportKind,
        envelope: {
          method: "submit_task",
          request: { symbol: "SOL-USD" },
        },
      }),
    );
    assert.equal(requestParsed?.kind, "request");

    const eventParsed = parseCanonicalTransportMessage(
      makeOutbox({
        transportKind,
        envelope: {
          eventType: "federation.task.updated",
          payload: { taskId: "task-2", status: "running" },
        },
      }),
    );
    assert.equal(eventParsed?.kind, "event");

    const ackParsed = parseCanonicalTransportMessage(
      makeOutbox({
        transportKind,
        envelope: {
          ackStatus: "ack",
        },
      }),
    );
    assert.equal(ackParsed?.kind, "ack");
  }
});
