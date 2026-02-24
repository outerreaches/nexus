import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase, type NexusDatabase } from "../storage/database.js";
import { memoryDelete, memoryRecall, memoryStore } from "./memory.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-memory-tool-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function insertMemory(params: {
  db: NexusDatabase;
  agentId: string;
  key: string;
  value: string;
  category?: "fact" | "observation" | "preference" | "plan";
  tags?: string[];
  nowMs: number;
}): void {
  params.db.db
    .prepare(
      `INSERT INTO memories (agent_id, key, value, category, tags_json, created_at, updated_at, accessed_at, access_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      params.agentId,
      params.key,
      params.value,
      params.category ?? "observation",
      JSON.stringify(params.tags ?? []),
      params.nowMs,
      params.nowMs,
      params.nowMs,
    );
}

function makeCtx(db: NexusDatabase, getNowMs: () => number): any {
  return {
    workspaceDir: process.cwd(),
    stateDir: process.cwd(),
    codeDir: process.cwd(),
    db,
    request: {
      channel: "cli",
      channelKey: "test",
      agentId: "main",
      sessionId: "session-1",
    },
    nowMs: getNowMs,
    log: () => {},
  };
}

test("memory_store normalizes keys/tags and deduplicates case-variant keys", async () => {
  await withDb(async (db) => {
    let nowMs = 1_700_000_100_000;
    insertMemory({
      db,
      agentId: "main",
      key: "Gateway Webhook Route",
      value: "legacy value",
      nowMs,
    });
    insertMemory({
      db,
      agentId: "main",
      key: "gateway webhook route",
      value: "stale duplicate",
      nowMs: nowMs + 1,
    });

    nowMs += 10;
    const ctx = makeCtx(db, () => nowMs);
    const result = await memoryStore.execute(
      {
        key: "  GATEWAY   webhook route ",
        value: " Node webhook -> gateway -> orchestrator ",
        category: "fact",
        tags: ["WebHook", "node", "NODE", "  "],
      },
      ctx,
    );

    assert.match(result, /OK: stored memory "gateway webhook route" \[fact\]/);
    assert.match(result, /deduplicated 1 older variant/);

    const rows = db.db
      .prepare("SELECT key, value, category, tags_json FROM memories WHERE agent_id = ? AND LOWER(key) = ?")
      .all("main", "gateway webhook route") as Array<{ key: string; value: string; category: string; tags_json: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.key, "gateway webhook route");
    assert.equal(rows[0]?.value, "Node webhook -> gateway -> orchestrator");
    assert.equal(rows[0]?.category, "fact");
    assert.deepEqual(JSON.parse(rows[0]?.tags_json ?? "[]"), ["node", "webhook"]);
  });
});

test("memory_store returns unchanged for equivalent normalized writes", async () => {
  await withDb(async (db) => {
    let nowMs = 1_700_000_110_000;
    const ctx = makeCtx(db, () => nowMs);
    const first = await memoryStore.execute(
      {
        key: "webhook routing rule",
        value: "node listener forwards events to gateway",
        category: "fact",
        tags: ["node", "webhook"],
      },
      ctx,
    );
    assert.match(first, /OK: stored memory "webhook routing rule" \[fact\]/);

    nowMs += 5;
    const second = await memoryStore.execute(
      {
        key: "  WEBHOOK   ROUTING RULE ",
        value: "node listener forwards events to gateway\n",
        category: "fact",
        tags: ["webhook", "NODE", "node"],
      },
      ctx,
    );
    assert.equal(second, 'OK: memory "webhook routing rule" unchanged');
  });
});

test("memory_recall and memory_delete resolve keys case-insensitively", async () => {
  await withDb(async (db) => {
    const nowMs = 1_700_000_120_000;
    insertMemory({
      db,
      agentId: "main",
      key: "Mixed Case Key",
      value: "remember this",
      nowMs,
    });

    const ctx = makeCtx(db, () => nowMs + 1);
    const recallRaw = await memoryRecall.execute({ key: "mixed case key" }, ctx);
    const recalled = JSON.parse(recallRaw) as { key: string; value: string; access_count: number };
    assert.equal(recalled.key, "Mixed Case Key");
    assert.equal(recalled.value, "remember this");
    assert.equal(recalled.access_count, 1);

    const del = await memoryDelete.execute({ key: "mixed case key" }, ctx);
    assert.equal(del, "OK");
    const remaining = db.db
      .prepare("SELECT COUNT(*) AS cnt FROM memories WHERE agent_id = ? AND LOWER(key) = ?")
      .get("main", "mixed case key") as { cnt: number };
    assert.equal(remaining.cnt, 0);
  });
});

test("memory_store rejects reserved low-signal keys", async () => {
  await withDb(async (db) => {
    const ctx = makeCtx(db, () => 1_700_000_130_000);
    const reserved = await memoryStore.execute(
      {
        key: "compaction:session-1:1",
        value: "should fail",
        category: "observation",
        tags: [],
      },
      ctx,
    );
    assert.match(reserved, /ERROR: memory key "compaction:session-1:1" uses a reserved system prefix/);

    const generic = await memoryStore.execute(
      {
        key: "notes",
        value: "too generic",
        category: "observation",
        tags: [],
      },
      ctx,
    );
    assert.match(generic, /ERROR: memory key "notes" is too generic/);
  });
});
