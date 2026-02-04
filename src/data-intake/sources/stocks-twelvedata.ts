import { z } from "zod";

import type { DataSource } from "../types.js";

type TwelveDataPriceResponse = {
  price?: string;
  status?: string;
  message?: string;
  code?: number;
};

const TwelveDataParams = z.object({
  symbols: z.array(z.string()).min(1),
  exchange: z.string().optional(),
});

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export const twelveDataSource: DataSource = {
  id: "stocks.twelvedata",
  name: "Twelve Data Stocks",
  description: "Fetch stock prices via Twelve Data (price endpoint)",
  usageNote:
    "Pass params at top level, e.g.: data_intake_source_add({ sourceId: \"stocks.twelvedata\", symbols: [\"AAPL\", \"MSFT\"] }). " +
    "Requires TWELVEDATA_API_KEY.",
  tags: ["stocks", "prices", "markets"],
  schemaVersion: 1,
  defaultTtlMs: 5 * 60_000,
  paramsSchema: TwelveDataParams,
  fetch: async (params) => {
    const parsed = TwelveDataParams.parse(params);
    const apiKey = process.env.TWELVEDATA_API_KEY;
    if (!apiKey) throw new Error("TWELVEDATA_API_KEY not configured");

    const results: Record<string, TwelveDataPriceResponse> = {};
    for (const symbol of parsed.symbols) {
      const url = new URL("https://api.twelvedata.com/price");
      url.searchParams.set("symbol", symbol);
      if (parsed.exchange) url.searchParams.set("exchange", parsed.exchange);
      url.searchParams.set("apikey", apiKey);

      const res = await fetch(url.toString(), { headers: { "User-Agent": "NexusAgent/0.0.1" } });
      if (!res.ok) throw new Error(`Twelve Data error: ${res.status} ${res.statusText}`);
      results[symbol] = (await res.json()) as TwelveDataPriceResponse;
    }

    return results;
  },
  normalize: (raw, params, ctx) => {
    const parsed = TwelveDataParams.parse(params);
    const json = raw as Record<string, TwelveDataPriceResponse>;
    return parsed.symbols.map((symbol) => {
      const response = json?.[symbol] ?? {};
      const price = response.price ? toNumber(response.price) : null;
      const isError = response.status === "error";
      return {
        subject: symbol.toUpperCase(),
        value: isError
          ? {
              symbol: symbol.toUpperCase(),
              price: null,
              error: response.message ?? "Unknown error",
            }
          : {
              symbol: symbol.toUpperCase(),
              price,
            },
        collectedAtMs: ctx.nowMs(),
        metadata: { provider: "twelvedata" },
      };
    });
  },
  summarize: (records) => {
    const prices: Record<string, number | null> = {};
    for (const r of records) {
      const v = r.value as { symbol?: string; price?: number | null } | null;
      if (v?.symbol) prices[v.symbol] = v.price ?? null;
    }
    return { prices };
  },
};
