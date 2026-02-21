import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { upsertCredential } from "./credentials.js";
import { startSecretSidecar } from "./sidecar.js";

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-secret-sidecar-test-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function requestViaUnixSocket(params: {
  socketPath: string;
  method: "GET" | "POST";
  path: string;
  body?: string;
  headers?: Record<string, string>;
}): Promise<{ statusCode: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: params.method,
        socketPath: params.socketPath,
        path: params.path,
        headers: params.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "",
          });
        });
      },
    );
    req.on("error", (err) => reject(err));
    if (params.body) req.write(params.body);
    req.end();
  });
}

test("sidecar strict mode requires bearer token for TCP endpoint", async () => {
  await withTempStateDir(async (stateDir) => {
    await assert.rejects(
      () =>
        startSecretSidecar({
          stateDir,
          bindHost: "127.0.0.1",
          port: 0,
          bearerToken: null,
          strictMode: true,
        }),
      /secret_sidecar_strict_mode_requires_bearer_token_for_tcp/,
    );
  });
});

test("sidecar resolves local credential over unix socket without bearer auth", async (t) => {
  await withEnv(
    {
      NEXUS_CREDENTIALS_KEY: "secret-sidecar-test-key",
      NEXUS_SECRETS_PROCESS_ROLE: "sidecar",
    },
    async () => {
      await withTempStateDir(async (stateDir) => {
        await upsertCredential({
          stateDir,
          id: "cred-sidecar-1",
          password: "pw-sidecar-1",
        });

        const socketPath = path.join(stateDir, "secret-sidecar.sock");
        let sidecar: Awaited<ReturnType<typeof startSecretSidecar>>;
        try {
          sidecar = await startSecretSidecar({
            stateDir,
            socketPath,
            strictMode: true,
          });
        } catch (err) {
          const code = (err as { code?: string } | null)?.code ?? "";
          if (code === "EPERM" || code === "EACCES") {
            t.skip("unix socket listen not permitted in sandbox runtime");
            return;
          }
          throw err;
        }
        try {
          const health = await requestViaUnixSocket({
            socketPath,
            method: "GET",
            path: "/health",
          });
          assert.equal(health.statusCode, 200);

          const resolveBody = JSON.stringify({
            providerKind: "sidecar_http",
            secretPath: "cred-sidecar-1",
            field: "password",
          });
          const resolved = await requestViaUnixSocket({
            socketPath,
            method: "POST",
            path: "/v1/secrets/resolve",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(resolveBody).toString(),
            },
            body: resolveBody,
          });
          assert.equal(resolved.statusCode, 200);
          const payload = JSON.parse(resolved.body) as { value?: string; secretClass?: string };
          assert.equal(payload.value, "pw-sidecar-1");
          assert.equal(payload.secretClass, "credential");
        } finally {
          await sidecar.stop();
        }
      });
    },
  );
});
