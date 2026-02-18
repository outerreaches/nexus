import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { parseNodePublicKey, verifyProtocolEnvelope } from "../nodes/auth.js";
import type { FederationOutboxRecord, FederationPeerRecord } from "../storage/federation.js";
import { createFederationHttpDispatcher } from "./dispatcher.js";

function makeOutboxRecord(overrides: Partial<FederationOutboxRecord> = {}): FederationOutboxRecord {
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

function makePeer(overrides: Partial<FederationPeerRecord> = {}): FederationPeerRecord {
  return {
    id: "peer-1",
    label: "Peer 1",
    endpoint: "https://peer-1.internal",
    signingKey: "ed25519:peer-1",
    trustState: "trusted",
    enabled: true,
    metadata: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

test("dispatcher returns terminal failure for insecure endpoint when mTLS is required", async () => {
  const pair = generateKeyPairSync("ed25519");
  const publicPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const parsed = parseNodePublicKey(publicPem);
  assert.ok(parsed);
  let called = false;

  const dispatch = createFederationHttpDispatcher({
    localInstanceId: "local-1",
    privateKey: pair.privateKey,
    keyId: "kid-local-1",
    publicKeyRaw: parsed!.raw,
    getPeerById: () => makePeer({ endpoint: "http://peer-1.internal" }),
    requireMtls: true,
    allowInsecureSignedOnlyDev: false,
    requestTimeoutMs: 5000,
    fetchImpl: async () => {
      called = true;
      return new Response("", { status: 200 });
    },
  });

  const result = await dispatch(makeOutboxRecord());
  assert.equal(result.ok, false);
  assert.equal(result.terminal, true);
  assert.equal(result.error, "mtls_required_https_only");
  assert.equal(called, false);
});

test("dispatcher sends signed envelope to federation inbox", async () => {
  const pair = generateKeyPairSync("ed25519");
  const publicPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const parsed = parseNodePublicKey(publicPem);
  assert.ok(parsed);
  let capturedUrl: string | null = null;
  let capturedBody: Record<string, unknown> | null = null;
  let capturedPublicKeyHeader: string | null = null;

  const dispatch = createFederationHttpDispatcher({
    localInstanceId: "local-1",
    privateKey: pair.privateKey,
    keyId: "kid-local-1",
    publicKeyRaw: parsed!.raw,
    getPeerById: () => makePeer(),
    requireMtls: true,
    allowInsecureSignedOnlyDev: false,
    requestTimeoutMs: 5000,
    nowMs: () => 1_700_000_000_000,
    nonceFactory: () => "nonce-1",
    fetchImpl: async (url, init) => {
      capturedUrl = String(url);
      const headers = new Headers(init?.headers as HeadersInit);
      capturedPublicKeyHeader = headers.get("x-nexus-public-key");
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response("", { status: 202 });
    },
  });

  const result = await dispatch(makeOutboxRecord());
  assert.equal(result.ok, true);
  assert.equal(capturedUrl, "https://peer-1.internal/api/federation/inbox");
  assert.ok(capturedBody);
  const envelope = capturedBody as Record<string, unknown>;
  assert.equal(envelope["nonce"], "nonce-1");
  assert.equal(envelope["traceId"], "trace-1");
  assert.ok(typeof envelope["sig"] === "string");
  assert.ok(typeof envelope["kid"] === "string");
  assert.equal(verifyProtocolEnvelope(envelope, pair.publicKey), true);
  assert.equal(capturedPublicKeyHeader, parsed!.raw);
});

test("dispatcher schedules retry on server-side failure with retry-after", async () => {
  const pair = generateKeyPairSync("ed25519");
  const publicPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const parsed = parseNodePublicKey(publicPem);
  assert.ok(parsed);
  const nowMs = 1_700_000_000_000;

  const dispatch = createFederationHttpDispatcher({
    localInstanceId: "local-1",
    privateKey: pair.privateKey,
    keyId: "kid-local-1",
    publicKeyRaw: parsed!.raw,
    getPeerById: () => makePeer(),
    requireMtls: true,
    allowInsecureSignedOnlyDev: false,
    requestTimeoutMs: 5000,
    nowMs: () => nowMs,
    fetchImpl: async () => new Response("", { status: 503, headers: { "retry-after": "7" } }),
  });

  const result = await dispatch(makeOutboxRecord());
  assert.equal(result.ok, false);
  assert.equal(result.terminal, undefined);
  assert.equal(result.error, "http_503");
  assert.equal(result.retryAt, nowMs + 7000);
});

test("dispatcher treats duplicate acknowledgement (409) as success", async () => {
  const pair = generateKeyPairSync("ed25519");
  const publicPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const parsed = parseNodePublicKey(publicPem);
  assert.ok(parsed);

  const dispatch = createFederationHttpDispatcher({
    localInstanceId: "local-1",
    privateKey: pair.privateKey,
    keyId: "kid-local-1",
    publicKeyRaw: parsed!.raw,
    getPeerById: () => makePeer(),
    requireMtls: true,
    allowInsecureSignedOnlyDev: false,
    requestTimeoutMs: 5000,
    fetchImpl: async () => new Response("", { status: 409 }),
  });

  const result = await dispatch(makeOutboxRecord());
  assert.equal(result.ok, true);
});

test("dispatcher supports dynamic signing material reload", async () => {
  const pairA = generateKeyPairSync("ed25519");
  const pairB = generateKeyPairSync("ed25519");
  const parsedA = parseNodePublicKey(pairA.publicKey.export({ format: "pem", type: "spki" }).toString());
  const parsedB = parseNodePublicKey(pairB.publicKey.export({ format: "pem", type: "spki" }).toString());
  assert.ok(parsedA);
  assert.ok(parsedB);

  let current = "a";
  const capturedBodies: Array<Record<string, unknown>> = [];

  const dispatch = createFederationHttpDispatcher({
    localInstanceId: "local-1",
    getSigningMaterial: async () =>
      current === "a"
        ? {
            privateKey: pairA.privateKey,
            keyId: "kid-a",
            publicKeyRaw: parsedA!.raw,
          }
        : {
            privateKey: pairB.privateKey,
            keyId: "kid-b",
            publicKeyRaw: parsedB!.raw,
          },
    getPeerById: () => makePeer(),
    requireMtls: true,
    allowInsecureSignedOnlyDev: false,
    requestTimeoutMs: 5000,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      capturedBodies.push(body);
      return new Response("", { status: 202 });
    },
  });

  const first = await dispatch(makeOutboxRecord({ id: "outbox-a" }));
  assert.equal(first.ok, true);
  current = "b";
  const second = await dispatch(makeOutboxRecord({ id: "outbox-b" }));
  assert.equal(second.ok, true);

  assert.equal(capturedBodies.length, 2);
  const firstEnvelope = capturedBodies[0]!;
  const secondEnvelope = capturedBodies[1]!;
  assert.equal(firstEnvelope["kid"], "kid-a");
  assert.equal(secondEnvelope["kid"], "kid-b");
  assert.equal(verifyProtocolEnvelope(firstEnvelope, pairA.publicKey), true);
  assert.equal(verifyProtocolEnvelope(secondEnvelope, pairB.publicKey), true);
});

test("dispatcher logs egress deny audit and returns terminal error on blocked method", async () => {
  const pair = generateKeyPairSync("ed25519");
  const parsed = parseNodePublicKey(pair.publicKey.export({ format: "pem", type: "spki" }).toString());
  assert.ok(parsed);
  const auditEvents: Array<{ decision: string; eventType: string; details: Record<string, unknown> }> = [];

  const dispatch = createFederationHttpDispatcher({
    localInstanceId: "local-1",
    privateKey: pair.privateKey,
    keyId: "kid-local-1",
    publicKeyRaw: parsed!.raw,
    getPeerById: () => makePeer(),
    requireMtls: true,
    allowInsecureSignedOnlyDev: false,
    requestTimeoutMs: 5000,
    audit: async (entry) => {
      auditEvents.push({
        decision: entry.decision,
        eventType: entry.eventType,
        details: entry.details,
      });
    },
    fetchImpl: async () => new Response("", { status: 202 }),
  });

  const result = await dispatch(
    makeOutboxRecord({
      envelope: { method: "shell_exec", command: "echo pwn" },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.terminal, true);
  assert.ok(String(result.error).startsWith("firewall_egress_denied:"));
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0]?.decision, "deny");
  assert.equal(auditEvents[0]?.eventType, "firewall.egress");
});

test("dispatcher blocks raw secret payload export by default", async () => {
  const pair = generateKeyPairSync("ed25519");
  const parsed = parseNodePublicKey(pair.publicKey.export({ format: "pem", type: "spki" }).toString());
  assert.ok(parsed);
  let called = false;

  const dispatch = createFederationHttpDispatcher({
    localInstanceId: "local-1",
    privateKey: pair.privateKey,
    keyId: "kid-local-1",
    publicKeyRaw: parsed!.raw,
    getPeerById: () => makePeer(),
    requireMtls: true,
    allowInsecureSignedOnlyDev: false,
    requestTimeoutMs: 5000,
    fetchImpl: async () => {
      called = true;
      return new Response("", { status: 202 });
    },
  });

  const result = await dispatch(
    makeOutboxRecord({
      envelope: {
        method: "submit_task",
        request: {
          password: "raw-secret",
        },
      },
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.terminal, true);
  assert.equal(result.error, "secret_payload_export_blocked");
  assert.equal(called, false);
});

test("dispatcher continues when audit sink fails", async () => {
  const pair = generateKeyPairSync("ed25519");
  const parsed = parseNodePublicKey(pair.publicKey.export({ format: "pem", type: "spki" }).toString());
  assert.ok(parsed);
  const logs: string[] = [];

  const dispatch = createFederationHttpDispatcher({
    localInstanceId: "local-1",
    privateKey: pair.privateKey,
    keyId: "kid-local-1",
    publicKeyRaw: parsed!.raw,
    getPeerById: () => makePeer(),
    requireMtls: true,
    allowInsecureSignedOnlyDev: false,
    requestTimeoutMs: 5000,
    audit: async () => {
      throw new Error("audit sink unavailable");
    },
    log: (msg) => logs.push(msg),
    fetchImpl: async () => new Response("", { status: 202 }),
  });

  const result = await dispatch(makeOutboxRecord());
  assert.equal(result.ok, true);
  assert.ok(logs.some((line) => line.includes("audit write failed")));
});

test("dispatcher prefers healthy federation transport route when available", async () => {
  const pair = generateKeyPairSync("ed25519");
  const parsed = parseNodePublicKey(pair.publicKey.export({ format: "pem", type: "spki" }).toString());
  assert.ok(parsed);
  let capturedUrl: string | null = null;

  const dispatch = createFederationHttpDispatcher({
    localInstanceId: "local-1",
    privateKey: pair.privateKey,
    keyId: "kid-local-1",
    publicKeyRaw: parsed!.raw,
    getPeerById: () => makePeer({ endpoint: "https://peer-config.internal" }),
    getRouteForPeer: () => ({
      routeId: "route-1",
      peerId: "peer-1",
      adapter: "federation_http",
      endpoint: "https://peer-route.internal",
      healthy: true,
      lastCheckedAt: null,
      lastError: null,
      metadata: {},
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    }),
    requireMtls: true,
    allowInsecureSignedOnlyDev: false,
    requestTimeoutMs: 5000,
    fetchImpl: async (url) => {
      capturedUrl = String(url);
      return new Response("", { status: 202 });
    },
  });

  const result = await dispatch(makeOutboxRecord());
  assert.equal(result.ok, true);
  assert.equal(capturedUrl, "https://peer-route.internal/api/federation/inbox");
});

test("dispatcher emits egress session heartbeat observation on successful delivery", async () => {
  const pair = generateKeyPairSync("ed25519");
  const parsed = parseNodePublicKey(pair.publicKey.export({ format: "pem", type: "spki" }).toString());
  assert.ok(parsed);
  const sessionEvents: Array<Record<string, unknown>> = [];
  const now = 1_700_000_123_000;

  const dispatch = createFederationHttpDispatcher({
    localInstanceId: "local-1",
    privateKey: pair.privateKey,
    keyId: "kid-local-1",
    publicKeyRaw: parsed!.raw,
    getPeerById: () => makePeer(),
    requireMtls: true,
    allowInsecureSignedOnlyDev: false,
    requestTimeoutMs: 5000,
    nowMs: () => now,
    fetchImpl: async () => new Response("", { status: 202 }),
    observeSessionHeartbeat: async (entry) => {
      sessionEvents.push(entry as unknown as Record<string, unknown>);
    },
  });

  const result = await dispatch(makeOutboxRecord({ id: "outbox-session-1", traceId: "trace-session-1" }));
  assert.equal(result.ok, true);
  assert.equal(sessionEvents.length, 1);
  const event = sessionEvents[0]!;
  assert.equal(event.peerId, "peer-1");
  assert.equal(event.kid, "kid-local-1");
  assert.equal(event.transportKind, "federation_http");
  assert.equal(event.direction, "egress");
  assert.equal(event.envelopeId, "outbox-session-1");
  assert.equal(event.traceId, "trace-session-1");
  assert.equal(event.nowMs, now);
});

test("dispatcher continues when session heartbeat observation sink fails", async () => {
  const pair = generateKeyPairSync("ed25519");
  const parsed = parseNodePublicKey(pair.publicKey.export({ format: "pem", type: "spki" }).toString());
  assert.ok(parsed);
  const logs: string[] = [];

  const dispatch = createFederationHttpDispatcher({
    localInstanceId: "local-1",
    privateKey: pair.privateKey,
    keyId: "kid-local-1",
    publicKeyRaw: parsed!.raw,
    getPeerById: () => makePeer(),
    requireMtls: true,
    allowInsecureSignedOnlyDev: false,
    requestTimeoutMs: 5000,
    fetchImpl: async () => new Response("", { status: 202 }),
    observeSessionHeartbeat: async () => {
      throw new Error("session sink unavailable");
    },
    log: (msg) => logs.push(msg),
  });

  const result = await dispatch(makeOutboxRecord({ id: "outbox-session-2" }));
  assert.equal(result.ok, true);
  assert.ok(logs.some((line) => line.includes("session heartbeat observation failed")));
});
