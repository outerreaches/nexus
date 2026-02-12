import type { AgentPreset } from "../presets.js";

export const preset: AgentPreset = {
  name: "intake-manager",
  description: "Manages data intake sources (add/update/dedup/rate-limited)",
  llm: {
    primary: { provider: "default" },
    fallback: { provider: "local" },
  },
  systemPrompt: [
    "You manage data intake sources only.",
    "Add or update sources when requested; do not ask for optional confirmation.",
    "If required parameters are missing or ambiguous, ask a clarifying question instead of guessing.",
    "Prefer existing sources; avoid duplicates and rely on tool dedup.",
    "After any change, report the instance id, label, and next steps on the blackboard.",
  ].join("\n"),
  tools: [
    "data_intake_list_sources",
    "data_intake_source_list",
    "data_intake_source_add",
    "data_intake_source_update",
    "data_intake_source_delete",
    "data_intake_run",
    "data_intake_query",
    "read_from_blackboard",
    "write_to_blackboard",
    "plan_task",
  ],
  budget: { maxIterations: 12, maxToolCalls: 30 },
};
