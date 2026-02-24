import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { memorySearch } from "../tools/memory.js";
import { openDatabase, type NexusDatabase } from "../storage/database.js";
import { generateMemoryHints } from "./memory-hints.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-memory-hints-test-"));
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
  tags: string[];
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
      "observation",
      JSON.stringify(params.tags),
      params.nowMs,
      params.nowMs,
      params.nowMs,
    );
}

test("generateMemoryHints ignores compaction/context-summary memories", async () => {
  await withDb((db) => {
    const nowMs = 1_700_000_001_000;
    insertMemory({
      db,
      agentId: "main",
      key: "compaction:session-1:1",
      value: "docker rollout summary",
      tags: ["compaction", "context-summary"],
      nowMs,
    });
    insertMemory({
      db,
      agentId: "main",
      key: "docker deployment notes",
      value: "use canary before full rollout",
      tags: ["deploy"],
      nowMs: nowMs + 1,
    });

    const hint = generateMemoryHints({
      db,
      agentId: "main",
      keywords: ["docker"],
      seenKeywords: new Set<string>(),
      messageText: "check docker status",
    });

    assert.ok(hint);
    assert.match(hint as string, /1 entry matches "docker"/);
  });
});

test("memory_search excludes compaction memories by default and can include them on demand", async () => {
  await withDb(async (db) => {
    const nowMs = 1_700_000_002_000;
    insertMemory({
      db,
      agentId: "main",
      key: "compaction:session-2:1",
      value: "redis restart summary",
      tags: ["compaction", "context-summary"],
      nowMs,
    });
    insertMemory({
      db,
      agentId: "main",
      key: "redis restart playbook",
      value: "graceful restart checklist",
      tags: ["redis", "ops"],
      nowMs: nowMs + 1,
    });

    const ctx = {
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
      nowMs: () => nowMs + 10,
      log: () => {},
    };

    const filtered = await memorySearch.execute(
      {
        query: "redis",
        limit: 10,
        includeValues: false,
        valuePreviewChars: 80,
      },
      ctx,
    );
    const filteredRows = JSON.parse(filtered) as Array<Record<string, unknown>>;
    assert.equal(filteredRows.length, 1);
    assert.equal(filteredRows[0]?.key, "redis restart playbook");
    assert.equal(filteredRows[0]?.value, undefined);
    assert.equal(typeof filteredRows[0]?.value_preview, "string");

    const includeSystem = await memorySearch.execute(
      {
        query: "redis",
        limit: 10,
        includeSystem: true,
        includeValues: false,
        valuePreviewChars: 80,
      },
      ctx,
    );
    const allRows = JSON.parse(includeSystem) as Array<Record<string, unknown>>;
    const keys = new Set(allRows.map((row) => String(row.key)));
    assert.equal(keys.has("compaction:session-2:1"), true);
    assert.equal(keys.has("redis restart playbook"), true);
  });
});
