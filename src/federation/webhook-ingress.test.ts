import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseNodePublicKey } from "../nodes/auth.js";
import { openDatabase, type NexusDatabase } from "../storage/database.js";
import {
  upsertFederationExport,
  upsertFederationGrant,
  upsertFederationPeer,
  upsertWebhookEndpoint,
  upsertWebhookSubscription,
} from "../storage/federation.js";
import { ingestWebhookIngressEvent } from "./webhook-ingress.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-webhook-ingress-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("ingress applies shared projection for federation-peer webhook events", async () => {
  await withDb(async (db) => {
    const keyPair = generateKeyPairSync("ed25519");
    const parsed = parseNodePublicKey(keyPair.publicKey.export({ format: "pem", type: "spki" }).toString());
    assert.ok(parsed);

    upsertFederationPeer(db, {
      id: "peer-projection-1",
      label: "Projection Peer",
      endpoint: "https://peer-projection-1.internal",
      signingKey: parsed.raw,
      trustState: "trusted",
      enabled: true,
    });
    upsertFederationExport(db, {
      id: "fexp-projection-1",
      resourceType: "node_pool",
      projection: {
        includeFields: ["nodeId", "status", "apiKey"],
        excludeFields: ["apiKey"],
      },
    });
    upsertFederationGrant(db, {
      id: "fgrant-projection-1",
      peerId: "peer-projection-1",
      exportId: "fexp-projection-1",
      sensitivityCeiling: "internal",
    });
    upsertWebhookEndpoint(db, {
      id: "wep-projection-1",
      ownerScope: "federation_peer",
      peerId: "peer-projection-1",
      url: "https://peer-projection-1.internal/federation-webhook",
    });
    upsertWebhookSubscription(db, {
      id: "wsub-projection-1",
      endpointId: "wep-projection-1",
      eventType: "node.share.*",
    });

    const outcome = ingestWebhookIngressEvent({
      db,
      source: {
        kind: "federation_peer",
        peerId: "peer-projection-1",
        sourceInstance: "peer-projection-1",
      },
      ingress: {
        eventId: "evt-projection-1",
        traceId: "trace-projection-1",
        kind: "node.share.updated",
        ts: Date.now(),
        destinationEndpointId: "wep-projection-1",
        payload: {
          nodeId: "node-a",
          status: "online",
          apiKey: "secret-value",
          localPath: "/private/path",
        },
        idempotencyKey: "idmp-projection-1",
        sensitivity: "internal",
      },
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.duplicate, false);

    const stored = db.db
      .prepare("SELECT payload_json FROM federation_events WHERE envelope_id = ?")
      .get("evt-projection-1") as { payload_json: string } | undefined;
    assert.ok(stored);
    const payload = JSON.parse(stored?.payload_json ?? "{}") as { webhook?: Record<string, unknown> };
    const webhookPayload = payload.webhook ?? {};
    assert.equal(webhookPayload.nodeId, "node-a");
    assert.equal(webhookPayload.status, "online");
    assert.equal("apiKey" in webhookPayload, false);
    assert.equal("localPath" in webhookPayload, false);
  });
});

test("node ingress rejects federation-owned endpoints", async () => {
  await withDb(async (db) => {
    upsertWebhookEndpoint(db, {
      id: "wep-fed-only-1",
      ownerScope: "federation_peer",
      peerId: null,
      url: "https://peer-1.internal/federation-webhook",
    });

    const outcome = ingestWebhookIngressEvent({
      db,
      source: {
        kind: "node",
        nodeId: "node-1",
      },
      ingress: {
        eventId: "evt-node-scope-1",
        traceId: "trace-node-scope-1",
        kind: "node.alert.cpu",
        ts: Date.now(),
        destinationEndpointId: "wep-fed-only-1",
        payload: {
          value: 92,
        },
      },
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.status, 403);
    assert.equal(outcome.code, "node_ingress_scope_mismatch");
  });
});

test("node ingress stores once and marks duplicate by envelope id", async () => {
  await withDb(async (db) => {
    upsertWebhookEndpoint(db, {
      id: "wep-local-dup-1",
      ownerScope: "local",
      url: "https://local.internal/webhook",
    });
    upsertWebhookSubscription(db, {
      id: "wsub-local-dup-1",
      endpointId: "wep-local-dup-1",
      eventType: "node.alert.*",
    });

    const first = ingestWebhookIngressEvent({
      db,
      source: {
        kind: "node",
        nodeId: "node-dup-1",
      },
      ingress: {
        eventId: "evt-node-dup-1",
        traceId: "trace-node-dup-1",
        kind: "node.alert.high_cpu",
        ts: Date.now(),
        destinationEndpointId: "wep-local-dup-1",
        payload: {
          value: 99,
        },
      },
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.duplicate, false);

    const duplicate = ingestWebhookIngressEvent({
      db,
      source: {
        kind: "node",
        nodeId: "node-dup-1",
      },
      ingress: {
        eventId: "evt-node-dup-1",
        traceId: "trace-node-dup-1",
        kind: "node.alert.high_cpu",
        ts: Date.now(),
        destinationEndpointId: "wep-local-dup-1",
        payload: {
          value: 99,
        },
      },
    });
    assert.equal(duplicate.ok, true);
    if (!duplicate.ok) return;
    assert.equal(duplicate.duplicate, true);

    const countRow = db.db
      .prepare("SELECT COUNT(*) AS count FROM federation_events WHERE envelope_id = ?")
      .get("evt-node-dup-1") as { count: number } | undefined;
    assert.equal(countRow?.count ?? 0, 1);
  });
});
