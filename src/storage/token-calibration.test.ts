import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deriveCalibrationKey,
  readCalibrationMultiplier,
  recordCalibrationSample,
} from "./token-calibration.js";
import { openDatabase, type NexusDatabase } from "./database.js";

async function withDb(fn: (db: NexusDatabase) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-calib-test-"));
  const db = await openDatabase(path.join(dir, "nexus.db"));
  try {
    await fn(db);
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ── Pure key derivation (no DB; runs anywhere) ────────────────────────────────

test("deriveCalibrationKey returns null without a model", () => {
  assert.equal(deriveCalibrationKey("http://localhost:8080/v1", undefined), null);
  assert.equal(deriveCalibrationKey(undefined, ""), null);
});

test("deriveCalibrationKey uses the base URL origin as provider", () => {
  assert.deepEqual(deriveCalibrationKey("http://localhost:8080/v1", "qwen2.5-coder"), {
    provider: "http://localhost:8080",
    model: "qwen2.5-coder",
  });
});

test("deriveCalibrationKey tolerates a non-URL base and an empty base", () => {
  assert.deepEqual(deriveCalibrationKey("not a url", "m"), { provider: "not a url", model: "m" });
  assert.deepEqual(deriveCalibrationKey(undefined, "m"), { provider: "", model: "m" });
});

// ── DB-backed accumulation (needs better-sqlite3 matching the runtime) ────────

test("readCalibrationMultiplier returns null below the seed sample floor", async () => {
  await withDb((db) => {
    const key = { provider: "local", model: "m" };
    recordCalibrationSample({ db, key, actualTokens: 1250, estimatedRawTokens: 1000, nowMs: 1 });
    recordCalibrationSample({ db, key, actualTokens: 1250, estimatedRawTokens: 1000, nowMs: 2 });
    // Only 2 samples — under the floor of 3.
    assert.equal(readCalibrationMultiplier(db, key), null);
    recordCalibrationSample({ db, key, actualTokens: 1250, estimatedRawTokens: 1000, nowMs: 3 });
    const seed = readCalibrationMultiplier(db, key);
    assert.ok(seed);
    assert.equal(seed.samples, 3);
    assert.ok(Math.abs(seed.multiplier - 1.25) < 1e-9, `expected ~1.25, got ${seed.multiplier}`);
  });
});

test("recordCalibrationSample accumulates a running ratio per key", async () => {
  await withDb((db) => {
    const key = { provider: "local", model: "hot-tokenizer" };
    // A tokenizer that runs 1.6x hotter than the char heuristic predicts.
    for (let i = 0; i < 5; i++) {
      recordCalibrationSample({ db, key, actualTokens: 1600, estimatedRawTokens: 1000, nowMs: i });
    }
    const seed = readCalibrationMultiplier(db, key);
    assert.ok(seed);
    assert.ok(Math.abs(seed.multiplier - 1.6) < 1e-9, `expected ~1.6, got ${seed.multiplier}`);
  });
});

test("readCalibrationMultiplier clamps an extreme ratio into the runtime range", async () => {
  await withDb((db) => {
    const key = { provider: "local", model: "absurd" };
    // Ratio 5x — must clamp to the 2.5 ceiling.
    for (let i = 0; i < 4; i++) {
      recordCalibrationSample({ db, key, actualTokens: 5000, estimatedRawTokens: 1000, nowMs: i });
    }
    const seed = readCalibrationMultiplier(db, key);
    assert.ok(seed);
    assert.equal(seed.multiplier, 2.5);
  });
});

test("keys are isolated per provider+model", async () => {
  await withDb((db) => {
    const a = { provider: "local", model: "a" };
    const b = { provider: "local", model: "b" };
    for (let i = 0; i < 3; i++) {
      recordCalibrationSample({ db, key: a, actualTokens: 1200, estimatedRawTokens: 1000, nowMs: i });
      recordCalibrationSample({ db, key: b, actualTokens: 900, estimatedRawTokens: 1000, nowMs: i });
    }
    assert.ok(Math.abs(readCalibrationMultiplier(db, a)!.multiplier - 1.2) < 1e-9);
    // 0.9 ratio stays above the 0.8 floor.
    assert.ok(Math.abs(readCalibrationMultiplier(db, b)!.multiplier - 0.9) < 1e-9);
  });
});

test("recordCalibrationSample ignores non-positive observations", async () => {
  await withDb((db) => {
    const key = { provider: "local", model: "guard" };
    recordCalibrationSample({ db, key, actualTokens: 0, estimatedRawTokens: 1000, nowMs: 1 });
    recordCalibrationSample({ db, key, actualTokens: 1200, estimatedRawTokens: 0, nowMs: 2 });
    assert.equal(readCalibrationMultiplier(db, key), null);
  });
});
