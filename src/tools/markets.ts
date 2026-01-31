import { z } from "zod";

import { defineTool } from "../core/tools.js";

const SymbolToCoinGeckoId: Record<string, string> = {
  btc: "bitcoin",
  eth: "ethereum",
  sol: "solana",
  usdc: "usd-coin",
  usdt: "tether",
};

async function resolveCoinGeckoId(symbol: string): Promise<string | null> {
  const s = symbol.toLowerCase();
  if (SymbolToCoinGeckoId[s]) return SymbolToCoinGeckoId[s];
  const url = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { headers: { "User-Agent": "NexusAgent/0.0.1" } });
  if (!res.ok) return null;
  const json = (await res.json()) as any;
  const coins = Array.isArray(json?.coins) ? json.coins : [];
  const match =
    coins.find((c: any) => String(c?.symbol ?? "").toLowerCase() === s) ??
    coins.find((c: any) => String(c?.id ?? "").toLowerCase() === s) ??
    coins[0];
  const id = match?.id ? String(match.id) : null;
  return id;
}

export const marketData = defineTool({
  name: "market_data",
  description: "Fetch simple market data (currently: CoinGecko spot price for common crypto symbols).",
  parameters: z.object({
    instrument: z.string().describe('Symbol like "BTC", "ETH", or pair like "BTC/USD"'),
    currency: z.string().default("usd").describe('Quote currency, e.g. "usd"'),
  }),
  execute: async ({ instrument, currency }) => {
    const symbol = instrument.includes("/") ? instrument.split("/")[0] : instrument;
    const id = await resolveCoinGeckoId(symbol);
    if (!id) return `ERROR: unable to resolve CoinGecko id for ${symbol}`;
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=${encodeURIComponent(currency)}`;
    const res = await fetch(url, { headers: { "User-Agent": "NexusAgent/0.0.1" } });
    if (!res.ok) return `ERROR: market_data failed: ${res.status} ${res.statusText}`;
    const json = (await res.json()) as any;
    const price = json?.[id]?.[currency.toLowerCase()];
    return JSON.stringify({ instrument, id, currency, price }, null, 2);
  },
});

