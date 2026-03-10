import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrateLegacyAgentTaskJobSpecs } from "./job-spec.js";
import { openDatabase, type NexusDatabase } from "../storage/database.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-job-spec-test-"));
  const dbPath = path.join(dir, "nexus.db");
  const db = await openDatabase(dbPath);
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("migrateLegacyAgentTaskJobSpecs upgrades resumable one-shot jobs and defaults ambiguous ones safely", async () => {
  await withDb(async (db) => {
    const now = Date.now();
    const insert = db.db.prepare(
      "INSERT INTO jobs (id, owner_agent_id, name, cron, timezone, enabled, spec_json, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(
      "JSAFE1",
      "main",
      "safe-upgrade",
      "@once",
      "UTC",
      1,
      JSON.stringify({
        mode: "agent_task",
        task: "resume me",
        originChannel: "telegram",
        originChannelKey: "1000000001",
        originSessionId: "session-1",
        originAgentId: "main",
      }),
      now,
      now,
      now,
    );
    insert.run(
      "JSAFE2",
      "main",
      "ambiguous",
      "@once",
      "UTC",
      1,
      JSON.stringify({
        mode: "agent_task",
        task: "report only",
      }),
      now,
      now,
      now,
    );

    const first = migrateLegacyAgentTaskJobSpecs(db);
    const second = migrateLegacyAgentTaskJobSpecs(db);

    assert.equal(first.upgradedToSessionResume, 1);
    assert.equal(first.defaultedToReportOnly, 1);
    assert.equal(second.alreadyVersioned, 2);

    const row1 = db.db.prepare("SELECT spec_json FROM jobs WHERE id = ?").get("JSAFE1") as { spec_json: string };
    const spec1 = JSON.parse(row1.spec_json) as Record<string, unknown>;
    assert.equal(spec1.deliveryMode, "session_resume");
    assert.equal(spec1.originRecoveredFrom, "migration");

    const row2 = db.db.prepare("SELECT spec_json FROM jobs WHERE id = ?").get("JSAFE2") as { spec_json: string };
    const spec2 = JSON.parse(row2.spec_json) as Record<string, unknown>;
    assert.equal(spec2.deliveryMode, "report_only");
    assert.equal(spec2.resumeUnavailable, true);
  });
});
