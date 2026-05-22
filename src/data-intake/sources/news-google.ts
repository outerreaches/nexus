import Parser from "rss-parser";
import { z } from "zod";

import type { DataSource, DataIntakeContext, NormalizedRecord } from "../types.js";
import { firecrawlConfigured, firecrawlScrape } from "../../tools/firecrawl.js";

// ── Google News RSS URL builders ────────────────────────────────────────────

const TOPIC_PATHS: Record<string, string> = {
  headlines: "",
  world: "WORLD",
  business: "BUSINESS",
  technology: "TECHNOLOGY",
  science: "SCIENCE",
  health: "HEALTH",
  sports: "SPORTS",
  entertainment: "ENTERTAINMENT",
};

function buildRssUrl(params: { query?: string; topic?: string; region: string; language: string }): string {
  const hl = `${params.language}-${params.region}`;
  const ceid = `${params.region}:${params.language}`;
  const base = "https://news.google.com/rss";

  if (params.query) {
    return `${base}/search?q=${encodeURIComponent(params.query)}&hl=${hl}&gl=${params.region}&ceid=${ceid}`;
  }

  const topicKey = params.topic ?? "headlines";
  const topicPath = TOPIC_PATHS[topicKey];
  if (topicPath) {
    return `${base}/headlines/section/topic/${topicPath}?hl=${hl}&gl=${params.region}&ceid=${ceid}`;
  }

  return `${base}?hl=${hl}&gl=${params.region}&ceid=${ceid}`;
}

// ── Source definition ───────────────────────────────────────────────────────

const GoogleNewsParams = z.object({
  query: z.string().min(1).max(500).optional().describe("Search query. Omit to use topic-based feed."),
  topic: z
    .enum(["headlines", "world", "business", "technology", "science", "health", "sports", "entertainment"])
    .optional()
    .describe("Google News topic section. Ignored if query is provided."),
  region: z.string().max(8).default("US"),
  language: z.string().max(8).default("en"),
  limit: z.number().int().min(1).max(30).default(10),
  scrapeContent: z.boolean().default(false).describe("Use Firecrawl to scrape full article content for top results."),
  maxScrape: z.number().int().min(1).max(10).default(3).describe("Max articles to scrape when scrapeContent is true."),
});

type RssItem = {
  title?: string;
  link?: string;
  pubDate?: string;
  content?: string;
  contentSnippet?: string;
  source?: { $: { url?: string }; _?: string } | string;
  guid?: string;
};

type ArticleValue = {
  title: string;
  url: string;
  source: string;
  sourceUrl: string | null;
  publishedAt: string | null;
  snippet: string | null;
  content: string | null;
  rank: number;
};

const parser = new Parser({
  customFields: { item: [["source", "source"]] },
});

function extractSource(item: RssItem): { name: string; url: string | null } {
  const src = item.source;
  if (src && typeof src === "object" && "_" in src) {
    return { name: String(src._ ?? ""), url: src.$?.url ?? null };
  }
  if (typeof src === "string") {
    return { name: src, url: null };
  }
  return { name: "", url: null };
}

export const googleNewsSource: DataSource = {
  id: "news.google",
  name: "Google News",
  description:
    "Fetch news articles from Google News via RSS. Supports search queries and topic sections. " +
    "Optionally scrapes full article content via Firecrawl.",
  usageNote:
    'Search: data_intake_run({ sourceId: "news.google", params: { query: "AI regulation", limit: 10 } }). ' +
    'Topic: data_intake_run({ sourceId: "news.google", params: { topic: "technology", limit: 10 } }). ' +
    'With content: data_intake_run({ sourceId: "news.google", params: { query: "AI", scrapeContent: true, maxScrape: 3 } }). ' +
    "scrapeContent requires FIRECRAWL_API_KEY.",
  tags: ["news", "google", "headlines", "articles"],
  schemaVersion: 1,
  defaultTtlMs: 30 * 60_000, // 30 minutes

  paramsSchema: GoogleNewsParams,

  fetch: async (params) => {
    const parsed = GoogleNewsParams.parse(params);
    const rssUrl = buildRssUrl(parsed);

    const feed = await parser.parseURL(rssUrl);
    const items: RssItem[] = (feed.items ?? []).slice(0, parsed.limit);

    const articles: ArticleValue[] = items.map((item, idx) => {
      const src = extractSource(item);
      return {
        title: item.title ?? "Untitled",
        url: item.link ?? "",
        source: src.name,
        sourceUrl: src.url,
        publishedAt: item.pubDate ?? null,
        snippet: item.contentSnippet?.slice(0, 500) ?? null,
        content: null,
        rank: idx + 1,
      };
    });

    // Scrape top articles with Firecrawl if requested
    if (parsed.scrapeContent && firecrawlConfigured()) {
      const toScrape = articles.slice(0, parsed.maxScrape);
      const results = await Promise.allSettled(
        toScrape.map((a) => firecrawlScrape(a.url, { timeoutMs: 20_000, scrapeTimeoutCapMs: 15_000 })),
      );
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === "fulfilled" && result.value) {
          articles[i].content = result.value.markdown;
        }
      }
    }

    return {
      query: parsed.query ?? null,
      topic: parsed.topic ?? null,
      region: parsed.region,
      language: parsed.language,
      feedTitle: feed.title ?? null,
      articles,
    };
  },

  normalize: (raw, _params, ctx: DataIntakeContext): NormalizedRecord[] => {
    const data = raw as {
      query: string | null;
      topic: string | null;
      region: string;
      articles: ArticleValue[];
    };

    const nowMs = ctx.nowMs();
    const prefix = data.query
      ? `GNEWS-Q-${data.query.slice(0, 30).toUpperCase().replace(/[^A-Z0-9]+/g, "-")}`
      : `GNEWS-${(data.topic ?? "headlines").toUpperCase()}`;

    const records: NormalizedRecord[] = [];

    for (const article of data.articles) {
      records.push({
        subject: `${prefix}-${article.rank}`,
        value: article,
        collectedAtMs: nowMs,
        ttlMs: 30 * 60_000,
        metadata: {
          provider: "google-news",
          query: data.query,
          topic: data.topic,
          region: data.region,
          rank: article.rank,
          hasContent: Boolean(article.content),
        },
      });
    }

    // LATEST alias for top article
    if (data.articles.length > 0) {
      records.push({
        subject: `${prefix}-LATEST`,
        value: data.articles[0],
        collectedAtMs: nowMs,
        ttlMs: 30 * 60_000,
        metadata: { provider: "google-news", alias: true },
      });
    }

    return records;
  },

  summarize: (records: NormalizedRecord[]) => {
    const articles = records
      .filter((r) => !r.metadata?.alias)
      .map((r) => r.value as ArticleValue)
      .sort((a, b) => a.rank - b.rank);

    if (articles.length === 0) return null;

    return {
      count: articles.length,
      articles: articles.slice(0, 5).map((a) => ({
        rank: a.rank,
        title: a.title.slice(0, 100) + (a.title.length > 100 ? "..." : ""),
        source: a.source,
        publishedAt: a.publishedAt,
        url: a.url,
        hasContent: Boolean(a.content),
      })),
    };
  },
};
