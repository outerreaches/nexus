// ─────────────────────────────────────────────────────────────────────────────
// Prompt-token estimator calibration (persistent, per provider+model)
// ─────────────────────────────────────────────────────────────────────────────
//
// The agent runner estimates prompt size from a char-count heuristic
// (CHARS_PER_TOKEN) and corrects it with a multiplier learned within a run from
// usage.promptTokens. That learning was thrown away at run end, so every run
// cold-started at a GPT-tuned default — a problem for local tokenizers
// (Llama/Qwen/DeepSeek) on code-heavy content, which run hotter and can slip a
// dense first turn past the compaction gate into a context-overflow.
//
// This module persists the calibration as running sums of (actual, estimated)
// prompt tokens keyed by provider+model. The multiplier is sum_actual /
// sum_estimated. Storing additive sums (rather than a stored EWMA) keeps the
// write race-free across the HA slots and isolated-worker processes sharing the
// DB file — no read-modify-write. Past a sample cap the sums are halved in the
// same atomic upsert, preserving the ratio while restoring recency weight.
// ─────────────────────────────────────────────────────────────────────────────

import type Database from "better-sqlite3";

import type { NexusDatabase } from "./database.js";

/** Don't seed from a single noisy sample. */
const SEED_MIN_SAMPLES = 3;
/** Halve the running sums once samples cross this, to stay adaptive on
 *  long-lived installs (e.g. after a model swap under the same name). */
const DECAY_SAMPLE_CAP = 1000;
/** Same clamp the runtime EWMA uses, so a seeded value matches its range. */
const MULTIPLIER_MIN = 0.8;
const MULTIPLIER_MAX = 2.5;

export type CalibrationKey = { provider: string; model: string };
export type CalibrationSeed = { multiplier: number; samples: number };

/** Derive a stable (provider, model) key from the active LLM config. Provider
 *  is the base URL origin (host) so the same local server keyed once; returns
 *  null when there's no model to key on. */
export function deriveCalibrationKey(
  baseUrl: string | undefined,
  model: string | undefined,
): CalibrationKey | null {
  if (!model) return null;
  let provider = "";
  if (baseUrl) {
    try {
      provider = new URL(baseUrl).origin;
    } catch {
      provider = baseUrl;
    }
  }
  return { provider, model };
}

// Hoisted prepared statements (one set per DB connection) — the runner records
// once per LLM call, so we avoid re-preparing on every sample.
type CalibStatements = { read: Database.Statement; upsert: Database.Statement };
const stmtCache = new WeakMap<NexusDatabase, CalibStatements>();

function statements(db: NexusDatabase): CalibStatements {
  const cached = stmtCache.get(db);
  if (cached) return cached;
  const read = db.db.prepare(
    `SELECT sum_actual AS sumActual, sum_estimated AS sumEstimated, samples
       FROM token_calibration WHERE provider = ? AND model = ?`,
  );
  const upsert = db.db.prepare(
    `INSERT INTO token_calibration (provider, model, sum_actual, sum_estimated, samples, updated_at)
     VALUES (@provider, @model, @actual, @estimated, 1, @now)
     ON CONFLICT(provider, model) DO UPDATE SET
       sum_actual = CASE WHEN samples >= @cap THEN (sum_actual + @actual) / 2.0 ELSE sum_actual + @actual END,
       sum_estimated = CASE WHEN samples >= @cap THEN (sum_estimated + @estimated) / 2.0 ELSE sum_estimated + @estimated END,
       samples = CASE WHEN samples >= @cap THEN samples / 2 + 1 ELSE samples + 1 END,
       updated_at = @now`,
  );
  const built = { read, upsert };
  stmtCache.set(db, built);
  return built;
}

/** Read the persisted multiplier for a model, or null when there isn't enough
 *  history yet (caller falls back to its cold-start default). Never throws. */
export function readCalibrationMultiplier(
  db: NexusDatabase,
  key: CalibrationKey,
): CalibrationSeed | null {
  try {
    const row = statements(db).read.get(key.provider, key.model) as
      | { sumActual: number; sumEstimated: number; samples: number }
      | undefined;
    if (!row) return null;
    if (!(row.samples >= SEED_MIN_SAMPLES) || !(row.sumEstimated > 0)) return null;
    const raw = row.sumActual / row.sumEstimated;
    if (!Number.isFinite(raw)) return null;
    const multiplier = Math.min(MULTIPLIER_MAX, Math.max(MULTIPLIER_MIN, raw));
    return { multiplier, samples: row.samples };
  } catch {
    return null;
  }
}

/** Fold one (actual, estimated-raw) observation into the running sums. Uses the
 *  uncalibrated estimate as the denominator so the stored ratio is the
 *  multiplier to apply to a raw estimate. Never throws. */
export function recordCalibrationSample(params: {
  db: NexusDatabase;
  key: CalibrationKey;
  actualTokens: number;
  estimatedRawTokens: number;
  nowMs: number;
}): void {
  const { actualTokens, estimatedRawTokens } = params;
  if (!(actualTokens > 0) || !(estimatedRawTokens > 0)) return;
  try {
    statements(params.db).upsert.run({
      provider: params.key.provider,
      model: params.key.model,
      actual: actualTokens,
      estimated: estimatedRawTokens,
      now: params.nowMs,
      cap: DECAY_SAMPLE_CAP,
    });
  } catch {
    // Non-critical — calibration is best-effort; never fail a run over it.
  }
}
