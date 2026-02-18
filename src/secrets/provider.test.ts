import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase, type NexusDatabase } from "../storage/database.js";
import { listSecretAccessEvents, upsertSecretProviderProfile } from "../storage/secrets.js";
import { setSecretBrokerRequestInvokerForTests } from "./broker.js";
import { upsertCredential } from "./credentials.js";
import { isSecretLeaseActive, parseSecretReference, resolveSecretReference, revokeSecretLease } from "./provider.js";

async function withStateAndDb(
  fn: (params: { stateDir: string; db: NexusDatabase }) => Promise<void> | void,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-secret-provider-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn({ stateDir: dir, db });
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

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

test("parseSecretReference parses provider/path and optional field", () => {
  const parsed = parseSecretReference("{{secret:local-main/cred-1#username}}");
  assert.deepEqual(parsed, {
    providerId: "local-main",
    secretPath: "cred-1",
    field: "username",
  });
});

test("strict mode rejects missing provider profiles", async () => {
  await withEnv(
    {
      NEXUS_SECRETS_STRICT: "1",
      NEXUS_CREDENTIALS_KEY: "master-key",
    },
    async () => {
      await withStateAndDb(async ({ stateDir, db }) => {
        await upsertCredential({
          stateDir,
          id: "cred-1",
          password: "pw-1",
        });
        await assert.rejects(
          () =>
            resolveSecretReference({
              db,
              stateDir,
              reference: "{{secret:missing/cred-1#password}}",
            }),
          /secret_provider_missing_or_disabled/,
        );
        const access = listSecretAccessEvents(db, { limit: 10 });
        assert.equal(access.length, 1);
        assert.equal(access[0]?.decision, "deny");
      });
    },
  );
});

test("local_file provider resolves credential and emits lease/audit records", async () => {
  await withEnv(
    {
      NEXUS_SECRETS_STRICT: "1",
      NEXUS_CREDENTIALS_KEY: "master-key",
    },
    async () => {
      await withStateAndDb(async ({ stateDir, db }) => {
        upsertSecretProviderProfile(db, {
          id: "local-main",
          kind: "local_file",
          strictMode: true,
          enabled: true,
          config: {
            leaseTtlMs: 5_000,
          },
        });
        await upsertCredential({
          stateDir,
          id: "cred-1",
          password: "pw-1",
        });

        const resolved = await resolveSecretReference({
          db,
          stateDir,
          reference: "{{secret:local-main/cred-1#password}}",
          traceId: "trace-1",
          actor: "node:test",
        });
        assert.equal(resolved.value, "pw-1");
        assert.ok(resolved.leaseId);
        assert.ok(resolved.expiresAt);

        const access = listSecretAccessEvents(db, { traceId: "trace-1", limit: 10 });
        assert.equal(access.length, 1);
        assert.equal(access[0]?.decision, "allow");
        assert.equal(access[0]?.leaseId, resolved.leaseId);
      });
    },
  );
});

test("secret lease can be revoked and no longer active", async () => {
  await withEnv(
    {
      NEXUS_SECRETS_STRICT: "1",
      NEXUS_CREDENTIALS_KEY: "master-key",
    },
    async () => {
      await withStateAndDb(async ({ stateDir, db }) => {
        upsertSecretProviderProfile(db, {
          id: "local-main",
          kind: "local_file",
          strictMode: true,
          enabled: true,
          config: {
            leaseTtlMs: 5_000,
          },
        });
        await upsertCredential({
          stateDir,
          id: "cred-1",
          password: "pw-1",
        });

        const resolved = await resolveSecretReference({
          db,
          stateDir,
          reference: "{{secret:local-main/cred-1#password}}",
        });
        assert.ok(resolved.leaseId);
        assert.equal(isSecretLeaseActive({ db, leaseId: resolved.leaseId! }), true);
        assert.equal(revokeSecretLease({ db, leaseId: resolved.leaseId! }), true);
        assert.equal(isSecretLeaseActive({ db, leaseId: resolved.leaseId! }), false);
      });
    },
  );
});

test("strict mode rejects unhardened sidecar auth modes", async () => {
  await withEnv(
    {
      NEXUS_SECRETS_STRICT: "1",
      NEXUS_CREDENTIALS_KEY: "master-key",
    },
    async () => {
      await withStateAndDb(async ({ stateDir, db }) => {
        upsertSecretProviderProfile(db, {
          id: "sidecar-1",
          kind: "sidecar_http",
          endpointRef: "http://127.0.0.1:7777",
          authMode: "none",
          strictMode: true,
          enabled: true,
        });
        await assert.rejects(
          () =>
            resolveSecretReference({
              db,
              stateDir,
              reference: "{{secret:sidecar-1/cred.sidecar#password}}",
            }),
          /secret_provider_auth_mode_not_hardened/,
        );
      });
    },
  );
});

test("sidecar provider resolves secret and emits auditable allow decision", async () => {
  await withEnv(
    {
      NEXUS_SECRETS_STRICT: "1",
      NEXUS_SECRET_BROKER_BEARER_TOKEN: "sidecar-token",
    },
    async () => {
      await withStateAndDb(async ({ stateDir, db }) => {
        setSecretBrokerRequestInvokerForTests(async (request) => {
          assert.equal(request.headers.authorization, "Bearer sidecar-token");
          return {
            statusCode: 200,
            bodyText: JSON.stringify({
              value: "wallet-secret",
              secretClass: "wallet",
              leaseId: "remote-sidecar-lease",
            }),
          };
        });
        try {
          upsertSecretProviderProfile(db, {
            id: "sidecar-2",
            kind: "sidecar_http",
            endpointRef: "https://127.0.0.1:7777/resolve",
            authMode: "workload_identity",
            strictMode: true,
            enabled: true,
            config: {
              resolvePath: "/resolve",
            },
          });

          const resolved = await resolveSecretReference({
            db,
            stateDir,
            reference: "{{secret:sidecar-2/cred.sidecar#password}}",
            traceId: "trace-sidecar-1",
            actor: "node:test",
          });
          assert.equal(resolved.value, "wallet-secret");
          assert.equal(resolved.secretClass, "wallet");
          assert.ok(resolved.leaseId);

          const access = listSecretAccessEvents(db, { traceId: "trace-sidecar-1", limit: 10 });
          assert.equal(access.length, 1);
          assert.equal(access[0]?.decision, "allow");
          assert.equal(access[0]?.reason, "resolved_sidecar:sidecar_http");
        } finally {
          setSecretBrokerRequestInvokerForTests(null);
        }
      });
    },
  );
});
