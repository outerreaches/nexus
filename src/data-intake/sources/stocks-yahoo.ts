import { z } from "zod";

import type { DataSource } from "../types.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const REQUEST_DELAY_MS = 200;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)",
        Accept: "application/json",
      },
    });

    if (res.ok) return res;

    if (res.status === 404) return res;

    if (res.status === 429 || res.status >= 500) {
      if (attempt < retries) {
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
    }

    return res;
  }

  throw new Error("Max retries exceeded");
}

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      meta?: {
        symbol?: string;
        regularMarketPrice?: number;
        previousClose?: number;
        currency?: string;
        exchangeName?: string;
        regularMarketTime?: number;
        fiftyTwoWeekHigh?: number;
        fiftyTwoWeekLow?: number;
        regularMarketDayHigh?: number;
        regularMarketDayLow?: number;
        regularMarketVolume?: number;
      };
    }>;
    error?: {
      code?: string;
      description?: string;
    };
  };
};

const YahooStocksParams = z.object({
  symbols: z.array(z.string()).min(1),
});

export const yahooStocksSource: DataSource = {
  id: "stocks.yahoo",
  name: "Yahoo Finance Stocks",
  description: "Fetch stock quotes via Yahoo Finance (unofficial API, no key required)",
  usageNote:
    "Provide ticker symbols. Example params: { symbols: [\"AAPL\", \"MSFT\"] }. Note: This uses an unofficial API that may break without notice.",
  tags: ["stocks", "prices", "markets", "free"],
  schemaVersion: 1,
  defaultTtlMs: 10 * 60_000,
  paramsSchema: YahooStocksParams,
  fetch: async (params) => {
    const parsed = YahooStocksParams.parse(params);
    const results: Record<string, YahooChartResponse> = {};

    for (let i = 0; i < parsed.symbols.length; i++) {
      const symbol = parsed.symbols[i];

      if (i > 0) await sleep(REQUEST_DELAY_MS);

      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;

      try {
        const res = await fetchWithRetry(url);

        if (!res.ok) {
          if (res.status === 404) {
            results[symbol] = { chart: { error: { code: "NOT_FOUND", description: `Symbol ${symbol} not found` } } };
            continue;
          }
          results[symbol] = {
            chart: { error: { code: `HTTP_${res.status}`, description: `HTTP ${res.status} ${res.statusText}` } },
          };
          continue;
        }

        const text = await res.text();
        try {
          results[symbol] = JSON.parse(text) as YahooChartResponse;
        } catch {
          results[symbol] = { chart: { error: { code: "PARSE_ERROR", description: "Invalid JSON response" } } };
        }
      } catch (e) {
        results[symbol] = {
          chart: { error: { code: "FETCH_ERROR", description: e instanceof Error ? e.message : String(e) } },
        };
      }
    }

    return results;
  },
  normalize: (raw, params, ctx) => {
    const parsed = YahooStocksParams.parse(params);
    const json = raw as Record<string, YahooChartResponse>;

    return parsed.symbols.map((symbol) => {
      const chart = json?.[symbol]?.chart;
      const error = chart?.error;
      const meta = chart?.result?.[0]?.meta;

      if (error || !meta) {
        return {
          subject: symbol.toUpperCase(),
          value: {
            symbol: symbol.toUpperCase(),
            price: null,
            error: error?.description ?? "No data available",
          },
          collectedAtMs: ctx.nowMs(),
          metadata: { provider: "yahoo" },
        };
      }

      return {
        subject: symbol.toUpperCase(),
        value: {
          symbol: meta.symbol ?? symbol.toUpperCase(),
          price: meta.regularMarketPrice ?? null,
          previousClose: meta.previousClose ?? null,
          currency: meta.currency ?? null,
          exchange: meta.exchangeName ?? null,
          dayHigh: meta.regularMarketDayHigh ?? null,
          dayLow: meta.regularMarketDayLow ?? null,
          fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
          fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
          volume: meta.regularMarketVolume ?? null,
          marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
        },
        collectedAtMs: ctx.nowMs(),
        metadata: { provider: "yahoo" },
      };
    });
  },
};
