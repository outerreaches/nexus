import { z } from "zod";

import type { DataSource } from "../types.js";

type CoinlayerResponse = {
  success?: boolean;
  timestamp?: number;
  target?: string;
  rates?: Record<string, number>;
  error?: { code?: number; info?: string };
};

const CoinlayerParams = z.object({
  symbols: z.array(z.string()).min(1),
  target: z.string().default("USD"),
});

export const coinlayerSource: DataSource = {
  id: "crypto.coinlayer",
  name: "Coinlayer Spot Prices",
  description: "Fetch crypto spot prices via Coinlayer live endpoint",
  usageNote:
    "Provide crypto symbols. Example params: { symbols: [\"BTC\", \"ETH\"], target: \"USD\" }. " +
    "Requires COINLAYER_API_KEY.",
  tags: ["crypto", "prices", "markets"],
  schemaVersion: 1,
  defaultTtlMs: 5 * 60_000,
  paramsSchema: CoinlayerParams,
  fetch: async (params) => {
    const parsed = CoinlayerParams.parse(params);
    const apiKey = process.env.COINLAYER_API_KEY;
    if (!apiKey) throw new Error("COINLAYER_API_KEY not configured");

    const symbols = parsed.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
    const url = new URL("https://api.coinlayer.com/live");
    url.searchParams.set("access_key", apiKey);
    url.searchParams.set("target", parsed.target.toUpperCase());
    url.searchParams.set("symbols", symbols.join(","));

    const res = await fetch(url.toString(), { headers: { "User-Agent": "NexusAgent/0.0.1" } });
    if (!res.ok) throw new Error(`Coinlayer error: ${res.status} ${res.statusText}`);
    const json = (await res.json()) as CoinlayerResponse;
    if (json.success === false) throw new Error(`Coinlayer error: ${json.error?.info ?? "Unknown error"}`);
    return { symbols, target: parsed.target.toUpperCase(), data: json };
  },
  normalize: (raw, params, ctx) => {
    const parsed = CoinlayerParams.parse(params);
    const payload = raw as { symbols: string[]; target: string; data: CoinlayerResponse };
    const rates = payload.data?.rates ?? {};
    const collectedAtMs = payload.data?.timestamp ? payload.data.timestamp * 1000 : ctx.nowMs();

    return payload.symbols.map((symbol) => {
      const price = typeof rates[symbol] === "number" ? rates[symbol] : null;
      return {
        subject: symbol,
        value: {
          symbol,
          target: payload.target,
          price,
        },
        collectedAtMs,
        metadata: { provider: "coinlayer" },
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
