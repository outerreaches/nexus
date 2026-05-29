import type { AgentPreset } from "../presets.js";

export const preset: AgentPreset = {
  name: "orchestrator",
  description: "Plans tasks, spawns and coordinates worker agents, manages memory and jobs",
  skillAccess: {
    promptGlobal: true,
    promptPreset: true,
  },
  videoModel: "google/gemini-2.5-flash-lite",
  videoProvider: "openrouter",
  systemPrompt: [
    // Always-on essentials. Full guidance lives in preset-scoped skills under
    // stateDir/presets/orchestrator/skills/* — discover via `skill_search`,
    // load with `skill_get`. Tool catalog: `tool_search` → `tool_load`.
    "You are the orchestrator: plan, route, and coordinate. Default to lazy discovery — `skill_search`/`skill_get` for guidance, `tool_search`/`tool_load` for tools you do not currently have visible.",
    "Never edit repository code yourself — the file tools reject it. For ANY code change or self-modification, spawn a `coder` (taskType='write'); the coder owns the full edit → typecheck → build → `ha_deploy` flow inside its candidate. You cannot deploy: `ha_deploy` is a coder/security tool, not yours. Relay any APPROVAL REQUIRED back to the user and stop (see skill `self-modification`).",
    "Handle `job_manage`, `mcp_manage`, and node MCP operations (`node_mcp_*`) directly — never delegate them to workers (see skill `preset-routing`).",
    "When delegating via `spawn_agent`, include a `Blackboard title:` line per task and read results back from the blackboard (see skill `spawn-and-blackboard`).",
    "When authoring reusable subagent playbooks, use `skill_create`/`skill_update` with `scope=\"preset\"` + `targetPreset` and a relevant `category`. Omit `targetPreset` only when the skill belongs to your own preset.",
    "Treat `RUN REPORT BATCH` inputs as internal callbacks (see skill `run-report-handling`): silent for routine heartbeat/idle, notify the user for webhook events and code deploy reports.",
  ].join("\n"),
  tools: [
    // Lazy-load discovery (always available regardless of kernel config)
    "tool_search",
    "tool_load",
    "tool_unload",
    // State files (HEARTBEAT.md, NOTES.md, etc.) - use absolute stateDir paths
    "file_read",
    "file_write",
    "file_edit",
    "file_edit_lines",
    "file_list",
    "shell_exec",
    "shell_interactive",
    "process_manage",
    "image_analyze",
    "video_analyze",
    "generate_song",
    "web_fetch",
    "web_search",
    // Swarm coordination
    "spawn_agent",
    "mcp_manage",
    "read_from_blackboard",
    "write_to_blackboard",
    "blackboard_manage",
    // Data intake
    "data_intake_manage",
    // Node management
    "node_manage",
    "node_symbols_list",
    "node_audit_query",
    "node_mcp_list",
    "node_mcp_call",
    "node_mcp_resources",
    // Scheduler jobs
    "job_manage",
    // Memory
    "memory_store",
    "memory_recall",
    "memory_search",
    "memory_delete",
    "session_search",
    // Skills
    "skill_create",
    "skill_search",
    "skill_list",
    "skill_get",
    "skill_update",
    // Communication
    "telegram_send",
    "human_action",
  ],
  // Kernel: always loaded into the LLM tool schema. Everything else in `tools`
  // is discoverable via `tool_search` and materialized via `tool_load`.
  kernel: [
    "spawn_agent",
    "skill_search",
    "skill_get",
    "memory_recall",
    "memory_search",
    "telegram_send",
    "file_read",
    "read_from_blackboard",
    "write_to_blackboard",
    "blackboard_manage",
    "shell_exec",
    // Everyday tools promoted to kernel so they skip the tool_load discovery
    // round-trip. Node management + running tasks on nodes is a core capability,
    // so node_manage (list/get/drain/update/system_run/process_*/file_*) is in
    // the kernel. The remaining long tail stays lazy: node_* introspection/MCP
    // (node_mcp_*, node_symbols_list, node_audit_query), media, mcp_manage,
    // authoring, data_intake_manage, session_search, file_edit_lines,
    // shell_interactive, process_manage, memory_delete.
    "web_search",
    "web_fetch",
    "file_write",
    "file_edit",
    "file_list",
    "job_manage",
    "node_manage",
    "memory_store",
    "human_action",
  ],
  budget: { maxIterations: 100, maxToolCalls: 200 },
};
