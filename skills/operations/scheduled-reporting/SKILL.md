---
name: scheduled-reporting
description: Create and manage recurring scheduled jobs for reports, summaries, and automated notifications via the Nexus scheduler.
triggers: report, daily summary, cron job, scheduled, recurring, weekly report, schedule a job, automate
---

# Scheduled Reporting (Nexus)

Use this skill when creating, modifying, or managing recurring reports and automated tasks through the Nexus scheduler.

## Creating a Scheduled Report

### 1. Define the schedule (cron syntax)

Standard 5-field cron: `min hour dom mon dow`

| Schedule | Cron | Example Use |
|----------|------|-------------|
| Every day at 9 AM | `0 9 * * *` | Daily summary |
| Weekdays at 8:30 AM | `30 8 * * 1-5` | Work-day briefing |
| Every Monday at 10 AM | `0 10 * * 1` | Weekly report |
| First of month at midnight | `0 0 1 * *` | Monthly recap |
| Every 6 hours | `0 */6 * * *` | Periodic check-in |

Always specify `timezone` (IANA format, e.g. `America/New_York`, `Europe/London`).

### 2. Create the job

```
job_manage action=create
  name="<descriptive-name>"
  cron="<CRON_EXPRESSION>"
  timezone="<IANA_TIMEZONE>"
  mode="agent_task"
  task="<AGENT_PROMPT>"
  enabled=true
```

The `task` field is the prompt the agent will execute on each run. Write it as a complete, self-contained instruction.

### 3. Task prompt best practices

- Be specific: "Fetch portfolio value from X, compare to yesterday, send summary to Telegram" not "do the report"
- Include output destination: "Send results via `telegram_send`" or "Store in memory with key `reports/daily/<date>`"
- Include error handling: "If data source is unavailable, report the error instead of skipping silently"
- Keep it under 4000 chars

## Job Modes

| Mode | When to Use |
|------|-------------|
| `agent_task` | Complex reports requiring reasoning, tool use, and formatting (default) |
| `script` | Run a shell command directly (for simple scripts) |
| `tool_call` | Invoke a single tool with fixed arguments |

## Managing Existing Jobs

- List jobs (including disabled by default): `job_manage` action=`list`
- List only enabled jobs: `job_manage` action=`list` includeDisabled=`false`
- Get job details: `job_manage` action=`get` id=`<JOB_ID>`
- Update task/schedule: `job_manage` action=`update` id=`<JOB_ID>` cron=`<NEW_CRON>` task=`<NEW_TASK>`
- Pause a job: `job_manage` action=`pause` id=`<JOB_ID>`
- Resume a job: `job_manage` action=`resume` id=`<JOB_ID>`
- Trigger immediately: `job_manage` action=`run_now` id=`<JOB_ID>`
- Delete a job: `job_manage` action=`delete` id=`<JOB_ID>`

## One-Shot Scheduled Tasks

For tasks that should run once at a specific time:

```
job_manage action=create
  name="<descriptive-name>"
  at="<ISO_8601_OR_UNIX_MS>"
  mode="agent_task"
  task="<AGENT_PROMPT>"
```

The `at` parameter accepts an ISO 8601 string or Unix timestamp in milliseconds.

## Monitoring & Debugging

1. Check recent runs: `job_manage` action=`runs` id=`<JOB_ID>` limit=`10`
2. Get specific run details: `job_manage` action=`run_get` runId=`<RUN_ID>`
3. View audit events: `job_manage` action=`events` id=`<JOB_ID>` limit=`10`

If a job is failing repeatedly:
- Check the run details for error messages
- Verify the task prompt is self-contained (no session context is carried over)
- Ensure any referenced tools/data sources are available at execution time

## Guardrails

1. Always set a `timezone` — cron runs in UTC by default which may not match user expectations.
2. Test with `run_now` before relying on the schedule.
3. Avoid schedules more frequent than every 5 minutes unless explicitly requested.
4. Include delivery instructions (Telegram, memory, blackboard) in the task prompt — the job runs without user interaction.
5. Use `contextMode="none"` for stateless reports that don't need session history.
