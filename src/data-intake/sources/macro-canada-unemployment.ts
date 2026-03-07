/**
 * Canada Unemployment Rate Data Source
 *
 * Fetches Labour Force Survey unemployment rate data from Statistics Canada WDS
 * using vector v2062815 (table 14-10-0287-01, seasonally adjusted).
 */

import { z } from "zod";

import type { DataSource } from "../types.js";

type StatCanVectorDataPoint = {
  refPer?: string;
  refPerRaw?: string;
  value?: number | string;
  releaseTime?: string;
};

type StatCanVectorObject = {
  responseStatusCode?: number;
  productId?: number;
  coordinate?: string;
  vectorId?: number;
  vectorDataPoint?: StatCanVectorDataPoint[];
};

type StatCanVectorResponse = Array<{
  status?: string;
  object?: StatCanVectorObject;
}>;

const CanadaUnemploymentParams = z.object({
  daysBack: z.number().int().min(1).max(730).default(180),
});

const STATCAN_PRODUCT_ID = 14100287; // Table 14-10-0287-01
const STATCAN_SERIES_ID = "14-10-0287-01";
const STATCAN_VECTOR_ID = 2062815;

export const canadaUnemploymentSource: DataSource = {
  id: "macro.canada-unemployment",
  name: "Canada Unemployment Rate",
  description: "Statistics Canada Labour Force Survey unemployment rate (seasonally adjusted)",
  usageNote: "Fetches latest Canadian unemployment rate and recent monthly history. Optional daysBack param (default 180, max 730).",
  tags: ["macro", "canada", "unemployment", "labour", "economics", "statcan"],
  schemaVersion: 1,
  defaultTtlMs: 24 * 60 * 60_000, // 24 hours
  paramsSchema: CanadaUnemploymentParams,
  fetch: async (params, _ctx) => {
    const parsed = CanadaUnemploymentParams.parse(params);

    // StatCan endpoint requires latestN periods, so map daysBack to months with small buffer.
    const latestN = Math.max(6, Math.min(36, Math.ceil(parsed.daysBack / 30) + 2));

    const res = await fetch("https://www150.statcan.gc.ca/t1/wds/rest/getDataFromVectorsAndLatestNPeriods", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "NexusAgent/0.0.1",
        Accept: "application/json",
      },
      body: JSON.stringify([{ vectorId: STATCAN_VECTOR_ID, latestN }]),
    });

    if (!res.ok) {
      throw new Error(`StatCan API error: ${res.status} ${res.statusText}`);
    }

    return (await res.json()) as StatCanVectorResponse;
  },
  normalize: (raw, params, ctx) => {
    const parsed = CanadaUnemploymentParams.parse(params);
    const payload = raw as StatCanVectorResponse;
    const vectorDataPoints = payload?.[0]?.object?.vectorDataPoint ?? [];

    type Observation = {
      date: string;
      rate: number;
      releaseTime?: string;
    };

    const observations: Observation[] = vectorDataPoints
      .map((point) => {
        const parsedRate = typeof point.value === "string" ? Number.parseFloat(point.value) : point.value;
        const date = point.refPerRaw ?? point.refPer;
        if (typeof date !== "string" || !Number.isFinite(parsedRate)) {
          return null;
        }
        return {
          date,
          rate: parsedRate,
          releaseTime: point.releaseTime,
        };
      })
      .filter((obs): obs is Observation => obs !== null)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    if (observations.length === 0) {
      return [];
    }

    const now = new Date(ctx.nowMs());
    const threshold = new Date(now);
    threshold.setDate(now.getDate() - parsed.daysBack);

    const withinRange = observations.filter((obs) => new Date(obs.date).getTime() >= threshold.getTime());
    const series = withinRange.length >= 2 ? withinRange : observations;

    const latest = series[0];
    if (!latest) {
      return [];
    }

    const previous = series[1];
    const change = previous ? latest.rate - previous.rate : undefined;
    const changePercent = previous && previous.rate !== 0 ? (change! / previous.rate) * 100 : undefined;

    return [
      {
        subject: "canada.unemployment-rate.latest",
        value: {
          currentRate: latest.rate,
          previousRate: previous?.rate,
          change,
          changePercent,
          effectiveDate: latest.date,
          releaseTime: latest.releaseTime,
          history: series.slice(0, 12).map((obs) => ({
            date: obs.date,
            rate: obs.rate,
            releaseTime: obs.releaseTime,
          })),
          seriesId: STATCAN_SERIES_ID,
          productId: STATCAN_PRODUCT_ID,
          vectorId: `v${STATCAN_VECTOR_ID}`,
          frequency: "monthly",
          adjustment: "seasonally-adjusted",
        },
        collectedAtMs: ctx.nowMs(),
        metadata: {
          provider: "statcan",
          productId: STATCAN_PRODUCT_ID,
          seriesId: STATCAN_SERIES_ID,
          vectorId: `v${STATCAN_VECTOR_ID}`,
          daysBack: parsed.daysBack,
          totalObservations: observations.length,
        },
      },
    ];
  },
  summarize: (records) => {
    if (records.length === 0) {
      return null;
    }

    const latest = records[0]?.value as {
      currentRate?: number;
      previousRate?: number;
      change?: number;
      changePercent?: number;
      effectiveDate?: string;
    } | undefined;

    return {
      currentRate: latest?.currentRate ?? null,
      previousRate: latest?.previousRate ?? null,
      change: latest?.change ?? null,
      changePercent: latest?.changePercent ?? null,
      effectiveDate: latest?.effectiveDate ?? null,
    };
  },
};
