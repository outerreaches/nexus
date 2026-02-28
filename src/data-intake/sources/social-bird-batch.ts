import { z } from "zod";

import { TwitterClient, resolveCredentials, type SearchResult, type TweetData } from "@steipete/bird";

import type { DataSource, NormalizedRecord } from "../types.js";
import { getSecret } from "../../secrets/resolve-env.js";

/**
 * Usage Example:
 * 
 * // Batch mode - fetch tweets from multiple handles
 * data_intake_source_add({ 
 *   sourceId: "social.bird-batch", 
 *   handles: ["@sama", "@pmarca", "@karpathy"],
 *   limitPerHandle: 5,
 *   includeRetweets: false,
 *   includeReplies: false
 * });
 * 
 * // Creates one record per handle with subject = handle (e.g., "@sama")
 */

const BirdBatchParams = z
  .object({
    // Array of Twitter handles to fetch
    handles: z.array(z.string()).min(1).max(50).default([]),
    // Number of tweets per handle (default: 5, max: 10)
    limitPerHandle: z.number().int().min(1).max(10).default(5),
    // Maximum handles to process per call (default: 20)
    maxHandles: z.number().int().min(1).max(50).default(20),
    // Include retweets in results (default: false)
    includeRetweets: z.boolean().default(false),
    // Include replies in results (default: false)
    includeReplies: z.boolean().default(false),
    // Optional cursor for pagination
    cursor: z.string().optional(),
    // Max pages to fetch per handle (default: 1)
    maxPages: z.number().int().min(1).max(5).default(1),
    // Request timeout in ms
    timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
    // Quote tweet depth
    quoteDepth: z.number().int().min(0).max(4).optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.handles || val.handles.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "handles array is required (at least one handle)",
        path: ["handles"]
      });
    }
  });

function sanitizeHandle(handle: string): string {
  return handle.replace(/^@+/, "").trim();
}

function formatHandle(handle: string): string {
  const sanitized = sanitizeHandle(handle);
  return sanitized ? `@${sanitized}` : handle;
}

function isRetweet(tweet: TweetData): boolean {
  return tweet.text?.startsWith("RT @") ?? false;
}

function filterTweets(tweets: TweetData[], includeReplies: boolean, includeRetweets: boolean): TweetData[] {
  return tweets.filter((tweet) => {
    if (!includeReplies && tweet.inReplyToStatusId) return false;
    if (!includeRetweets && isRetweet(tweet)) return false;
    return true;
  });
}

type UserTweetsResult = {
  handle: string;
  userId: string;
  success: boolean;
  error?: string;
  result: SearchResult;
};

type BatchFetchResult = {
  results: UserTweetsResult[];
  allHandles: string[];
  warnings: string[];
};

async function fetchUserTweets(
  client: TwitterClient,
  handle: string,
  limit: number,
  maxPages: number,
  cursor?: string,
): Promise<UserTweetsResult> {
  const sanitizedHandle = sanitizeHandle(handle);
  const formattedHandle = formatHandle(handle);

  if (!sanitizedHandle) {
    return {
      handle: formattedHandle,
      userId: "",
      success: false,
      error: "Invalid handle",
      result: { tweets: [], success: false, error: "Invalid handle" },
    };
  }

  const lookup = await client.getUserIdByUsername(sanitizedHandle);
  if (!lookup.success || !lookup.userId) {
    return {
      handle: formattedHandle,
      userId: "",
      success: false,
      error: lookup.error ?? "User lookup failed",
      result: { tweets: [], success: false, error: lookup.error ?? "User lookup failed" },
    };
  }

  const result =
    maxPages > 1 || cursor
      ? await client.getUserTweetsPaged(lookup.userId, limit, { maxPages, cursor })
      : await client.getUserTweets(lookup.userId, limit);

  return {
    handle: formattedHandle,
    userId: lookup.userId,
    success: result.success,
    error: result.success ? undefined : (result as { error?: string }).error,
    result,
  };
}

export const birdBatchSource: DataSource = {
  id: "social.bird-batch",
  name: "X/Twitter via Bird (Batch)",
  description: "Fetch posts from multiple Twitter handles in a single API call via Bird (unofficial X/Twitter GraphQL; requires auth cookies)",
  usageNote:
    "Batch mode: data_intake_source_add({ sourceId: \"social.bird-batch\", handles: [\"@sama\", \"@pmarca\"], limitPerHandle: 5, maxHandles: 20 }). " +
    "Creates one record per handle. Requires AUTH_TOKEN + CT0 (or TWITTER_AUTH_TOKEN + TWITTER_CT0) env vars.",
  tags: ["social", "twitter", "x", "posts", "batch"],
  schemaVersion: 1,
  defaultTtlMs: 5 * 60_000,
  paramsSchema: BirdBatchParams,

  fetch: async (params): Promise<BatchFetchResult> => {
    const parsed = BirdBatchParams.parse(params);
    const authToken = getSecret("AUTH_TOKEN") ?? getSecret("TWITTER_AUTH_TOKEN") ?? undefined;
    const ct0 = getSecret("CT0") ?? getSecret("TWITTER_CT0") ?? undefined;
    const { cookies, warnings } = await resolveCredentials({ authToken, ct0, cookieSource: [] });

    if (!cookies.authToken || !cookies.ct0) {
      throw new Error(
        `Missing X auth cookies. Provide AUTH_TOKEN + CT0 (or TWITTER_AUTH_TOKEN + TWITTER_CT0). ${warnings.join(" ")}`.trim(),
      );
    }

    const client = new TwitterClient({
      cookies,
      timeoutMs: parsed.timeoutMs,
      quoteDepth: parsed.quoteDepth,
    });

    // Respect maxHandles limit
    const handles = (parsed.handles ?? []).slice(0, parsed.maxHandles);
    const allHandles = handles.map(formatHandle);
    const results: UserTweetsResult[] = [];

    // Process handles sequentially to avoid rate limiting
    // Bird API uses unofficial endpoints, so we need to be conservative
    for (const handle of handles) {
      try {
        const result = await fetchUserTweets(
          client,
          handle,
          parsed.limitPerHandle,
          parsed.maxPages,
          parsed.cursor,
        );
        results.push(result);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        results.push({
          handle: formatHandle(handle),
          userId: "",
          success: false,
          error: errorMsg,
          result: { tweets: [], success: false, error: errorMsg },
        });
      }
    }

    return {
      results,
      allHandles,
      warnings
    };
  },

  normalize: (raw, params, ctx): NormalizedRecord[] => {
    const parsed = BirdBatchParams.parse(params);
    const payload = raw as BatchFetchResult;
    const records: NormalizedRecord[] = [];

    // One record per handle
    for (const userResult of payload.results) {
      const tweets = userResult.result?.tweets ?? [];
      const filtered = filterTweets(tweets, parsed.includeReplies, parsed.includeRetweets);

      const items = filtered.map((tweet) => ({
        id: tweet.id,
        text: tweet.text,
        author: tweet.author,
        authorId: tweet.authorId ?? null,
        createdAt: tweet.createdAt ?? null,
        replyCount: tweet.replyCount ?? null,
        retweetCount: tweet.retweetCount ?? null,
        likeCount: tweet.likeCount ?? null,
        conversationId: tweet.conversationId ?? null,
        inReplyToStatusId: tweet.inReplyToStatusId ?? null,
        url: `https://x.com/${tweet.author?.username ?? "i"}/status/${tweet.id}`,
        media: tweet.media ?? null,
        quotedTweetId: tweet.quotedTweet?.id ?? null,
      }));

      records.push({
        // Subject is just the handle (e.g., "@sama")
        subject: userResult.handle,
        value: {
          handle: userResult.handle,
          userId: userResult.userId || null,
          count: items.length,
          nextCursor: userResult.result?.nextCursor ?? null,
          success: userResult.success,
          error: userResult.error ?? null,
          tweets: items,
        },
        collectedAtMs: ctx.nowMs(),
        metadata: {
          provider: "bird-batch",
          cursor: userResult.result?.nextCursor ?? null,
          warnings: payload.warnings ?? [],
          includeReplies: parsed.includeReplies,
          includeRetweets: parsed.includeRetweets,
          // Include list of all handles in this batch
          batchHandles: payload.allHandles,
          batchSize: payload.allHandles.length,
        },
      });
    }

    return records;
  },

  summarize: (records) => {
    const summary = {
      totalHandles: records.length,
      totalTweets: 0,
      handles: [] as Array<{
        handle: string;
        tweetCount: number;
        sample: Array<{ id: string; author: string | null; text: string }>;
      }>,
    };

    for (const r of records) {
      const v = r.value as {
        handle?: string;
        count?: number;
        tweets?: Array<{ id: string; text: string; author?: { username?: string } }>;
      } | null;

      const handle = v?.handle ?? r.subject;
      const count = v?.count ?? 0;
      const tweets = v?.tweets ?? [];

      summary.totalTweets += count;
      summary.handles.push({
        handle,
        tweetCount: count,
        sample: tweets.slice(0, 3).map((t) => ({
          id: t.id,
          author: t.author?.username ?? null,
          text: t.text?.slice(0, 180) ?? "",
        })),
      });
    }

    return summary;
  },
};
