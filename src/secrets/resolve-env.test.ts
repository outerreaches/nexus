import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase } from "../storage/database.js";
import { upsertSecretProviderProfile } from "../storage/secrets.js";
import { setSecretBrokerRequestInvokerForTests } from "./broker.js";
import {
    resolveEnvSecrets,
    getSecret,
    requireSecret,
    listResolvedSecretKeys,
    clearResolvedSecretsForTests,
} from "./resolve-env.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-resolve-env-test-"));
    try {
        await fn(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

test("resolveEnvSecrets stores plain values in registry", async () => {
    await withTempDir(async (dir) => {
        clearResolvedSecretsForTests();
        const db = await openDatabase(path.join(dir, "test.db"));
        try {
            const result = await resolveEnvSecrets({
                db,
                stateDir: dir,
                env: {
                    MY_PLAIN_KEY: "hello-plain",
                    ANOTHER_KEY: "world",
                },
                log: () => { },
            });

            assert.equal(result.resolved, 2);
            assert.equal(result.plain, 2);
            assert.equal(result.fromProvider, 0);
            assert.equal(getSecret("MY_PLAIN_KEY"), "hello-plain");
            assert.equal(getSecret("ANOTHER_KEY"), "world");
        } finally {
            db.close();
            clearResolvedSecretsForTests();
        }
    });
});

test("getSecret returns undefined for unregistered keys", () => {
    clearResolvedSecretsForTests();
    assert.equal(getSecret("NEVER_REGISTERED"), undefined);
});

test("requireSecret throws for missing keys", () => {
    clearResolvedSecretsForTests();
    assert.throws(
        () => requireSecret("DOES_NOT_EXIST"),
        /required_env_secret_missing:DOES_NOT_EXIST/,
    );
});

test("listResolvedSecretKeys returns sorted keys", async () => {
    await withTempDir(async (dir) => {
        clearResolvedSecretsForTests();
        const db = await openDatabase(path.join(dir, "test.db"));
        try {
            await resolveEnvSecrets({
                db,
                stateDir: dir,
                env: { ZZZ_KEY: "z", AAA_KEY: "a", MMM_KEY: "m" },
                log: () => { },
            });

            const keys = listResolvedSecretKeys();
            assert.deepEqual(keys, ["AAA_KEY", "MMM_KEY", "ZZZ_KEY"]);
        } finally {
            db.close();
            clearResolvedSecretsForTests();
        }
    });
});

test("resolveEnvSecrets resolves secret references via provider", async () => {
    await withTempDir(async (dir) => {
        clearResolvedSecretsForTests();
        const db = await openDatabase(path.join(dir, "test.db"));
        try {
            upsertSecretProviderProfile(db, {
                id: "sidecar-main",
                kind: "sidecar_http",
                endpointRef: "unix:///run/nexus/secret-sidecar.sock",
                authMode: "unix_peer",
                strictMode: true,
                config: {},
                enabled: true,
                nowMs: Date.now(),
            });

            const seenBodies: Array<{ secretPath?: string; field?: string }> = [];
            setSecretBrokerRequestInvokerForTests(async (params) => {
                const parsed = JSON.parse(params.bodyJson) as { secretPath?: string; field?: string };
                seenBodies.push(parsed);
                return {
                    statusCode: 200,
                    bodyText: JSON.stringify({
                        value: `resolved-${parsed.secretPath}-${parsed.field ?? "default"}`,
                        secretClass: "credential",
                    }),
                };
            });

            const result = await resolveEnvSecrets({
                db,
                stateDir: dir,
                env: {
                    BRAVE_API_KEY: "{{secret:sidecar-main/brave-key#password}}",
                    PLAIN_VALUE: "not-a-secret-ref",
                },
                log: () => { },
            });

            assert.equal(result.resolved, 2);
            assert.equal(result.fromProvider, 1);
            assert.equal(result.plain, 1);
            assert.equal(getSecret("BRAVE_API_KEY"), "resolved-brave-key-password");
            assert.equal(getSecret("PLAIN_VALUE"), "not-a-secret-ref");
            assert.equal(seenBodies.length, 1);
            assert.equal(seenBodies[0]?.secretPath, "brave-key");
        } finally {
            setSecretBrokerRequestInvokerForTests(null);
            db.close();
            clearResolvedSecretsForTests();
        }
    });
});

test("resolveEnvSecrets fails closed on resolution error", async () => {
    await withTempDir(async (dir) => {
        clearResolvedSecretsForTests();
        const db = await openDatabase(path.join(dir, "test.db"));
        try {
            upsertSecretProviderProfile(db, {
                id: "sidecar-main",
                kind: "sidecar_http",
                endpointRef: "unix:///run/nexus/secret-sidecar.sock",
                authMode: "unix_peer",
                strictMode: true,
                config: {},
                enabled: true,
                nowMs: Date.now(),
            });

            setSecretBrokerRequestInvokerForTests(async () => {
                return {
                    statusCode: 500,
                    bodyText: "internal error",
                };
            });

            await assert.rejects(
                () =>
                    resolveEnvSecrets({
                        db,
                        stateDir: dir,
                        env: {
                            BAD_KEY: "{{secret:sidecar-main/fail-path#password}}",
                        },
                        log: () => { },
                    }),
                /env_secret_resolution_failed:BAD_KEY/,
            );
        } finally {
            setSecretBrokerRequestInvokerForTests(null);
            db.close();
            clearResolvedSecretsForTests();
        }
    });
});

test("resolveEnvSecrets with empty env returns zero counts", async () => {
    await withTempDir(async (dir) => {
        clearResolvedSecretsForTests();
        const db = await openDatabase(path.join(dir, "test.db"));
        try {
            const result = await resolveEnvSecrets({
                db,
                stateDir: dir,
                env: {},
                log: () => { },
            });

            assert.equal(result.resolved, 0);
            assert.equal(result.fromProvider, 0);
            assert.equal(result.plain, 0);
            assert.deepEqual(result.keys, []);
        } finally {
            db.close();
            clearResolvedSecretsForTests();
        }
    });
});
