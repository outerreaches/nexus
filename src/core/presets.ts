// ─────────────────────────────────────────────────────────────────────────────
// Agent Presets — define roles with tool whitelists and budgets
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentPreset {
  name: string;
  description: string;
  /** Extra system prompt appended after workspace personalization files. */
  systemPrompt?: string;
  /** Tool name whitelist — only these tools are available to this preset. */
  tools: string[];
  budget?: {
    maxToolCalls?: number;
    maxIterations?: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Default presets
// ─────────────────────────────────────────────────────────────────────────────

const ORCHESTRATOR: AgentPreset = {
  name: "orchestrator",
  description: "Plans tasks, spawns and coordinates worker agents, manages memory and jobs",
  tools: [
    // Swarm coordination
    "spawn_agent",
    "read_from_blackboard",
    "write_to_blackboard",
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

const CODER: AgentPreset = {
  name: "coder",
  description: "Programming, debugging, code review, file operations",
  systemPrompt: [
    "You are a senior software engineer working as part of a multi-agent system.",
    "Write clean, idiomatic code. Prefer simplicity. Explain your reasoning briefly.",
    "You have access to file and shell tools. Use them to accomplish your task.",
    "When finished, write a summary of what you did to the blackboard.",
  ].join("\n"),
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
  ],
  budget: { maxIterations: 20, maxToolCalls: 50 },
};

const RESEARCHER: AgentPreset = {
  name: "researcher",
  description: "Web research, document analysis, knowledge synthesis",
  systemPrompt: [
    "You are a research specialist working as part of a multi-agent system.",
    "Search the web, read documents, and synthesize findings.",
    "Always cite sources with URLs. Submit structured findings with confidence levels.",
    "When finished, write your findings to the blackboard.",
  ].join("\n"),
  tools: [
    "web_search",
    "web_fetch",
    "browser",
    "read_from_blackboard",
    "write_to_blackboard",
  ],
  budget: { maxIterations: 15, maxToolCalls: 30 },
};

const TRADER: AgentPreset = {
  name: "trader",
  description: "Paper trading execution and position management",
  systemPrompt: [
    "You are a trading execution agent operating in PAPER TRADING mode only.",
    "You never have access to real money.",
    "",
    "Your job:",
    "1. Read predictions and market analysis from the blackboard",
    "2. Evaluate risk/reward and position sizing",
    "3. Execute paper trades via the trading tools",
    "4. Monitor open positions and manage exits",
    "5. Track P&L and report performance",
    "",
    "Risk rules (hard-coded, never override):",
    "- Max position size: 5% of paper portfolio per trade",
    "- Max total exposure: 30% of portfolio",
    "- Always set stop-losses",
    "- Never average down on losing positions",
    "",
    "Log every trade decision with reasoning to the blackboard.",
  ].join("\n"),
  tools: [
    "paper_trade",
    "portfolio_status",
    "market_data",
    "read_from_blackboard",
    "write_to_blackboard",
  ],
  budget: { maxIterations: 15, maxToolCalls: 30 },
};

const ANALYST: AgentPreset = {
  name: "analyst",
  description: "Data analysis, market research, structured reporting",
  systemPrompt: [
    "You are a data analyst working as part of a multi-agent system.",
    "Analyze data from multiple sources, synthesize findings, and produce structured reports.",
    "Include confidence levels and cite sources.",
    "When finished, write your analysis to the blackboard.",
  ].join("\n"),
  tools: [
    "web_search",
    "web_fetch",
    "market_data",
    "read_from_blackboard",
    "write_to_blackboard",
  ],
  budget: { maxIterations: 20, maxToolCalls: 40 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

const PRESETS: Record<string, AgentPreset> = {
  orchestrator: ORCHESTRATOR,
  coder: CODER,
  researcher: RESEARCHER,
  trader: TRADER,
  analyst: ANALYST,
};

export function getPreset(name: string): AgentPreset | undefined {
  return PRESETS[name];
}

export function listPresets(): AgentPreset[] {
  return Object.values(PRESETS);
}

export function getPresetNames(): string[] {
  return Object.keys(PRESETS);
}

/** Format presets list for injection into the orchestrator system prompt. */
export function formatPresetsForPrompt(): string {
  const lines = [
    "## Available Agent Presets",
    "",
    "Use `spawn_agent` to delegate tasks to specialized workers:",
    "",
  ];
  for (const p of Object.values(PRESETS)) {
    if (p.name === "orchestrator") continue; // Don't list self
    lines.push(`- **${p.name}**: ${p.description} (tools: ${p.tools.filter(t => t !== "read_from_blackboard" && t !== "write_to_blackboard").join(", ")})`);
  }
  lines.push("");
  lines.push("For simple questions, answer directly without spawning agents.");
  lines.push("For complex multi-step tasks, spawn the appropriate worker(s).");
  lines.push("Workers share data via the Blackboard — use `write_to_blackboard` / `read_from_blackboard`.");
  return lines.join("\n");
}
