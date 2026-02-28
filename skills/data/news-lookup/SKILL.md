---
name: news-lookup
description: Research a topic across Google News, Hacker News, X/Twitter, and market data, then aggregate findings into a unified news report.
triggers: news lookup, news report, news briefing, what's happening with, latest news, news summary, research topic, topic report, news roundup, what's in the news
---

# News Lookup

Use this skill to research a topic or event across multiple news and social sources, then produce an aggregated report with headlines, social sentiment, and market impact.

## Tools Required

- `data_intake_run` — fetch fresh data from news/social sources
- `data_intake_query` — read cached data if already fresh
- `web_search` — supplemental web research and context
- `web_fetch` — read full article content when needed
- `write_to_blackboard` — store the report
- `telegram_send` — deliver the report
- `spawn_agent` — parallelize source gathering

## Source Priority

Fetch sources in this order. Skip unavailable sources gracefully.

| Priority | Source | Source ID | What it provides |
|----------|--------|-----------|-----------------|
| 1 | Google News | `news.google` | Mainstream headlines, publisher attribution, timestamps |
| 2 | Hacker News | `news.hackernews` | Tech community signal, upvotes, comment counts |
| 3 | X/Twitter | `social.bird` | Real-time social sentiment, key voices |
| 4 | Market data | `yahoo` / `coingecko-multi` / `metals` | Price impact for financially relevant topics |
| 5 | Web search | (tool, not source) | Gap-filling context, background, explainers |

## Workflow

### Step 1: Gather Google News

Always start here. Google News gives the broadest, most authoritative coverage.

```
data_intake_run(sourceId: "news.google", params: {
  query: "<TOPIC>",
  limit: 10,
  scrapeContent: true,
  maxScrape: 3
})
```

If the topic maps to a section, use topic mode for broader coverage:
```
data_intake_run(sourceId: "news.google", params: {
  topic: "technology",
  limit: 10
})
```

Read the scraped article content for the top results to understand the full story, not just headlines.

### Step 2: Check Hacker News

For tech, startup, science, or programming topics — check if HN is discussing it.

```
data_intake_run(sourceId: "news.hackernews", params: {
  storyTypes: ["top"],
  limit: 20
})
```

Then scan the results for relevant stories. High comment counts indicate active discussion.

### Step 3: Check X/Twitter (if available)

For real-time sentiment and breaking developments. Requires auth cookies.

**Search mode** (best for specific topics):
```
data_intake_run(sourceId: "social.bird", params: {
  mode: "search",
  query: "<TOPIC>",
  limit: 20
})
```

**Key voices mode** (for known commentators on the topic):
```
data_intake_run(sourceId: "social.bird", params: {
  mode: "batch_user_tweets",
  handles: ["@relevant_account_1", "@relevant_account_2"],
  limitPerHandle: 5
})
```

If X is unavailable (missing auth cookies), note it and continue.

### Step 4: Check Market Impact (if relevant)

For topics with financial implications, pull recent market data:

```
data_intake_query(sourceId: "yahoo", subjectLike: "%TICKER%", latestOnly: true)
data_intake_query(sourceId: "coingecko-multi", subject: "BTC", latestOnly: true)
```

If data is stale, refresh:
```
data_intake_run(sourceId: "yahoo", params: { symbols: ["AAPL", "MSFT"] })
```

Skip this step for topics without clear market relevance.

### Step 5: Fill Gaps with Web Search

Use `web_search` for context not covered by the above sources:
- Background on the topic if it's new or developing.
- Official statements, press releases, or primary sources.
- Explainer content if the topic is technical.

Limit: 3 web searches. Use `web_fetch` to read full pages from relevant results.

### Step 6: Aggregate into Report

Synthesize all findings into a structured report. Cross-reference sources — if Google News and X agree, confidence is higher. If they diverge, note the discrepancy.

## Report Format

```
# News Report: [TOPIC]

**Generated**: [datetime]
**Sources consulted**: Google News, Hacker News, X/Twitter, [market data if used]

## Summary
[2-3 paragraph synthesis of the key story. Lead with the most important finding.
Cross-reference multiple sources. Note developing vs. confirmed information.]

## Headlines
[Top 5-8 headlines from Google News with source attribution]
1. [HEADLINE] — [SOURCE], [TIME]
2. [HEADLINE] — [SOURCE], [TIME]
...

## Tech Community (Hacker News)
[If relevant stories found:]
- [STORY TITLE] ([SCORE] points, [COMMENTS] comments) — [KEY TAKEAWAY]
[If no relevant stories: "No significant HN discussion found."]

## Social Sentiment (X/Twitter)
[If available:]
- Overall tone: [positive/negative/mixed/divided]
- Key voices: [Notable accounts and their positions]
- Trending angles: [What aspects people are focused on]
[If unavailable: "X/Twitter data not available (auth not configured)."]

## Market Impact
[If relevant:]
- [TICKER]: [PRICE] ([CHANGE]) — [CONTEXT]
[If not relevant: omit section entirely]

## Context & Background
[Web search findings that add depth to the story.
Link to primary sources where possible.]

## Confidence Assessment
- Coverage depth: [high/medium/low] — based on number of sources with relevant data
- Source agreement: [strong/moderate/weak] — do sources tell the same story?
- Freshness: [data timestamps and whether the story is still developing]

---
*Aggregated by Nexus news-lookup across [N] sources*
```

## Delegation Pattern

For time-sensitive lookups, parallelize source gathering:

```
spawn_agent(preset: "intake-manager", task:
  "Run Google News data intake for '<TOPIC>' with scrapeContent: true, maxScrape: 3.
   Then run Hacker News intake for top stories.
   Return the results.")

spawn_agent(preset: "intake-manager", task:
  "Search X/Twitter for '<TOPIC>' (limit 20).
   Also check these handles: [@handle1, @handle2].
   Return the results.")
```

Then synthesize results from both agents plus any market data.

## Topic-Specific Patterns

### Breaking news / events
- Prioritize X/Twitter (fastest signal) and Google News.
- Use `web_search` with freshness filter for very recent coverage.
- Note that information may be incomplete or evolving.

### Tech / product launches
- Prioritize Hacker News (community reaction) and Google News (press coverage).
- Check relevant company X accounts.
- Include market impact if publicly traded.

### Financial / market events
- Prioritize market data sources, then Google News.
- Check financial X accounts (@zerohedge, @DeItaone, etc.).
- Always include price context.

### Policy / regulation
- Prioritize Google News (official coverage).
- Check government/official X accounts.
- Use `web_search` for primary source documents.

## Guardrails

1. Always attribute information to its source — never present unverified claims as fact.
2. Note when information is from a single source vs. corroborated across multiple.
3. If X data is unavailable, say so explicitly rather than omitting the section silently.
4. Keep total data intake runs under 5 per report to manage API usage.
5. Keep web searches under 3 per report.
6. For developing stories, explicitly note that information may change.
7. Do not editorialize — report what sources say, not opinions.

## Completion Protocol

1. Report: topic researched, sources consulted (with counts), data freshness.
2. Deliver: via requested channel (telegram/blackboard/inline).
3. Flag: any sources that were unavailable or returned errors.
4. Note: confidence level and whether the topic warrants follow-up monitoring.
