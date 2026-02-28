import { z } from "zod";

import type { DataSource } from "../types.js";

type AQHIResult = {
  location: string;
  aqhi: number | null;
  category: string | null;
  healthMessage: string | null;
  observedAt: string | null;
  forecast: Array<{ period: string; aqhi: number | null; category: string | null }>;
  sourceUrl: string;
};

const AqiParams = z.object({
  location: z.string().default("Barrie"),
});

function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function deriveHealthMessage(category: string | null): string | null {
  if (!category) return null;
  const c = category.toLowerCase();
  if (c.includes("low")) return "Ideal air quality for outdoor activities.";
  if (c.includes("moderate")) return "Consider reducing or rescheduling strenuous outdoor activities if you experience symptoms.";
  if (c.includes("high")) return "Reduce or reschedule strenuous activities outdoors. Consider reducing outdoor activity.";
  return null;
}

function parseOntarioSummaryRow(location: string, html: string): AQHIResult {
  const normalizedLocation = location.trim().toLowerCase();
  const fallbackLocation = normalizedLocation === "innisfil" ? "Barrie" : location.trim();

  const tableRows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
  const row = tableRows.find((r) => {
    const firstCell = r.match(/<th[^>]*>([\s\S]*?)<\/th>/i)?.[1] ?? r.match(/<td[^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? "";
    const city = stripHtml(firstCell).toLowerCase();
    return city === normalizedLocation || city === fallbackLocation.toLowerCase();
  });

  if (!row) {
    throw new Error(`No AQHI row found for location: ${location}`);
  }

  const locationMatch = row.match(/<th[^>]*>([\s\S]*?)<\/th>/i) ?? row.match(/<td[^>]*>([\s\S]*?)<\/td>/i);
  const resolvedLocation = locationMatch ? stripHtml(locationMatch[1]) : location;

  const riskPairs = [...row.matchAll(/([0-9]+)\s*<br\s*\/?\s*>\s*(Low|Moderate|High|Very High)\s*Risk/gi)].map((m) => ({
    aqhi: Number(m[1]),
    category: `${m[2]} Risk`,
  }));

  const periods = ["Observed", "Tonight", "Tomorrow", "Tomorrow Night", "Day+2"];
  const forecast = riskPairs.slice(1, 5).map((entry, idx) => ({
    period: periods[idx + 1] ?? `Forecast ${idx + 1}`,
    aqhi: entry.aqhi,
    category: entry.category,
  }));

  const observed = riskPairs[0] ?? { aqhi: null, category: null };

  const observedAtMatch = html.match(/Issued at:\s*<[^>]*>\s*([^<]+)\s*<\/[^>]+>/i);

  return {
    location: resolvedLocation,
    aqhi: observed.aqhi,
    category: observed.category,
    healthMessage: deriveHealthMessage(observed.category),
    observedAt: observedAtMatch ? stripHtml(observedAtMatch[1]) : null,
    forecast,
    sourceUrl: "https://weather.gc.ca/airquality/pages/provincial_summary/on_e.html",
  };
}

export const barrieAqiSource: DataSource = {
  id: "weather.aqi-barrie",
  name: "Barrie/Innisfil AQHI",
  description: "Fetch AQHI (Air Quality Health Index) for Barrie/Innisfil area from Environment Canada AQHI pages.",
  usageNote:
    'Optional location param (default "Barrie"). Innisfil is mapped to the Barrie station when no direct row is available. Example: data_intake_run({ sourceId: "weather.aqi-barrie", params: { location: "Barrie" } }).',
  tags: ["weather", "aqhi", "air-quality", "barrie", "innisfil", "ontario"],
  schemaVersion: 1,
  defaultTtlMs: 60 * 60_000,
  paramsSchema: AqiParams,
  fetch: async (params) => {
    const parsed = AqiParams.parse(params);
    const summaryUrl = "https://weather.gc.ca/airquality/pages/provincial_summary/on_e.html";

    const summaryRes = await fetch(summaryUrl, {
      headers: { "User-Agent": "NexusAgent/0.0.1", "Accept": "text/html" },
    });
    if (!summaryRes.ok) {
      throw new Error(`AQHI summary fetch error: ${summaryRes.status} ${summaryRes.statusText}`);
    }

    const summaryHtml = await summaryRes.text();
    return parseOntarioSummaryRow(parsed.location, summaryHtml);
  },
  normalize: (raw, params, ctx) => {
    const parsed = AqiParams.parse(params);
    const payload = raw as AQHIResult;
    const nowMs = ctx.nowMs();
    const location = (parsed.location.trim() || "Barrie").toUpperCase().replace(/\s+/g, "-");

    return [
      {
        subject: `AQHI-${location}`,
        value: {
          location: payload.location,
          aqhi: payload.aqhi,
          category: payload.category,
          healthMessage: payload.healthMessage,
          observedAt: payload.observedAt,
          forecast: payload.forecast,
          sourceUrl: payload.sourceUrl,
        },
        collectedAtMs: nowMs,
        ttlMs: 60 * 60_000,
        metadata: {
          provider: "environment-canada",
          location: payload.location,
        },
      },
    ];
  },
  summarize: (records) => {
    if (records.length === 0) return null;
    const value = records[0].value as AQHIResult;
    return {
      location: value.location,
      aqhi: value.aqhi,
      category: value.category,
      observedAt: value.observedAt,
    };
  },
};
