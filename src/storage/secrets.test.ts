import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase, type NexusDatabase } from "./database.js";
import {
  appendSecretAccessEvent,
  createSecretLease,
  getActiveSecretLeaseByRef,
  getSecretLeaseById,
  getSecretProviderProfileById,
  listSecretAccessEvents,
  upsertSecretProviderProfile,
} from "./secrets.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-secret-store-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("secret provider profile upsert/get works", async () => {
  await withDb(async (db) => {
    upsertSecretProviderProfile(db, {
      id: "local-main",
      kind: "local_file",
      strictMode: true,
      enabled: true,
      config: {
        leaseTtlMs: 30_000,
      },
      nowMs: 1_700_000_000_000,
    });

    const row = getSecretProviderProfileById(db, "local-main");
    assert.ok(row);
    assert.equal(row?.kind, "local_file");
    assert.equal(row?.strictMode, true);
    assert.equal(row?.enabled, true);
    assert.equal(row?.config.leaseTtlMs, 30_000);
  });
});

test("secret access events and leases persist", async () => {
  await withDb(async (db) => {
    upsertSecretProviderProfile(db, {
      id: "local-main",
      kind: "local_file",
      strictMode: true,
      enabled: true,
      nowMs: 500,
    });
    createSecretLease(db, {
      id: "lease-1",
      providerProfileId: "local-main",
      leaseRef: "local-main/cred-1",
      status: "active",
      issuedAt: 1_000,
      expiresAt: 2_000,
      traceId: "trace-1",
    });
    appendSecretAccessEvent(db, {
      id: "access-1",
      providerProfileId: "local-main",
      traceId: "trace-1",
      firewallSession: "fw-1",
      actor: "node:1",
      secretPathHash: "hash-1",
      secretClass: "credential",
      decision: "allow",
      reason: "ok",
      leaseId: "lease-1",
      nowMs: 1_500,
    });

    const lease = getSecretLeaseById(db, "lease-1");
    assert.ok(lease);
    assert.equal(lease?.status, "active");

    const active = getActiveSecretLeaseByRef(db, {
      leaseRef: "local-main/cred-1",
      nowMs: 1_999,
    });
    assert.ok(active);
    assert.equal(active?.id, "lease-1");

    const events = listSecretAccessEvents(db, { limit: 10 });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.decision, "allow");
    assert.equal(events[0]?.leaseId, "lease-1");
  });
});
