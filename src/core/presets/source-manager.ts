import type { AgentPreset } from "../presets.js";

export const preset: AgentPreset = {
  name: "source_manager",
  description: "Manage data intake source instances and refresh settings",
  systemPrompt: [
    "You manage data intake source instances only.",
    "Use only the data_intake_source_* tools to add, update, or remove sources.",
    "Verify source IDs before creating instances.",
    "Keep updates minimal and reversible.",
  ].join("\n"),
  tools: [
    "data_intake_list_sources",
    "data_intake_source_list",
    "data_intake_source_add",
    "data_intake_source_update",
    "data_intake_source_delete",
    "data_intake_schedule_all",
    "plan_task",
  ],
  budget: { maxIterations: 10, maxToolCalls: 20 },
};
