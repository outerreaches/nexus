import { z } from "zod";

import type { DataSource } from "../types.js";

type WeatherResponse = {
  latitude?: number;
  longitude?: number;
  hourly?: { time?: string[]; temperature_2m?: number[]; precipitation_probability?: number[] };
};

const WeatherParams = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const weatherSource: DataSource = {
  id: "weather.open-meteo",
  name: "Open-Meteo Forecast",
  description: "Fetch hourly temperature + precipitation probability from open-meteo.com",
  tags: ["weather", "forecast"],
  schemaVersion: 1,
  defaultTtlMs: 2 * 60 * 60_000,
  paramsSchema: WeatherParams,
  fetch: async (params) => {
    const parsed = WeatherParams.parse(params);
    const url = [
      "https://api.open-meteo.com/v1/forecast",
      `?latitude=${encodeURIComponent(parsed.latitude)}`,
      `&longitude=${encodeURIComponent(parsed.longitude)}`,
      "&hourly=temperature_2m,precipitation_probability",
      "&timezone=UTC",
    ].join("");
    const res = await fetch(url, { headers: { "User-Agent": "NexusAgent/0.0.1" } });
    if (!res.ok) throw new Error(`OpenMeteo error: ${res.status} ${res.statusText}`);
    return (await res.json()) as WeatherResponse;
  },
  normalize: (raw, params, ctx) => {
    const parsed = WeatherParams.parse(params);
    const json = raw as WeatherResponse;
    const times = json?.hourly?.time ?? [];
    const temps = json?.hourly?.temperature_2m ?? [];
    const precip = json?.hourly?.precipitation_probability ?? [];
    const subject = `${parsed.latitude},${parsed.longitude}`;
    const entries = times.map((time, idx) => ({
      time,
      temperatureC: temps[idx] ?? null,
      precipitationProbability: precip[idx] ?? null,
    }));
    return [
      {
        subject,
        value: {
          latitude: parsed.latitude,
          longitude: parsed.longitude,
          hourly: entries,
        },
        collectedAtMs: ctx.nowMs(),
        metadata: { provider: "open-meteo" },
      },
    ];
  },
};
