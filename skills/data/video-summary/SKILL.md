---
name: video-summary
description: Analyze videos and produce structured summaries with key moments, insights, and optional visual exports.
triggers: video summary, analyze video, summarize video, video report, video analysis, watch video, video recap, video breakdown
---

# Video Summary & Analysis

Use this skill to analyze video content and produce structured summaries, key moment extraction, and insight reports.

## Tools Required

- `video_analyze` — multimodal video analysis (MP4, MOV, WebM, YouTube URLs)
- `web_search` — context lookup for topics referenced in the video
- `write_to_blackboard` — store analysis results
- `telegram_send` — deliver summary
- `file_write` — save detailed report

## Supported Input

| Source | Format | Max Size | Notes |
|--------|--------|----------|-------|
| Local file | MP4, MPEG, MOV, WebM | 10 MB | Base64-inline to LLM |
| HTTP/HTTPS URL | Any video format | Streamed | URL passed directly |
| YouTube | youtube.com, youtu.be | No limit | URL passed directly |

## Workflow

### Step 1: Analyze the Video

Call `video_analyze` with a structured analysis prompt. Tailor the prompt to the use case:

**General summary:**
```
video_analyze(source: "<PATH_OR_URL>", prompt:
  "Watch this video and provide a structured analysis:
  1. OVERVIEW: One-paragraph summary of the video content.
  2. KEY POINTS: List the 5-8 most important points or arguments made.
  3. KEY MOMENTS: List timestamps (approximate) of significant moments with descriptions.
  4. SPEAKERS: Identify speakers/presenters and their roles if apparent.
  5. VISUAL ELEMENTS: Note any charts, slides, demonstrations, or visual aids shown.
  6. TONE & AUDIENCE: Describe the tone and apparent target audience.
  7. ACTIONABLE TAKEAWAYS: List 2-3 concrete takeaways or action items.")
```

**Technical content (talks, tutorials):**
```
video_analyze(source: "<PATH_OR_URL>", prompt:
  "Analyze this technical presentation:
  1. TOPIC & THESIS: What is the main subject and core argument?
  2. TECHNICAL CONCEPTS: List technologies, frameworks, algorithms, or methods discussed.
  3. CODE/DEMOS: Describe any code shown or live demonstrations.
  4. ARCHITECTURE: Note any system designs or architecture diagrams presented.
  5. KEY CLAIMS: List specific claims with supporting evidence mentioned.
  6. REFERENCES: Note any papers, tools, or resources referenced.
  7. PRACTICAL IMPLICATIONS: How does this apply to real-world work?")
```

**Meeting/discussion:**
```
video_analyze(source: "<PATH_OR_URL>", prompt:
  "Summarize this meeting/discussion:
  1. PARTICIPANTS: Who is involved?
  2. AGENDA: What topics were covered?
  3. DECISIONS: What decisions were made?
  4. ACTION ITEMS: What follow-ups were assigned and to whom?
  5. OPEN QUESTIONS: What remained unresolved?
  6. KEY QUOTES: Notable statements or positions taken.")
```

**Product/demo review:**
```
video_analyze(source: "<PATH_OR_URL>", prompt:
  "Review this product demo:
  1. PRODUCT: What is being demonstrated?
  2. FEATURES: List features shown with brief descriptions.
  3. UX OBSERVATIONS: Note usability, design quality, and user flow.
  4. STRENGTHS: What works well?
  5. WEAKNESSES: What needs improvement?
  6. COMPETITIVE NOTES: How does this compare to alternatives mentioned?")
```

### Step 2: Enrich with Context (optional)

If the video references external topics, use `web_search` to add context:
- Look up referenced papers, tools, or products.
- Verify claims or statistics mentioned.
- Find related content for deeper understanding.

Limit: 3 web searches per video analysis.

### Step 3: Structure the Report

Format the analysis into a clean report:

```
# Video Summary: [TITLE]

**Source**: [URL or filename]
**Duration**: [if known]
**Analyzed**: [date]

## Overview
[1-2 paragraph summary]

## Key Points
1. [Point with context]
2. [Point with context]
...

## Key Moments
- [~MM:SS] [Description]
- [~MM:SS] [Description]
...

## Takeaways
- [Actionable item]
- [Actionable item]

## Additional Context
[Web research findings if applicable]

---
*Analysis by Nexus video_analyze*
```

### Step 4: Deliver

**Blackboard**: Write the full report as a finding with the video source in metadata.

**Telegram**: Send a condensed version (under 4096 chars):
- Overview paragraph.
- Bullet-point key takeaways.
- Link to source video.

**File**: Save full report to `/data/workspace/reports/video-summary-[title].md`.

## Multi-Video Comparison

For comparing multiple videos on the same topic:
1. Analyze each video separately (parallel spawn_agent if available).
2. Write individual results to blackboard.
3. Synthesize a comparison table: shared themes, contrasting positions, unique insights per video.

## Guardrails

1. Always report the source (URL/path) and analysis date.
2. Timestamps are approximate — the model estimates, not frame-accurate.
3. If video_analyze fails or returns poor results, report the limitation (file too large, format unsupported, content unclear).
4. Do not present video opinions as facts — attribute claims to speakers.
5. For long videos (>30 min), note that analysis may miss details. Suggest splitting into segments if available.
6. Video analysis has a 5-minute timeout — very long videos may need chunked analysis.

## Completion Protocol

1. Report: video source, estimated duration, analysis type used.
2. Deliver summary in requested format (blackboard/telegram/file).
3. Note confidence level: was the video clear, well-structured, or difficult to parse?
4. Flag any segments that were unclear or potentially misinterpreted.
