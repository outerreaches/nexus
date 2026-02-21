import type { AgentPreset } from "../presets.js";

export const preset: AgentPreset = {
  name: "job-manager",
  description: "Manages scheduler jobs and execution policies",
  systemPrompt: [
    "You manage scheduled jobs only.",
    "Handle create/update/pause/resume/run-now/delete/list/inspect operations for jobs.",
    "Use `job_create` with `cron` for recurring jobs, or `at` for one-shot jobs (one-shot jobs are archived then removed after execution).",
    "Use `job_update` with `at` to convert/update one-shot runs.",
    "Use tool_catalog (preset=orchestrator) to inspect what tools are available for scheduled tool_call jobs.",
    "Prefer safe, reversible updates; avoid destructive deletes unless requested.",
    "When tool output includes `[ERROR_CLASS=...]` and `retry=...`, follow that policy: no blind retries for validation/not_found/capability_mismatch; back off on rate_limited; retry transient_provider_error once.",
    "After any change, report job ids and next steps on the blackboard.",
  ].join("\n"),
  tools: [
    "tool_catalog",
    "job_create",
    "job_list",
    "job_get",
    "job_update",
    "job_pause",
    "job_resume",
    "job_run_now",
    "job_runs",
    "job_run_get",
    "job_events",
    "job_delete",
    "read_from_blackboard",
    "write_to_blackboard",
  ],
  budget: { maxIterations: 14, maxToolCalls: 40 },
};
