import { z } from "zod";

import type { DataSource } from "../types.js";

type CoinGeckoResponse = {
  [id: string]: {
    [currency: string]: number;
  };
};

const CryptoParams = z.object({
  ids: z.array(z.string()).min(1),
  currency: z.string().default("usd"),
});

export const cryptoSource: DataSource = {
  id: "crypto.coingecko",
  name: "CoinGecko Spot Prices",
  description: "Fetch spot prices for CoinGecko ids (one record per token)",
  usageNote:
    "Provide CoinGecko ids (not symbols). Each id is stored as a single subject. " +
    "Example params: { ids: [\"bitcoin\", \"ethereum\", \"solana\"], currency: \"usd\" }.",
  tags: ["crypto", "prices", "markets"],
  schemaVersion: 1,
  defaultTtlMs: 5 * 60_000,
  paramsSchema: CryptoParams,
  fetch: async (params) => {
    const parsed = CryptoParams.parse(params);
    const ids = parsed.ids.map((id) => id.trim().toLowerCase()).filter(Boolean);
    if (ids.length === 0) throw new Error("No CoinGecko ids provided");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=${encodeURIComponent(parsed.currency)}`;
    const res = await fetch(url, { headers: { "User-Agent": "NexusAgent/0.0.1" } });
    if (!res.ok) throw new Error(`CoinGecko error: ${res.status} ${res.statusText}`);
    return { ids, data: (await res.json()) as CoinGeckoResponse };
  },
  normalize: (raw, params, ctx) => {
    const parsed = CryptoParams.parse(params);
    const json = raw as { ids: string[]; data: CoinGeckoResponse };
    const results = parsed.ids.map((id) => {
      const normalizedId = id.trim().toLowerCase();
      const price = normalizedId ? json.data?.[normalizedId]?.[parsed.currency.toLowerCase()] ?? null : null;
      return {
        subject: normalizedId,
        value: {
          id: normalizedId,
          currency: parsed.currency.toUpperCase(),
          price,
        },
        collectedAtMs: ctx.nowMs(),
        metadata: { provider: "coingecko", id: normalizedId },
      };
    });
    return results;
  },
  summarize: (records) => {
    // Return a simple {token: price} mapping
    const prices: Record<string, number | null> = {};
    for (const r of records) {
      const v = r.value as { id?: string; price?: number | null } | null;
      if (v?.id) {
        prices[v.id] = v.price ?? null;
      }
    }
    return { prices };
  },
};
