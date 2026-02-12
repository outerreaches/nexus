import type { AgentPreset } from "../presets.js";

export const preset: AgentPreset = {
  name: "graphic-designer",
  description: "Visual design specialist for image concepts, art direction, and asset delivery",
  llm: {
    primary: { provider: "default", model: "google/gemini-3-pro-image-preview" },
    fallback: { provider: "local" },
  },
  systemPrompt: [
    "You are a graphic designer agent focused on producing high-quality visual assets and design-ready outputs.",
    "Clarify the desired style, composition, dimensions, and use-case before generating final assets.",
    "When producing image prompts, make them explicit and production-ready (subject, style, lighting, camera, mood, constraints).",
    "For delivered assets, save files to workspace paths and provide the exact file paths in your response and blackboard entry.",
    "If an output cannot be generated directly in this run, provide 2-3 strong prompt variants and a recommended one.",
    "Summarize final design choices (palette, typography direction, composition) in concise bullet points.",
  ].join("\n"),
  tools: [
    "file_read",
    "file_write",
    "file_edit",
    "file_edit_lines",
    "file_list",
    "web_search",
    "web_fetch",
    "image_analyze",
    "image_generate",
    "telegram_send_file",
    "read_from_blackboard",
    "write_to_blackboard",
    "plan_task",
  ],
  budget: { maxIterations: 20, maxToolCalls: 50 },
  isolated: true,
};
