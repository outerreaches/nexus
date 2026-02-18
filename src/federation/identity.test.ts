import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase } from "../storage/database.js";
import { loadOrCreateFederationSigningIdentity } from "./identity.js";

test("loadOrCreateFederationSigningIdentity generates then reuses active keyring identity", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-federation-identity-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    const first = await loadOrCreateFederationSigningIdentity({
      db,
      stateDir: dir,
      nowMs: 1_700_000_000_000,
    });
    assert.equal(first.loadedFrom, "generated");
    assert.ok(first.kid.length > 0);
    assert.ok(first.publicKeyRaw.length > 0);
    assert.ok(first.privateKeyRef.startsWith("file:"));
    const privatePath = first.privateKeyRef.slice("file:".length);
    const privatePem = await fs.readFile(privatePath, "utf8");
    assert.ok(privatePem.includes("BEGIN PRIVATE KEY"));

    const row = db.db
      .prepare("SELECT scope, kid, public_key, private_key_ref, status FROM identity_keyring WHERE scope = 'federation' AND kid = ?")
      .get(first.kid) as
      | { scope: string; kid: string; public_key: string; private_key_ref: string | null; status: string }
      | undefined;
    assert.ok(row);
    assert.equal(row?.scope, "federation");
    assert.equal(row?.kid, first.kid);
    assert.equal(row?.public_key, first.publicKeyRaw);
    assert.equal(row?.status, "active");

    const second = await loadOrCreateFederationSigningIdentity({
      db,
      stateDir: dir,
      nowMs: 1_700_000_010_000,
    });
    assert.equal(second.loadedFrom, "keyring");
    assert.equal(second.kid, first.kid);
    assert.equal(second.publicKeyRaw, first.publicKeyRaw);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

