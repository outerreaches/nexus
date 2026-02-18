import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getCredentialField, upsertCredential } from "./credentials.js";

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
      NEXUS_SECRETS_STRICT: "1",
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
          /Plaintext credential writes are blocked in strict mode/,
        );
      });
    },
  );
});

test("credential plaintext writes are allowed when strict mode is disabled", async () => {
  await withEnv(
    {
      NEXUS_SECRETS_STRICT: "0",
      NEXUS_CREDENTIALS_KEY: undefined,
    },
    async () => {
      await withTempStateDir(async (stateDir) => {
        await upsertCredential({
          stateDir,
          id: "cred-plain",
          password: "plain-secret",
        });
        const password = await getCredentialField({
          stateDir,
          id: "cred-plain",
          field: "password",
        });
        assert.equal(password, "plain-secret");
      });
    },
  );
});

test("credential writes are encrypted when vault key is configured", async () => {
  await withEnv(
    {
      NEXUS_SECRETS_STRICT: "1",
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

test("monetization-local credential ids are blocked outside monetization profile", async () => {
  await withEnv(
    {
      NEXUS_SECRETS_STRICT: "1",
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
      NEXUS_SECRETS_STRICT: "1",
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
