import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ToolContext } from "../core/tools.js";
import { ProcessManager } from "../process/manager.js";
import { openDatabase, type NexusDatabase } from "../storage/database.js";
import { upsertNode } from "../storage/nodes.js";
import { processManage } from "./process.js";

async function withProcessEnv(
  fn: (params: {
    db: NexusDatabase;
    stateDir: string;
    workspaceDir: string;
    codeDir: string;
    processManager: ProcessManager;
    ctx: ToolContext;
  }) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-process-tool-test-"));
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(root, "workspace");
  const codeDir = path.join(root, "code");
  const dbPath = path.join(root, "nexus.db");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(codeDir, { recursive: true });
  const db = await openDatabase(dbPath);
  const processManager = new ProcessManager({ stateDir, db });
  const ctx: ToolContext = {
    db,
    processManager,
    workspaceDir,
    stateDir,
    codeDir,
    allowShellExec: true,
    request: {
      channel: "cli",
      channelKey: "local",
      agentId: "main",
      preset: "coder",
      sessionId: "session-1",
      runId: "run-1",
    },
    nowMs: () => Date.now(),
    log: () => undefined,
  };

  try {
    await fn({ db, stateDir, workspaceDir, codeDir, processManager, ctx });
  } finally {
    const running = processManager.list().filter((proc) => proc.status === "running");
    for (const proc of running) {
      try {
        await processManager.stop({ id: proc.id, signal: "SIGTERM", killAfterMs: 200 });
      } catch {
        // ignore cleanup failures
      }
    }
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function seedNode(db: NexusDatabase, id: string): void {
  upsertNode(db, {
    id,
    label: id,
    publicKey: `pk-${id}`,
    fingerprint: `fp-${id}`,
    status: "online",
    backend: "nexus",
    firewallMode: "transparent",
    capabilities: ["process.start", "process.status", "process.logs", "process.cancel"],
    tags: [],
  });
}

test("process_manage handles local start/list/status/logs/stop and defaults notify preset to orchestrator", async () => {
  await withProcessEnv(async ({ db, ctx }) => {
    const startRaw = await processManage.execute(
      {
        action: "start",
        command: `node -e "console.log('ready'); setInterval(() => {}, 1000)"`,
      },
      ctx,
    );
    assert.doesNotMatch(startRaw, /^ERROR:/);
    const started = JSON.parse(startRaw) as { id: string; status: string };
    assert.equal(started.status, "running");

    const persisted = db.db
      .prepare("SELECT notify_preset FROM process_runs WHERE id = ?")
      .get(started.id) as { notify_preset: string | null } | undefined;
    assert.equal(persisted?.notify_preset, "orchestrator");

    const listRaw = await processManage.execute({ action: "list" }, ctx);
    const listed = JSON.parse(listRaw) as Array<{ id: string }>;
    assert.equal(listed.some((proc) => proc.id === started.id), true);

    const statusRaw = await processManage.execute({ action: "status", processId: started.id }, ctx);
    const status = JSON.parse(statusRaw) as { id: string; status: string };
    assert.equal(status.id, started.id);
    assert.equal(status.status, "running");

    const logsRaw = await processManage.execute({ action: "logs", processId: started.id, maxChars: 4000 }, ctx);
    assert.match(logsRaw, /ready/);

    const stopRaw = await processManage.execute(
      { action: "stop", processId: started.id, signal: "SIGTERM", killAfterMs: 200 },
      ctx,
    );
    assert.doesNotMatch(stopRaw, /^ERROR:/);
    const stopped = JSON.parse(stopRaw) as { id: string; status: string };
    assert.equal(stopped.id, started.id);
    assert.notEqual(stopped.status, "running");
  });
});

test("process_manage surfaces immediate-exit hints for local starts", async () => {
  await withProcessEnv(async ({ ctx }) => {
    const result = await processManage.execute(
      {
        action: "start",
        command: `node -e "console.error('boom'); process.exit(2)"`,
      },
      ctx,
    );

    assert.match(result, /^ERROR: process exited/);
    assert.match(result, /process_manage\(action='logs', processId='/);
    assert.match(result, /boom/);
  });
});

test("process_manage rejects node-only fields on local targets", async () => {
  await withProcessEnv(async ({ ctx }) => {
    const timeoutResult = await processManage.execute(
      {
        action: "status",
        target: "local",
        processId: "proc-1",
        timeoutMs: 1000,
      },
      ctx,
    );
    assert.equal(timeoutResult, "ERROR: timeoutMs is only supported when target='node'.");

    const securityResult = await processManage.execute(
      {
        action: "list",
        target: "local",
        security: { requireNexusBackend: true },
      },
      ctx,
    );
    assert.equal(securityResult, "ERROR: security is only supported when target='node'.");
  });
});

test("process_manage defaults to the pinned node for remote process actions", async () => {
  await withProcessEnv(async ({ db, ctx }) => {
    seedNode(db, "node-a");
    const routed: Array<{ tool: string; args: unknown; executionNode?: string; executionMode?: string }> = [];
    const remoteCtx: ToolContext = {
      ...ctx,
      executionNode: "node-a",
      executionMode: "remote",
      nodeRouter: {
        routeToolExecution: async (tool, args, routeCtx) => {
          routed.push({
            tool: tool.name,
            args,
            executionNode: routeCtx.executionNode,
            executionMode: routeCtx.executionMode,
          });
          return JSON.stringify({ ok: true, id: "proc-1", status: "running" });
        },
      },
    };

    const result = await processManage.execute(
      {
        action: "status",
        processId: "proc-1",
      },
      remoteCtx,
    );

    assert.equal(result, JSON.stringify({ ok: true, id: "proc-1", status: "running" }));
    assert.equal(routed.length, 1);
    assert.equal(routed[0]?.tool, "process_status");
    assert.deepEqual(routed[0]?.args, { id: "proc-1" });
    assert.equal(routed[0]?.executionNode, "node-a");
    assert.equal(routed[0]?.executionMode, "remote");
  });
});

test("process_manage rejects local targets and conflicting node ids in node-pinned runs", async () => {
  await withProcessEnv(async ({ db, ctx }) => {
    seedNode(db, "node-a");
    seedNode(db, "node-b");
    const remoteCtx: ToolContext = {
      ...ctx,
      executionNode: "node-a",
      executionMode: "remote",
      nodeRouter: {
        routeToolExecution: async () => "ok",
      },
    };

    const localResult = await processManage.execute({ action: "list", target: "local" }, remoteCtx);
    assert.equal(localResult, "ERROR: node-pinned run requires process_manage target=node (nodeId=node-a).");

    const mismatchResult = await processManage.execute(
      {
        action: "status",
        target: "node",
        nodeId: "node-b",
        processId: "proc-1",
      },
      remoteCtx,
    );
    assert.equal(
      mismatchResult,
      'ERROR: node-pinned run (node-a) cannot target node "node-b". Use nodeId="node-a" or omit nodeId.',
    );
  });
});

test("process_manage returns a clear error for remote list", async () => {
  await withProcessEnv(async ({ db, ctx }) => {
    seedNode(db, "node-a");
    let routed = 0;
    const result = await processManage.execute(
      {
        action: "list",
        target: "node",
        nodeId: "node-a",
      },
      {
        ...ctx,
        nodeRouter: {
          routeToolExecution: async () => {
            routed += 1;
            return "unexpected";
          },
        },
      },
    );

    assert.equal(
      result,
      "ERROR: remote process listing is not implemented yet; use action='status', 'logs', or 'stop' with a known processId.",
    );
    assert.equal(routed, 0);
  });
});
