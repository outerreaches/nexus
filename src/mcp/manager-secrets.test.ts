import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { setSecretBrokerRequestInvokerForTests } from "../secrets/broker.js";
import { openDatabase, type NexusDatabase } from "../storage/database.js";
import {
  getActiveSecretLeaseByRef,
  listSecretAccessEvents,
  upsertSecretProviderProfile,
} from "../storage/secrets.js";
import { resolveMcpServerEnvSecrets } from "./manager.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-mcp-manager-secrets-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("resolveMcpServerEnvSecrets resolves secret references and revokes issued leases", async () => {
  await withDb(async (db) => {
    upsertSecretProviderProfile(db, {
      id: "sidecar-main",
      kind: "sidecar_http",
      endpointRef: "unix:///run/nexus/secret-sidecar.sock",
      authMode: "unix_peer",
      strictMode: true,
      enabled: true,
      config: {},
    });

    const seenBodies: Array<{ secretPath?: string; field?: string }> = [];
    setSecretBrokerRequestInvokerForTests(async (params) => {
      const parsed = JSON.parse(params.bodyJson) as { secretPath?: string; field?: string };
      seenBodies.push(parsed);
      return {
        statusCode: 200,
        bodyText: JSON.stringify({
          value: parsed.field === "username" ? "octocat" : "ghp_test_123",
          secretClass: "credential",
        }),
      };
    });

    try {
      const resolved = await resolveMcpServerEnvSecrets({
        db,
        stateDir: "/data/nexus",
        serverId: "github-sidecar",
        env: {
          KEEP: "plain-value",
          GITHUB_TOKEN: "{{secret:sidecar-main/mcp.github.pat#password}}",
          GITHUB_USER: "{{secret:sidecar-main/mcp.github.pat#username}}",
        },
      });

      assert.equal(resolved.KEEP, "plain-value");
      assert.equal(resolved.GITHUB_TOKEN, "ghp_test_123");
      assert.equal(resolved.GITHUB_USER, "octocat");
      assert.equal(seenBodies.length, 2);
      assert.equal(seenBodies[0]?.secretPath, "mcp.github.pat");
      assert.equal(seenBodies[0]?.field, "password");
      assert.equal(seenBodies[1]?.secretPath, "mcp.github.pat");
      assert.equal(seenBodies[1]?.field, "username");

      const events = listSecretAccessEvents(db, { limit: 20 });
      const allowEvents = events.filter((event) => event.decision === "allow" && event.providerProfileId === "sidecar-main");
      assert.equal(allowEvents.length, 2);

      const activeLease = getActiveSecretLeaseByRef(db, {
        leaseRef: "sidecar-main/mcp.github.pat",
      });
      assert.equal(activeLease, null);
    } finally {
      setSecretBrokerRequestInvokerForTests(null);
    }
  });
});

test("resolveMcpServerEnvSecrets requires stateDir only when secret refs are present", async () => {
  await withDb(async (db) => {
    upsertSecretProviderProfile(db, {
      id: "sidecar-main",
      kind: "sidecar_http",
      endpointRef: "unix:///run/nexus/secret-sidecar.sock",
      authMode: "unix_peer",
      strictMode: true,
      enabled: true,
      config: {},
    });

    await assert.rejects(
      () =>
        resolveMcpServerEnvSecrets({
          db,
          stateDir: "",
          serverId: "github-sidecar",
          env: {
            GITHUB_TOKEN: "{{secret:sidecar-main/mcp.github.pat#password}}",
          },
        }),
      /cannot resolve secret references without stateDir/,
    );

    const plainOnly = await resolveMcpServerEnvSecrets({
      db,
      stateDir: "",
      serverId: "github-sidecar",
      env: {
        LOG_LEVEL: "debug",
      },
    });
    assert.deepEqual(plainOnly, { LOG_LEVEL: "debug" });
  });
});
