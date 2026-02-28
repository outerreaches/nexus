import { z } from "zod";

import type { DataSource } from "../types.js";

type TrafficEvent = {
  DT_RowId?: string;
  id?: number;
  type?: string;
  layerName?: string;
  roadwayName?: string;
  description?: string;
  sourceId?: string;
  source?: string;
  comment?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  lastUpdated?: string | null;
  direction?: string | null;
  laneDescription?: string | null;
  region?: string | null;
  city?: string | null;
};

type TrafficApiResponse = {
  draw?: number;
  recordsTotal?: number;
  recordsFiltered?: number;
  data?: TrafficEvent[];
};

const TrafficParams = z.object({
  highway: z.string().default("400,11"),
  limit: z.number().int().min(1).max(200).default(100),
});

const DEFAULT_QUERY = {
  draw: 1,
  columns: [],
  order: [],
  start: 0,
  length: 200,
  search: { value: "", regex: false },
};

function parseHighwayFilter(highway: string): string[] {
  return highway
    .split(",")
    .map((h) => h.trim().toUpperCase())
    .filter(Boolean)
    .map((h) => (h.startsWith("HWY") ? h : `HWY ${h}`));
}

function matchesHighway(event: TrafficEvent, filters: string[]): boolean {
  if (filters.length === 0) return true;
  const roadway = (event.roadwayName ?? "").toUpperCase();
  const description = (event.description ?? "").toUpperCase();
  return filters.some((f) => roadway.includes(f) || description.includes(f));
}

export const ontario511TrafficSource: DataSource = {
  id: "traffic.511ontario",
  name: "Ontario 511 Traffic (Hwy 400/11)",
  description: "Fetch incidents, closures, and roadwork from Ontario 511 and filter for Highway 400/11 corridor.",
  usageNote:
    'Optional params: highway (default "400,11"), limit (default 100). Example: data_intake_run({ sourceId: "traffic.511ontario", params: { highway: "400,11" } }).',
  tags: ["traffic", "ontario", "511", "highway", "barrie", "innisfil"],
  schemaVersion: 1,
  defaultTtlMs: 5 * 60_000,
  paramsSchema: TrafficParams,
  fetch: async (params) => {
    const parsed = TrafficParams.parse(params);
    const highways = parseHighwayFilter(parsed.highway);
    const endpoints = [
      { kind: "incidents", url: "https://511on.ca/List/GetData/traffic" },
      { kind: "roadwork", url: "https://511on.ca/List/GetData/Roadwork" },
      { kind: "closures", url: "https://511on.ca/List/GetData/Closures" },
      { kind: "construction", url: "https://511on.ca/List/GetData/ConstructionProjects" },
    ] as const;

    const allEvents: Array<TrafficEvent & { eventKind: string }> = [];

    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint.url, {
          method: "POST",
          headers: {
            "User-Agent": "NexusAgent/0.0.1",
            "Accept": "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(DEFAULT_QUERY),
        });
        if (!res.ok) continue;
        const json = (await res.json()) as TrafficApiResponse;
        const events = (json.data ?? [])
          .filter((event) => matchesHighway(event, highways))
          .slice(0, parsed.limit)
          .map((event) => ({ ...event, eventKind: endpoint.kind }));
        allEvents.push(...events);
      } catch {
        // Continue with other endpoint(s).
      }
    }

    return {
      fetchedAt: new Date().toISOString(),
      highways,
      events: allEvents.slice(0, parsed.limit),
    };
  },
  normalize: (raw, params, ctx) => {
    const parsed = TrafficParams.parse(params);
    const payload = raw as {
      fetchedAt: string;
      highways: string[];
      events: Array<TrafficEvent & { eventKind: string }>;
    };

    const nowMs = ctx.nowMs();

    return payload.events.map((event, idx) => {
      const id = event.DT_RowId ?? String(event.id ?? idx + 1);
      const roadway = event.roadwayName ?? "unknown-roadway";

      return {
        subject: `ON511-${roadway.replace(/\s+/g, "-").toUpperCase()}-${id}`,
        value: {
          id,
          roadwayName: roadway,
          description: event.description ?? null,
          type: event.type ?? event.eventKind,
          eventKind: event.eventKind,
          direction: event.direction ?? null,
          laneDescription: event.laneDescription ?? null,
          startDate: event.startDate ?? null,
          endDate: event.endDate ?? null,
          lastUpdated: event.lastUpdated ?? null,
          region: event.region ?? null,
          city: event.city ?? null,
          source: event.source ?? null,
          sourceId: event.sourceId ?? null,
          highwayFilter: parsed.highway,
          fetchedAt: payload.fetchedAt,
        },
        collectedAtMs: nowMs,
        ttlMs: 5 * 60_000,
        metadata: {
          provider: "511on",
          corridor: payload.highways,
          eventKind: event.eventKind,
        },
      };
    });
  },
  summarize: (records) => {
    const byType: Record<string, number> = {};
    for (const record of records) {
      const value = record.value as { type?: string; eventKind?: string } | null;
      const type = value?.type ?? value?.eventKind ?? "unknown";
      byType[type] = (byType[type] ?? 0) + 1;
    }
    return {
      totalEvents: records.length,
      byType,
    };
  },
};
