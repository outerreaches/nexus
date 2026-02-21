import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SecretProviderProfileRecord } from "../storage/secrets.js";
import { resolveSecretThroughBroker, setSecretBrokerRequestInvokerForTests, validateSecretBrokerProfile } from "./broker.js";

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

async function withTempStateDir(fn: (stateDir: string) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-secret-broker-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeProfile(overrides: Partial<SecretProviderProfileRecord> = {}): SecretProviderProfileRecord {
  return {
    id: "provider-1",
    kind: "sidecar_http",
    endpointRef: "http://127.0.0.1:0",
    authMode: "workload_identity",
    strictMode: true,
    config: {},
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

test("secret broker blocks local_file provider", async () => {
  await withTempStateDir(async (stateDir) => {
    await assert.rejects(
      () =>
        resolveSecretThroughBroker({
          profile: makeProfile({
            id: "local-main",
            kind: "local_file",
            endpointRef: null,
            authMode: "none",
          }),
          stateDir,
          secretPath: "cred-1",
          field: "password",
          strictMode: true,
        }),
      /secret_provider_local_file_disabled:sidecar_required/,
    );
  });
});

test("secret broker strict mode blocks non-private sidecar endpoint", async () => {
  await withTempStateDir(async (stateDir) => {
    await assert.rejects(
      () =>
        resolveSecretThroughBroker({
          profile: makeProfile({
            endpointRef: "https://example.com/v1/secrets/resolve",
            authMode: "mtls",
          }),
          stateDir,
          secretPath: "wallet/hot",
          field: "password",
          strictMode: true,
        }),
      /secret_broker_non_private_endpoint_blocked/,
    );
  });
});

test("secret broker strict mode blocks static credential material in provider config", async () => {
  await withTempStateDir(async (stateDir) => {
    await assert.rejects(
      () =>
        resolveSecretThroughBroker({
          profile: makeProfile({
            endpointRef: "http://127.0.0.1:7777",
            authMode: "workload_identity",
            config: {
              apiKey: "dont-store-this",
            },
          }),
          stateDir,
          secretPath: "wallet/hot",
          field: "password",
          strictMode: true,
        }),
      /secret_provider_static_auth_material_in_config_blocked/,
    );
  });
});

test("secret broker sidecar_http resolves via workload identity header", async () => {
  await withTempStateDir(async (stateDir) => {
    setSecretBrokerRequestInvokerForTests(async (request) => {
      assert.equal(request.headers.authorization, "Bearer broker-token");
      const payload = JSON.parse(request.bodyJson) as { secretPath?: string };
      assert.equal(payload.secretPath, "wallet/hot");
      return {
        statusCode: 200,
        bodyText: JSON.stringify({
          value: "resolved-secret",
          secretClass: "wallet",
          leaseId: "remote-lease-1",
          expiresAt: Date.now() + 60_000,
        }),
      };
    });

    try {
      await withEnv(
        {
          NEXUS_SECRET_BROKER_BEARER_TOKEN: "broker-token",
        },
        async () => {
          const resolved = await resolveSecretThroughBroker({
            profile: makeProfile({
              endpointRef: "https://127.0.0.1:7777/sidecar/resolve",
              authMode: "workload_identity",
              config: {
                resolvePath: "/sidecar/resolve",
              },
            }),
            stateDir,
            secretPath: "wallet/hot",
            field: "password",
            strictMode: true,
          });
          assert.equal(resolved.value, "resolved-secret");
          assert.equal(resolved.secretClass, "wallet");
          assert.equal(resolved.leaseId, "remote-lease-1");
        },
      );
    } finally {
      setSecretBrokerRequestInvokerForTests(null);
    }
  });
});

test("secret broker strict mode requires https for workload identity", async () => {
  await withTempStateDir(async (stateDir) => {
    await withEnv(
      {
        NEXUS_SECRET_BROKER_BEARER_TOKEN: "broker-token",
      },
      async () => {
        await assert.rejects(
          () =>
            resolveSecretThroughBroker({
              profile: makeProfile({
                endpointRef: "http://127.0.0.1:7777/sidecar/resolve",
                authMode: "workload_identity",
              }),
              stateDir,
              secretPath: "wallet/hot",
              field: "password",
              strictMode: true,
            }),
          /secret_provider_auth_mode_workload_identity_requires_https_in_strict_mode/,
        );
      },
    );
  });
});

test("secret broker profile validation blocks local provider", async () => {
  await assert.rejects(
    () =>
      validateSecretBrokerProfile({
        profile: makeProfile({
          id: "local-main",
          kind: "local_file",
          endpointRef: null,
          authMode: "none",
        }),
        strictMode: true,
      }),
    /secret_provider_local_file_disabled:sidecar_required/,
  );
});

test("secret broker mtls mode forwards client certificate material", async () => {
  await withTempStateDir(async (stateDir) => {
    const certPath = path.join(stateDir, "broker-client.crt");
    const keyPath = path.join(stateDir, "broker-client.key");
    const caPath = path.join(stateDir, "broker-ca.crt");
    await fs.writeFile(certPath, "test-cert");
    await fs.writeFile(keyPath, "test-key");
    await fs.writeFile(caPath, "test-ca");

    setSecretBrokerRequestInvokerForTests(async (request) => {
      assert.ok(request.tlsClientMaterial);
      assert.equal(request.tlsClientMaterial?.cert.toString("utf8"), "test-cert");
      assert.equal(request.tlsClientMaterial?.key.toString("utf8"), "test-key");
      assert.equal(request.tlsClientMaterial?.ca?.toString("utf8"), "test-ca");
      return {
        statusCode: 200,
        bodyText: JSON.stringify({
          value: "resolved-secret",
        }),
      };
    });

    try {
      await withEnv(
        {
          NEXUS_SECRET_BROKER_CLIENT_CERT_FILE: certPath,
          NEXUS_SECRET_BROKER_CLIENT_KEY_FILE: keyPath,
          NEXUS_SECRET_BROKER_CA_FILE: caPath,
        },
        async () => {
          const resolved = await resolveSecretThroughBroker({
            profile: makeProfile({
              endpointRef: "https://127.0.0.1:7777/sidecar/resolve",
              authMode: "mtls",
            }),
            stateDir,
            secretPath: "wallet/hot",
            field: "password",
            strictMode: true,
          });
          assert.equal(resolved.value, "resolved-secret");
        },
      );
    } finally {
      setSecretBrokerRequestInvokerForTests(null);
    }
  });
});
