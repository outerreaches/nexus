import { z } from "zod";

import type { DataSource } from "../types.js";
import { getSecret } from "../../secrets/resolve-env.js";

type MetalResponse = {
  rates?: Record<string, number>;
  base?: string;
  timestamp?: number;
};

const MetalsParams = z.object({
  base: z.string().default("USD"),
  symbols: z.array(z.string()).min(1).default(["XAU", "XAG"]),
});

export const metalsSource: DataSource = {
  id: "metals.openmetalsapi",
  name: "Open Metals Prices",
  description: "Fetch spot prices for metals using openmetalsapi.com",
  usageNote: "Pass symbols at top level, e.g.: data_intake_source_add({ sourceId: \"metals.openmetalsapi\", symbols: [\"XAU\", \"XAG\"], base: \"USD\" }).",
  tags: ["metals", "prices", "commodities"],
  schemaVersion: 1,
  defaultTtlMs: 30 * 60_000,
  paramsSchema: MetalsParams,
  fetch: async (params, _ctx) => {
    const parsed = MetalsParams.parse(params);
    const apiKey = getSecret("OPEN_METALS_API_KEY");
    if (!apiKey) throw new Error("OPEN_METALS_API_KEY not configured");
    const symbols = parsed.symbols.map((s) => s.toUpperCase()).join(",");
    const url = `https://api.openmetalsapi.com/v1/latest?base=${encodeURIComponent(parsed.base)}&symbols=${encodeURIComponent(symbols)}`;
    const res = await fetch(url, { headers: { "x-api-key": apiKey, "User-Agent": "NexusAgent/0.0.1" } });
    if (!res.ok) throw new Error(`OpenMetals error: ${res.status} ${res.statusText}`);
    return (await res.json()) as MetalResponse;
  },
  normalize: (raw, params, ctx) => {
    const parsed = MetalsParams.parse(params);
    const json = raw as MetalResponse;
    const collectedAtMs = typeof json.timestamp === "number" ? json.timestamp * 1000 : ctx.nowMs();
    const rates = json?.rates ?? {};
    return parsed.symbols.map((symbol) => {
      const key = symbol.toUpperCase();
      return {
        subject: `${key}/${parsed.base.toUpperCase()}`,
        value: {
          base: parsed.base.toUpperCase(),
          symbol: key,
          price: rates[key] ?? null,
        },
        collectedAtMs,
        metadata: {
          provider: "openmetalsapi",
          base: parsed.base.toUpperCase(),
        },
      };
    });
  },
};
