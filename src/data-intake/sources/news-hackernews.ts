import { z } from "zod";

import type { DataSource, NormalizedRecord, DataIntakeContext } from "../types.js";

/**
 * Hacker News Algolia API Response Types
 */
type HNHit = {
  objectID: string;
  title?: string;
  url?: string;
  author?: string;
  points?: number;
  num_comments?: number;
  created_at?: string;
  created_at_i?: number;
  story_id?: number;
  _tags?: string[];
};

type HNResponse = {
  hits: HNHit[];
  nbHits?: number;
  page?: number;
  hitsPerPage?: number;
};

type StoryValue = {
  title: string;
  url: string | null;
  author: string;
  score: number;
  commentCount: number;
  storyId: number;
  createdAt: string;
  rank: number;
  type: "top" | "ask" | "show";
};

const StoryTypeEnum = z.enum(["top", "ask", "show"]);

const HNParams = z.object({
  storyTypes: z.array(StoryTypeEnum).default(["top", "ask", "show"]),
  limit: z.number().int().min(1).max(50).default(20),
});

const API_ENDPOINTS = {
  top: "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30",
  ask: "https://hn.algolia.com/api/v1/search?tags=ask_hn&hitsPerPage=20",
  show: "https://hn.algolia.com/api/v1/search?tags=show_hn&hitsPerPage=20",
};

function normalizeHit(hit: HNHit, rank: number, type: "top" | "ask" | "show"): StoryValue {
  return {
    title: hit.title ?? "Untitled",
    url: hit.url ?? null,
    author: hit.author ?? "unknown",
    score: hit.points ?? 0,
    commentCount: hit.num_comments ?? 0,
    storyId: hit.story_id ?? parseInt(hit.objectID, 10) ?? 0,
    createdAt: hit.created_at ?? new Date().toISOString(),
    rank,
    type,
  };
}

async function fetchStories(type: "top" | "ask" | "show", limit: number): Promise<StoryValue[]> {
  const url = API_ENDPOINTS[type];
  const res = await fetch(url, {
    headers: {
      "User-Agent": "NexusAgent/0.0.1",
      "Accept": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`HN API error (${type}): ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as HNResponse;
  const hits = data.hits ?? [];

  return hits.slice(0, limit).map((hit, idx) => normalizeHit(hit, idx + 1, type));
}

/**
 * Hacker News Top Stories Source
 *
 * Fetches top stories, ask posts, and show posts from the HN Algolia API.
 * Generates normalized records for each story type with rankings and "LATEST" aliases.
 */
export const hackerNewsSource: DataSource = {
  id: "news.hackernews",
  name: "Hacker News Top Stories",
  description: "Fetch top stories, ask posts, and show posts from Hacker News",
  usageNote:
    "Pass storyTypes and limit at top level, e.g.: data_intake_source_add({ sourceId: \"news.hackernews\", storyTypes: [\"top\", \"ask\"], limit: 10 }). " +
    "storyTypes defaults to all types, limit defaults to 20.",
  tags: ["news", "tech", "hackernews", "startup", "programming"],
  schemaVersion: 2,
  defaultTtlMs: 60 * 60_000, // 1 hour
  paramsSchema: HNParams,

  fetch: async (params) => {
    const parsed = HNParams.parse(params);
    const results: Record<string, StoryValue[]> = {};

    for (const type of parsed.storyTypes) {
      results[type] = await fetchStories(type, parsed.limit);
    }

    return results;
  },

  normalize: (raw, params, ctx: DataIntakeContext): NormalizedRecord[] => {
    const parsed = HNParams.parse(params);
    const data = raw as Record<string, StoryValue[]>;
    const records: NormalizedRecord[] = [];
    const nowMs = ctx.nowMs();

    for (const type of parsed.storyTypes) {
      const stories = data[type] ?? [];

      // Generate ranked records for each story
      for (const story of stories) {
        records.push({
          subject: `HN-${type.toUpperCase()}-${story.rank}`,
          value: story,
          collectedAtMs: nowMs,
          ttlMs: 60 * 60_000,
          metadata: { provider: "hackernews", type, rank: story.rank },
        });
      }

      // Generate LATEST alias for #1 story
      if (stories.length > 0) {
        records.push({
          subject: `HN-${type.toUpperCase()}-LATEST`,
          value: stories[0],
          collectedAtMs: nowMs,
          ttlMs: 60 * 60_000,
          metadata: { provider: "hackernews", type, alias: true },
        });
      }
    }

    return records;
  },

  summarize: (records: NormalizedRecord[]) => {
    if (records.length === 0) return null;

    // Group by type
    const byType: Record<string, StoryValue[]> = { top: [], ask: [], show: [] };

    for (const record of records) {
      const val = record.value as StoryValue | null;
      if (val?.type && val.rank !== undefined) {
        byType[val.type].push(val);
      }
    }

    // Sort by rank and take top 3
    const summarizeType = (stories: StoryValue[]) =>
      stories
        .sort((a, b) => a.rank - b.rank)
        .slice(0, 3)
        .map((s) => ({
          rank: s.rank,
          title: s.title.slice(0, 80) + (s.title.length > 80 ? "..." : ""),
          author: s.author,
          score: s.score,
          comments: s.commentCount,
          url: s.url,
        }));

    return {
      top: summarizeType(byType.top),
      ask: summarizeType(byType.ask),
      show: summarizeType(byType.show),
      totalStories: records.length,
    };
  },
};
