import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getCredentialField, getCredentialStorePath, upsertCredential } from "./credentials.js";

async function withTempStateDir(fn: (stateDir: string) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-credentials-test-"));
  try {
    await fn(dir);
  } finally {
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

test("credential writes fail closed in strict mode without vault key", async () => {
  await withEnv(
    {
      NEXUS_SECRETS_PROCESS_ROLE: "sidecar",
      NEXUS_CREDENTIALS_KEY: undefined,
    },
    async () => {
      await withTempStateDir(async (stateDir) => {
        await assert.rejects(
          () =>
            upsertCredential({
              stateDir,
              id: "cred-1",
              password: "top-secret",
            }),
          /Credential writes require NEXUS_CREDENTIALS_KEY to be set/,
        );
      });
    },
  );
});

test("credential plaintext entries are rejected on read", async () => {
  await withEnv(
    {
      NEXUS_SECRETS_PROCESS_ROLE: "sidecar",
      NEXUS_CREDENTIALS_KEY: undefined,
    },
    async () => {
      await withTempStateDir(async (stateDir) => {
        const storePath = getCredentialStorePath(stateDir);
        const payload = {
          version: 1,
          updatedAt: Date.now(),
          credentials: [
            {
              id: "cred-plain",
              password: { format: "plain", value: "plain-secret" },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          ],
        };
        await fs.mkdir(path.dirname(storePath), { recursive: true });
        await fs.writeFile(storePath, JSON.stringify(payload, null, 2));
        await assert.rejects(
          () =>
            getCredentialField({
              stateDir,
              id: "cred-plain",
              field: "password",
            }),
          /Plaintext credentials are blocked/,
        );
      });
    },
  );
});

test("credential store parse errors fail closed", async () => {
  await withEnv(
    {
      NEXUS_SECRETS_PROCESS_ROLE: "sidecar",
      NEXUS_CREDENTIALS_KEY: "parse-fail-key",
    },
    async () => {
      await withTempStateDir(async (stateDir) => {
        const storePath = getCredentialStorePath(stateDir);
        await fs.mkdir(path.dirname(storePath), { recursive: true });
        await fs.writeFile(storePath, "{not-json", "utf8");
        await assert.rejects(
          () =>
            upsertCredential({
              stateDir,
              id: "cred-parse-fail",
              password: "secret",
            }),
          /credential_store_parse_failed/,
        );
      });
    },
  );
});

test("credential writes are encrypted when vault key is configured", async () => {
  await withEnv(
    {
      NEXUS_SECRETS_PROCESS_ROLE: "sidecar",
      NEXUS_CREDENTIALS_KEY: "super-secret-master-key",
    },
    async () => {
      await withTempStateDir(async (stateDir) => {
        const res = await upsertCredential({
          stateDir,
          id: "cred-encrypted",
          password: "enc-secret",
        });
        assert.equal(res.passwordEncrypted, true);

        const password = await getCredentialField({
          stateDir,
          id: "cred-encrypted",
          field: "password",
        });
        assert.equal(password, "enc-secret");
      });
    },
  );
});

test("direct credential access is blocked outside sidecar role", async () => {
  await withEnv(
    {
      NEXUS_CREDENTIALS_KEY: "sidecar-only-key",
      NEXUS_SECRETS_PROCESS_ROLE: "gateway",
    },
    async () => {
      await withTempStateDir(async (stateDir) => {
        await assert.rejects(
          () =>
            upsertCredential({
              stateDir,
              id: "cred-sidecar-only",
              password: "secret",
            }),
          /secret_sidecar_only_direct_credential_access_blocked:upsert/,
        );
      });
    },
  );
});

test("direct credential access is allowed for sidecar role", async () => {
  await withEnv(
    {
      NEXUS_CREDENTIALS_KEY: "sidecar-only-key",
      NEXUS_SECRETS_PROCESS_ROLE: "sidecar",
    },
    async () => {
      await withTempStateDir(async (stateDir) => {
        await upsertCredential({
          stateDir,
          id: "cred-sidecar-ok",
          password: "secret",
        });
        const value = await getCredentialField({
          stateDir,
          id: "cred-sidecar-ok",
          field: "password",
        });
        assert.equal(value, "secret");
      });
    },
  );
});

test("monetization-local credential ids are blocked outside monetization profile", async () => {
  await withEnv(
    {
      NEXUS_SECRETS_PROCESS_ROLE: "sidecar",
      NEXUS_CREDENTIALS_KEY: "wallet-key",
      NEXUS_RUNTIME_PROFILE: "primary",
    },
    async () => {
      await withTempStateDir(async (stateDir) => {
        await assert.rejects(
          () =>
            upsertCredential({
              stateDir,
              id: "wallet.hot",
              password: "secret",
            }),
          /credential_locality_violation/,
        );
      });
    },
  );
});

test("monetization-local credential ids are allowed in monetization profile", async () => {
  await withEnv(
    {
      NEXUS_SECRETS_PROCESS_ROLE: "sidecar",
      NEXUS_CREDENTIALS_KEY: "wallet-key",
      NEXUS_RUNTIME_PROFILE: "monetization",
    },
    async () => {
      await withTempStateDir(async (stateDir) => {
        await upsertCredential({
          stateDir,
          id: "wallet.hot",
          password: "secret",
        });
        const value = await getCredentialField({
          stateDir,
          id: "wallet.hot",
          field: "password",
        });
        assert.equal(value, "secret");
      });
    },
  );
});

test("credentials store path honors NEXUS_CREDENTIALS_STORE_DIR override", async () => {
  await withEnv(
    {
      NEXUS_CREDENTIALS_STORE_DIR: "/tmp/nexus-secrets",
      NEXUS_CREDENTIALS_STORE_PATH: undefined,
    },
    async () => {
      const p = getCredentialStorePath("/data/nexus");
      assert.equal(p, "/tmp/nexus-secrets/credentials.json");
    },
  );
});

test("credentials store path disallows explicit file override", async () => {
  await withEnv(
    {
      NEXUS_CREDENTIALS_STORE_PATH: "/tmp/credentials.json",
      NEXUS_CREDENTIALS_STORE_DIR: undefined,
    },
    async () => {
      assert.throws(
        () => getCredentialStorePath("/data/nexus"),
        /NEXUS_CREDENTIALS_STORE_PATH is not supported/,
      );
    },
  );
});
