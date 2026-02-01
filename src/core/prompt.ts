import { loadPersonalizationContext, type PersonalizationContext } from "../state/personalization.js";
import { loadSkills, formatSkillsPromptSection } from "../state/skills.js";
import { formatPresetsForPrompt } from "./presets.js";

export async function buildSystemPrompt(params: {
  workspaceDir: string;
  agentId?: string;
}): Promise<string> {
  const [ctx, skills] = await Promise.all([
    loadPersonalizationContext(params.workspaceDir, params.agentId),
    loadSkills(params.workspaceDir, params.agentId),
  ]);
  return formatSystemPrompt(ctx, formatSkillsPromptSection(skills));
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

  // Agent identity metadata (IDENTITY.md)
  if (ctx.identity) {
    sections.push(ctx.identity.trim());
  }

  // User profile context (USER.md)
  if (ctx.user) {
    sections.push(ctx.user.trim());
  }

  // Tool usage guidelines (TOOLS.md)
  if (ctx.tools) {
    sections.push(ctx.tools.trim());
  }

  // Code guide for self-modification (CODEGUIDE.md)
  if (ctx.codeguide) {
    sections.push(ctx.codeguide.trim());
  }

  // Learned skills (from workspace/skills/*/SKILL.md)
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
      "- Workers share data via the **Blackboard** (`write_to_blackboard` / `read_from_blackboard`). Workers automatically write their results to the blackboard.",
      "- For periodic/scheduled tasks, use `job_create` with a cron expression. Manage with `job_*` tools. Failed jobs notify you (the owning agent).",
      "- Use `memory_store` / `memory_recall` / `memory_search` to persist learnings across sessions. Use `reflect` to extract insights from recent conversations.",
      "- Use `skill_create` to save reusable playbooks for tasks you learn to do well.",
      "- Use `budget_status` to check remaining iterations/tool calls during complex tasks.",
      "- To notify the user on Telegram from non-telegram contexts (e.g. scheduled jobs), use `telegram_send`.",
      "- If you need human help (OTP/MFA/CAPTCHA), call `human_request`; the operator replies via Telegram `/act <ID> <response>`.",
      "- To live-edit your own source code: spawn a `coder` agent, or use `file_read`/`file_edit` with `root: \"code\"` (via a coder worker), then `gateway_restart()`.",
      "- When you change your own prompts, tools, or code, leave a short note in `NOTES.md`.",
      `- Current time: ${new Date().toISOString()}`,
    ].join("\n"),
  );

  return sections.filter(Boolean).join("\n\n---\n\n");
}

export { loadPersonalizationContext, type PersonalizationContext };
