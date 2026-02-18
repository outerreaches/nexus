import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase, type NexusDatabase } from "./database.js";
import {
  appendFederationEvent,
  consumeFederationReplayNonce,
  federationPeerIdentityScope,
  getFederationEventByEnvelopeId,
  getFederationGrantProjectionForPeerResource,
  getIdentityKeyByScopeKid,
  getPreferredIdentityKeyForScope,
  getFederationPeerById,
  getFederationStatusSnapshot,
  getPreferredTransportRouteForPeer,
  listFederationPeers,
  rotateIdentityKeyForScope,
  setIdentityKeyStatusByScope,
  setFederationPeerTrustState,
  upsertFederationExport,
  upsertFederationGrant,
  upsertIdentityKey,
  upsertFederationPeer,
  upsertFederationSession,
  upsertTransportRoute,
} from "./federation.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-federation-store-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("federation peer upsert/list/get works", async () => {
  await withDb(async (db) => {
    upsertFederationPeer(db, {
      id: "peer-1",
      label: "Monetization Peer",
      endpoint: "https://peer-1.internal",
      signingKey: "ed25519:peer-1",
      trustState: "pending",
      metadata: { zone: "lab-a" },
      nowMs: 1000,
    });

    const peers = listFederationPeers(db);
    assert.equal(peers.length, 1);
    assert.equal(peers[0]?.id, "peer-1");
    assert.equal(peers[0]?.trustState, "pending");

    const peer = getFederationPeerById(db, "peer-1");
    assert.ok(peer);
    assert.equal(peer?.endpoint, "https://peer-1.internal");
    assert.equal(peer?.metadata.zone, "lab-a");
  });
});

test("federation event append/get by envelope id works for inbound dedupe lookups", async () => {
  await withDb(async (db) => {
    const nowMs = 1_700_000_000_000;
    upsertFederationPeer(db, {
      id: "peer-1",
      label: "Peer",
      endpoint: "https://peer-1.internal",
      signingKey: "ed25519:peer-1",
      trustState: "trusted",
      nowMs,
    });

    appendFederationEvent(db, {
      id: "evt-1",
      peerId: "peer-1",
      eventType: "submit_task",
      direction: "inbound",
      envelopeId: "env-1",
      payload: { taskId: "task-1" },
      traceId: "trace-1",
      nowMs: nowMs + 10,
    });

    const found = getFederationEventByEnvelopeId(db, {
      envelopeId: "env-1",
      direction: "inbound",
    });
    assert.ok(found);
    assert.equal(found?.id, "evt-1");
    assert.equal(found?.eventType, "submit_task");
    assert.equal(found?.traceId, "trace-1");
  });
});

test("federation replay nonce consume rejects duplicates until TTL expiry", async () => {
  await withDb(async (db) => {
    const first = consumeFederationReplayNonce(db, {
      sourceInstance: "peer-1",
      nonce: "nonce-1",
      keyId: "kid-1",
      envelopeId: "env-1",
      traceId: "trace-1",
      ttlMs: 5_000,
      nowMs: 1_000,
    });
    assert.equal(first.accepted, true);
    assert.equal(first.duplicate, false);

    const duplicate = consumeFederationReplayNonce(db, {
      sourceInstance: "peer-1",
      nonce: "nonce-1",
      keyId: "kid-1",
      envelopeId: "env-2",
      traceId: "trace-2",
      ttlMs: 5_000,
      nowMs: 3_000,
    });
    assert.equal(duplicate.accepted, false);
    assert.equal(duplicate.duplicate, true);

    const afterExpiry = consumeFederationReplayNonce(db, {
      sourceInstance: "peer-1",
      nonce: "nonce-1",
      keyId: "kid-1",
      envelopeId: "env-3",
      traceId: "trace-3",
      ttlMs: 5_000,
      nowMs: 8_001,
    });
    assert.equal(afterExpiry.accepted, true);
    assert.equal(afterExpiry.duplicate, false);
    assert.ok(afterExpiry.cleanupDeleted >= 1);
  });
});

test("identity keyring helpers select active key and enforce scoped status transitions", async () => {
  await withDb(async (db) => {
    const nowMs = 1_700_000_000_000;
    upsertIdentityKey(db, {
      scope: "federation",
      kid: "kid-next",
      publicKey: "next-key",
      status: "next",
      notBefore: nowMs - 1_000,
      nowMs,
    });
    upsertIdentityKey(db, {
      scope: "federation",
      kid: "kid-active",
      publicKey: "active-key",
      status: "active",
      notBefore: nowMs - 2_000,
      nowMs,
    });

    const preferred = getPreferredIdentityKeyForScope(db, {
      scope: "federation",
      nowMs,
    });
    assert.ok(preferred);
    assert.equal(preferred?.kid, "kid-active");

    const peerScope = federationPeerIdentityScope("peer-1");
    upsertIdentityKey(db, {
      scope: peerScope,
      kid: "kid-peer",
      publicKey: "peer-key",
      status: "active",
      nowMs,
    });
    const found = getIdentityKeyByScopeKid(db, {
      scope: peerScope,
      kid: "kid-peer",
      nowMs,
    });
    assert.ok(found);
    assert.equal(found?.publicKey, "peer-key");

    const revokedChanges = setIdentityKeyStatusByScope(db, {
      scope: peerScope,
      status: "revoked",
      nowMs: nowMs + 1_000,
    });
    assert.equal(revokedChanges, 1);
    const revoked = getIdentityKeyByScopeKid(db, {
      scope: peerScope,
      kid: "kid-peer",
      nowMs: nowMs + 2_000,
    });
    assert.equal(revoked, null);

    const reactivatedChanges = setIdentityKeyStatusByScope(db, {
      scope: peerScope,
      status: "active",
      nowMs: nowMs + 3_000,
    });
    assert.equal(reactivatedChanges, 0);
    const stillRevoked = getIdentityKeyByScopeKid(db, {
      scope: peerScope,
      kid: "kid-peer",
      includeInactive: true,
      nowMs: nowMs + 4_000,
    });
    assert.ok(stillRevoked);
    assert.equal(stillRevoked?.status, "revoked");
  });
});

test("identity key rotation demotes prior active key to next within overlap window", async () => {
  await withDb(async (db) => {
    const nowMs = 1_700_000_000_000;
    const scope = federationPeerIdentityScope("peer-rotate");
    upsertIdentityKey(db, {
      scope,
      kid: "kid-old",
      publicKey: "old-key",
      status: "active",
      notBefore: nowMs - 60_000,
      nowMs,
    });

    rotateIdentityKeyForScope(db, {
      scope,
      kid: "kid-new",
      publicKey: "new-key",
      overlapMs: 60_000,
      nowMs: nowMs + 1_000,
    });

    const preferred = getPreferredIdentityKeyForScope(db, {
      scope,
      nowMs: nowMs + 2_000,
    });
    assert.ok(preferred);
    assert.equal(preferred?.kid, "kid-new");
    assert.equal(preferred?.status, "active");

    const oldDuringOverlap = getIdentityKeyByScopeKid(db, {
      scope,
      kid: "kid-old",
      nowMs: nowMs + 30_000,
    });
    assert.ok(oldDuringOverlap);
    assert.equal(oldDuringOverlap?.status, "next");

    const oldAfterOverlap = getIdentityKeyByScopeKid(db, {
      scope,
      kid: "kid-old",
      nowMs: nowMs + 70_000,
    });
    assert.equal(oldAfterOverlap, null);
  });
});

test("federation status snapshot transitions to active_federated with key + trusted healthy peer", async () => {
  await withDb(async (db) => {
    const nowMs = 1_700_000_000_000;
    upsertFederationPeer(db, {
      id: "peer-1",
      label: "Monetization Peer",
      endpoint: "https://peer-1.internal",
      signingKey: "ed25519:peer-1",
      trustState: "pending",
      nowMs,
    });
    setFederationPeerTrustState(db, { id: "peer-1", trustState: "trusted", nowMs: nowMs + 10 });

    upsertTransportRoute(db, {
      routeId: "route-1",
      peerId: "peer-1",
      adapter: "federation_http",
      endpoint: "https://peer-1.internal",
      healthy: true,
      nowMs: nowMs + 20,
    });
    upsertFederationSession(db, {
      id: "sess-1",
      peerId: "peer-1",
      status: "active",
      establishedAt: nowMs + 30,
      expiresAt: nowMs + 60_000,
      lastHeartbeatAt: nowMs + 30,
    });

    const noIdentity = getFederationStatusSnapshot({
      db,
      enabled: true,
      firewallActive: true,
      nowMs: nowMs + 40,
    });
    assert.equal(noIdentity.identityValid, false);
    assert.equal(noIdentity.derivedState, "federated_degraded");

    db.db
      .prepare(
        `INSERT INTO identity_keyring (
           id,
           scope,
           kid,
           public_key,
           private_key_ref,
           status,
           not_before,
           not_after,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "key-1",
        "federation",
        "kid-1",
        "ed25519-public",
        "local:key-1",
        "active",
        nowMs,
        nowMs + 600_000,
        nowMs,
        nowMs,
      );

    const withIdentity = getFederationStatusSnapshot({
      db,
      enabled: true,
      firewallActive: true,
      nowMs: nowMs + 50,
    });
    assert.equal(withIdentity.identityValid, true);
    assert.equal(withIdentity.derivedState, "active_federated");
    assert.equal(withIdentity.trustedPeerCount, 1);
    assert.equal(withIdentity.healthyTrustedPeerCount, 1);
  });
});

test("federation status snapshot is standalone when disabled", async () => {
  await withDb(async (db) => {
    const status = getFederationStatusSnapshot({
      db,
      enabled: false,
      firewallActive: false,
      nowMs: 1_700_000_000_000,
    });
    assert.equal(status.derivedState, "standalone");
    assert.equal(status.peerCount, 0);
    assert.equal(status.identityValid, false);
  });
});

test("transport route upsert updates existing tuple even when routeId changes", async () => {
  await withDb(async (db) => {
    const nowMs = 1_700_000_000_000;
    upsertFederationPeer(db, {
      id: "peer-1",
      label: "Peer",
      endpoint: "https://peer-1.internal",
      signingKey: "ed25519:peer-1",
      nowMs,
    });

    upsertTransportRoute(db, {
      routeId: "route-a",
      peerId: "peer-1",
      adapter: "federation_http",
      endpoint: "https://peer-1.internal",
      healthy: false,
      nowMs: nowMs + 10,
    });

    upsertTransportRoute(db, {
      routeId: "route-b",
      peerId: "peer-1",
      adapter: "federation_http",
      endpoint: "https://peer-1.internal",
      healthy: true,
      nowMs: nowMs + 20,
    });

    const row = db.db
      .prepare(
        "SELECT route_id, healthy FROM transport_routes WHERE peer_id = ? AND adapter = ? AND endpoint = ?",
      )
      .get("peer-1", "federation_http", "https://peer-1.internal") as { route_id: string; healthy: number } | undefined;
    assert.ok(row);
    assert.equal(row?.route_id, "route-a");
    assert.equal(row?.healthy, 1);

    const preferred = getPreferredTransportRouteForPeer(db, {
      peerId: "peer-1",
      adapter: "federation_http",
      requireHealthy: true,
    });
    assert.ok(preferred);
    assert.equal(preferred?.routeId, "route-a");
    assert.equal(preferred?.endpoint, "https://peer-1.internal");
  });
});

test("grant projection lookup returns active export projection for shared resource type", async () => {
  await withDb(async (db) => {
    const nowMs = 1_700_000_000_000;
    upsertFederationPeer(db, {
      id: "peer-projection-1",
      label: "Peer",
      endpoint: "https://peer-projection-1.internal",
      signingKey: "ed25519:peer-projection-1",
      trustState: "trusted",
      nowMs,
    });
    upsertFederationExport(db, {
      id: "fexp-projection-1",
      resourceType: "node_pool",
      projection: {
        includeFields: ["nodeId", "status"],
      },
      enabled: true,
      nowMs,
    });
    upsertFederationGrant(db, {
      id: "fgrant-projection-1",
      peerId: "peer-projection-1",
      exportId: "fexp-projection-1",
      sensitivityCeiling: "internal",
      enabled: true,
      nowMs,
    });

    const row = getFederationGrantProjectionForPeerResource(db, {
      peerId: "peer-projection-1",
      resourceType: "node_pool",
    });
    assert.ok(row);
    assert.equal(row?.grantId, "fgrant-projection-1");
    assert.equal(row?.resourceType, "node_pool");
    assert.deepEqual(row?.projection, {
      includeFields: ["nodeId", "status"],
    });
    assert.equal(row?.sensitivityCeiling, "internal");
  });
});
