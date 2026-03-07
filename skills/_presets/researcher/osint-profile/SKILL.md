---
name: osint-profile
description: Build an open-source intelligence profile on a company, product, technology, or public figure using publicly available information.
triggers: osint, profile, company profile, competitive analysis, company research, who is, background check, due diligence, competitor analysis
---

# OSINT Profile

Use this skill to build a comprehensive profile from publicly available information. Suitable for company research, competitive analysis, technology assessments, and public figure backgrounds.

## Tools Required

- `web_search` — search across multiple angles
- `web_fetch` — retrieve detailed pages
- `image_analyze` — analyze logos, screenshots, org charts
- `data_intake_manage` — check internal data sources
- `session_search` — check prior research
- `spawn_agent` — delegate parallel research tracks
- `write_to_blackboard` — store the profile

## Ethical Boundaries

- Only use publicly available information (websites, press releases, public filings, social media profiles, open databases).
- Do not attempt to access private systems, bypass paywalls, or scrape data against ToS.
- For individuals, focus on professional/public persona only — not personal details.

## Workflow

### Step 1: Define the Subject

Clarify:
- **Subject type**: Company, product, technology, public figure
- **Research purpose**: Investment due diligence, competitive analysis, partnership evaluation, technology selection
- **Key questions**: What specific aspects matter most?

### Step 2: Information Gathering

#### For Companies
1. **Official presence**: Website, about page, leadership team, careers page
2. **Corporate filings**: SEC EDGAR (public US companies), Companies House (UK), etc.
3. **Funding & financials**: Crunchbase, PitchBook mentions, press releases
4. **Tech stack**: job postings (technologies mentioned), GitHub org, BuiltWith
5. **News & press**: Recent articles, press releases, blog posts
6. **Social presence**: LinkedIn company page, Twitter/X, industry forums
7. **Reviews & reputation**: Glassdoor, G2, Trustpilot, HN discussions
8. **Competitive landscape**: Similar companies, market position

#### For Technologies/Products
1. **Official docs**: Documentation, changelog, roadmap
2. **Community**: GitHub stars/issues/contributors, Discord/Slack, Stack Overflow
3. **Adoption**: Who uses it? Case studies, testimonials
4. **Alternatives**: Competing products/technologies
5. **Trajectory**: Release frequency, contributor trends, sentiment

#### For Public Figures (Professional)
1. **Professional background**: LinkedIn, company bios, speaker profiles
2. **Published work**: Articles, papers, talks, patents
3. **Public statements**: Interviews, social media, conference talks
4. **Affiliations**: Board memberships, advisory roles, organizations

### Step 3: Decompose for Breadth

For comprehensive profiles, delegate parallel tracks:
- Sub-agent 1: Official sources & filings
- Sub-agent 2: News, press, community sentiment
- Sub-agent 3: Technical/product analysis (if applicable)

### Step 4: Synthesize Profile

```
## OSINT Profile: [Subject]

### Overview
- **Type**: [Company/Product/Technology/Person]
- **Summary**: [2-3 sentence overview]
- **Key Data Points**: [Founded, HQ, size, funding, etc.]

### Background
[Narrative summary of history, trajectory, key milestones]

### Current State
[What they're doing now, recent developments, current focus]

### Strengths
- [Backed by evidence]

### Risks / Concerns
- [Backed by evidence]

### Competitive Position
[Where they sit relative to alternatives/competitors]

### Key People (if applicable)
| Name | Role | Notable |
|------|------|---------|
| [Name] | CEO | [Background note] |

### Sources
- [Title — URL] (accessed [date])

### Confidence: [high/medium/low]
### Information Gaps
- [What couldn't be determined from public sources]
```

## Guardrails

1. Clearly label all information with its source.
2. Distinguish between verified facts and inferences.
3. Do not speculate beyond what the evidence supports.
4. For individuals, stick to professionally relevant public information.
5. Note when information may be outdated or unverifiable.
