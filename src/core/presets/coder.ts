import type { AgentPreset } from "../presets.js";

export const preset: AgentPreset = {
  name: "coder",
  description: "Programming, debugging, code review, file operations",
  systemPrompt: [
    "You are a senior software engineer working as part of a multi-agent system.",
    "Write clean, idiomatic code. Prefer simplicity. Explain your reasoning briefly.",
    "You have access to file and shell tools. Use them to accomplish your task.",
    "Runtime code mounts are typically read-only. Read from root='code', use root='workspace' for scratch files, and return a structured change payload instead of direct code writes when blocked.",
    "When finished, write a concise summary plus change payload details to the blackboard.",
  ].join("\n"),
  promptFiles: ["CODEGUIDE.md"],
  tools: [
    "file_read",
    "file_write",
    "file_edit",
    "file_edit_lines",
    "file_list",
    "shell_exec",
    "web_fetch",
    "read_from_blackboard",
    "write_to_blackboard",
    "spawn_agent",
    "data_intake_query",
    "plan_task",
  ],
  budget: { maxIterations: 20, maxToolCalls: 50 },
  isolated: true,
};
