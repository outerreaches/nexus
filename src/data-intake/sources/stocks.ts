import { z } from "zod";

import type { DataSource } from "../types.js";

type AlphaVantageResponse = {
  "Global Quote"?: {
    "01. symbol"?: string;
    "05. price"?: string;
    "07. latest trading day"?: string;
  };
};

const StocksParams = z.object({
  symbols: z.array(z.string()).min(1),
});

export const stocksSource: DataSource = {
  id: "stocks.alphavantage",
  name: "Alpha Vantage Stocks",
  description: "Fetch stock quotes via Alpha Vantage (GLOBAL_QUOTE)",
  usageNote: "Pass symbols at top level, e.g.: data_intake_source_add({ sourceId: \"stocks.alphavantage\", symbols: [\"AAPL\", \"MSFT\"] }). Requires ALPHAVANTAGE_API_KEY.",
  tags: ["stocks", "prices", "markets"],
  schemaVersion: 1,
  defaultTtlMs: 10 * 60_000,
  paramsSchema: StocksParams,
  fetch: async (params) => {
    const parsed = StocksParams.parse(params);
    const apiKey = process.env.ALPHAVANTAGE_API_KEY;
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY not configured");
    const results: Record<string, AlphaVantageResponse> = {};
    for (const symbol of parsed.symbols) {
      const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, { headers: { "User-Agent": "NexusAgent/0.0.1" } });
      if (!res.ok) throw new Error(`Alpha Vantage error: ${res.status} ${res.statusText}`);
      results[symbol] = (await res.json()) as AlphaVantageResponse;
    }
    return results;
  },
  normalize: (raw, params, ctx) => {
    const parsed = StocksParams.parse(params);
    const json = raw as Record<string, AlphaVantageResponse>;
    return parsed.symbols.map((symbol) => {
      const quote = json?.[symbol]?.["Global Quote"] ?? {};
      const price = quote["05. price"] ? Number(quote["05. price"]) : null;
      const tradingDay = quote["07. latest trading day"] ?? null;
      return {
        subject: symbol.toUpperCase(),
        value: {
          symbol: symbol.toUpperCase(),
          price,
          latestTradingDay: tradingDay,
        },
        collectedAtMs: ctx.nowMs(),
        metadata: { provider: "alphavantage" },
      };
    });
  },
};
