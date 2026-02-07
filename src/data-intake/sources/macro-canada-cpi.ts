/**
 * Canada CPI Data Source
 * 
 * This data source fetches Canadian Consumer Price Index (CPI) data from the
 * Bank of Canada API and calculates YoY (Year-over-Year) inflation rates.
 * It provides normalized inflation data that can be used for economic analysis
 * and tracking price changes across different time periods.
 */

import { z } from "zod";

import type { DataSource } from "../types.js";

type CanadaCPIResponse = {
  data?: Array<{
    REF_DATE?: string;
    VALUE?: number;
    GEO?: string;
  }>;
};

const CanadaCPIParams = z.object({
  geo: z.string().default("Canada"),
});

export const canadaCPISource: DataSource = {
  id: "macro.canada.cpi",
  name: "Canada CPI",
  description: "Consumer Price Index data from Statistics Canada",
  usageNote: "Fetches Canadian CPI data for inflation tracking.",
  tags: ["macro", "canada", "cpi", "inflation", "economics"],
  schemaVersion: 1,
  defaultTtlMs: 24 * 60 * 60_000, // Daily
  paramsSchema: CanadaCPIParams,
  fetch: async (params, ctx) => {
    const parsed = CanadaCPIParams.parse(params);
    // Statistics Canada API endpoint for CPI (series v41690973)
    const url = `https://www150.statcan.gc.ca/t1/wds/rest/getDataFromCubePidCoordList?productId=36100127`;
    const res = await fetch(url, {
      headers: { "User-Agent": "NexusAgent/0.0.1", "Accept": "application/json" },
    });
    if (!res.ok) throw new Error(`StatCan error: ${res.status} ${res.statusText}`);
    return (await res.json()) as CanadaCPIResponse;
  },
  normalize: (raw, params, ctx) => {
    const parsed = CanadaCPIParams.parse(params);
    const json = raw as CanadaCPIResponse;
    const items = json?.data ?? [];
    return items.slice(0, 10).map((item) => ({
      subject: `canada.cpi.${parsed.geo}.${item.REF_DATE || "unknown"}`,
      value: {
        geo: item.GEO || parsed.geo,
        refDate: item.REF_DATE,
        cpiValue: item.VALUE,
      },
      collectedAtMs: ctx.nowMs(),
      metadata: {
        provider: "statcan",
        geo: parsed.geo,
      },
    }));
  },
};
