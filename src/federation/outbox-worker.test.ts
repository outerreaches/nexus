import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase, type NexusDatabase } from "../storage/database.js";
import { enqueueFederationOutbox, listFederationOutbox, upsertFederationPeer } from "../storage/federation.js";
import { startFederationOutboxWorker } from "./outbox-worker.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-federation-outbox-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("outbox worker marks pending items as sent on successful dispatch", async () => {
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
    enqueueFederationOutbox(db, {
      id: "outbox-1",
      peerId: "peer-1",
      transportKind: "federation_http",
      envelope: { hello: "world" },
      nowMs,
    });

    const worker = startFederationOutboxWorker({
      db,
      dispatch: async () => ({ ok: true }),
      intervalMs: 60_000,
      maxBatch: 10,
    });
    try {
      const processed = await worker.tick();
      assert.equal(processed, 1);
    } finally {
      worker.stop();
    }

    const outbox = listFederationOutbox(db);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0]?.status, "sent");
    assert.equal(outbox[0]?.attempts, 1);
    assert.equal(outbox[0]?.lastError, null);
  });
});

test("outbox worker marks item failed and schedules retry on dispatch failure", async () => {
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
    enqueueFederationOutbox(db, {
      id: "outbox-1",
      peerId: "peer-1",
      transportKind: "federation_http",
      envelope: { hello: "world" },
      nowMs,
    });

    const worker = startFederationOutboxWorker({
      db,
      dispatch: async () => ({ ok: false, error: "peer_unavailable", retryAt: nowMs + 30_000 }),
      intervalMs: 60_000,
      maxBatch: 10,
    });
    try {
      const processed = await worker.tick();
      assert.equal(processed, 1);
    } finally {
      worker.stop();
    }

    const outbox = listFederationOutbox(db);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0]?.status, "failed");
    assert.equal(outbox[0]?.attempts, 1);
    assert.equal(outbox[0]?.lastError, "peer_unavailable");
    assert.ok((outbox[0]?.nextAttemptAt ?? 0) > 0);
  });
});

test("outbox worker sends terminal failures to dead-letter status", async () => {
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
    enqueueFederationOutbox(db, {
      id: "outbox-1",
      peerId: "peer-1",
      transportKind: "federation_http",
      envelope: { hello: "world" },
      nowMs,
    });

    const worker = startFederationOutboxWorker({
      db,
      dispatch: async () => ({ ok: false, terminal: true, error: "peer_not_trusted" }),
      intervalMs: 60_000,
      maxBatch: 10,
    });
    try {
      const processed = await worker.tick();
      assert.equal(processed, 1);
    } finally {
      worker.stop();
    }

    const outbox = listFederationOutbox(db);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0]?.status, "dead_letter");
    assert.equal(outbox[0]?.lastError, "peer_not_trusted");
    assert.equal(outbox[0]?.nextAttemptAt, null);
  });
});
