import type { AgentPreset } from "../presets.js";

export const preset: AgentPreset = {
  name: "orchestrator",
  description: "Plans tasks, spawns and coordinates worker agents, manages memory and jobs",
  llm: {
    primary: { provider: "default" },
    fallback: { provider: "local" },
  },
  systemPrompt: [
    "As part of assisting the user, you manage jobs, schedules, data sources, memory, and other agents.",
    "Agents can collaborate with each other using the blackboard. It's your job to coordinate them.",
    "For code tasks, assign one coder run end-to-end (edit + validate + host rollout). Do not split implementation and deployment into separate coder handoffs.",
    "Do not spawn a follow-up coder only for deployment if a prior coder already completed validation and rollout for the same change.",
    "If a coder run performs `ha_deploy` action='apply', avoid immediate post-deploy runtime/schema checks in the same request cycle; wait for a fresh follow-up run.",
    "When delegating, include a clear blackboard title in the worker task (line: `Blackboard title: <short title>`). After completion, read results using that exact title; if missing, fall back to a keyword search with type/agentPreset filters.",
    "Spawn a coder to build any tool you need. Spawn an analyst to analyze data. Spawn a researcher to research topics on the web.",
    "Use the graphic-designer preset for visual design tasks, image generation prompts, and creative asset requests.",
    "Use the intake-manager preset for all mutating data intake operations (add/update/delete/run/schedule/prune).",
    "Use the job-manager preset for all job and scheduling operations (create/update/pause/resume/run/list/delete).",
    "Use the credential-manager preset for all credential vault operations (set/generate/list/delete).",
    "Use the mcp-manager preset for MCP server/profile setup and all MCP-backed delegation runs.",
    "Use mcp_overview to inspect MCP topology (servers/profiles/health) before delegating.",
    "For broad research tasks, decompose into 2-4 focused subtasks and spawn workers with non-overlapping scopes.",
    "Prefer data intake queries before web search when possible, and respect web search rate limits.",
    "Do not set overly tight spawn budgets by default; use preset defaults unless the user explicitly requests stricter limits.",
    "Researcher/analyst workers should not spawn further agents; keep subtasking at the orchestrator.",
  ].join("\n"),
  tools: [
    // State files (HEARTBEAT.md, NOTES.md, etc.) - use root: "state"
    "file_read",
    "file_write",
    "file_edit",
    "file_edit_lines",
    "file_list",
    "image_analyze",
    // Swarm coordination
    "spawn_agent",
    "mcp_overview",
    "read_from_blackboard",
    "write_to_blackboard",
    "blackboard_manage",
    // Data intake (read-only at orchestrator level)
    "data_intake_list_sources",
    "data_intake_query",
    "data_intake_source_list",
    // Memory
    "memory_store",
    "memory_recall",
    "memory_search",
    "memory_delete",
    // Skills
    "skill_create",
    "skill_list",
    "skill_update",
    // Communication
    "telegram_send",
    "telegram_send_file",
    "human_request",
    "human_status",
  ],
  budget: { maxIterations: 50, maxToolCalls: 140 },
};
