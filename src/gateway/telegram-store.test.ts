import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase, type NexusDatabase } from "../storage/database.js";
import { approvePairingRequest, createPairingRequest, getPairingRequest } from "./telegram-store.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-pairing-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("createPairingRequest returns already_pending for same sender", async () => {
  await withDb(async (db) => {
    const nowMs = 1_700_000_000_000;
    const first = createPairingRequest(db, {
      channel: "telegram",
      senderKey: "1000000001",
      nowMs,
      ttlMs: 10 * 60_000,
      maxPending: 3,
    });
    assert.equal(first.status, "created");

    const second = createPairingRequest(db, {
      channel: "telegram",
      senderKey: "1000000001",
      nowMs: nowMs + 1000,
      ttlMs: 10 * 60_000,
      maxPending: 3,
    });
    assert.equal(second.status, "already_pending");
    assert.equal(second.code, first.code);
  });
});

test("createPairingRequest returns max_pending when queue is full", async () => {
  await withDb(async (db) => {
    const nowMs = 1_700_000_000_000;
    const first = createPairingRequest(db, {
      channel: "telegram",
      senderKey: "user-1",
      nowMs,
      ttlMs: 10 * 60_000,
      maxPending: 1,
    });
    assert.equal(first.status, "created");

    const second = createPairingRequest(db, {
      channel: "telegram",
      senderKey: "user-2",
      nowMs: nowMs + 1000,
      ttlMs: 10 * 60_000,
      maxPending: 1,
    });
    assert.equal(second.status, "max_pending");
  });
});

test("approvePairingRequest does not consume request for wrong channel", async () => {
  await withDb(async (db) => {
    const nowMs = 1_700_000_000_000;
    const created = createPairingRequest(db, {
      channel: "telegram",
      senderKey: "1000000001",
      nowMs,
      ttlMs: 10 * 60_000,
      maxPending: 3,
    });
    assert.equal(created.status, "created");

    const wrongChannel = approvePairingRequest(db, {
      channel: "discord",
      code: created.code,
      nowMs: nowMs + 1000,
    });
    assert.equal(wrongChannel.ok, false);

    const stillPending = getPairingRequest(db, {
      channel: "telegram",
      code: created.code,
      nowMs: nowMs + 1000,
    });
    assert.ok(stillPending);
    assert.equal(stillPending?.senderKey, "1000000001");

    const approved = approvePairingRequest(db, {
      channel: "telegram",
      code: created.code,
      nowMs: nowMs + 2000,
    });
    assert.equal(approved.ok, true);
    assert.equal(approved.senderKey, "1000000001");
  });
});

test("createPairingRequest retries on pairing code collisions", async () => {
  await withDb(async (db) => {
    const nowMs = 1_700_000_000_000;
    db.db
      .prepare("INSERT INTO pairing_requests (code, channel, sender_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run("AAAAAAAA", "telegram", "existing-user", nowMs, nowMs + 10 * 60_000);

    const originalRandomBytes = crypto.randomBytes;
    let calls = 0;
    const replacement: typeof crypto.randomBytes = ((size: number) => {
      calls += 1;
      if (calls === 1) return Buffer.alloc(size, 0); // -> AAAAAAAA (collision)
      return Buffer.alloc(size, 1); // -> BBBBBBBB (next attempt)
    }) as typeof crypto.randomBytes;
    (crypto as { randomBytes: typeof crypto.randomBytes }).randomBytes = replacement;
    try {
      const result = createPairingRequest(db, {
        channel: "telegram",
        senderKey: "new-user",
        nowMs: nowMs + 1000,
        ttlMs: 10 * 60_000,
        maxPending: 10,
      });
      assert.equal(result.status, "created");
      assert.equal(result.code, "BBBBBBBB");
    } finally {
      (crypto as { randomBytes: typeof crypto.randomBytes }).randomBytes = originalRandomBytes;
    }
  });
});
