import { z } from "zod";

import type { DataSource } from "../types.js";

type HydroRateKey = "offPeak" | "midPeak" | "onPeak";

type HydroRateValue = {
  period: HydroRateKey;
  label: string;
  centsPerKwh: number;
};

type HydroPayload = {
  source: "oeb-api" | "oeb-web";
  fetchedAt: string;
  effectiveDate?: string | null;
  rates: Record<HydroRateKey, HydroRateValue>;
};

const HydroParams = z.object({});

const PERIOD_LABELS: Record<HydroRateKey, string> = {
  offPeak: "Off-Peak",
  midPeak: "Mid-Peak",
  onPeak: "On-Peak",
};

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseRatesFromApi(raw: unknown): HydroPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const ratesObj =
    (obj.rates as Record<string, unknown> | undefined) ??
    (obj.current as Record<string, unknown> | undefined) ??
    (obj.tou as Record<string, unknown> | undefined) ??
    obj;

  const getRate = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = (ratesObj as Record<string, unknown>)[key];
      const n = toNumber(value);
      if (n !== null) return n;
    }
    return null;
  };

  const offPeak = getRate("offPeak", "off_peak", "offpeak", "offPeakCents", "offPeakCentsPerKwh");
  const midPeak = getRate("midPeak", "mid_peak", "midpeak", "midPeakCents", "midPeakCentsPerKwh");
  const onPeak = getRate("onPeak", "on_peak", "onpeak", "onPeakCents", "onPeakCentsPerKwh");

  if (offPeak === null || midPeak === null || onPeak === null) return null;

  return {
    source: "oeb-api",
    fetchedAt: new Date().toISOString(),
    effectiveDate: typeof obj.effectiveDate === "string" ? obj.effectiveDate : null,
    rates: {
      offPeak: { period: "offPeak", label: PERIOD_LABELS.offPeak, centsPerKwh: offPeak },
      midPeak: { period: "midPeak", label: PERIOD_LABELS.midPeak, centsPerKwh: midPeak },
      onPeak: { period: "onPeak", label: PERIOD_LABELS.onPeak, centsPerKwh: onPeak },
    },
  };
}

function parseRatesFromHtml(html: string): HydroPayload {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
  const rates: Partial<Record<HydroRateKey, HydroRateValue>> = {};

  for (const row of rows) {
    const rowText = row.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    let period: HydroRateKey | null = null;

    if (rowText.includes("off-peak")) period = "offPeak";
    else if (rowText.includes("mid-peak")) period = "midPeak";
    else if (rowText.includes("on-peak")) period = "onPeak";

    if (!period) continue;

    const strongNums = [...row.matchAll(/<strong>\s*([0-9]+(?:\.[0-9]+)?)\s*<\/strong>/gi)].map((m) => Number(m[1]));
    const centsPerKwh = strongNums.length > 0 ? strongNums[strongNums.length - 1] : null;
    if (centsPerKwh === null || !Number.isFinite(centsPerKwh)) continue;

    rates[period] = { period, label: PERIOD_LABELS[period], centsPerKwh };
  }

  if (!rates.offPeak || !rates.midPeak || !rates.onPeak) {
    throw new Error("Unable to parse TOU rates from OEB electricity rates page");
  }

  const effectiveDateMatch = html.match(/Current prices[\s\S]*?for\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/i);

  return {
    source: "oeb-web",
    fetchedAt: new Date().toISOString(),
    effectiveDate: effectiveDateMatch?.[1] ?? null,
    rates: {
      offPeak: rates.offPeak,
      midPeak: rates.midPeak,
      onPeak: rates.onPeak,
    },
  };
}

export const ontarioHydroSource: DataSource = {
  id: "utilities.ontario-hydro",
  name: "Ontario Hydro TOU Rates",
  description: "Fetch current Ontario time-of-use electricity rates (off-peak, mid-peak, on-peak) from OEB.",
  usageNote:
    'No params required. Example: data_intake_run({ sourceId: "utilities.ontario-hydro" }). Attempts OEB API first and falls back to OEB web page parsing.',
  tags: ["utilities", "ontario", "hydro", "electricity", "rates", "oeb"],
  schemaVersion: 1,
  defaultTtlMs: 60 * 60_000,
  paramsSchema: HydroParams,
  fetch: async (params) => {
    HydroParams.parse(params);

    const apiUrl = "https://api.oeb.ca/v1/rates/electricity/current";
    try {
      const apiRes = await fetch(apiUrl, {
        headers: { "User-Agent": "NexusAgent/0.0.1", "Accept": "application/json" },
      });
      if (apiRes.ok) {
        const apiJson = await apiRes.json();
        const parsedApi = parseRatesFromApi(apiJson);
        if (parsedApi) return parsedApi;
      }
    } catch {
      // Fall back to OEB web page parsing below.
    }

    const webUrl = "https://www.oeb.ca/rates-and-your-bill/electricity-rates";
    const webRes = await fetch(webUrl, {
      headers: { "User-Agent": "NexusAgent/0.0.1", "Accept": "text/html" },
    });
    if (!webRes.ok) {
      throw new Error(`OEB web fetch error: ${webRes.status} ${webRes.statusText}`);
    }
    const html = await webRes.text();
    return parseRatesFromHtml(html);
  },
  normalize: (raw, _params, ctx) => {
    const payload = raw as HydroPayload;
    const nowMs = ctx.nowMs();
    const periods: HydroRateKey[] = ["offPeak", "midPeak", "onPeak"];

    return periods.map((period) => ({
      subject: `ON-HYDRO-${period.toUpperCase()}`,
      value: {
        period,
        label: payload.rates[period].label,
        centsPerKwh: payload.rates[period].centsPerKwh,
        effectiveDate: payload.effectiveDate ?? null,
        fetchedAt: payload.fetchedAt,
      },
      collectedAtMs: nowMs,
      ttlMs: 60 * 60_000,
      metadata: {
        provider: "oeb",
        source: payload.source,
      },
    }));
  },
  summarize: (records) => {
    const summary: Record<string, number | null> = {
      offPeak: null,
      midPeak: null,
      onPeak: null,
    };

    for (const record of records) {
      const value = record.value as { period?: string; centsPerKwh?: number } | null;
      if (value?.period && typeof value.centsPerKwh === "number") {
        summary[value.period] = value.centsPerKwh;
      }
    }

    return { touCentsPerKwh: summary };
  },
};
