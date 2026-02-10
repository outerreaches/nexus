import { z } from "zod";

import { TwitterClient, resolveCredentials, type SearchResult, type TweetData } from "@steipete/bird";

import type { DataSource, NormalizedRecord, DataIntakeContext } from "../types.js";

const BirdBatchParams = z
  .object({
    mode: z.enum(["batch_user_tweets", "user_tweets", "search"]).default("batch_user_tweets"),
    // For batch mode
    handles: z.array(z.string()).min(1).max(50).optional(),
    limitPerHandle: z.number().int().min(1).max(10).default(5),
    // For single user_tweets mode (backward compatible)
    handle: z.string().optional(),
    // For search mode
    query: z.string().optional(),
    // Common params
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().optional(),
    maxPages: z.number().int().min(1).max(5).default(1),
    includeReplies: z.boolean().default(false),
    includeRetweets: z.boolean().default(false),
    timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
    quoteDepth: z.number().int().min(0).max(4).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.mode === "batch_user_tweets") {
      if (!val.handles || val.handles.length === 0) {
        ctx.addIssue({ 
          code: z.ZodIssueCode.custom, 
          message: "handles array is required for mode=batch_user_tweets", 
          path: ["handles"] 
        });
      }
    }
    if (val.mode === "user_tweets" && !val.handle) {
      ctx.addIssue({ 
        code: z.ZodIssueCode.custom, 
        message: "handle is required for mode=user_tweets", 
        path: ["handle"] 
      });
    }
    if (val.mode === "search" && !val.query) {
      ctx.addIssue({ 
        code: z.ZodIssueCode.custom, 
        message: "query is required for mode=search", 
        path: ["query"] 
      });
    }
  });

function sanitizeHandle(handle: string): string {
  return handle.replace(/^@+/, "").trim();
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
  mode: "batch_user_tweets" | "user_tweets" | "search";
  handle?: string;
  query?: string;
  results: UserTweetsResult[];
  searchResult?: SearchResult;
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
  if (!sanitizedHandle) {
    return { 
      handle, 
      userId: "", 
      success: false, 
      error: "Invalid handle",
      result: { tweets: [], success: false, error: "Invalid handle" },
    };
  }

  const lookup = await client.getUserIdByUsername(sanitizedHandle);
  if (!lookup.success || !lookup.userId) {
    return { 
      handle: `@${sanitizedHandle}`, 
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
    handle: `@${sanitizedHandle}`,
    userId: lookup.userId,
    success: result.success,
    error: result.success ? undefined : (result as { error?: string }).error,
    result,
  };
}

export const birdBatchSource: DataSource = {
  id: "social.bird-batch",
  name: "X/Twitter via Bird (Batch)",
  description: "Fetch posts from multiple Twitter handles in batch via Bird (unofficial X/Twitter GraphQL; requires auth cookies)",
  usageNote:
    "Pass params at top level. For batch mode: data_intake_source_add({ sourceId: \"social.bird-batch\", mode: \"batch_user_tweets\", handles: [\"@sama\", \"@pmarca\"], limitPerHandle: 5 }). " +
    "Single handle and search modes also supported. " +
    "Requires AUTH_TOKEN + CT0 (or TWITTER_AUTH_TOKEN + TWITTER_CT0) env vars. " +
    "Creates one record per handle for batch mode.",
  tags: ["social", "twitter", "x", "posts", "batch", "multi"],
  schemaVersion: 1,
  defaultTtlMs: 5 * 60_000,
  paramsSchema: BirdBatchParams,
  fetch: async (params): Promise<BatchFetchResult> => {
    const parsed = BirdBatchParams.parse(params);
    const authToken = process.env.AUTH_TOKEN ?? process.env.TWITTER_AUTH_TOKEN ?? undefined;
    const ct0 = process.env.CT0 ?? process.env.TWITTER_CT0 ?? undefined;
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

    // Search mode
    if (parsed.mode === "search") {
      const query = parsed.query ?? "";
      const searchResult =
        parsed.maxPages > 1 || parsed.cursor
          ? await client.getAllSearchResults(query, { maxPages: parsed.maxPages, cursor: parsed.cursor })
          : await client.search(query, parsed.limit);
      return { 
        mode: "search", 
        query, 
        results: [], 
        searchResult, 
        warnings 
      };
    }

    // Single user_tweets mode (backward compatible)
    if (parsed.mode === "user_tweets") {
      const result = await fetchUserTweets(
        client,
        parsed.handle ?? "",
        parsed.limit,
        parsed.maxPages,
        parsed.cursor,
      );
      return { 
        mode: "user_tweets", 
        handle: result.handle, 
        results: [result], 
        warnings 
      };
    }

    // Batch user_tweets mode
    const handles = parsed.handles ?? [];
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
          handle: sanitizeHandle(handle),
          userId: "",
          success: false,
          error: errorMsg,
          result: { tweets: [], success: false, error: errorMsg },
        });
      }
    }

    return { 
      mode: "batch_user_tweets", 
      results, 
      warnings 
    };
  },
  normalize: (raw, params, ctx): NormalizedRecord[] => {
    const parsed = BirdBatchParams.parse(params);
    const payload = raw as BatchFetchResult;
    const records: NormalizedRecord[] = [];

    // Search mode - single record
    if (payload.mode === "search" && payload.searchResult) {
      const tweets = payload.searchResult.tweets ?? [];
      const filtered = filterTweets(tweets, parsed.includeReplies, parsed.includeRetweets);
      const subject = `search:${payload.query ?? ""}`;

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
        subject,
        value: {
          mode: "search",
          query: payload.query ?? null,
          count: items.length,
          nextCursor: payload.searchResult?.nextCursor ?? null,
          success: payload.searchResult?.success ?? false,
          error: payload.searchResult?.success ? null : (payload.searchResult as { error?: string }).error ?? "Unknown error",
          tweets: items,
        },
        collectedAtMs: ctx.nowMs(),
        metadata: {
          provider: "bird-batch",
          mode: "search",
          cursor: payload.searchResult?.nextCursor ?? null,
          warnings: payload.warnings ?? [],
          includeReplies: parsed.includeReplies,
          includeRetweets: parsed.includeRetweets,
        },
      });

      return records;
    }

    // Batch or single user_tweets mode - one record per handle
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

      // Create a descriptive tag for each handle
      const displayHandle = userResult.handle.startsWith("@") 
        ? userResult.handle 
        : `@${userResult.handle}`;

      records.push({
        subject: `Twitter Batch - ${displayHandle}`,
        value: {
          mode: payload.mode,
          handle: displayHandle,
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
          mode: payload.mode,
          handle: displayHandle,
          userId: userResult.userId || null,
          cursor: userResult.result?.nextCursor ?? null,
          warnings: payload.warnings ?? [],
          includeReplies: parsed.includeReplies,
          includeRetweets: parsed.includeRetweets,
        },
      });
    }

    return records;
  },
  summarize: (records) => {
    const summary: Record<string, { count: number; sample: Array<{ id: string; author: string | null; text: string }> }> = {};

    for (const r of records) {
      const subject = r.subject as string;
      const v = r.value as { 
        handle?: string; 
        tweets?: Array<{ id: string; text: string; author?: { username?: string } }>;
        count?: number;
      } | null;

      const handle = v?.handle ?? subject;
      const tweets = v?.tweets ?? [];
      
      summary[handle] = {
        count: tweets.length,
        sample: tweets.slice(0, 3).map((t) => ({
          id: t.id,
          author: t.author?.username ?? null,
          text: t.text?.slice(0, 180) ?? "",
        })),
      };
    }

    return summary;
  },
};
