import { loadPersonalizationContext, readPersonalizationFile, type PersonalizationContext } from "../state/personalization.js";
import { loadSkills, formatSkillsPromptSection } from "../state/skills.js";
import { formatPresetsForPrompt } from "./presets.js";

export async function buildSystemPrompt(params: {
  stateDir: string;
  agentId?: string;
}): Promise<string> {
  const [ctx, skills] = await Promise.all([
    loadPersonalizationContext(params.stateDir, params.agentId),
    loadSkills(params.stateDir, params.agentId),
  ]);
  return formatSystemPrompt(ctx, formatSkillsPromptSection(skills));
}

export async function buildPresetSystemPrompt(params: {
  stateDir: string;
  agentId?: string;
  promptFiles?: string[];
  systemPrompt?: string;
  includePresets?: boolean;
}): Promise<string> {
  const promptFiles = params.promptFiles ?? [];
  const sections: string[] = [];
  if (promptFiles.length > 0) {
    const loaded = await Promise.all(
      promptFiles.map((filename) => readPersonalizationFile(params.stateDir, filename, params.agentId)),
    );
    for (const content of loaded) {
      if (content && content.trim()) {
        sections.push(content.trim());
      }
    }
  }
  if (params.systemPrompt?.trim()) {
    sections.push(params.systemPrompt.trim());
  }
  if (params.includePresets) {
    sections.push(formatPresetsForPrompt());
  }
  return sections.filter(Boolean).join("\n\n---\n\n");
}

function formatSystemPrompt(ctx: PersonalizationContext, skillsSection: string | null): string {
  const sections: string[] = [];

  // Core identity and personality (SOUL.md)
  if (ctx.soul) {
    sections.push(ctx.soul.trim());
  }

  // Operating instructions (AGENTS.md)
  if (ctx.agents) {
    sections.push(ctx.agents.trim());
  }

  // User profile context (USER.md)
  if (ctx.user) {
    sections.push(ctx.user.trim());
  }

  // Learned skills (from stateDir/skills/*/SKILL.md)
  if (skillsSection) {
    sections.push(skillsSection);
  }

  // Multi-agent presets (always included so orchestrator knows what it can spawn)
  sections.push(formatPresetsForPrompt());

  // Proactive tasks (HEARTBEAT.md) - optional, only if non-empty
  if (ctx.heartbeat && ctx.heartbeat.trim().length > 50) {
    sections.push(ctx.heartbeat.trim());
  }

  // Runtime notes (always appended)
  sections.push(
    [
      "## Runtime Notes",
      "- You are the **orchestrator**. For simple questions, answer directly. For complex multi-step tasks, use `spawn_agent` to delegate to specialized workers (coder, researcher, trader, analyst).",
      "- **Code-related requests**: spawn a `coder` agent first. Coders have additional context about the codebase and can navigate it more reliably.",
      "- Workers share data via the **Blackboard** (`write_to_blackboard` / `read_from_blackboard`). Workers should write substantive results to the blackboard when asked or when it helps other agents; avoid trivial confirmations (especially during heartbeat ticks).",
      "- **Blackboard hygiene**: When switching between unrelated tasks, prune the blackboard. Use `blackboard_delete` for specific entry IDs, `blackboard_clear` for the current session scope, or `blackboard_prune` for age/TTL cleanup. Avoid leaving stale entries that could confuse workers.",
      "- For data intake source management, use the data_intake_* tools directly (add/update/remove, schedule, run, prune).",
      "- For periodic/scheduled tasks, use `job_create`. Prefer `mode: \"tool_call\"` (zero token cost) for recurring tool executions or `mode: \"script\"` for maintenance scripts. Use `mode: \"agent_task\"` (default) only when LLM reasoning is required for each run.",
      "- Use `memory_store` / `memory_recall` / `memory_search` to persist learnings across sessions. Use `reflect` to extract insights from recent conversations.",
      "- Use `skill_create` to save reusable playbooks for tasks you learn to do well.",
      "- Use `budget_status` to check remaining iterations/tool calls during complex tasks.",
      "- To notify the user on Telegram from non-telegram contexts (e.g. scheduled jobs), use `telegram_send`.",
      "- If you need human help (OTP/MFA/CAPTCHA), call `human_request`; the operator replies via Telegram `/act <ID> <response>`.",
      "- Your personality/state files (SOUL.md, AGENTS.md, USER.md, HEARTBEAT.md, NOTES.md, CODEGUIDE.md) live in the **state** root. To update, first read the file. When adding standing instructions (especially to HEARTBEAT.md), append with `file_write` and preserve existing content unless explicitly asked to replace it.",
      "- For code changes: spawn a `coder` and ask for one end-to-end run (edit `root:\"code\"`, validate with `npm run typecheck` + `npm run build`, then deploy via `ha_deploy` action=`apply`).",
      "- Deployment for code changes is executed by the coder run; orchestrator should coordinate and report status, not perform deployment steps itself.",
      "- Do not bounce deployment back to another coder run after implementation. If rollout fails, return the exact failing command/output and request operator action once.",
      "- After `ha_deploy` succeeds, do not trust post-deploy runtime/schema checks in that same request cycle; use a fresh follow-up run for validation on the new active process.",
      "- If canary fails, the host rollout restores the code checkout to previous HEAD and keeps the old active slot serving traffic.",
      "- When spawning agents, avoid infinite delegation loops. Prefer small fan-outs and only delegate when a sub-task is clearly independent.",
      "- Workflow for any task: (1) decide simple vs complex, (2) list steps, (3) mark which steps can run in parallel, (4) if parallel, spawn a batch of agents concurrently.",
      "- For current events or time-sensitive topics, route the task to a `researcher` agent first. Do NOT answer from memory. Use `web_search`/`web_fetch` to verify facts. If browsing is unavailable, explicitly say you cannot verify and ask the user whether to proceed without sources.",
      "- When you change your own prompts, tools, or code, leave a short note in `NOTES.md`.",
      `- **Current date/time: ${new Date().toISOString()} (year ${new Date().getFullYear()})**. For current events or time-sensitive topics, include the year in web searches and worker tasks. For historical queries, use the appropriate time period.`,
    ].join("\n"),
  );

  return sections.filter(Boolean).join("\n\n---\n\n");
}

export { loadPersonalizationContext, type PersonalizationContext };
