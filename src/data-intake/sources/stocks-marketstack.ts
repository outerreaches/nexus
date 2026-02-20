import { z } from "zod";

import type { DataSource } from "../types.js";
import { getSecret } from "../../secrets/resolve-env.js";

type MarketstackItem = {
  symbol?: string;
  date?: string;
  open?: number | string;
  high?: number | string;
  low?: number | string;
  close?: number | string;
  last?: number | string;
  volume?: number | string;
  adj_open?: number | string;
  adj_high?: number | string;
  adj_low?: number | string;
  adj_close?: number | string;
  adj_volume?: number | string;
  exchange?: string;
};

type MarketstackResponse = {
  data?: MarketstackItem[];
  error?: { code?: string; message?: string };
};

const MarketstackParams = z.object({
  symbols: z.array(z.string()).min(1),
  dataType: z.enum(["eod", "intraday"]).default("eod"),
  interval: z.string().optional(),
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

export const marketstackSource: DataSource = {
  id: "stocks.marketstack",
  name: "Marketstack Stocks",
  description: "Fetch latest stock data via Marketstack (EOD or intraday latest)",
  usageNote:
    "Pass params at top level, e.g.: data_intake_source_add({ sourceId: \"stocks.marketstack\", symbols: [\"AAPL\", \"MSFT\"] }). " +
    "Requires MARKETSTACK_API_KEY. Use dataType: \"intraday\" for intraday if your plan supports it.",
  tags: ["stocks", "prices", "markets"],
  schemaVersion: 1,
  defaultTtlMs: 10 * 60_000,
  paramsSchema: MarketstackParams,
  fetch: async (params) => {
    const parsed = MarketstackParams.parse(params);
    const apiKey = getSecret("MARKETSTACK_API_KEY");
    if (!apiKey) throw new Error("MARKETSTACK_API_KEY not configured");

    const symbols = parsed.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (symbols.length === 0) throw new Error("No symbols provided");

    const endpoint = parsed.dataType === "intraday" ? "intraday/latest" : "eod/latest";
    const url = new URL(`https://api.marketstack.com/v1/${endpoint}`);
    url.searchParams.set("access_key", apiKey);
    url.searchParams.set("symbols", symbols.join(","));
    if (parsed.exchange) url.searchParams.set("exchange", parsed.exchange);
    if (parsed.interval && parsed.dataType === "intraday") url.searchParams.set("interval", parsed.interval);

    const res = await fetch(url.toString(), { headers: { "User-Agent": "NexusAgent/0.0.1" } });
    if (!res.ok) throw new Error(`Marketstack error: ${res.status} ${res.statusText}`);
    const json = (await res.json()) as MarketstackResponse;
    if (json?.error) throw new Error(`Marketstack error: ${json.error.message ?? json.error.code ?? "Unknown error"}`);
    return { symbols, dataType: parsed.dataType, data: json.data ?? [] };
  },
  normalize: (raw, params, ctx) => {
    const parsed = MarketstackParams.parse(params);
    const payload = raw as { symbols: string[]; dataType: string; data: MarketstackItem[] };
    const bySymbol = new Map<string, MarketstackItem>();
    for (const item of payload.data ?? []) {
      const sym = item.symbol?.toUpperCase();
      if (sym && !bySymbol.has(sym)) bySymbol.set(sym, item);
    }

    return payload.symbols.map((symbol) => {
      const sym = symbol.toUpperCase();
      const item = bySymbol.get(sym);
      const price = item ? toNumber(item.close ?? item.last) : null;
      return {
        subject: sym,
        value: item
          ? {
            symbol: sym,
            date: item.date ?? null,
            price,
            open: toNumber(item.open),
            high: toNumber(item.high),
            low: toNumber(item.low),
            close: toNumber(item.close),
            volume: toNumber(item.volume),
            adjOpen: toNumber(item.adj_open),
            adjHigh: toNumber(item.adj_high),
            adjLow: toNumber(item.adj_low),
            adjClose: toNumber(item.adj_close),
            adjVolume: toNumber(item.adj_volume),
            exchange: item.exchange ?? null,
            dataType: payload.dataType,
          }
          : {
            symbol: sym,
            price: null,
            error: "No data available",
            dataType: payload.dataType,
          },
        collectedAtMs: ctx.nowMs(),
        metadata: { provider: "marketstack", dataType: payload.dataType },
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
