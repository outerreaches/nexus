import { z } from "zod";

import type { DataSource } from "../types.js";

/**
 * Open-Meteo Weather Forecast Source
 *
 * This data source fetches hourly weather forecast data from the Open-Meteo API
 * (https://api.open-meteo.com). For a given latitude/longitude, it retrieves:
 *   - Temperature (°C)
 *   - "Feels like" temperature (°C)
 *   - Relative humidity (%)
 *   - Precipitation probability (%)
 *   - Wind speed (km/h)
 *   - Weather condition codes (WMO codes)
 *
 * Each data item represents one hourly forecast with all above metrics,
 * tagged with location and timestamp. Records have TTL based on forecast hour.
 */
type WeatherResponse = {
  latitude?: number;
  longitude?: number;
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    apparent_temperature?: number[];
    relative_humidity_2m?: number[];
    precipitation_probability?: number[];
    wind_speed_10m?: number[];
    weather_code?: number[];
  };
};

const WeatherParams = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const weatherSource: DataSource = {
  id: "weather.open-meteo",
  name: "Open-Meteo Forecast",
  description: "Fetch hourly weather forecast (temperature, feels like, humidity, wind, conditions) from open-meteo.com",
  usageNote: "Pass coordinates at top level, e.g.: data_intake_source_add({ sourceId: \"weather.open-meteo\", latitude: 37.7749, longitude: -122.4194 }).",
  tags: ["weather", "forecast"],
  schemaVersion: 2,
  defaultTtlMs: 2 * 60 * 60_000,
  paramsSchema: WeatherParams,
  fetch: async (params) => {
    const parsed = WeatherParams.parse(params);
    const url = [
      "https://api.open-meteo.com/v1/forecast",
      `?latitude=${encodeURIComponent(parsed.latitude)}`,
      `&longitude=${encodeURIComponent(parsed.longitude)}`,
      "&hourly=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,wind_speed_10m,weather_code",
      "&timezone=UTC",
    ].join("");
    const res = await fetch(url, { headers: { "User-Agent": "NexusAgent/0.0.1" } });
    if (!res.ok) throw new Error(`OpenMeteo error: ${res.status} ${res.statusText}`);
    return (await res.json()) as WeatherResponse;
  },
  normalize: (raw, params, ctx) => {
    const parsed = WeatherParams.parse(params);
    const json = raw as WeatherResponse;
    const hourly = json?.hourly ?? {};
    const times = hourly.time ?? [];
    const temps = hourly.temperature_2m ?? [];
    const feelsLike = hourly.apparent_temperature ?? [];
    const humidity = hourly.relative_humidity_2m ?? [];
    const precip = hourly.precipitation_probability ?? [];
    const wind = hourly.wind_speed_10m ?? [];
    const codes = hourly.weather_code ?? [];
    const location = `${parsed.latitude},${parsed.longitude}`;
    const nowMs = ctx.nowMs();

    return times.map((time, idx) => {
      const hourMs = new Date(time).getTime();
      const ttlMs = Math.max(3600_000, hourMs - nowMs + 3600_000);

      return {
        subject: `${location}@${time}`,
        value: {
          location,
          time,
          temperatureC: temps[idx] ?? null,
          feelsLikeC: feelsLike[idx] ?? null,
          humidityPercent: humidity[idx] ?? null,
          precipitationProbability: precip[idx] ?? null,
          windSpeedKmh: wind[idx] ?? null,
          weatherCode: codes[idx] ?? null,
        },
        collectedAtMs: nowMs,
        ttlMs,
        metadata: { provider: "open-meteo", latitude: parsed.latitude, longitude: parsed.longitude },
      };
    });
  },
  summarize: (records, ctx) => {
    const nowMs = ctx.nowMs();
    // Find the record closest to the current hour
    let closest = records[0];
    let closestDiff = Infinity;
    for (const r of records) {
      const val = r.value as { time?: string } | null;
      if (val?.time) {
        const hourMs = new Date(val.time).getTime();
        const diff = Math.abs(hourMs - nowMs);
        if (diff < closestDiff) {
          closestDiff = diff;
          closest = r;
        }
      }
    }
    if (!closest) return null;
    const v = closest.value as Record<string, unknown>;
    return {
      current: {
        time: v.time,
        temperatureC: v.temperatureC,
        feelsLikeC: v.feelsLikeC,
        humidityPercent: v.humidityPercent,
        precipitationProbability: v.precipitationProbability,
        windSpeedKmh: v.windSpeedKmh,
        weatherCode: v.weatherCode,
      },
    };
  },
};
