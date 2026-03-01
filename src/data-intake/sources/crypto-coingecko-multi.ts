import { z } from "zod";

import type { DataSource } from "../types.js";

// CoinGecko coins/markets API response item
// https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,ripple,monero,solana,tether&order=market_cap_desc&sparkline=false

type CoinGeckoMarketData = {
  id: string;
  symbol: string;
  name: string;
  current_price: number | null;
  market_cap: number | null;
  total_volume: number | null;
  price_change_percentage_24h: number | null;
  last_updated: string;
};

// Symbol to CoinGecko ID mapping
const SYMBOL_TO_COINGECKO_ID: Record<string, string> = {
  btc: "bitcoin",
  eth: "ethereum",
  xrp: "ripple",
  xmr: "monero",
  sol: "solana",
  usdt: "tether",
};

// CoinGecko ID to symbol mapping (reverse)
const COINGECKO_ID_TO_SYMBOL: Record<string, string> = Object.fromEntries(
  Object.entries(SYMBOL_TO_COINGECKO_ID).map(([symbol, id]) => [id, symbol.toUpperCase()])
);

const CryptoMultiParams = z.object({
  symbols: z.array(z.string()).min(1).default(["BTC", "ETH", "XRP", "XMR", "SOL", "USDT"]),
});

export const cryptoCoingeckoMultiSource: DataSource = {
  id: "crypto.coingecko-multi",
  name: "Crypto Multi-Token (CoinGecko)",
  description: "Fetch multiple crypto prices in a single CoinGecko API call",
  usageNote:
    "Pass params at top level, e.g.: data_intake_source_add({ sourceId: \"crypto.coingecko-multi\", symbols: [\"BTC\", \"ETH\"] }). " +
    "Fetches all tracked cryptos in one request to minimize rate limiting.",
  tags: ["crypto", "prices", "markets", "multi"],
  schemaVersion: 1,
  defaultTtlMs: 5 * 60_000, // 5 minutes
  paramsSchema: CryptoMultiParams,
  fetch: async (params) => {
    const parsed = CryptoMultiParams.parse(params);
    const symbols = parsed.symbols
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    if (symbols.length === 0) throw new Error("No symbols provided");

    // Map symbols to CoinGecko IDs
    const ids = symbols
      .map((symbol) => SYMBOL_TO_COINGECKO_ID[symbol.toLowerCase()])
      .filter(Boolean);

    if (ids.length === 0) throw new Error("No valid symbols provided");

    // Use coins/markets endpoint for richer data including volume and market cap
    const url = new URL("https://api.coingecko.com/api/v3/coins/markets");
    url.searchParams.set("vs_currency", "usd");
    url.searchParams.set("ids", ids.join(","));
    url.searchParams.set("order", "market_cap_desc");
    url.searchParams.set("sparkline", "false");

    const res = await fetch(url.toString(), {
      headers: { "User-Agent": "NexusAgent/0.0.1" },
    });

    if (!res.ok) {
      throw new Error(`CoinGecko error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as CoinGeckoMarketData[];
    return { symbols, data };
  },
  normalize: (raw, _params, ctx) => {
    const payload = raw as { symbols: string[]; data: CoinGeckoMarketData[] };
    const results: Array<{
      subject: string;
      value: unknown;
      collectedAtMs: number;
      ttlMs?: number;
      metadata: Record<string, unknown>;
    }> = [];

    // Create a map of CoinGecko ID to market data for quick lookup
    const dataMap = new Map<string, CoinGeckoMarketData>();
    for (const item of payload.data) {
      if (item.id) {
        dataMap.set(item.id, item);
      }
    }

    const nowMs = ctx.nowMs();

    for (const symbol of payload.symbols) {
      const normalizedSymbol = symbol.toUpperCase();
      const coingeckoId = SYMBOL_TO_COINGECKO_ID[symbol.toLowerCase()];

      if (!coingeckoId) continue;

      const item = dataMap.get(coingeckoId);

      if (!item) {
        // Record not found in response, still create placeholder records
        results.push({
          subject: `CRYPTO-${normalizedSymbol}-PRICE`,
          value: {
            symbol: normalizedSymbol,
            name: normalizedSymbol,
            priceUsd: null,
            change24hPercent: null,
            marketCapUsd: null,
            volume24hUsd: null,
            lastUpdated: null,
          },
          collectedAtMs: nowMs,
          ttlMs: 5 * 60_000,
          metadata: { provider: "coingecko-multi", symbol: normalizedSymbol, error: "not_found" },
        });
        continue;
      }

      const recordValue = {
        symbol: normalizedSymbol,
        name: item.name,
        priceUsd: item.current_price,
        change24hPercent: item.price_change_percentage_24h,
        marketCapUsd: item.market_cap,
        volume24hUsd: item.total_volume,
        lastUpdated: item.last_updated,
      };

      // Generate 4 records per crypto as specified
      results.push(
        {
          subject: `CRYPTO-${normalizedSymbol}-PRICE`,
          value: {
            ...recordValue,
            recordType: "PRICE",
          },
          collectedAtMs: nowMs,
          ttlMs: 5 * 60_000,
          metadata: { provider: "coingecko-multi", symbol: normalizedSymbol, type: "price" },
        },
        {
          subject: `CRYPTO-${normalizedSymbol}-24H-CHANGE`,
          value: {
            ...recordValue,
            recordType: "24H-CHANGE",
          },
          collectedAtMs: nowMs,
          ttlMs: 5 * 60_000,
          metadata: { provider: "coingecko-multi", symbol: normalizedSymbol, type: "24h_change" },
        },
        {
          subject: `CRYPTO-${normalizedSymbol}-MARKET-CAP`,
          value: {
            ...recordValue,
            recordType: "MARKET-CAP",
          },
          collectedAtMs: nowMs,
          ttlMs: 5 * 60_000,
          metadata: { provider: "coingecko-multi", symbol: normalizedSymbol, type: "market_cap" },
        },
        {
          subject: `CRYPTO-${normalizedSymbol}-VOLUME`,
          value: {
            ...recordValue,
            recordType: "VOLUME",
          },
          collectedAtMs: nowMs,
          ttlMs: 5 * 60_000,
          metadata: { provider: "coingecko-multi", symbol: normalizedSymbol, type: "volume" },
        }
      );
    }

    return results;
  },
  snapshotValue: (value) => {
    const v = value as { priceUsd?: number | null; change24hPercent?: number | null; marketCapUsd?: number | null; volume24hUsd?: number | null; recordType?: string } | null;
    if (!v || v.recordType !== "PRICE") return null; // Only snapshot the PRICE record (has all fields)
    return { price: v.priceUsd, change24h: v.change24hPercent, marketCap: v.marketCapUsd, volume: v.volume24hUsd };
  },
  summarize: (records) => {
    // Build a summary grouped by symbol
    const summary: Record<
      string,
      {
        price: number | null;
        change24h: number | null;
        marketCap: number | null;
        volume24h: number | null;
      }
    > = {};

    for (const r of records) {
      const subject = r.subject as string;
      const v = r.value as {
        symbol?: string;
        priceUsd?: number | null;
        change24hPercent?: number | null;
        marketCapUsd?: number | null;
        volume24hUsd?: number | null;
      } | null;

      if (!v?.symbol) continue;

      if (!summary[v.symbol]) {
        summary[v.symbol] = {
          price: null,
          change24h: null,
          marketCap: null,
          volume24h: null,
        };
      }

      if (subject.endsWith("-PRICE")) {
        summary[v.symbol].price = v.priceUsd ?? null;
      } else if (subject.endsWith("-24H-CHANGE")) {
        summary[v.symbol].change24h = v.change24hPercent ?? null;
      } else if (subject.endsWith("-MARKET-CAP")) {
        summary[v.symbol].marketCap = v.marketCapUsd ?? null;
      } else if (subject.endsWith("-VOLUME")) {
        summary[v.symbol].volume24h = v.volume24hUsd ?? null;
      }
    }

    return summary;
  },
};

// Export the symbol mapping for use in other modules
export { SYMBOL_TO_COINGECKO_ID, COINGECKO_ID_TO_SYMBOL };
