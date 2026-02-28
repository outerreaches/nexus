import { z } from "zod";

import type { DataSource } from "../types.js";
import { getSecret } from "../../secrets/resolve-env.js";

type CryptoCompareResponse = {
  Response?: string;
  Message?: string;
} & Record<string, Record<string, number>>;

const CryptoCompareParams = z.object({
  symbols: z.array(z.string()).min(1),
  currencies: z.array(z.string()).min(1).default(["USD"]),
});

export const cryptoCompareSource: DataSource = {
  id: "crypto.cryptocompare",
  name: "CryptoCompare Spot Prices",
  description: "Fetch crypto spot prices via CryptoCompare (pricemulti)",
  usageNote:
    "Pass params at top level, e.g.: data_intake_source_add({ sourceId: \"crypto.cryptocompare\", symbols: [\"BTC\", \"ETH\"], currencies: [\"USD\"] }). " +
    "Requires CRYPTOCOMPARE_API_KEY.",
  tags: ["crypto", "prices", "markets"],
  schemaVersion: 1,
  defaultTtlMs: 5 * 60_000,
  paramsSchema: CryptoCompareParams,
  fetch: async (params) => {
    const parsed = CryptoCompareParams.parse(params);
    const apiKey = getSecret("CRYPTOCOMPARE_API_KEY");
    if (!apiKey) throw new Error("CRYPTOCOMPARE_API_KEY not configured");

    const symbols = parsed.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
    const currencies = parsed.currencies.map((s) => s.trim().toUpperCase()).filter(Boolean);

    const url = new URL("https://min-api.cryptocompare.com/data/pricemulti");
    url.searchParams.set("fsyms", symbols.join(","));
    url.searchParams.set("tsyms", currencies.join(","));
    url.searchParams.set("api_key", apiKey);

    const res = await fetch(url.toString(), { headers: { "User-Agent": "NexusAgent/0.0.1" } });
    if (!res.ok) throw new Error(`CryptoCompare error: ${res.status} ${res.statusText}`);
    const json = (await res.json()) as CryptoCompareResponse;
    if (json.Response === "Error") throw new Error(`CryptoCompare error: ${json.Message ?? "Unknown error"}`);
    return { symbols, currencies, data: json };
  },
  normalize: (raw, _params, ctx) => {
    const payload = raw as { symbols: string[]; currencies: string[]; data: CryptoCompareResponse };
    return payload.symbols.map((symbol) => {
      const prices = payload.data?.[symbol] ?? {};
      return {
        subject: symbol,
        value: {
          symbol,
          prices,
        },
        collectedAtMs: ctx.nowMs(),
        metadata: { provider: "cryptocompare", currencies: payload.currencies },
      };
    });
  },
  summarize: (records) => {
    const prices: Record<string, Record<string, number>> = {};
    for (const r of records) {
      const v = r.value as { symbol?: string; prices?: Record<string, number> } | null;
      if (v?.symbol && v.prices) prices[v.symbol] = v.prices;
    }
    return { prices };
  },
};
