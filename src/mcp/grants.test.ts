import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Semaphore } from "../core/semaphore.js";
import { openDatabase, type NexusDatabase } from "../storage/database.js";
import { McpManager } from "./manager.js";
import {
  bindMcpGrantToRun,
  createMcpGrant,
  createMcpProfile,
  createMcpServer,
  getMcpGrant,
  listMcpGrants,
  revokeMcpGrant,
} from "./store.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-mcp-grants-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("listMcpGrants excludes revoked/expired by default", async () => {
  await withDb(async (db) => {
    const nowMs = Date.now();
    const server = createMcpServer(db, {
      id: "srv-main",
      label: "Main MCP",
      transport: "stdio",
      command: "node",
      args: ["./server.js"],
      enabled: true,
      active: false,
    }, nowMs);
    const profile = createMcpProfile(db, {
      id: "prof-main",
      name: "profile-main",
      serverId: server.id,
      toolNames: ["mcp.srv_main.echo"],
      enabled: true,
      hidden: true,
      ephemeral: false,
    }, nowMs);

    const active = createMcpGrant(db, {
      id: "grant-active",
      profileId: profile.id,
      serverId: server.id,
      targetPreset: "researcher",
      toolNames: ["mcp.srv_main.echo"],
      maxCalls: 10,
      expiresAt: nowMs + 60_000,
    }, nowMs);
    const expired = createMcpGrant(db, {
      id: "grant-expired",
      profileId: profile.id,
      serverId: server.id,
      targetPreset: "researcher",
      toolNames: ["mcp.srv_main.echo"],
      maxCalls: 10,
      expiresAt: nowMs - 120_000,
    }, nowMs);
    const revoked = createMcpGrant(db, {
      id: "grant-revoked",
      profileId: profile.id,
      serverId: server.id,
      targetPreset: "researcher",
      toolNames: ["mcp.srv_main.echo"],
      maxCalls: 10,
      expiresAt: nowMs + 60_000,
    }, nowMs);
    revokeMcpGrant(db, revoked.id, "test_revoke", nowMs + 1);

    const defaultList = listMcpGrants(db);
    assert.equal(defaultList.length, 1);
    assert.equal(defaultList[0]?.id, active.id);

    const all = listMcpGrants(db, { includeExpired: true, includeRevoked: true });
    assert.equal(all.length, 3);
    assert.deepEqual(new Set(all.map((row) => row.id)), new Set([active.id, expired.id, revoked.id]));
  });
});

test("bindMcpGrantToRun persists run linkage", async () => {
  await withDb(async (db) => {
    const nowMs = Date.now();
    const server = createMcpServer(db, {
      id: "srv-bind",
      label: "Bind MCP",
      transport: "stdio",
      command: "node",
      args: ["./server.js"],
      enabled: true,
      active: false,
    }, nowMs);
    const profile = createMcpProfile(db, {
      id: "prof-bind",
      name: "profile-bind",
      serverId: server.id,
      toolNames: ["mcp.srv_bind.echo"],
      enabled: true,
      hidden: true,
      ephemeral: false,
    }, nowMs);
    const grant = createMcpGrant(db, {
      id: "grant-bind",
      profileId: profile.id,
      serverId: server.id,
      targetPreset: "researcher",
      toolNames: ["mcp.srv_bind.echo"],
      maxCalls: null,
      expiresAt: nowMs + 60_000,
    }, nowMs);

    const bound = bindMcpGrantToRun(db, grant.id, { runId: "run-child-1", parentRunId: "run-parent-1" }, nowMs + 100);
    assert.ok(bound);
    assert.equal(bound?.runId, "run-child-1");
    assert.equal(bound?.parentRunId, "run-parent-1");
  });
});

test("McpManager executeToolWithGrant enforces run/preset and expires at maxCalls", async () => {
  await withDb(async (db) => {
    const nowMs = Date.now();
    const server = createMcpServer(db, {
      id: "srv-run",
      label: "Run MCP",
      transport: "stdio",
      command: "node",
      args: ["./server.js"],
      enabled: true,
      active: true,
    }, nowMs);
    const profile = createMcpProfile(db, {
      id: "prof-run",
      name: "profile-run",
      serverId: server.id,
      toolNames: ["mcp.srv_run.echo"],
      enabled: true,
      hidden: true,
      ephemeral: false,
    }, nowMs);
    const grant = createMcpGrant(db, {
      id: "grant-run",
      profileId: profile.id,
      serverId: server.id,
      targetPreset: "researcher",
      toolNames: ["mcp.srv_run.echo"],
      maxCalls: 1,
      runId: "run-allowed",
      expiresAt: nowMs + 60_000,
    }, nowMs);

    const manager = new McpManager({ db, log: () => undefined });
    const connected = (manager as any).connected as Map<string, unknown>;
    (manager as any).managedTools = [
      {
        localName: "mcp.srv_run.echo",
        serverId: server.id,
        remoteName: "echo",
        description: "echo tool",
        inputSchema: {},
      },
    ];
    connected.set(server.id, {
      server,
      client: {
        callTool: async (_name: string, _args: Record<string, unknown>) => ({
          content: [{ type: "text", text: "ok" }],
        }),
      },
      semaphore: new Semaphore(1),
      discoveredTools: [{ name: "echo", description: "echo", inputSchema: {} }],
      lastActivatedAt: nowMs,
    });

    const wrongPreset = await manager.executeToolWithGrant({
      grantId: grant.id,
      localToolName: "mcp.srv_run.echo",
      args: {},
      presetName: "analyst",
      runId: "run-allowed",
    });
    assert.match(wrongPreset, /does not allow preset/);

    const wrongRun = await manager.executeToolWithGrant({
      grantId: grant.id,
      localToolName: "mcp.srv_run.echo",
      args: {},
      presetName: "researcher",
      runId: "run-other",
    });
    assert.match(wrongRun, /bound to another run/);

    const ok = await manager.executeToolWithGrant({
      grantId: grant.id,
      localToolName: "mcp.srv_run.echo",
      args: { message: "hello" },
      presetName: "researcher",
      runId: "run-allowed",
    });
    assert.equal(ok, "ok");

    const updated = getMcpGrant(db, grant.id);
    assert.equal(updated?.callCount, 1);
    assert.equal(updated?.status, "expired");

    const secondCall = await manager.executeToolWithGrant({
      grantId: grant.id,
      localToolName: "mcp.srv_run.echo",
      args: {},
      presetName: "researcher",
      runId: "run-allowed",
    });
    assert.match(secondCall, /is expired/);
  });
});

test("McpManager listToolsForGrants returns tools only for matching preset and run", async () => {
  await withDb(async (db) => {
    const nowMs = Date.now();
    const server = createMcpServer(db, {
      id: "srv-list",
      label: "List MCP",
      transport: "stdio",
      command: "node",
      args: ["./server.js"],
      enabled: true,
      active: true,
    }, nowMs);
    const profile = createMcpProfile(db, {
      id: "prof-list",
      name: "profile-list",
      serverId: server.id,
      toolNames: ["mcp.srv_list.echo"],
      enabled: true,
      hidden: true,
      ephemeral: false,
    }, nowMs);
    const grant = createMcpGrant(db, {
      id: "grant-list",
      profileId: profile.id,
      serverId: server.id,
      targetPreset: "researcher",
      toolNames: ["mcp.srv_list.echo"],
      maxCalls: 5,
      runId: "run-list",
      expiresAt: nowMs + 60_000,
    }, nowMs);

    const manager = new McpManager({ db, log: () => undefined });
    (manager as any).managedTools = [
      {
        localName: "mcp.srv_list.echo",
        serverId: server.id,
        remoteName: "echo",
        description: "echo tool",
        inputSchema: {},
      },
    ];

    const wrongPreset = manager.listToolsForGrants({
      grantIds: [grant.id],
      presetName: "analyst",
      runId: "run-list",
    });
    assert.equal(wrongPreset.length, 0);

    const wrongRun = manager.listToolsForGrants({
      grantIds: [grant.id],
      presetName: "researcher",
      runId: "run-other",
    });
    assert.equal(wrongRun.length, 0);

    const ok = manager.listToolsForGrants({
      grantIds: [grant.id],
      presetName: "researcher",
      runId: "run-list",
    });
    assert.equal(ok.length, 1);
    assert.equal(ok[0]?.name, "mcp.srv_list.echo");
  });
});
