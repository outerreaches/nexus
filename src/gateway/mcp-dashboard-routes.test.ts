import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Hono } from "hono";
import type { McpManager } from "../mcp/manager.js";
import {
  createMcpGrant,
  createMcpProfile,
  createMcpServer,
  getMcpGrant,
  getMcpProfile,
  getMcpServer,
  listMcpGrants,
} from "../mcp/store.js";
import { openDatabase, type NexusDatabase } from "../storage/database.js";
import type { GatewayHttpDeps } from "./http.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";

async function withDb(fn: (db: NexusDatabase, dir: string) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-mcp-dashboard-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db, dir);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeDashboardApp(params: {
  db: NexusDatabase;
  stateDir: string;
  mcp: Partial<McpManager>;
  logSink?: string[];
}): Hono {
  const app = new Hono();
  const logs = params.logSink ?? [];
  const deps: GatewayHttpDeps = {
    port: 0,
    stateDir: params.stateDir,
    getStatus: () => ({ ok: true }),
    log: (line) => logs.push(line),
    db: params.db,
    mcp: params.mcp as McpManager,
  };
  registerDashboardRoutes(app, deps);
  return app;
}

function formRequest(url: string, body: Record<string, string>): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
}

test("disabling MCP server deactivates server and revokes matching active grants", async () => {
  await withDb(async (db, dir) => {
    const nowMs = Date.now();
    const srv1 = createMcpServer(db, {
      id: "srv-1",
      label: "Server 1",
      transport: "stdio",
      command: "node",
      args: ["./server1.js"],
      enabled: true,
      active: true,
    }, nowMs);
    const srv2 = createMcpServer(db, {
      id: "srv-2",
      label: "Server 2",
      transport: "stdio",
      command: "node",
      args: ["./server2.js"],
      enabled: true,
      active: true,
    }, nowMs);
    const p1 = createMcpProfile(db, {
      id: "profile-1",
      name: "profile-1",
      serverId: srv1.id,
      toolNames: ["mcp.srv_1.echo"],
      enabled: true,
      hidden: true,
      ephemeral: false,
    }, nowMs);
    const p2 = createMcpProfile(db, {
      id: "profile-2",
      name: "profile-2",
      serverId: srv2.id,
      toolNames: ["mcp.srv_2.echo"],
      enabled: true,
      hidden: true,
      ephemeral: false,
    }, nowMs);

    createMcpGrant(db, {
      id: "grant-1",
      profileId: p1.id,
      serverId: srv1.id,
      targetPreset: "researcher",
      toolNames: ["mcp.srv_1.echo"],
      expiresAt: nowMs + 60_000,
    }, nowMs);
    createMcpGrant(db, {
      id: "grant-2",
      profileId: p2.id,
      serverId: srv2.id,
      targetPreset: "analyst",
      toolNames: ["mcp.srv_2.echo"],
      expiresAt: nowMs + 60_000,
    }, nowMs);

    const deactivated: string[] = [];
    const app = makeDashboardApp({
      db,
      stateDir: dir,
      mcp: {
        getOverview: () => ({ servers: [], profiles: [] }),
        deactivateServer: async (id: string) => {
          deactivated.push(id);
          return getMcpServer(db, id)!;
        },
      },
    });

    const res = await app.request(
      formRequest("http://localhost/dashboard/mcp/server/enabled", {
        id: srv1.id,
        enabled: "false",
      }),
    );
    assert.equal(res.status, 302);
    assert.deepEqual(deactivated, [srv1.id]);

    const updatedServer = getMcpServer(db, srv1.id);
    assert.equal(updatedServer?.enabled, false);
    assert.equal(updatedServer?.active, false);

    const grant1 = getMcpGrant(db, "grant-1");
    const grant2 = getMcpGrant(db, "grant-2");
    assert.equal(grant1?.status, "revoked");
    assert.equal(grant1?.revokeReason, `server_disabled:${srv1.id}`);
    assert.equal(grant2?.status, "active");
  });
});

test("disabling MCP profile revokes only grants for that profile", async () => {
  await withDb(async (db, dir) => {
    const nowMs = Date.now();
    const server = createMcpServer(db, {
      id: "srv-profile",
      label: "Profile Server",
      transport: "stdio",
      command: "node",
      args: ["./server.js"],
      enabled: true,
      active: false,
    }, nowMs);
    const p1 = createMcpProfile(db, {
      id: "profile-a",
      name: "profile-a",
      serverId: server.id,
      toolNames: ["mcp.srv_profile.echo"],
      enabled: true,
      hidden: true,
      ephemeral: false,
    }, nowMs);
    const p2 = createMcpProfile(db, {
      id: "profile-b",
      name: "profile-b",
      serverId: server.id,
      toolNames: ["mcp.srv_profile.echo"],
      enabled: true,
      hidden: true,
      ephemeral: false,
    }, nowMs);
    createMcpGrant(db, {
      id: "grant-a",
      profileId: p1.id,
      serverId: server.id,
      targetPreset: "researcher",
      toolNames: ["mcp.srv_profile.echo"],
      expiresAt: nowMs + 60_000,
    }, nowMs);
    createMcpGrant(db, {
      id: "grant-b",
      profileId: p2.id,
      serverId: server.id,
      targetPreset: "researcher",
      toolNames: ["mcp.srv_profile.echo"],
      expiresAt: nowMs + 60_000,
    }, nowMs);

    const app = makeDashboardApp({
      db,
      stateDir: dir,
      mcp: {
        getOverview: () => ({ servers: [], profiles: [] }),
      },
    });

    const res = await app.request(
      formRequest("http://localhost/dashboard/mcp/profile/enabled", {
        id: p1.id,
        enabled: "false",
      }),
    );
    assert.equal(res.status, 302);

    const updatedProfile = getMcpProfile(db, p1.id);
    assert.equal(updatedProfile?.enabled, false);
    assert.equal(getMcpGrant(db, "grant-a")?.status, "revoked");
    assert.equal(getMcpGrant(db, "grant-a")?.revokeReason, `profile_disabled:${p1.id}`);
    assert.equal(getMcpGrant(db, "grant-b")?.status, "active");
  });
});

test("activating a disabled server returns 400", async () => {
  await withDb(async (db, dir) => {
    const nowMs = Date.now();
    const server = createMcpServer(db, {
      id: "srv-disabled",
      label: "Disabled",
      transport: "stdio",
      command: "node",
      args: ["./server.js"],
      enabled: false,
      active: false,
    }, nowMs);

    const app = makeDashboardApp({
      db,
      stateDir: dir,
      mcp: {
        getOverview: () => ({ servers: [], profiles: [] }),
      },
    });

    const res = await app.request(
      formRequest("http://localhost/dashboard/mcp/server/active", {
        id: server.id,
        active: "true",
      }),
    );
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Cannot activate a disabled server/);
  });
});

test("probe and grant revoke routes invoke expected behavior", async () => {
  await withDb(async (db, dir) => {
    const nowMs = Date.now();
    const server = createMcpServer(db, {
      id: "srv-probe",
      label: "Probe Server",
      transport: "stdio",
      command: "node",
      args: ["./server.js"],
      enabled: true,
      active: false,
    }, nowMs);
    const profile = createMcpProfile(db, {
      id: "profile-probe",
      name: "profile-probe",
      serverId: server.id,
      toolNames: ["mcp.srv_probe.echo"],
      enabled: true,
      hidden: true,
      ephemeral: false,
    }, nowMs);
    const grant = createMcpGrant(db, {
      id: "grant-probe",
      profileId: profile.id,
      serverId: server.id,
      targetPreset: "researcher",
      toolNames: ["mcp.srv_probe.echo"],
      expiresAt: nowMs + 60_000,
    }, nowMs);

    const probed: string[] = [];
    const app = makeDashboardApp({
      db,
      stateDir: dir,
      mcp: {
        getOverview: () => ({ servers: [], profiles: [] }),
        probeServer: async (id: string) => {
          probed.push(id);
          return { server: getMcpServer(db, id)!, tools: [] };
        },
      },
    });

    const probeRes = await app.request(
      formRequest("http://localhost/dashboard/mcp/server/probe", {
        id: server.id,
      }),
    );
    assert.equal(probeRes.status, 302);
    assert.deepEqual(probed, [server.id]);

    const revokeRes = await app.request(
      formRequest("http://localhost/dashboard/mcp/grants/revoke", {
        id: grant.id,
      }),
    );
    assert.equal(revokeRes.status, 302);
    assert.equal(getMcpGrant(db, grant.id)?.status, "revoked");

    const active = listMcpGrants(db, { includeExpired: false, includeRevoked: false });
    assert.equal(active.length, 0);
  });
});
