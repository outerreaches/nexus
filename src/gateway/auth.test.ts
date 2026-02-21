import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase, type NexusDatabase } from "../storage/database.js";
import { startHttpServer, type GatewayHttpDeps } from "./http.js";

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
    if (result && typeof (result as PromiseLike<void>).then === "function") {
      return Promise.resolve(result).finally(restore);
    }
    restore();
    return;
  } catch (err) {
    restore();
    throw err;
  }
}

async function withGatewayApp(
  fn: (params: {
    app: Awaited<ReturnType<typeof startHttpServer>>["app"];
    db: NexusDatabase;
  }) => Promise<void> | void,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-auth-test-"));
  const db = await openDatabase(path.join(dir, "nexus.db"));
  let globalDisable = false;
  const deps: GatewayHttpDeps = {
    port: 0,
    stateDir: dir,
    db,
    getStatus: () => ({
      mode: "active",
      runtime: { profile: "primary" },
      federation: {
        enabled: true,
        derivedState: "active_federated",
        trustedPeerCount: 0,
        healthyTrustedPeerCount: 0,
        identityValid: true,
        firewallActive: true,
      },
      proactive: { enabled: false, paused: false },
      llm: { modelMode: "default", localProvider: "local", localModel: "test-model" },
      activeLease: {
        key: "gateway_active",
        holderId: "test-holder",
        held: true,
        expiresAt: Date.now() + 45_000,
        ttlMs: 45_000,
        renewMs: 15_000,
      },
    }),
    log: () => {},
    getFederationBreakglassState: () => ({ globalDisable }),
    setFederationGlobalDisable: (disabled: boolean) => {
      globalDisable = disabled;
      return { globalDisable };
    },
    setModelMode: (mode) => mode,
  };
  const http = await startHttpServer(deps);
  try {
    await fn({ app: http.app, db });
  } finally {
    await http.stop();
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function extractSessionCookie(res: Response, cookieName: string): string | null {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const match = raw.match(new RegExp(`${cookieName}=([^;]+)`));
  if (!match) return null;
  return `${cookieName}=${match[1]}`;
}

function extractCsrfToken(html: string): string | null {
  const match = html.match(/name="csrfToken" value="([^"]+)"/);
  return match?.[1] ?? null;
}

test("gateway HTTP auth enforces API key, dashboard session login, and CSRF", async () => {
  await withEnv(
    {
      NEXUS_HTTP_API_KEY: "api-test-key",
      NEXUS_DASHBOARD_USERNAME: "admin",
      NEXUS_DASHBOARD_PASSWORD: "dashboard-test-pass",
      NEXUS_HTTP_AUTH_COOKIE_NAME: "nexus_dashboard_session",
      NEXUS_HTTP_AUTH_COOKIE_SECURE: "0",
    },
    async () => {
      await withGatewayApp(async ({ app }) => {
        const apiWithoutAuth = await app.request("http://localhost/api/federation/status");
        assert.equal(apiWithoutAuth.status, 401);

        const apiWithKey = await app.request("http://localhost/api/federation/status", {
          headers: { authorization: "Bearer api-test-key" },
        });
        assert.equal(apiWithKey.status, 200);

        const inboxBypass = await app.request("http://localhost/api/federation/inbox", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        assert.notEqual(inboxBypass.status, 401);

        const dashboardUnauthed = await app.request("http://localhost/dashboard");
        assert.equal(dashboardUnauthed.status, 302);
        assert.match(dashboardUnauthed.headers.get("location") ?? "", /^\/login\?/);

        const badLogin = await app.request("http://localhost/auth/login", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            username: "admin",
            password: "wrong",
            next: "/dashboard",
          }),
        });
        assert.equal(badLogin.status, 401);

        const login = await app.request("http://localhost/auth/login", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            username: "admin",
            password: "dashboard-test-pass",
            next: "/dashboard",
          }),
        });
        assert.equal(login.status, 303);
        const sessionCookie = extractSessionCookie(login, "nexus_dashboard_session");
        assert.ok(sessionCookie);

        const dashboardAuthed = await app.request("http://localhost/dashboard", {
          headers: { cookie: sessionCookie! },
        });
        assert.equal(dashboardAuthed.status, 200);
        const dashboardHtml = await dashboardAuthed.text();
        const csrfToken = extractCsrfToken(dashboardHtml);
        assert.ok(csrfToken);

        const dashboardNoCsrf = await app.request("http://localhost/dashboard/llm/mode", {
          method: "POST",
          headers: {
            cookie: sessionCookie!,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ mode: "default" }),
        });
        assert.equal(dashboardNoCsrf.status, 403);

        const dashboardWithCsrf = await app.request("http://localhost/dashboard/llm/mode", {
          method: "POST",
          headers: {
            cookie: sessionCookie!,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ mode: "default", csrfToken: csrfToken! }),
        });
        assert.equal(dashboardWithCsrf.status, 302);

        const apiSessionNoCsrf = await app.request("http://localhost/api/federation/breakglass/global", {
          method: "POST",
          headers: {
            cookie: sessionCookie!,
            "content-type": "application/json",
          },
          body: JSON.stringify({ disabled: true }),
        });
        assert.equal(apiSessionNoCsrf.status, 403);

        const apiSessionWithCsrf = await app.request("http://localhost/api/federation/breakglass/global", {
          method: "POST",
          headers: {
            cookie: sessionCookie!,
            "content-type": "application/json",
            "x-csrf-token": csrfToken!,
          },
          body: JSON.stringify({ disabled: true }),
        });
        assert.equal(apiSessionWithCsrf.status, 200);

        const apiKeyBypassCsrf = await app.request("http://localhost/api/federation/breakglass/global", {
          method: "POST",
          headers: {
            authorization: "Bearer api-test-key",
            "content-type": "application/json",
          },
          body: JSON.stringify({ disabled: false }),
        });
        assert.equal(apiKeyBypassCsrf.status, 200);

        const logoutNoCsrf = await app.request("http://localhost/auth/logout", {
          method: "POST",
          headers: {
            cookie: sessionCookie!,
          },
        });
        assert.equal(logoutNoCsrf.status, 403);

        const logoutWithCsrf = await app.request("http://localhost/auth/logout", {
          method: "POST",
          headers: {
            cookie: sessionCookie!,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ csrfToken: csrfToken! }),
        });
        assert.equal(logoutWithCsrf.status, 303);
      });
    },
  );
});
