---
name: incident-response
description: Structured troubleshooting and incident response for Nexus gateway, processes, and jobs.
triggers: error, crash, down, incident, troubleshoot, debug, failing, broken, not working, unhealthy
---

# Incident Response (Nexus)

Use this skill when diagnosing failures — crashed processes, gateway issues, job failures, or unexpected errors.

## Step 1: Triage — Identify Scope

Determine what is affected before diving in.

1. Check gateway health:
   - `shell_exec` command=`curl -s http://localhost:<PORT>/health/ready | jq .`
   - Key signals: `ok: false`, any check with `error` field
2. Check local processes:
   - `process_manage` action=`list` — look for `exited` or `crashed` status
3. Check recent job failures:
   - `job_manage` action=`runs` id=`<JOB_ID>` limit=`5` — look for failed runs

Classify the incident: **gateway** | **process** | **job** | **external dependency**

## Step 2: Gather Evidence

### For crashed processes

1. `process_manage` action=`status` processId=`<PROCESS_ID>` — get exit code and runtime
2. `process_manage` action=`logs` processId=`<PROCESS_ID>` maxChars=`20000` — capture full error output
3. Look for patterns: OOM, unhandled rejection, ECONNREFUSED, ENOSPC

### For gateway issues

1. Check gateway logs: `shell_exec` command=`tail -200 logs/nexus.log`
2. Check database: `shell_exec` command=`curl -s http://localhost:<PORT>/health/traffic | jq .`
3. Check HA lease status in `/health/ready` response

### For job failures

1. `job_manage` action=`runs` id=`<JOB_ID>` limit=`5`
2. `job_manage` action=`run_get` runId=`<RUN_ID>` — get full error details
3. `job_manage` action=`events` id=`<JOB_ID>` limit=`10` — audit trail

## Step 3: Diagnose

Common root causes and their signals:

| Signal | Likely Cause | Next Step |
|--------|-------------|-----------|
| `ENOSPC` | Disk full | `df -h`, clean logs/tmp |
| `ENOMEM` / OOM killed | Memory exhaustion | Check `free -h`, reduce concurrency |
| `ECONNREFUSED` | Downstream service down | Check dependent service status |
| Exit code 137 | SIGKILL (OOM or manual) | Check `dmesg` for OOM killer |
| Exit code 1 + stack trace | Unhandled error | Read stack trace, identify source |
| Lease not held | HA failover issue | Check standby instance status |

## Step 4: Remediate

1. **Restart crashed process**: `process_manage` action=`start` with the same command
2. **Clear disk space**: Remove old logs, tmp files, or stale data
3. **Fix and redeploy**: If code bug, fix → build → `ha_deploy`

## Step 5: Report

Always conclude with a structured summary:

1. **What happened**: One-sentence description
2. **Root cause**: What caused the failure
3. **Impact**: What was affected and for how long
4. **Resolution**: What was done to fix it
5. **Prevention**: What should change to prevent recurrence (memory limit, alerting, etc.)

Store the summary with `memory_store` using key `incident/<DATE>/<SHORT_DESCRIPTION>` for future reference.

## Guardrails

1. Do not restart services blindly — diagnose first.
2. Preserve logs before restarting (they may be lost).
3. Escalate to user via `telegram_send` if the incident cannot be auto-resolved.
4. Do not modify production data or run destructive cleanup without explicit confirmation.
