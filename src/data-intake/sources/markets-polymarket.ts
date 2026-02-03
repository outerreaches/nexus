import { z } from "zod";

import type { DataSource } from "../types.js";

type PolymarketMarket = Record<string, unknown>;

const PolymarketParams = z.object({
  active: z.boolean().optional().default(true),
  closed: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

function parseMaybeJsonArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export const polymarketSource: DataSource = {
  id: "markets.polymarket",
  name: "Polymarket Markets",
  description: "Fetch market data from Polymarket Gamma API",
  usageNote:
    "Best practice: start narrow and page. Use `active: true` and a small `limit` (e.g. 20-50), " +
    "then increase `offset` to page. Use `closed: true` only when explicitly needed. " +
    "Market fields can be large/varied; prefer filtering by question/slug after ingest via data_intake_query. " +
    "Example params: { active: true, limit: 50, offset: 0 }.",
  tags: ["markets", "prediction", "polymarket"],
  schemaVersion: 1,
  defaultTtlMs: 10 * 60_000,
  paramsSchema: PolymarketParams,
  fetch: async (params) => {
    const parsed = PolymarketParams.parse(params);
    const url = new URL("https://gamma-api.polymarket.com/markets");
    if (typeof parsed.active === "boolean") url.searchParams.set("active", parsed.active ? "true" : "false");
    if (typeof parsed.closed === "boolean") url.searchParams.set("closed", parsed.closed ? "true" : "false");
    url.searchParams.set("limit", String(parsed.limit));
    url.searchParams.set("offset", String(parsed.offset));
    const res = await fetch(url.toString(), { headers: { "User-Agent": "NexusAgent/0.0.1" } });
    if (!res.ok) throw new Error(`Polymarket error: ${res.status} ${res.statusText}`);
    return (await res.json()) as unknown;
  },
  normalize: (raw, params, ctx) => {
    const parsed = PolymarketParams.parse(params);
    const payload = raw as { data?: PolymarketMarket[]; markets?: PolymarketMarket[] };
    const markets = Array.isArray(payload)
      ? (payload as PolymarketMarket[])
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.markets)
          ? payload.markets
          : [];

    return markets.map((market, idx) => {
      const conditionId = typeof market.conditionId === "string" ? market.conditionId : undefined;
      const id = typeof market.id === "string" ? market.id : undefined;
      const slug = typeof market.slug === "string" ? market.slug : undefined;
      const question = typeof market.question === "string" ? market.question : typeof market.title === "string" ? market.title : undefined;
      const subject = conditionId ?? id ?? slug ?? question ?? `polymarket-${parsed.offset + idx}`;
      const outcomes = parseMaybeJsonArray(market.outcomes);
      const outcomePrices = parseMaybeJsonArray(market.outcomePrices);
      return {
        subject,
        value: {
          id: id ?? null,
          conditionId: conditionId ?? null,
          slug: slug ?? null,
          question: question ?? null,
          active: typeof market.active === "boolean" ? market.active : null,
          closed: typeof market.closed === "boolean" ? market.closed : null,
          endDate: (market.end_date ?? market.endDate) as string | null,
          outcomes,
          outcomePrices,
          volume: toNumber(market.volume),
          liquidity: toNumber(market.liquidity),
          category: (market.category ?? market.category_id ?? null) as string | null,
          eventId: (market.event_id ?? market.eventId ?? null) as string | null,
          clobTokenIds: parseMaybeJsonArray(market.clobTokenIds),
        },
        collectedAtMs: ctx.nowMs(),
        metadata: { provider: "polymarket", source: "gamma", limit: parsed.limit, offset: parsed.offset },
      };
    });
  },
  summarize: (records) => {
    const sample = records.slice(0, 5).map((r) => {
      const v = r.value as { question?: string | null } | null;
      return v?.question ?? r.subject;
    });
    return { count: records.length, sample };
  },
};
