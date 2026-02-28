---
name: infographic
description: Create data-driven infographics by combining data queries, chart generation, and visual composition.
triggers: infographic, data visualization, chart, data chart, visual summary, data graphic, visualize data, stats graphic
---

# Infographic Creation

Use this skill to create data-driven infographics that combine quantitative data with visual design.

## Tools Required

- `data_intake_query` — retrieve structured data
- `generate_svg` — create charts, layouts, and visual elements
- `image_generate` — create styled visual compositions
- `image_analyze` — verify generated output
- `shell_exec` — data processing, format conversion
- `web_search` — find supporting statistics or context
- `write_to_blackboard` — store final assets

## Workflow

### Step 1: Gather Data

Identify data sources and collect the numbers:

**From Nexus data intake:**
```
data_intake_query(sourceId: "yahoo", latest: true, subject: "SPY")
data_intake_query(sourceId: "coingecko-multi", latest: true)
```

**From web research:**
```
web_search(query: "[TOPIC] statistics 2026")
```

**From provided data:**
- User may supply raw numbers, CSV, or table data directly.

Organize into a clean dataset: labels, values, categories, time periods.

### Step 2: Plan the Layout

Choose an infographic type based on the data:

| Data Shape | Best Chart Type | Tool |
|-----------|----------------|------|
| Categories with values | Bar chart (horizontal/vertical) | `generate_svg` |
| Time series | Line chart | `generate_svg` |
| Part-of-whole | Pie/donut chart | `generate_svg` |
| Comparison (2-3 items) | Side-by-side bars or icons | `generate_svg` |
| Geographic | Map with markers | `image_generate` |
| Process/flow | Flowchart with data annotations | `generate_svg` |
| Single key metric | Big number with context | `generate_svg` |
| Mixed/dashboard | Multi-section layout | `generate_svg` or `image_generate` |

Plan the visual hierarchy:
1. **Hero metric** — the single most important number, large and prominent.
2. **Supporting charts** — 2-3 visualizations that provide context.
3. **Key takeaways** — 2-3 short text callouts.
4. **Source attribution** — data provenance and timestamp.

### Step 3: Generate Chart Elements

Use `generate_svg` for clean, scalable chart components:

**Bar chart:**
```
generate_svg(instructions: "Horizontal bar chart with 5 items:
'Category A': 85%, 'Category B': 72%, 'Category C': 58%, 'Category D': 41%, 'Category E': 23%.
Bars in gradient blue (#2563EB to #60A5FA). Labels on left, percentages on right.
Clean sans-serif font, white background, no gridlines.")
```

**Line chart:**
```
generate_svg(instructions: "Line chart showing monthly trend Jan-Dec:
[45, 52, 48, 61, 73, 69, 82, 95, 88, 102, 110, 125].
Blue line (#2563EB) with dot markers. Gray gridlines, labeled x-axis (months),
y-axis with values. Title: '[METRIC] Monthly Trend'. White background.")
```

**Donut chart:**
```
generate_svg(instructions: "Donut chart with 4 segments:
'Segment A' 45% (#2563EB), 'Segment B' 25% (#10B981), 'Segment C' 20% (#F59E0B),
'Segment D' 10% (#EF4444). Center text: '100%'. Legend below.
Clean flat design, white background.")
```

**Big number callout:**
```
generate_svg(instructions: "Large metric display: '$1.2M' in bold dark text, 48pt.
Subtitle: 'Total Revenue Q4 2025' in gray, 16pt.
Small green arrow up with '+23% YoY'. Minimal, card-style with subtle border.")
```

### Step 4: Compose the Infographic

**Option A: Single SVG composition**
Generate the full infographic as one SVG if it's relatively simple (under 10 elements):
```
generate_svg(instructions: "Full infographic poster, portrait orientation:
Title: '[TITLE]' at top.
Section 1: [HERO METRIC] - big number display.
Section 2: [BAR CHART] with data [...].
Section 3: [KEY TAKEAWAYS] - 3 bullet points.
Footer: 'Source: [SOURCE] | [DATE]'.
Style: [COLOR SCHEME], clean corporate, sans-serif.")
```

**Option B: Multi-element assembly**
For complex infographics, generate elements separately and assemble:
1. Generate each chart/section as a separate SVG.
2. Convert SVGs to PNG via `cairosvg`.
3. Composite using Pillow:
```bash
python3 -c "
from PIL import Image
canvas = Image.new('RGB', (1200, 1600), 'white')
header = Image.open('/data/workspace/infographic/header.png')
chart1 = Image.open('/data/workspace/infographic/chart1.png')
chart2 = Image.open('/data/workspace/infographic/chart2.png')
canvas.paste(header, (0, 0))
canvas.paste(chart1, (0, 400))
canvas.paste(chart2, (0, 900))
canvas.save('/data/workspace/infographic/final.png')
print('Composed infographic')
"
```

**Option C: Styled image composition**
For visually rich infographics, use `image_generate` with a detailed prompt that includes the data:
```
image_generate(prompt: "Professional infographic poster showing [TOPIC].
Key stats: [STAT1], [STAT2], [STAT3]. Include bar chart showing [DATA].
Modern flat design, [COLOR SCHEME], clean typography, data visualization style.
Portrait orientation, white background.", sizeHint: "4K")
```

### Step 5: Verify

Use `image_analyze` to check:
- All data values are correctly represented.
- Text is readable and not overlapping.
- Visual hierarchy is clear (hero metric is most prominent).
- Color contrast meets accessibility basics.
- Source attribution is present.

### Step 6: Deliver

- Save final infographic to `/data/workspace/infographic/`.
- Write to blackboard with: title, data sources, key metrics.
- Convert to PDF if requested: `img2pdf infographic.png -o infographic.pdf`.
- Send via `telegram_send` if requested.

## Guardrails

1. Always cite data sources and timestamps in the infographic itself.
2. Do not fabricate or estimate data — use only queried/provided values.
3. Keep charts simple: max 8 items per bar chart, max 6 segments per pie chart.
4. Use consistent colors across related charts.
5. If generate_svg can't render the chart accurately, report the limitation and try image_generate as fallback.
6. Verify numeric accuracy via image_analyze before finalizing.

## Completion Protocol

1. Report: infographic title, data sources used, data freshness.
2. List key metrics featured.
3. Provide file path, dimensions, and format.
4. Note any data that was unavailable or approximated.
