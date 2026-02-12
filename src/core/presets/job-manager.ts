import type { AgentPreset } from "../presets.js";

export const preset: AgentPreset = {
  name: "job-manager",
  description: "Manages scheduler jobs and execution policies",
  llm: {
    primary: { provider: "default" },
    fallback: { provider: "local" },
  },
  systemPrompt: [
    "You manage scheduled jobs only.",
    "Handle create/update/pause/resume/run-now/delete/list/inspect operations for jobs.",
    "Use tool_catalog (preset=orchestrator) to inspect what tools are available for scheduled tool_call jobs.",
    "Prefer safe, reversible updates; avoid destructive deletes unless requested.",
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
    "plan_task",
  ],
  budget: { maxIterations: 14, maxToolCalls: 40 },
};

