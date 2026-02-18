import assert from "node:assert/strict";
import test from "node:test";

import { createFederationTransportRouter } from "./transport.js";
import type { FederationOutboxRecord } from "../storage/federation.js";

function makeOutbox(overrides: Partial<FederationOutboxRecord> = {}): FederationOutboxRecord {
  return {
    id: "outbox-1",
    peerId: "peer-1",
    transportKind: "federation_http",
    envelope: { method: "submit_task", request: { symbol: "BTC-USD" } },
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

test("transport router dispatches to matching adapter", async () => {
  let called = 0;
  const router = createFederationTransportRouter({
    adapterDispatchers: {
      federation_http: async () => {
        called += 1;
        return { ok: true };
      },
    },
  });
  const result = await router.dispatch(makeOutbox());
  assert.equal(result.ok, true);
  assert.equal(called, 1);
  assert.ok(router.adapters.includes("federation_http"));
  assert.equal(router.contract.federation_http?.request, "POST /api/federation/inbox");
});

test("transport router fails terminally when adapter missing", async () => {
  const router = createFederationTransportRouter({
    adapterDispatchers: {},
  });
  const result = await router.dispatch(makeOutbox());
  assert.equal(result.ok, false);
  assert.equal(result.terminal, true);
  assert.equal(result.error, "missing_transport_adapter:federation_http");
});

test("transport router rejects unknown transport kind", async () => {
  const router = createFederationTransportRouter({
    adapterDispatchers: {
      federation_http: async () => ({ ok: true }),
    },
  });
  const result = await router.dispatch(
    makeOutbox({
      transportKind: "unknown_transport",
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.terminal, true);
  assert.equal(result.error, "unsupported_transport_kind:unknown_transport");
});

test("transport router rejects invalid canonical transport envelopes", async () => {
  const router = createFederationTransportRouter({
    adapterDispatchers: {
      federation_http: async () => ({ ok: true }),
    },
  });
  const result = await router.dispatch(
    makeOutbox({
      envelope: {
        payload: { ok: true },
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.terminal, true);
  assert.equal(result.error, "invalid_transport_envelope");
});
