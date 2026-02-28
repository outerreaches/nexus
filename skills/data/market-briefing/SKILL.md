---
name: market-briefing
description: Generate a market intelligence briefing by pulling live data, researching context, and delivering a visual summary.
triggers: market briefing, market report, market summary, portfolio update, market intel, daily briefing, market overview, what are markets doing
---

# Market Intelligence Briefing

Use this skill to produce a structured market briefing that combines live data, contextual research, and visual summaries.

## Tools Required

- `data_intake_query` — retrieve latest market data (crypto, stocks, metals, prediction markets)
- `web_search` — find context, news, and catalysts
- `image_generate` or `generate_svg` — create charts and visual summaries
- `telegram_send` — deliver the briefing
- `write_to_blackboard` — store the briefing for other agents
- `spawn_agent` — delegate research or chart generation to specialists

## Available Data Sources

| Source | Data | Query Subject Pattern |
|--------|------|----------------------|
| crypto / coingecko-multi | Crypto spot prices | `BTC`, `ETH`, `SOL` |
| yahoo / marketstack / twelvedata | Stock prices | `AAPL`, `MSFT`, `SPY` |
| metals | Precious metals | `XAU`, `XAG` (gold, silver) |
| kalshi / polymarket | Prediction markets | varies by contract |
| hackernews | Tech news | n/a (RSS feed) |

## Workflow

### Step 1: Gather Data

Query recent data across relevant sources:

```
data_intake_query(sourceId: "coingecko-multi", latest: true)
data_intake_query(sourceId: "yahoo", latest: true)
data_intake_query(sourceId: "metals", latest: true)
```

For specific instruments:
```
data_intake_query(sourceId: "yahoo", subject: "SPY", latest: true)
data_intake_query(sourceId: "coingecko-multi", subject: "BTC", latest: true)
```

If data is stale (older than the source's TTL), trigger a refresh first:
```
data_intake_run(instanceId: "<instance-id>")
```

### Step 2: Research Context

Use `web_search` to find market-moving context (limit: 3-5 searches):
- "US stock market today [current date]"
- "crypto market news today"
- "economic events this week"
- Specific searches for any notable price movements found in step 1.

### Step 3: Analyze

Synthesize data + context into a structured briefing:

**Required sections:**
1. **Market Snapshot** — Key prices and daily changes (table format).
2. **Notable Moves** — Instruments with significant changes (>2% for stocks, >5% for crypto). Explain why if context was found.
3. **Macro Context** — Relevant economic events, Fed/ECB decisions, earnings, geopolitical factors.
4. **Sentiment** — Overall market sentiment assessment based on data + news.
5. **Watchlist** — 2-3 instruments or events to monitor next.

### Step 4: Visualize (optional)

Generate a visual summary if delivery is via Telegram or if explicitly requested:

**Option A: SVG chart (clean, fast)**
```
generate_svg(instructions: "Bar chart showing daily performance: SPY +0.8%, QQQ +1.2%,
BTC -2.1%, ETH -1.5%, Gold +0.3%. Green bars for positive, red for negative.
Clean style, white background, labeled axes.")
```

**Option B: Image graphic (richer, slower)**
```
image_generate(prompt: "Professional financial dashboard graphic showing market data:
[key metrics]. Dark theme, clean typography, data visualization style.")
```

### Step 5: Deliver

**Telegram delivery:**
- Send the text briefing first via `telegram_send`.
- Send any generated charts/images as follow-up messages.
- Keep the text under 4096 characters (Telegram limit). Split into multiple messages if needed.

**Blackboard storage:**
- Write the full briefing to blackboard with type `finding` and title `Market Briefing [date]`.
- Attach any generated visuals.

## Briefing Format Template

```
📊 Market Briefing — [Date]

── Snapshot ──────────────────
SPY     $XXX.XX  (+X.X%)
QQQ     $XXX.XX  (+X.X%)
BTC     $XX,XXX  (-X.X%)
ETH     $X,XXX   (-X.X%)
Gold    $X,XXX   (+X.X%)

── Notable Moves ────────────
• [INSTRUMENT]: [MOVE] — [REASON]
• [INSTRUMENT]: [MOVE] — [REASON]

── Macro Context ────────────
• [EVENT/FACTOR and its market impact]

── Sentiment ────────────────
[OVERALL ASSESSMENT: risk-on/risk-off/mixed]

── Watchlist ─────────────────
• [INSTRUMENT/EVENT]: [WHY]
```

## Delegation Pattern

For comprehensive briefings, the orchestrator can parallelize:
1. Spawn researcher for macro context and news.
2. Query data sources directly (orchestrator has data_intake_query).
3. Spawn graphic-designer for chart generation.
4. Synthesize results and deliver.

## Guardrails

1. Always include the data timestamp — do not present stale data as current.
2. Never present analysis as financial advice — frame as informational only.
3. If a data source is unavailable or returns errors, note it in the briefing and continue with available data.
4. Limit web searches to 5 per briefing to stay within budget.
5. Do not make price predictions or target prices.

## Scheduling

To run this briefing on a schedule, create a recurring job:
```
job_manage(action: "create", spec: {
  cron: "0 9 * * 1-5",
  timezone: "America/New_York",
  mode: "agent_task",
  task: "Generate a market briefing for today covering US equities, crypto, and metals. Deliver via Telegram.",
  preset: "orchestrator"
})
```

## Completion Protocol

1. Report: data sources used, data freshness, briefing delivery method.
2. Flag any data gaps or source failures.
3. Note if any instruments showed unusual activity warranting follow-up.
