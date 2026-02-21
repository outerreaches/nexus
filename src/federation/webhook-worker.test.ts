import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";

import { openDatabase, type NexusDatabase } from "../storage/database.js";
import {
  appendFederationEvent,
  enqueueWebhookDelivery,
  getWebhookDeliveryById,
  listWebhookDlq,
  upsertFederationExport,
  upsertFederationGrant,
  upsertFederationPeer,
  upsertWebhookEndpoint,
} from "../storage/federation.js";
import { upsertSecretProviderProfile } from "../storage/secrets.js";
import { setSecretBrokerRequestInvokerForTests } from "../secrets/broker.js";
import { upsertCredential } from "../secrets/credentials.js";
import { startWebhookDeliveryWorker } from "./webhook-worker.js";

function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> | void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).then === "function") {
      return (result as Promise<void>).finally(restore);
    }
    restore();
  } catch (err) {
    restore();
    throw err;
  }
}

async function withDb(fn: (params: { db: NexusDatabase; stateDir: string }) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-webhook-worker-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn({ db, stateDir: dir });
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("webhook worker dispatches pending delivery and marks acked on success", async () => {
  await withDb(async ({ db, stateDir }) => {
    const nowMs = Date.now();
    const signing = generateKeyPairSync("ed25519");

    upsertFederationPeer(db, {
      id: "peer-1",
      label: "Peer",
      endpoint: "https://peer-1.internal",
      signingKey: "ed25519:peer-1",
      trustState: "trusted",
      nowMs,
    });
    upsertWebhookEndpoint(db, {
      id: "wep-1",
      ownerScope: "federation_peer",
      peerId: "peer-1",
      url: "https://peer-1.internal/federation-webhook",
      eventFilter: ["federation.task.*"],
      signingMode: "ed25519",
      enabled: true,
      status: "active",
      nowMs,
    });
    appendFederationEvent(db, {
      id: "evt-1",
      peerId: "peer-1",
      eventType: "federation.task.updated",
      direction: "outbound",
      envelopeId: "env-1",
      payload: { taskId: "task-1", status: "running" },
      traceId: "trace-1",
      nowMs,
    });
    enqueueWebhookDelivery(db, {
      id: "wdel-1",
      endpointId: "wep-1",
      eventId: "evt-1",
      traceId: "trace-1",
      nowMs,
    });

    let seen = 0;
    const worker = startWebhookDeliveryWorker({
      db,
      stateDir,
      localInstanceId: "local-1",
      getSigningMaterial: () => ({
        privateKey: signing.privateKey,
        keyId: "kid-local-1",
      }),
      webhooksFederatedOnly: true,
      webhooksExternalEnabled: false,
      fetchImpl: async () => {
        seen += 1;
        return new Response("", { status: 202 });
      },
      lookupHost: async () => [{ address: "203.0.113.20", family: 4 }],
      intervalMs: 100_000,
      maxBatch: 10,
      requestTimeoutMs: 2_000,
    });
    try {
      const processed = await worker.tick();
      assert.equal(processed, 1);
    } finally {
      worker.stop();
    }

    const row = getWebhookDeliveryById(db, "wdel-1");
    assert.ok(row);
    assert.equal(row?.status, "acked");
    assert.equal(row?.responseCode, 202);
    assert.equal(seen, 1);
  });
});

test("webhook worker dead-letters deliveries when DNS resolves to blocked addresses", async () => {
  await withDb(async ({ db, stateDir }) => {
    const nowMs = Date.now();
    const signing = generateKeyPairSync("ed25519");

    upsertFederationPeer(db, {
      id: "peer-dns-1",
      label: "Peer",
      endpoint: "https://peer-dns-1.internal",
      signingKey: "ed25519:peer-dns-1",
      trustState: "trusted",
      nowMs,
    });
    upsertWebhookEndpoint(db, {
      id: "wep-dns-1",
      ownerScope: "federation_peer",
      peerId: "peer-dns-1",
      url: "https://peer-dns-1.internal/federation-webhook",
      eventFilter: ["federation.task.*"],
      signingMode: "ed25519",
      enabled: true,
      status: "active",
      nowMs,
    });
    appendFederationEvent(db, {
      id: "evt-dns-1",
      peerId: "peer-dns-1",
      eventType: "federation.task.updated",
      direction: "outbound",
      envelopeId: "env-dns-1",
      payload: { taskId: "task-dns-1" },
      traceId: "trace-dns-1",
      nowMs,
    });
    enqueueWebhookDelivery(db, {
      id: "wdel-dns-1",
      endpointId: "wep-dns-1",
      eventId: "evt-dns-1",
      traceId: "trace-dns-1",
      nowMs,
    });

    const worker = startWebhookDeliveryWorker({
      db,
      stateDir,
      localInstanceId: "local-1",
      getSigningMaterial: () => ({
        privateKey: signing.privateKey,
        keyId: "kid-local-1",
      }),
      webhooksFederatedOnly: true,
      webhooksExternalEnabled: false,
      lookupHost: async () => [{ address: "127.0.0.1", family: 4 }],
      intervalMs: 100_000,
      maxBatch: 10,
      requestTimeoutMs: 2_000,
    });
    try {
      const processed = await worker.tick();
      assert.equal(processed, 1);
    } finally {
      worker.stop();
    }

    const row = getWebhookDeliveryById(db, "wdel-dns-1");
    assert.ok(row);
    assert.equal(row?.status, "dead_letter");
    assert.match(row?.responseBody ?? "", /endpoint_dns_validation_failed/);
  });
});

test("webhook worker applies shared payload projection before dispatch", async () => {
  await withDb(async ({ db, stateDir }) => {
    const nowMs = Date.now();
    const signing = generateKeyPairSync("ed25519");

    upsertFederationPeer(db, {
      id: "peer-share-1",
      label: "Peer",
      endpoint: "https://peer-share-1.internal",
      signingKey: "ed25519:peer-share-1",
      trustState: "trusted",
      nowMs,
    });
    upsertFederationExport(db, {
      id: "fexp-1",
      resourceType: "node_pool",
      projection: {
        includeFields: ["nodeId", "status", "apiKey", "localPath"],
        excludeFields: ["apiKey"],
      },
      enabled: true,
      nowMs,
    });
    upsertFederationGrant(db, {
      id: "fgrant-1",
      peerId: "peer-share-1",
      exportId: "fexp-1",
      sensitivityCeiling: "internal",
      enabled: true,
      nowMs,
    });
    upsertWebhookEndpoint(db, {
      id: "wep-share-1",
      ownerScope: "federation_peer",
      peerId: "peer-share-1",
      url: "https://peer-share-1.internal/federation-webhook",
      eventFilter: ["node.share.*"],
      signingMode: "ed25519",
      enabled: true,
      status: "active",
      nowMs,
    });
    appendFederationEvent(db, {
      id: "evt-share-1",
      peerId: "peer-share-1",
      eventType: "node.share.updated",
      direction: "outbound",
      envelopeId: "env-share-1",
      payload: {
        nodeId: "node-1",
        status: "online",
        apiKey: "secret",
        localPath: "/data/private",
      },
      traceId: "trace-share-1",
      nowMs,
    });
    enqueueWebhookDelivery(db, {
      id: "wdel-share-1",
      endpointId: "wep-share-1",
      eventId: "evt-share-1",
      traceId: "trace-share-1",
      nowMs,
    });

    let payloadSeen: Record<string, unknown> | null = null;
    const worker = startWebhookDeliveryWorker({
      db,
      stateDir,
      localInstanceId: "local-1",
      getSigningMaterial: () => ({
        privateKey: signing.privateKey,
        keyId: "kid-local-1",
      }),
      webhooksFederatedOnly: true,
      webhooksExternalEnabled: false,
      lookupHost: async () => [{ address: "203.0.113.20", family: 4 }],
      fetchImpl: async (_url, init) => {
        payloadSeen = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response("", { status: 202 });
      },
      intervalMs: 100_000,
      maxBatch: 10,
      requestTimeoutMs: 2_000,
    });
    try {
      const processed = await worker.tick();
      assert.equal(processed, 1);
    } finally {
      worker.stop();
    }

    const bodyPayload = payloadSeen && typeof payloadSeen === "object"
      ? (payloadSeen["payload"] as Record<string, unknown> | undefined)
      : undefined;
    assert.ok(bodyPayload);
    assert.equal(bodyPayload?.nodeId, "node-1");
    assert.equal(bodyPayload?.status, "online");
    assert.equal("apiKey" in (bodyPayload ?? {}), false);
    assert.equal("localPath" in (bodyPayload ?? {}), false);

    const row = getWebhookDeliveryById(db, "wdel-share-1");
    assert.equal(row?.status, "acked");
  });
});

test("webhook worker blocks deliveries that contain raw secret payloads", async () => {
  await withDb(async ({ db, stateDir }) => {
    const nowMs = Date.now();
    const signing = generateKeyPairSync("ed25519");

    upsertFederationPeer(db, {
      id: "peer-secret-1",
      label: "Peer",
      endpoint: "https://peer-secret-1.internal",
      signingKey: "ed25519:peer-secret-1",
      trustState: "trusted",
      nowMs,
    });
    upsertWebhookEndpoint(db, {
      id: "wep-secret-1",
      ownerScope: "federation_peer",
      peerId: "peer-secret-1",
      url: "https://peer-secret-1.internal/federation-webhook",
      eventFilter: ["federation.task.*"],
      signingMode: "ed25519",
      enabled: true,
      status: "active",
      nowMs,
    });
    appendFederationEvent(db, {
      id: "evt-secret-1",
      peerId: "peer-secret-1",
      eventType: "federation.task.updated",
      direction: "outbound",
      envelopeId: "env-secret-1",
      payload: {
        taskId: "task-1",
        password: "raw-secret",
      },
      traceId: "trace-secret-1",
      nowMs,
    });
    enqueueWebhookDelivery(db, {
      id: "wdel-secret-1",
      endpointId: "wep-secret-1",
      eventId: "evt-secret-1",
      traceId: "trace-secret-1",
      nowMs,
    });

    let seen = 0;
    const worker = startWebhookDeliveryWorker({
      db,
      stateDir,
      localInstanceId: "local-1",
      getSigningMaterial: () => ({
        privateKey: signing.privateKey,
        keyId: "kid-local-1",
      }),
      webhooksFederatedOnly: true,
      webhooksExternalEnabled: false,
      lookupHost: async () => [{ address: "203.0.113.20", family: 4 }],
      fetchImpl: async () => {
        seen += 1;
        return new Response("", { status: 202 });
      },
      intervalMs: 100_000,
      maxBatch: 10,
      requestTimeoutMs: 2_000,
    });
    try {
      const processed = await worker.tick();
      assert.equal(processed, 1);
    } finally {
      worker.stop();
    }

    const row = getWebhookDeliveryById(db, "wdel-secret-1");
    assert.ok(row);
    assert.equal(row?.status, "dead_letter");
    assert.match(row?.responseBody ?? "", /secret_payload_export_blocked/);
    assert.equal(seen, 0);
  });
});

test("webhook worker supports hmac endpoint signing with secret references", async () => {
  await withEnv(
    {
      NEXUS_CREDENTIALS_KEY: "webhook-hmac-test-key",
      NEXUS_SECRETS_PROCESS_ROLE: "sidecar",
      NEXUS_SECRET_BROKER_BEARER_TOKEN: "sidecar-token",
      NEXUS_RUNTIME_PROFILE: "monetization",
    },
    async () => await withDb(async ({ db, stateDir }) => {
      const nowMs = Date.now();
      const signing = generateKeyPairSync("ed25519");

      upsertSecretProviderProfile(db, {
        id: "sidecar-main",
        kind: "sidecar_http",
        endpointRef: "https://127.0.0.1:7777/resolve",
        authMode: "workload_identity",
        strictMode: true,
        enabled: true,
        config: {
          leaseTtlMs: 30_000,
          resolvePath: "/resolve",
        },
        nowMs,
      });
      await upsertCredential({
        stateDir,
        id: "webhook.shared",
        password: "hmac-secret",
      });
      upsertWebhookEndpoint(db, {
        id: "wep-hmac-1",
        ownerScope: "local",
        peerId: null,
        url: "https://hooks.internal/ingest",
        eventFilter: ["federation.task.*"],
        signingMode: "hmac",
        secretRef: "{{secret:sidecar-main/webhook.shared#password}}",
        enabled: true,
        status: "active",
        nowMs,
      });
      appendFederationEvent(db, {
        id: "evt-hmac-1",
        peerId: null,
        eventType: "federation.task.updated",
        direction: "outbound",
        envelopeId: "env-hmac-1",
        payload: { taskId: "task-1", status: "running" },
        traceId: "trace-hmac-1",
        nowMs,
      });
      enqueueWebhookDelivery(db, {
        id: "wdel-hmac-1",
        endpointId: "wep-hmac-1",
        eventId: "evt-hmac-1",
        traceId: "trace-hmac-1",
        nowMs,
      });

      const seenHeaders: Record<string, string> = {};
      setSecretBrokerRequestInvokerForTests(async () => ({
        statusCode: 200,
        bodyText: JSON.stringify({
          value: "hmac-secret",
          secretClass: "credential",
        }),
      }));
      const worker = startWebhookDeliveryWorker({
        db,
        stateDir,
        localInstanceId: "local-1",
        getSigningMaterial: () => ({
          privateKey: signing.privateKey,
          keyId: "kid-local-1",
        }),
        webhooksFederatedOnly: false,
        webhooksExternalEnabled: true,
        lookupHost: async () => [{ address: "203.0.113.20", family: 4 }],
        fetchImpl: async (_url, init) => {
          const headers = init?.headers as Record<string, string> | undefined;
          if (headers) {
            for (const [key, value] of Object.entries(headers)) {
              seenHeaders[key.toLowerCase()] = String(value);
            }
          }
          return new Response("", { status: 202 });
        },
        intervalMs: 100_000,
        maxBatch: 10,
        requestTimeoutMs: 2_000,
      });
      try {
        const processed = await worker.tick();
        assert.equal(processed, 1);
      } finally {
        setSecretBrokerRequestInvokerForTests(null);
        worker.stop();
      }

      assert.match(seenHeaders["x-nexus-signature"] ?? "", /^hmac-sha256:/);
      assert.equal(seenHeaders["x-nexus-key-id"], "hmac:sidecar-main");
      const row = getWebhookDeliveryById(db, "wdel-hmac-1");
      assert.equal(row?.status, "acked");
    }),
  );
});

test("webhook worker applies retry-backoff on retryable delivery failures", async () => {
  await withDb(async ({ db, stateDir }) => {
    const nowMs = Date.now();
    const signing = generateKeyPairSync("ed25519");

    upsertFederationPeer(db, {
      id: "peer-retry-1",
      label: "Peer",
      endpoint: "https://peer-retry-1.internal",
      signingKey: "ed25519:peer-retry-1",
      trustState: "trusted",
      nowMs,
    });
    upsertWebhookEndpoint(db, {
      id: "wep-retry-1",
      ownerScope: "federation_peer",
      peerId: "peer-retry-1",
      url: "https://peer-retry-1.internal/federation-webhook",
      eventFilter: ["federation.task.*"],
      signingMode: "ed25519",
      enabled: true,
      status: "active",
      nowMs,
    });
    appendFederationEvent(db, {
      id: "evt-retry-1",
      peerId: "peer-retry-1",
      eventType: "federation.task.updated",
      direction: "outbound",
      envelopeId: "env-retry-1",
      payload: { taskId: "task-1", status: "running" },
      traceId: "trace-retry-1",
      nowMs,
    });
    enqueueWebhookDelivery(db, {
      id: "wdel-retry-1",
      endpointId: "wep-retry-1",
      eventId: "evt-retry-1",
      traceId: "trace-retry-1",
      nowMs,
    });

    const worker = startWebhookDeliveryWorker({
      db,
      stateDir,
      localInstanceId: "local-1",
      getSigningMaterial: () => ({
        privateKey: signing.privateKey,
        keyId: "kid-local-1",
      }),
      webhooksFederatedOnly: true,
      webhooksExternalEnabled: false,
      lookupHost: async () => [{ address: "203.0.113.20", family: 4 }],
      fetchImpl: async () => new Response("", { status: 503, headers: { "retry-after": "7" } }),
      intervalMs: 100_000,
      maxBatch: 10,
      requestTimeoutMs: 2_000,
    });
    try {
      const processed = await worker.tick();
      assert.equal(processed, 1);
    } finally {
      worker.stop();
    }

    const row = getWebhookDeliveryById(db, "wdel-retry-1");
    assert.ok(row);
    assert.equal(row?.status, "failed");
    assert.equal(row?.attempts, 1);
    assert.ok((row?.nextAttemptAt ?? 0) >= nowMs + 6_000);
  });
});

test("webhook worker sends retry-exhausted deliveries to DLQ", async () => {
  await withDb(async ({ db, stateDir }) => {
    const nowMs = Date.now();
    const signing = generateKeyPairSync("ed25519");

    upsertFederationPeer(db, {
      id: "peer-dlq-1",
      label: "Peer",
      endpoint: "https://peer-dlq-1.internal",
      signingKey: "ed25519:peer-dlq-1",
      trustState: "trusted",
      nowMs,
    });
    upsertWebhookEndpoint(db, {
      id: "wep-dlq-1",
      ownerScope: "federation_peer",
      peerId: "peer-dlq-1",
      url: "https://peer-dlq-1.internal/federation-webhook",
      eventFilter: ["federation.task.*"],
      signingMode: "ed25519",
      enabled: true,
      status: "active",
      nowMs,
    });
    appendFederationEvent(db, {
      id: "evt-dlq-1",
      peerId: "peer-dlq-1",
      eventType: "federation.task.updated",
      direction: "outbound",
      envelopeId: "env-dlq-1",
      payload: { taskId: "task-1", status: "running" },
      traceId: "trace-dlq-1",
      nowMs,
    });
    enqueueWebhookDelivery(db, {
      id: "wdel-dlq-1",
      endpointId: "wep-dlq-1",
      eventId: "evt-dlq-1",
      traceId: "trace-dlq-1",
      nowMs,
    });

    const worker = startWebhookDeliveryWorker({
      db,
      stateDir,
      localInstanceId: "local-1",
      getSigningMaterial: () => ({
        privateKey: signing.privateKey,
        keyId: "kid-local-1",
      }),
      webhooksFederatedOnly: true,
      webhooksExternalEnabled: false,
      lookupHost: async () => [{ address: "203.0.113.20", family: 4 }],
      fetchImpl: async () => new Response("", { status: 503 }),
      intervalMs: 100_000,
      maxBatch: 10,
      maxAttempts: 1,
      requestTimeoutMs: 2_000,
    });
    try {
      const processed = await worker.tick();
      assert.equal(processed, 1);
    } finally {
      worker.stop();
    }

    const row = getWebhookDeliveryById(db, "wdel-dlq-1");
    assert.ok(row);
    assert.equal(row?.status, "dead_letter");
    const dlq = listWebhookDlq(db, 10).find((entry) => entry.deliveryId === "wdel-dlq-1");
    assert.ok(dlq);
  });
});
