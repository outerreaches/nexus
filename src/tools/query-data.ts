import { z } from "zod";

import { defineTool } from "../core/tools.js";
import { initDataIntake } from "../data-intake/index.js";
import { listLatestDataItems } from "../data-intake/store.js";

function requireDb(ctx: { db?: unknown }) {
  return ctx.db ?? null;
}

function buildSubjects(instrument: string, _currency: string): string[] {
  const cleaned = instrument.trim();
  if (!cleaned) return [];
  if (cleaned.includes("/")) {
    return [cleaned.toUpperCase()];
  }
  const symbol = cleaned.toUpperCase();
  return [cleaned.toLowerCase(), symbol];
}

export const queryData = defineTool({
  name: "query_data",
  description: [
    "Query the latest cached data intake record for a subject.",
    "",
    "Use this to retrieve recently ingested data across any domain (markets, weather, news, sensors, etc.).",
    "The tool reads from the normalized data intake store and does not call external APIs directly.",
    "",
    "Matching behavior:",
    "- If the instrument includes a slash (e.g. BTC/USD), it is treated as an exact subject.",
    "- Otherwise, it will try the lowercase key and then the uppercase symbol.",
    "",
    "Returned fields:",
    "- instrument, subject, sourceId, sourceName",
    "- collectedAt, expiresAt",
    "- value (parsed JSON payload), metadata (parsed JSON)",
    "- price (if the value payload contains a price field)",
  ].join("\n"),
  parameters: z.object({
    instrument: z.string().describe('Subject key or symbol like "BTC", "ETH", or "BTC/USD"'),
    currency: z.string().default("usd").describe('Quote currency for symbol lookup (e.g. "usd")'),
  }),
  execute: async ({ instrument, currency }, ctx) => {
    initDataIntake();
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";

    const subjects = buildSubjects(instrument, currency);
    if (subjects.length === 0) return "ERROR: missing instrument";

    for (const subject of subjects) {
      const rows = listLatestDataItems({
        db: db as any,
        subject,
        limit: 1,
        includeExpired: false,
        nowMs: ctx.nowMs(),
      });
      const row = rows[0];
      if (!row) continue;
      const value = safeJsonParse(row.value_json);
      const metadata = safeJsonParse(row.metadata_json);
      const price = value && typeof value === "object" && "price" in value ? (value as any).price : null;
      return JSON.stringify(
        {
          instrument,
          subject,
          sourceId: row.source_id,
          sourceName: row.source_name,
          collectedAt: row.collected_at,
          expiresAt: row.expires_at,
          price,
          value,
          metadata,
        },
        null,
        2,
      );
    }

    return `ERROR: no data found for ${instrument}`;
  },
});

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
