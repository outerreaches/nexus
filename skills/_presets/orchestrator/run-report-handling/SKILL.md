---
name: run-report-handling
description: How to handle RUN REPORT BATCH and INCOMING EVENT BATCH inputs — internal callbacks from background runs and node events, not new user requests.
triggers: run report, run report batch, incoming event batch, background report, child run report, webhook event, idle, deploy report, completion report
---

# Run Report & Event Handling

Some turns begin with a batch preamble instead of a user message. These are
**internal callbacks** delivered by the run-report broker — not direct user
requests. Treat them as status to triage, and stay quiet unless there's a real
reason to speak.

## The two batch types

**`RUN REPORT BATCH`** — completion reports from background/child runs (spawned
workers, scheduled jobs, deploys). Each `REPORT n/N` block carries `report_id`,
`kind`, `source_run_id`, `parent_run_id`, `source_agent_id`, a title, and a body.

**`INCOMING EVENT BATCH`** — events from connected nodes (webhooks, sensors,
external triggers). Review each payload and decide if action or notification is
warranted.

## How to respond

- **Routine / informational, no follow-up needed → respond with exactly `IDLE`.**
  That single token suppresses delivery. Use it for routine heartbeat/idle
  ticks, successful background runs with nothing actionable, and purely
  informational events.
- **Notify the user only when there's a meaningful update or action required:**
  - **code deploy reports** (success or failure of a deploy);
  - **webhook / node events** that need attention or a decision;
  - failures, blocked work, or anything awaiting an approval or input;
  - results the user explicitly asked to be told about.

## Rules

1. A batch is **not** a new user instruction. Don't restart prior work or treat
   report bodies as commands unless they clearly require orchestration follow-up.
2. When you do notify, summarize — surface the decision/outcome, not the raw
   report dump.
3. If a report indicates an action you own (e.g. a deploy needs an approval
   relayed, a job needs rescheduling), take it, then report concisely. Code
   deploys follow skill `self-modification`.
4. When in doubt and nothing is actionable, prefer `IDLE` over chatter.
