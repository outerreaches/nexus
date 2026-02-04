import { z } from "zod";

import type { DataSource } from "../types.js";

type KalshiMarket = Record<string, unknown>;

const KalshiParams = z.object({
  limit: z.number().int().min(1).max(1000).default(100),
  cursor: z.string().optional(),
  eventTicker: z.string().optional(),
  seriesTicker: z.string().optional(),
  status: z.string().optional(),
  tickers: z.array(z.string()).optional(),
  minCloseTs: z.number().int().optional(),
  maxCloseTs: z.number().int().optional(),
});

export const kalshiSource: DataSource = {
  id: "markets.kalshi",
  name: "Kalshi Markets",
  description: "Fetch market data from Kalshi public API",
  usageNote:
    "Pass params at top level, e.g.: data_intake_source_add({ sourceId: \"markets.kalshi\", eventTicker: \"FED\", limit: 100, status: \"open\" }). " +
    "Filter by eventTicker or seriesTicker when possible to avoid huge result sets.",
  tags: ["markets", "prediction", "kalshi"],
  schemaVersion: 1,
  defaultTtlMs: 10 * 60_000,
  paramsSchema: KalshiParams,
  fetch: async (params) => {
    const parsed = KalshiParams.parse(params);
    const url = new URL("https://api.elections.kalshi.com/trade-api/v2/markets");
    url.searchParams.set("limit", String(parsed.limit));
    if (parsed.cursor) url.searchParams.set("cursor", parsed.cursor);
    if (parsed.eventTicker) url.searchParams.set("event_ticker", parsed.eventTicker);
    if (parsed.seriesTicker) url.searchParams.set("series_ticker", parsed.seriesTicker);
    if (parsed.status) url.searchParams.set("status", parsed.status);
    if (parsed.tickers && parsed.tickers.length > 0) url.searchParams.set("tickers", parsed.tickers.join(","));
    if (typeof parsed.minCloseTs === "number") url.searchParams.set("min_close_ts", String(parsed.minCloseTs));
    if (typeof parsed.maxCloseTs === "number") url.searchParams.set("max_close_ts", String(parsed.maxCloseTs));

    const res = await fetch(url.toString(), { headers: { "User-Agent": "NexusAgent/0.0.1" } });
    if (!res.ok) throw new Error(`Kalshi error: ${res.status} ${res.statusText}`);
    return (await res.json()) as unknown;
  },
  normalize: (raw, params, ctx) => {
    const parsed = KalshiParams.parse(params);
    const payload = raw as { markets?: KalshiMarket[] };
    const markets = Array.isArray(payload?.markets) ? payload.markets : [];
    return markets.map((market, idx) => {
      const ticker = (market.ticker ?? market.market_ticker ?? null) as string | null;
      const subject = ticker ?? `kalshi-${parsed.cursor ?? "page"}-${idx}`;
      return {
        subject,
        value: market,
        collectedAtMs: ctx.nowMs(),
        metadata: { provider: "kalshi", limit: parsed.limit, cursor: parsed.cursor ?? null },
      };
    });
  },
  summarize: (records) => {
    const sample = records.slice(0, 5).map((r) => r.subject);
    return { count: records.length, sample };
  },
};
