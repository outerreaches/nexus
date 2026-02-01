import { z } from "zod";

import type { DataSource } from "../types.js";

type RssFeed = {
  title?: string;
  items: Array<{ title?: string; link?: string; pubDate?: string; guid?: string }>;
};

const RssParams = z.object({
  feedUrl: z.string().url(),
  maxItems: z.number().int().min(1).max(50).default(20),
});

function extractTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\s\S]*?)</${tag}>`, "i"));
  if (!match) return null;
  return match[1].trim();
}

function parseRss(xml: string, maxItems: number): RssFeed {
  const channelBlock = xml.match(/<channel[\s\S]*?<\/channel>/i)?.[0] ?? xml;
  const title = extractTag(channelBlock, "title");
  const itemBlocks = channelBlock.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  const items = itemBlocks.slice(0, maxItems).map((item) => ({
    title: extractTag(item, "title") ?? undefined,
    link: extractTag(item, "link") ?? undefined,
    pubDate: extractTag(item, "pubDate") ?? undefined,
    guid: extractTag(item, "guid") ?? undefined,
  }));
  return { title: title ?? undefined, items };
}

export const rssSource: DataSource = {
  id: "rss.feed",
  name: "RSS Feed",
  description: "Fetch and normalize an RSS feed (each feed URL is a separate source instance)",
  tags: ["rss", "feeds", "news"],
  schemaVersion: 1,
  defaultTtlMs: 30 * 60_000,
  paramsSchema: RssParams,
  fetch: async (params) => {
    const parsed = RssParams.parse(params);
    const res = await fetch(parsed.feedUrl, { headers: { "User-Agent": "NexusAgent/0.0.1" } });
    if (!res.ok) throw new Error(`RSS error: ${res.status} ${res.statusText}`);
    const xml = await res.text();
    return { xml, feedUrl: parsed.feedUrl, maxItems: parsed.maxItems };
  },
  normalize: (raw, params, ctx) => {
    const parsed = RssParams.parse(params);
    const payload = raw as { xml: string; feedUrl: string; maxItems: number };
    const feed = parseRss(payload.xml, payload.maxItems);
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
