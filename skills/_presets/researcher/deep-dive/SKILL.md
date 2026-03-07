---
name: deep-dive
description: Structured multi-source deep dive research with evidence grading, source triangulation, and comprehensive synthesis.
triggers: deep dive, deep research, comprehensive research, thorough analysis, in-depth, literature review, state of the art, survey
---

# Deep Dive Research

Use this skill for thorough, multi-source research that requires evidence triangulation and comprehensive synthesis. This is for topics that need more than a quick search — typically 10+ sources across multiple types.

## Tools Required

- `web_search` — primary search across multiple angles
- `web_fetch` — retrieve full content from high-value sources
- `image_analyze` — analyze charts, diagrams, or visual data in sources
- `video_analyze` — analyze video content if relevant
- `data_intake_manage` — check internal data sources first
- `session_search` — check for prior research on the topic
- `spawn_agent` — delegate sub-questions to parallel researchers
- `write_to_blackboard` — store findings

## Workflow

### Step 1: Frame the Research

Decompose the topic into:
1. **Central question**: What is the user actually trying to understand or decide?
2. **Sub-questions** (3-6): Break the central question into distinct, answerable sub-questions.
3. **Source types needed**: Academic, industry reports, news, primary data, expert opinion.
4. **Recency requirements**: Must sources be current (last 6 months)? Or is historical context valuable?

### Step 2: Check Existing Knowledge

Before searching externally:
- `session_search` for prior research in conversation scope
- `data_intake_manage` action=`query` for internal data sources
- Read blackboard for relevant prior findings

### Step 3: Research Strategy

Plan searches by sub-question. For each:
- Primary search query (broad)
- Refinement query (specific, with date/domain constraints)
- Alternative angle query (different terminology or perspective)

**Budget allocation:**
- If handling directly: ~8-12 web_search, ~6-8 web_fetch calls
- If decomposing: 2-3 sub-agents with ~4-6 searches each

### Step 4: Evidence Collection

For each source, record:
- **Claim**: What specific claim does this source make?
- **Source type**: Academic paper, industry report, news article, blog, official docs
- **Authority**: Is the source authoritative? (peer-reviewed, official, well-known expert)
- **Recency**: Publication date
- **Corroboration**: Does another independent source support this?

Grade each piece of evidence:
- **A**: Multiple authoritative sources agree
- **B**: Single authoritative source, unchallenged
- **C**: Single source or non-authoritative, plausible
- **D**: Speculative, single non-authoritative source

### Step 5: Decompose if Needed

If the topic is too broad for the search budget:
- Identify 2-4 non-overlapping sub-questions
- Spawn sub-agents with distinct scopes
- Include `Do NOT repeat:` section with queries already tried
- Each sub-agent writes to blackboard with a distinct title

### Step 6: Synthesize

Combine all evidence into a structured report:

```
## Deep Dive: [Topic]

### Executive Summary
[2-3 sentences answering the central question with confidence level]

### Key Findings

#### [Sub-question 1]
- [Finding with evidence grade] [A/B/C]
  - Source: [Title — URL]
  - Corroborated by: [Second source if available]
- [Finding 2]

#### [Sub-question 2]
...

### Consensus vs Debate
- **Agreed upon**: [Points where sources converge]
- **Contested**: [Points where sources disagree, with each position noted]

### Knowledge Gaps
- [What couldn't be answered with available sources]
- [Areas where evidence is thin or outdated]

### Sources
| # | Title | Type | Date | Grade |
|---|-------|------|------|-------|
| 1 | [Title] | Academic | 2025-01 | A |
| 2 | [Title] | Industry | 2024-11 | B |

### Confidence: [high/medium/low]
[Justification for overall confidence rating]
```

## Guardrails

1. Do not present single-source findings as established fact — always note evidence grade.
2. If sources contradict, present both sides rather than choosing one.
3. Do not fabricate sources. If you cannot find evidence, say so.
4. Keep the final synthesis under 12k chars for blackboard. Use file attachment for full reports.
5. For time-sensitive topics, always include the current year in search queries.
