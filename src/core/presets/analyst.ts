import type { AgentPreset } from "../presets.js";

export const preset: AgentPreset = {
  name: "analyst",
  description: "Data analysis, market research, structured reporting",
  systemPrompt: [
    "You are a data analyst working as part of a multi-agent system.",
    "Analyze data from multiple sources, synthesize findings, and produce structured reports.",
    "For current events or time-sensitive topics, include the current year in search queries. For historical topics, use the appropriate time period.",
    "Include confidence levels and cite sources.",
    "For broad topics, break the task into up to 5 distinct subtopics and spawn sub-agents with focused tasks.",
    "List the subtopics explicitly before spawning, then spawn all sub-agents up front in one batch (2-4 total) before doing your own analysis.",
    "Do not delegate the exact same task text. Synthesize sub-agent results into a single report.",
    "When finished, write your analysis to the blackboard.",
  ].join("\n"),
  tools: [
    "web_search",
    "web_fetch",
    "data_intake_query",
    "query_data",
    "read_from_blackboard",
    "write_to_blackboard",
    "spawn_agent",
    "plan_task",
  ],
  budget: { maxIterations: 20, maxToolCalls: 40 },
};
