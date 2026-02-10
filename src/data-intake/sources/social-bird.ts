import { z } from "zod";

import { TwitterClient, resolveCredentials, type SearchResult, type TweetData } from "@steipete/bird";

import type { DataSource } from "../types.js";

const BirdParams = z
  .object({
    mode: z.enum(["user_tweets", "batch_user_tweets", "search"]).default("user_tweets"),
    handle: z.string().optional(),
    handles: z.array(z.string()).optional(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(20),
    limitPerHandle: z.number().int().min(1).max(20).default(5),
    maxHandles: z.number().int().min(1).max(50).default(20),
    cursor: z.string().optional(),
    maxPages: z.number().int().min(1).max(5).default(1),
    includeReplies: z.boolean().default(false),
    includeRetweets: z.boolean().default(false),
    timeoutMs: z.number().int().min(1_000).max(60_000).optional(),
    quoteDepth: z.number().int().min(0).max(4).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.mode === "user_tweets" && !val.handle) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "handle is required for mode=user_tweets", path: ["handle"] });
    }
    if (val.mode === "batch_user_tweets" && (!val.handles || val.handles.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "handles array is required for mode=batch_user_tweets", path: ["handles"] });
    }
    if (val.mode === "search" && !val.query) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "query is required for mode=search", path: ["query"] });
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

// Types for batch mode
type UserTweetsResult = {
  handle: string;
  userId: string;
  success: boolean;
  error?: string;
  result: SearchResult;
};

type BatchFetchResult = {
  mode: "batch_user_tweets";
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

export const birdSource: DataSource = {
  id: "social.bird",
  name: "X/Twitter via Bird",
  description: "Fetch posts via Bird (unofficial X/Twitter GraphQL; requires auth cookies). Supports single user tweets, batch user tweets (multiple handles), and search.",
  usageNote:
    "Single user: data_intake_source_add({ sourceId: \"social.bird\", mode: \"user_tweets\", handle: \"@elonmusk\", limit: 20 }). " +
    "Batch mode: data_intake_source_add({ sourceId: \"social.bird\", mode: \"batch_user_tweets\", handles: [\"@sama\", \"@pmarca\"], limitPerHandle: 5, maxHandles: 20 }). " +
    "Search mode: data_intake_source_add({ sourceId: \"social.bird\", mode: \"search\", query: \"AI\" }). " +
    "Requires AUTH_TOKEN + CT0 (or TWITTER_AUTH_TOKEN + TWITTER_CT0) env vars.",
  tags: ["social", "twitter", "x", "posts"],
  schemaVersion: 1,
  defaultTtlMs: 5 * 60_000,
  paramsSchema: BirdParams,
  fetch: async (params) => {
    const parsed = BirdParams.parse(params);
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

    // Handle search mode
    if (parsed.mode === "search") {
      const query = parsed.query ?? "";
      const result =
        parsed.maxPages > 1 || parsed.cursor
          ? await client.getAllSearchResults(query, { maxPages: parsed.maxPages, cursor: parsed.cursor })
          : await client.search(query, parsed.limit);
      return { mode: "search", query, result, warnings };
    }

    // Handle batch mode
    if (parsed.mode === "batch_user_tweets") {
      const allHandles = (parsed.handles ?? []).slice(0, parsed.maxHandles).map(formatHandle);
      const results: UserTweetsResult[] = [];

      for (const handle of allHandles) {
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
        mode: "batch_user_tweets",
        results,
        allHandles,
        warnings,
      } as BatchFetchResult;
    }

    // Handle single user tweets mode
    const handle = sanitizeHandle(parsed.handle ?? "");
    if (!handle) throw new Error("Invalid handle");

    const lookup = await client.getUserIdByUsername(handle);
    if (!lookup.success || !lookup.userId) {
      throw new Error(`User lookup failed for @${handle}: ${lookup.error ?? "unknown error"}`);
    }

    const result =
      parsed.maxPages > 1 || parsed.cursor
        ? await client.getUserTweetsPaged(lookup.userId, parsed.limit, { maxPages: parsed.maxPages, cursor: parsed.cursor })
        : await client.getUserTweets(lookup.userId, parsed.limit);

    return { mode: "user_tweets", handle: `@${handle}`, userId: lookup.userId, result, warnings };
  },
  normalize: (raw, params, ctx) => {
    const parsed = BirdParams.parse(params);
    const payload = raw as {
      mode: "search" | "user_tweets" | "batch_user_tweets";
      handle?: string;
      userId?: string;
      query?: string;
      result?: SearchResult;
      results?: UserTweetsResult[];
      allHandles?: string[];
      warnings?: string[];
    };

    // Handle batch mode - returns multiple records
    if (payload.mode === "batch_user_tweets" && payload.results) {
      const records = payload.results.map((userResult) => {
        const tweets = userResult.result?.tweets ?? [];
        const filtered = filterTweets(tweets, parsed.includeReplies!, parsed.includeRetweets!);

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

        return {
          subject: userResult.handle,
          value: {
            mode: "batch_user_tweets",
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
            provider: "bird",
            cursor: userResult.result?.nextCursor ?? null,
            warnings: payload.warnings ?? [],
            includeReplies: parsed.includeReplies,
            includeRetweets: parsed.includeRetweets,
            batchHandles: payload.allHandles ?? [],
            batchSize: payload.allHandles?.length ?? 0,
          },
        };
      });

      return records;
    }

    // Handle single modes (user_tweets and search)
    const tweets = payload.result?.tweets ?? [];
    const filtered = filterTweets(tweets, parsed.includeReplies!, parsed.includeRetweets!);
    const subject = payload.mode === "search" ? `search:${payload.query ?? ""}` : payload.handle ?? "user_tweets";

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

    return [
      {
        subject,
        value: {
          mode: payload.mode,
          handle: payload.handle ?? null,
          userId: payload.userId ?? null,
          query: payload.query ?? null,
          count: items.length,
          nextCursor: payload.result?.nextCursor ?? null,
          success: payload.result?.success ?? false,
          error: payload.result?.success ? null : (payload.result as { error?: string }).error ?? "Unknown error",
          tweets: items,
        },
        collectedAtMs: ctx.nowMs(),
        metadata: {
          provider: "bird",
          cursor: payload.result?.nextCursor ?? null,
          warnings: payload.warnings ?? [],
          includeReplies: parsed.includeReplies,
          includeRetweets: parsed.includeRetweets,
        },
      },
    ];
  },
  summarize: (records) => {
    // Handle batch mode summary
    if (records.length > 1) {
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
    }

    // Single record summary (user_tweets or search)
    const r = records[0];
    if (!r) return null;
    const v = r.value as { tweets?: Array<{ id: string; text: string; author?: { username?: string } }> } | null;
    const tweets = v?.tweets ?? [];
    const sample = tweets.slice(0, 5).map((t) => ({
      id: t.id,
      author: t.author?.username ?? null,
      text: t.text?.slice(0, 180) ?? "",
    }));
    return { count: tweets.length, sample };
  },
};
