import { z } from "zod";

import type { DataSource } from "../types.js";

type CoinGeckoResponse = {
  [id: string]: {
    [currency: string]: number;
  };
};

const CryptoParams = z.object({
  symbols: z.array(z.string()).min(1).default(["BTC", "ETH"]),
  currency: z.string().default("usd"),
});

const SymbolToCoinGeckoId: Record<string, string> = {
  btc: "bitcoin",
  eth: "ethereum",
  sol: "solana",
  usdc: "usd-coin",
  usdt: "tether",
};

async function resolveCoinGeckoIds(symbols: string[]): Promise<Record<string, string | null>> {
  const results: Record<string, string | null> = {};
  for (const symbol of symbols) {
    const key = symbol.toLowerCase();
    if (SymbolToCoinGeckoId[key]) {
      results[symbol] = SymbolToCoinGeckoId[key];
      continue;
    }
    const url = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`;
    const res = await fetch(url, { headers: { "User-Agent": "NexusAgent/0.0.1" } });
    if (!res.ok) {
      results[symbol] = null;
      continue;
    }
    const json = (await res.json()) as any;
    const coins = Array.isArray(json?.coins) ? json.coins : [];
    const match =
      coins.find((c: any) => String(c?.symbol ?? "").toLowerCase() === key) ??
      coins.find((c: any) => String(c?.id ?? "").toLowerCase() === key) ??
      coins[0];
    results[symbol] = match?.id ? String(match.id) : null;
  }
  return results;
}

export const cryptoSource: DataSource = {
  id: "crypto.coingecko",
  name: "CoinGecko Spot Prices",
  description: "Fetch spot prices for crypto symbols via CoinGecko",
  tags: ["crypto", "prices", "markets"],
  schemaVersion: 1,
  defaultTtlMs: 5 * 60_000,
  paramsSchema: CryptoParams,
  fetch: async (params) => {
    const parsed = CryptoParams.parse(params);
    const idsMap = await resolveCoinGeckoIds(parsed.symbols);
    const ids = Object.values(idsMap).filter(Boolean) as string[];
    if (ids.length === 0) {
      throw new Error("No CoinGecko ids resolved for requested symbols");
    }
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=${encodeURIComponent(parsed.currency)}`;
    const res = await fetch(url, { headers: { "User-Agent": "NexusAgent/0.0.1" } });
    if (!res.ok) throw new Error(`CoinGecko error: ${res.status} ${res.statusText}`);
    return { idsMap, data: (await res.json()) as CoinGeckoResponse };
  },
  normalize: (raw, params, ctx) => {
    const parsed = CryptoParams.parse(params);
    const json = raw as { idsMap: Record<string, string | null>; data: CoinGeckoResponse };
    const results = parsed.symbols.map((symbol) => {
      const id = json.idsMap[symbol];
      const price = id ? json.data?.[id]?.[parsed.currency.toLowerCase()] ?? null : null;
      return {
        subject: `${symbol.toUpperCase()}/${parsed.currency.toUpperCase()}`,
        value: {
          symbol: symbol.toUpperCase(),
          currency: parsed.currency.toUpperCase(),
          price,
        },
        collectedAtMs: ctx.nowMs(),
        metadata: { provider: "coingecko", id },
      };
    });
    return results;
  },
};
