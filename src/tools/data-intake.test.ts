import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ToolContext } from "../core/tools.js";
import { openDatabase, type NexusDatabase } from "../storage/database.js";
import { dataIntakeManage, dataIntakeQuery } from "./data-intake.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-data-intake-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function createToolContext(db: NexusDatabase): ToolContext {
  return {
    db,
    workspaceDir: process.cwd(),
    stateDir: process.cwd(),
    codeDir: process.cwd(),
    nowMs: () => Date.now(),
    log: () => undefined,
  };
}

function seedDataItems(db: NexusDatabase): void {
  const now = Date.now();
  const insert = db.db.prepare(
    "INSERT INTO data_items (id, source_id, source_name, tags_json, subject, value_json, metadata_json, collected_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );

  insert.run(
    "weather.open-meteo:current",
    "weather.open-meteo",
    "Open-Meteo Forecast",
    JSON.stringify(["weather"]),
    "current",
    JSON.stringify({ temperatureC: 18.4 }),
    JSON.stringify({}),
    now,
    now + 60_000,
    now,
  );

  insert.run(
    "traffic.511ontario:highway-400",
    "traffic.511ontario",
    "Ontario 511 Traffic",
    JSON.stringify(["traffic"]),
    "highway-400",
    JSON.stringify({ incidents: 2 }),
    JSON.stringify({}),
    now,
    now + 60_000,
    now,
  );
}

test("data_intake_query accepts sourceType alias and filters by source_id", async () => {
  await withDb(async (db) => {
    seedDataItems(db);

    const result = await dataIntakeQuery.execute(
      {
        sourceType: "weather.open-meteo",
        limit: 10,
      },
      createToolContext(db),
    );

    const rows = JSON.parse(result) as Array<{ source_id: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.source_id, "weather.open-meteo");
  });
});

test("data_intake_manage query action forwards sourceType alias correctly", async () => {
  await withDb(async (db) => {
    seedDataItems(db);

    const result = await dataIntakeManage.execute(
      {
        action: "query",
        args: {
          sourceType: "weather.open-meteo",
          limit: 10,
        },
      },
      createToolContext(db),
    );

    const rows = JSON.parse(result) as Array<{ source_id: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.source_id, "weather.open-meteo");
  });
});
