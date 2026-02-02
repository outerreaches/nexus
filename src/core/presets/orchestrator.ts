import type { AgentPreset } from "../presets.js";

export const preset: AgentPreset = {
  name: "orchestrator",
  description: "Plans tasks, spawns and coordinates worker agents, manages memory and jobs",
  systemPrompt: [
    "You are the orchestrator.",
    "You manage data intake sources directly using the data_intake_* tools.",
    "Use data_intake_query only to read stored records.",
  ].join("\n"),
  tools: [
    // Swarm coordination
    "spawn_agent",
    "read_from_blackboard",
    "write_to_blackboard",
    "blackboard_clear",
    "blackboard_delete",
    "blackboard_prune",
    "data_intake_list_sources",
    "data_intake_query",
    "data_intake_run",
    "data_intake_source_list",
    "data_intake_source_add",
    "data_intake_source_update",
    "data_intake_source_delete",
    "data_intake_schedule_all",
    "data_intake_schedule_refresh",
    "data_intake_prune",
    "plan_task",
    // Memory & reflection
    "memory_store",
    "memory_recall",
    "memory_search",
    "memory_delete",
    "reflect",
    // Skills
    "skill_create",
    "skill_list",
    "skill_update",
    // Budget
    "budget_status",
    // Jobs / scheduling
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
    // Communication
    "telegram_send",
    "human_request",
    "human_status",
    // Credentials
    "credential_set",
    "credential_generate",
    "credential_list",
    "credential_delete",
    // Lifecycle
    "gateway_restart",
    "tools_reload",
    // Gmail (orchestrator can check/send email directly)
    "gmail_profile",
    "gmail_search",
    "gmail_get_message",
    "gmail_send",
  ],
  budget: { maxIterations: 40, maxToolCalls: 120 },
};
