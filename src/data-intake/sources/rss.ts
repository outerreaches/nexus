import Parser from "rss-parser";
import { z } from "zod";

import type { DataSource } from "../types.js";

type RssFeed = {
  title?: string;
  items: Array<{ title?: string; link?: string; pubDate?: string; guid?: string }>;
};

const parser = new Parser();

const RssParams = z.object({
  feedUrl: z.string().url(),
  maxItems: z.number().int().min(1).max(50).default(20),
});

function parseRss(feed: { title?: string; items?: Array<{ title?: string; link?: string; pubDate?: string; guid?: string }> }, maxItems: number): RssFeed {
  const items = (feed.items ?? []).slice(0, maxItems).map((item) => ({
    title: item.title ?? undefined,
    link: item.link ?? undefined,
    pubDate: item.pubDate ?? undefined,
    guid: item.guid ?? undefined,
  }));
  return { title: feed.title ?? undefined, items };
}

export const rssSource: DataSource = {
  id: "rss.feed",
  name: "RSS Feed",
  description: "Fetch and normalize an RSS feed (each feed URL is a separate source instance)",
  usageNote: "Pass feedUrl at top level, e.g.: data_intake_source_add({ sourceId: \"rss.feed\", feedUrl: \"https://example.com/rss.xml\" }).",
  tags: ["rss", "feeds", "news"],
  schemaVersion: 1,
  defaultTtlMs: 30 * 60_000,
  paramsSchema: RssParams,
  fetch: async (params) => {
    const parsed = RssParams.parse(params);
    const feed = await parser.parseURL(parsed.feedUrl);
    return { feed, feedUrl: parsed.feedUrl, maxItems: parsed.maxItems };
  },
  normalize: (raw, params, ctx) => {
    const parsed = RssParams.parse(params);
    const payload = raw as { feed: { title?: string; items?: Array<{ title?: string; link?: string; pubDate?: string; guid?: string }> }; feedUrl: string; maxItems: number };
    const feed = parseRss(payload.feed, payload.maxItems);
    return [
      {
        subject: parsed.feedUrl,
        value: {
          feedUrl: parsed.feedUrl,
          title: feed.title ?? null,
          items: feed.items,
        },
        collectedAtMs: ctx.nowMs(),
        metadata: { provider: "rss" },
      },
    ];
  },
};
