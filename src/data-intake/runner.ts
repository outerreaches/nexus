import type { DataIntakeContext, DataRunResult, DataSource, NormalizedRecord } from "./types.js";

type StoreResult = { stored: number; skipped: number };

export type RunDataSourceOptions = {
  /** Additional tags to merge with source.tags (e.g., instance label) */
  instanceTags?: string[];
};

export async function runDataSource(
  source: DataSource,
  params: unknown,
  ctx: DataIntakeContext,
  options?: RunDataSourceOptions,
): Promise<DataRunResult> {
  const collectedAtMs = ctx.nowMs();
  const errors: string[] = [];
  let stored = 0;
  let skipped = 0;

  try {
    if (source.paramsSchema) {
      params = source.paramsSchema.parse(params);
    }
  } catch (err) {
    return {
      sourceId: source.id,
      sourceName: source.name,
      stored: 0,
      skipped: 0,
      errors: [`Invalid params: ${err instanceof Error ? err.message : String(err)}`],
      collectedAtMs,
    };
  }

  let raw: unknown;
  try {
    raw = await source.fetch(params, ctx);
  } catch (err) {
    errors.push(`Fetch error: ${err instanceof Error ? err.message : String(err)}`);
    return { sourceId: source.id, sourceName: source.name, stored, skipped, errors, collectedAtMs };
  }

  let normalized: NormalizedRecord[] = [];
  try {
    const result = await source.normalize(raw, params, ctx);
    normalized = Array.isArray(result) ? result : [];
  } catch (err) {
    errors.push(`Normalize error: ${err instanceof Error ? err.message : String(err)}`);
    return { sourceId: source.id, sourceName: source.name, stored, skipped, errors, collectedAtMs };
  }

  const storeResult = storeRecords(source, normalized, params, ctx, collectedAtMs, errors, options?.instanceTags);
  stored = storeResult.stored;
  skipped = storeResult.skipped;

  // Generate a preview if the source has a summarize function (useful for ad-hoc runs)
  let preview: unknown;
  if (source.summarize && normalized.length > 0) {
    try {
      preview = source.summarize(normalized, ctx);
    } catch (err) {
      errors.push(`Summarize error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { sourceId: source.id, sourceName: source.name, stored, skipped, errors, collectedAtMs, preview };
}

function storeRecords(
  source: DataSource,
  records: NormalizedRecord[],
  params: unknown,
  ctx: DataIntakeContext,
  collectedAtMs: number,
  errors: string[],
  instanceTags?: string[],
): StoreResult {
  if (!ctx.db) {
    errors.push("Storage error: database is not available");
    return { stored: 0, skipped: records.length };
  }

  const upsertStmt = ctx.db.db.prepare(
    "INSERT OR REPLACE INTO data_items (id, source_id, source_name, tags_json, subject, value_json, metadata_json, collected_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const snapshotStmt = source.snapshotValue
    ? ctx.db.db.prepare(
        "INSERT INTO data_snapshots (source_id, subject, value_json, collected_at, created_at) VALUES (?, ?, ?, ?, ?)",
      )
    : null;

  let stored = 0;
  let skipped = 0;
  for (const record of records) {
    if (!record || !record.subject) {
      skipped += 1;
      continue;
    }

    const ttlMs = typeof record.ttlMs === "number" ? record.ttlMs : source.defaultTtlMs;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      skipped += 1;
      continue;
    }

    const nowMs = ctx.nowMs();
    const collectedAt = typeof record.collectedAtMs === "number" ? record.collectedAtMs : collectedAtMs;
    const expiresAt = collectedAt + ttlMs;
    const id = `${source.id}:${record.subject}`;

    try {
      const valueJson = JSON.stringify(record.value ?? null);
      const allTags = [...(source.tags ?? []), ...(instanceTags ?? [])];
      upsertStmt.run(
        id,
        source.id,
        source.name,
        JSON.stringify(allTags),
        record.subject,
        valueJson,
        JSON.stringify({
          ...(record.metadata ?? {}),
          collectedAt,
          sourceSchemaVersion: source.schemaVersion,
        }),
        collectedAt,
        expiresAt,
        nowMs,
      );

      // Write compact snapshot for historical tracking (if source supports it)
      if (snapshotStmt && source.snapshotValue) {
        const snap = source.snapshotValue(record.value);
        if (snap != null) {
          snapshotStmt.run(source.id, record.subject, JSON.stringify(snap), collectedAt, nowMs);
        }
      }

      stored += 1;
    } catch (err) {
      errors.push(`Store error (${record.subject}): ${err instanceof Error ? err.message : String(err)}`);
      skipped += 1;
    }
  }

  return { stored, skipped };
}
