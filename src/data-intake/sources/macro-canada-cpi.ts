import { z } from "zod";

import type { DataSource } from "../types.js";

// Statistics Canada WDS API Response types
type WDSResponse = {
  responseStatusCode: number;
  productId: string;
  object?: {
    vectorDataPoint?: Array<{
      refPer: string;
      refPerRaw: string;
      value: number;
      scalarFactorCode?: string;
      symbolCode?: string;
      statusCode?: string;
    }>;
  };
};

const CanadaCPIParams = z.object({
  vectors: z.array(z.string()).min(1).max(10).default(["v41690973"]),
  periods: z.number().min(1).max(24).default(12),
});

// Common Canada CPI vectors
// v41690973 - All-items, Canada, not seasonally adjusted (most common)
// v41690914 - All-items excluding food and energy, Canada
// v41690974 - Food, Canada
// v41690975 - Shelter, Canada
// v41690976 - Household operations, furnishings and equipment, Canada
// v41690977 - Clothing and footwear, Canada
// v41690978 - Transportation, Canada
// v41690979 - Gasoline, Canada
// v41690980 - Health and personal care, Canada
// v41690981 - Recreation, education and reading, Canada
// v41690982 - Alcoholic beverages, tobacco products and recreational cannabis, Canada

export const canadaCPISource: DataSource = {
  id: "macro.canada-cpi",
  name: "Statistics Canada CPI (WDS)",
  description: "Consumer Price Index data from Statistics Canada Web Data Service",
  usageNote: `Common vectors:
- v41690973: All-items, Canada (headline CPI)
- v41690914: All-items excluding food and energy (core CPI)
- v41690974: Food
- v41690975: Shelter
- v41690978: Transportation
- v41690979: Gasoline

Example: data_intake_source_add({ sourceId: "macro.canada-cpi", vectors: ["v41690973"], periods: 12 })`,
  tags: ["macro", "canada", "cpi", "inflation", "statistics-canada"],
  schemaVersion: 1,
  defaultTtlMs: 24 * 60 * 60_000, // 24 hours
  paramsSchema: CanadaCPIParams,
  fetch: async (params, ctx) => {
    const parsed = CanadaCPIParams.parse(params);
    
    const requestBody = {
      vectorIds: parsed.vectors.map(v => v.toLowerCase().startsWith('v') ? v.toLowerCase() : `v${v}`),
      latestN: parsed.periods,
    };

    const url = "https://www150.statcan.gc.ca/t1/wds/rest/getDataFromVectorsAndLatestNPeriods";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "NexusAgent/0.0.1",
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      throw new Error(`StatsCan WDS error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    
    // Handle array response (one entry per vector)
    if (Array.isArray(data)) {
      return data as WDSResponse[];
    }
    
    return [data as WDSResponse];
  },
  normalize: (raw, params, ctx) => {
    const parsed = CanadaCPIParams.parse(params);
    const responses = raw as WDSResponse[];
    const records: Array<{
      subject: string;
      value: Record<string, unknown>;
      collectedAtMs: number;
      metadata?: Record<string, unknown>;
    }> = [];

    for (const [index, response] of responses.entries()) {
      const vectorId = parsed.vectors[index]?.toLowerCase() || "unknown";
      
      if (response.responseStatusCode !== 0) {
        ctx.log(`Warning: StatsCan WDS returned status ${response.responseStatusCode} for ${vectorId}`);
        continue;
      }

      const dataPoints = response.object?.vectorDataPoint || [];
      
      for (const dp of dataPoints) {
        const refPerDate = new Date(dp.refPer);
        const collectedAtMs = refPerDate.getTime() || ctx.nowMs();
        
        records.push({
          subject: `canada.cpi.${vectorId}.${dp.refPerRaw || dp.refPer}`,
          value: {
            vector: vectorId,
            referencePeriod: dp.refPer,
            referencePeriodRaw: dp.refPerRaw,
            value: dp.value,
            scalarFactorCode: dp.scalarFactorCode,
            symbolCode: dp.symbolCode,
            statusCode: dp.statusCode,
          },
          collectedAtMs,
          metadata: {
            productId: response.productId,
            provider: "statistics-canada-wds",
            vector: vectorId,
          },
  summarize: (records, ctx) => {
    type RecordValue = {
      vector?: string;
      referencePeriod?: string;
      value?: number;
    };
    
    const byVector: Record<string, Array<{ value: RecordValue }>> = {};
    
    for (const r of records) {
      const value = r.value as RecordValue;
      const vector = value.vector || "unknown";
      if (!byVector[vector]) byVector[vector] = [];
      byVector[vector].push(r as { value: RecordValue });
    }

    const summary: Record<string, unknown> = {};
    
    for (const [vector, vecRecords] of Object.entries(byVector)) {
      const sorted = vecRecords.sort((a, b) => {
        const dateA = new Date(a.value.referencePeriod || 0).getTime();
        const dateB = new Date(b.value.referencePeriod || 0).getTime();
        return dateB - dateA;
      });
      const latest = sorted[0];
      const previous = sorted[1];
      
      const latestValue = latest?.value?.value;
      const prevValue = previous?.value?.value;
      
      summary[vector] = {
        latestPeriod: latest?.value?.referencePeriod,
        latestValue: latestValue,
        previousPeriod: previous?.value?.referencePeriod,
        previousValue: prevValue,
        yoyChange: prevValue && latestValue ? ((latestValue - prevValue) / prevValue * 100).toFixed(2) + "%" : null,
        dataPoints: vecRecords.length,
      };
    }
    
    return summary;
  },
};
      }
    }

    return records;
  },
  summarize: (records, ctx) => {
    const byVector: Record<string, Array<typeof records[0]>> = {};
    
    for (const r of records) {
      const value = r.value as { vector?: string };
      const vector = value.vector || "unknown";
      if (!byVector[vector]) byVector[vector] = [];
      byVector[vector].push(r);
    }

    const summary: Record<string, unknown> = {};
    
    for (const [vector, vecRecords] of Object.entries(byVector)) {
      const sorted = vecRecords.sort((a, b) => b.collectedAtMs - a.collectedAtMs);
      const latest = sorted[0];
      const previous = sorted[1];
      
      const latestValue = (latest?.value as { value?: number })?.value;
      const prevValue = previous?.value?.value as number;
      
      summary[vector] = {
        latestPeriod: latest?.value?.referencePeriod,
        latestValue: latestValue,
        previousPeriod: previous?.value?.referencePeriod,
        previousValue: prevValue,
        yoyChange: prevValue ? ((latestValue - prevValue) / prevValue * 100).toFixed(2) + "%" : null,
        dataPoints: vecRecords.length,
      };
    }
    
    return summary;
  },
};
