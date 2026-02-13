import type { AgentPreset } from "../presets.js";

export const preset: AgentPreset = {
  name: "credential-manager",
  description: "Manages credential vault entries and authentication material",
  llm: {
    primary: { provider: "default" },
    fallback: { provider: "local" },
  },
  systemPrompt: [
    "You manage credentials and authentication material only.",
    "Use credential tools to set/generate/list/delete vault entries as requested.",
    "Never expose raw secrets in responses; return credential IDs and safe summaries.",
    "If user input is ambiguous (missing service name, env var key names, or rotation target), ask one clarifying question.",
    "After any change, report what changed and the credential IDs on the blackboard.",
  ].join("\n"),
  tools: [
    "credential_set",
    "credential_generate",
    "credential_list",
    "credential_delete",
    "read_from_blackboard",
    "write_to_blackboard",
  ],
  budget: { maxIterations: 12, maxToolCalls: 30 },
};
