/**
 * Bank of Canada Policy Rate Data Source
 * 
 * This data source fetches the Bank of Canada overnight lending rate
 * (policy interest rate) from the Bank of Canada Valet API.
 * Provides current rate, effective date, and recent history.
 */

import { z } from "zod";

import type { DataSource } from "../types.js";

// Bank of Canada Valet API response types
type BocSeriesResponse = {
  seriesDetail?: {
    label?: string;
    description?: string;
  };
  observations?: Array<{
    d: string; // date
    v: string | number; // value (can be ".." for missing)
  }>;
};

const BankOfCanadaPolicyRateParams = z.object({
  daysBack: z.number().int().min(1).max(365).default(30),
});

// Bank of Canada Valet API series ID for overnight lending rate
const BOC_SERIES_ID = "V39079";

export const bankOfCanadaPolicyRateSource: DataSource = {
  id: "macro.bankofcanada-policy-rate",
  name: "Bank of Canada Policy Rate",
  description: "Bank of Canada overnight lending rate (policy interest rate) from Valet API",
  usageNote: "Fetches current and recent policy rate history. Optional daysBack param (default 30, max 365).",
  tags: ["macro", "canada", "interest-rate", "bank-of-canada", "economics", "monetary-policy"],
  schemaVersion: 1,
  defaultTtlMs: 24 * 60 * 60_000, // 24 hours
  paramsSchema: BankOfCanadaPolicyRateParams,
  fetch: async (params, _ctx) => {
    const parsed = BankOfCanadaPolicyRateParams.parse(params);
    
    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - parsed.daysBack);
    
    const formatDate = (d: Date) => d.toISOString().split("T")[0];
    const startStr = formatDate(startDate);
    const endStr = formatDate(endDate);
    
    // Bank of Canada Valet API endpoint
    const url = `https://www.bankofcanada.ca/valet/observations/${BOC_SERIES_ID}/json?start_date=${startStr}&end_date=${endStr}`;
    
    const res = await fetch(url, {
      headers: { 
        "User-Agent": "NexusAgent/0.0.1", 
        "Accept": "application/json" 
      },
    });
    
    if (!res.ok) {
      throw new Error(`Bank of Canada API error: ${res.status} ${res.statusText}`);
    }
    
    return (await res.json()) as BocSeriesResponse;
  },
  normalize: (raw, params, ctx) => {
    const parsed = BankOfCanadaPolicyRateParams.parse(params);
    const json = raw as BocSeriesResponse;
    const observations = json?.observations ?? [];
    
    // Filter out missing values ("..") and parse
    const validObservations = observations
      .filter((obs) => obs.v !== ".." && obs.v !== "" && obs.v !== null && obs.v !== undefined)
      .map((obs) => ({
        date: obs.d,
        rate: typeof obs.v === "string" ? parseFloat(obs.v) : obs.v,
      }))
      .filter((obs) => !isNaN(obs.rate));
    
    if (validObservations.length === 0) {
      return [];
    }
    
    // Sort by date descending to get latest first
    validObservations.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    
    const latest = validObservations[0];
    const previous = validObservations[1];
    
    // Calculate change from previous rate if available
    const change = previous ? latest.rate - previous.rate : undefined;
    const changePercent = previous ? ((change! / previous.rate) * 100) : undefined;
    
    return [
      {
        subject: "bankofcanada.policy-rate.latest",
        value: {
          currentRate: latest.rate,
          effectiveDate: latest.date,
          previousRate: previous?.rate,
          change: change,
          changePercent: changePercent,
          history: validObservations.slice(0, 10), // Last 10 observations
          seriesLabel: json?.seriesDetail?.label,
          seriesDescription: json?.seriesDetail?.description,
        },
        collectedAtMs: ctx.nowMs(),
        metadata: {
          provider: "bank-of-canada",
          seriesId: BOC_SERIES_ID,
          daysBack: parsed.daysBack,
          totalObservations: validObservations.length,
        },
      },
    ];
  },
};
