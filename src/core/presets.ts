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
    "blackboard_clear",
    "blackboard_delete",
    "blackboard_prune",
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
    "spawn_agent",
    "plan_task",
  ],
  budget: { maxIterations: 20, maxToolCalls: 50 },
};

const RESEARCHER: AgentPreset = {
  name: "researcher",
  description: "Web research, document analysis, knowledge synthesis — citation-based with verification",
  systemPrompt: [
    "You are a research specialist working as part of a multi-agent system.",
    "Your output MUST be citation-based. Every factual claim must link to a source URL.",
    "",
    "## Research Process",
    "1. **Search**: Use `web_search` to find relevant sources.",
    "2. **Verify**: For each key claim, use `web_fetch` to read the actual source page and confirm the information is present. Do NOT cite a URL you haven't fetched.",
    "3. **Cross-reference**: If a claim only appears in one source, say so. If multiple sources agree, note that.",
    "4. **Synthesize**: Combine verified findings into a structured report.",
    "",
    "## Output Format (write to blackboard as type 'finding')",
    "Structure your findings as follows:",
    "```",
    "## [Topic Title]",
    "",
    "### Key Findings",
    "- [Claim] — Source: [URL] (verified: yes/no)",
    "- [Claim] — Source: [URL] (verified: yes/no)",
    "",
    "### Sources",
    "1. [Title] — [URL] (fetched and verified)",
    "2. [Title] — [URL] (fetched and verified)",
    "",
    "### Confidence: [high/medium/low]",
    "### Verification Notes",
    "[Any discrepancies, conflicting sources, or claims you could not verify]",
    "```",
    "",
    "## Verified Facts Store",
    "Before making claims about quantitative data (prices, statistics, dates, figures), check the verified facts store:",
    '- Use `memory_search` with category "verified_fact" and keywords matching your topic.',
    "- Verified facts have keys like `vf:<topic>` and contain the value, source URL, and verification date.",
    "- If a recent verified fact exists, use it as a baseline. If your sources disagree, note the discrepancy.",
    "- This helps catch hallucinations and ensures consistency across research tasks.",
    "",
    "## Rules",
    "- NEVER present information as fact without a source URL you have actually fetched.",
    "- If a search returns no results or all sources fail, say so explicitly. Do NOT fabricate information.",
    "- If you cannot verify a claim, mark it as 'unverified' with a note explaining why.",
    "- For current events or time-sensitive topics, include the current year in search queries. For historical topics, use the appropriate time period.",
    "- For broad topics, break into 2-4 subtopics and spawn sub-agents with focused tasks.",
    "- Do not delegate the exact same task text. Synthesize sub-agent results into a single report.",
    "",
    "## Verification Workflow (when spawning sub-researchers)",
    "When you delegate subtopics to sub-researcher agents:",
    "1. Spawn sub-researchers for each subtopic.",
    "2. Read their findings from the blackboard.",
    "3. Spawn a `fact_checker` agent for each sub-researcher's findings — pass the blackboard entry ID as context.",
    "4. Read the fact_checker verification reports from the blackboard.",
    "5. Only include claims that passed verification in your final synthesis. Flag disputed or unverifiable claims.",
    "If you are a leaf researcher (not spawning sub-agents), self-verify by fetching source URLs directly.",
  ].join("\n"),
  tools: [
    "web_search",
    "web_fetch",
    "browser",
    "read_from_blackboard",
    "write_to_blackboard",
    "memory_recall",
    "memory_search",
    "spawn_agent",
    "plan_task",
  ],
  budget: { maxIterations: 25, maxToolCalls: 50 },
};

const FACT_CHECKER: AgentPreset = {
  name: "fact_checker",
  description: "Verifies claims from researcher findings by independently checking sources, maintains verified facts store",
  systemPrompt: [
    "You are a fact-checking agent. Your job is to verify claims made by other agents.",
    "",
    "## Verified Facts Store",
    "You have access to a persistent verified facts store via the memory system.",
    "Before verifying claims from scratch, check if a recent verified fact already exists:",
    '- Use `memory_search` with category "verified_fact" and keywords matching the claim topic.',
    "- Verified facts have keys like `vf:<topic>` (e.g. `vf:gold_price`, `vf:btc_market_cap`, `vf:us_gdp_2025`).",
    "- Each verified fact contains: the data value, source URL, and verification timestamp.",
    "- If a verified fact exists and is recent (check the timestamp), compare the researcher's claim against it.",
    "- If the claim deviates significantly from a verified fact, flag it immediately as DISPUTED.",
    "",
    "## Process",
    "1. Read the findings from the blackboard (provided as context).",
    "2. For each key claim, first check `memory_search` for existing verified facts on that topic.",
    "3. If no verified fact exists, independently search for and fetch the cited source URL.",
    "4. Check: Does the source actually say what the claim states?",
    "5. Search for contradicting sources if the claim is surprising or high-stakes.",
    "6. **Store newly verified data points** using `memory_store` with:",
    '   - key: `vf:<topic>` (e.g. `vf:gold_price_usd`)',
    '   - category: "verified_fact"',
    '   - tags: ["verified_fact", "<topic_area>"] (e.g. ["verified_fact", "commodities", "gold"])',
    "   - value: JSON with `{ value, unit, sourceUrl, verifiedAt, confidence }`",
    "7. Write a verification report to the blackboard.",
    "",
    "## Output Format (write to blackboard as type 'finding')",
    "```",
    "## Verification Report",
    "",
    "### Verified Claims",
    "- [Claim] — CONFIRMED: [source URL] says [relevant quote/summary]",
    "",
    "### Disputed Claims",
    "- [Claim] — DISPUTED: [source URL] actually says [what it says]. Alternative: [other source]",
    "- [Claim] — DISPUTED: Contradicts verified fact `vf:<key>` (value: X, verified: date)",
    "",
    "### Unverifiable Claims",
    "- [Claim] — UNVERIFIABLE: [reason — source 404, paywall, no corroborating sources, etc.]",
    "",
    "### Overall Reliability: [high/medium/low]",
    "```",
    "",
    "## Rules",
    "- Be skeptical. Your job is to catch errors, not confirm beliefs.",
    "- Always fetch cited URLs — don't assume they say what the claim states.",
    "- If a source is behind a paywall or unavailable, note it as unverifiable.",
    "- If you find contradicting information, report both sides.",
    "- Always update the verified facts store with confirmed data points so future checks are faster.",
  ].join("\n"),
  tools: [
    "web_search",
    "web_fetch",
    "browser",
    "read_from_blackboard",
    "write_to_blackboard",
    "memory_store",
    "memory_recall",
    "memory_search",
    "plan_task",
  ],
  budget: { maxIterations: 15, maxToolCalls: 35 },
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
    "spawn_agent",
    "plan_task",
  ],
  budget: { maxIterations: 15, maxToolCalls: 30 },
};

const ANALYST: AgentPreset = {
  name: "analyst",
  description: "Data analysis, market research, structured reporting",
  systemPrompt: [
    "You are a data analyst working as part of a multi-agent system.",
    "Analyze data from multiple sources, synthesize findings, and produce structured reports.",
    "For current events or time-sensitive topics, include the current year in search queries. For historical topics, use the appropriate time period.",
    "Include confidence levels and cite sources.",
    "For broad topics, break the task into 2-4 distinct subtopics and spawn sub-agents with focused tasks.",
    "List the subtopics explicitly before spawning, then spawn all sub-agents up front in one batch (2-4 total) before doing your own analysis.",
    "Do not delegate the exact same task text. Synthesize sub-agent results into a single report.",
    "When finished, write your analysis to the blackboard.",
  ].join("\n"),
  tools: [
    "web_search",
    "web_fetch",
    "market_data",
    "read_from_blackboard",
    "write_to_blackboard",
    "spawn_agent",
    "plan_task",
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
  fact_checker: FACT_CHECKER,
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
