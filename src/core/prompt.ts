import { loadPersonalizationContext, type PersonalizationContext } from "../state/personalization.js";

export async function buildSystemPrompt(params: {
  workspaceDir: string;
  agentId?: string;
}): Promise<string> {
  const ctx = await loadPersonalizationContext(params.workspaceDir, params.agentId);
  return formatSystemPrompt(ctx);
}

function formatSystemPrompt(ctx: PersonalizationContext): string {
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

  // Proactive tasks (HEARTBEAT.md) - optional, only if non-empty
  if (ctx.heartbeat && ctx.heartbeat.trim().length > 50) {
    sections.push(ctx.heartbeat.trim());
  }

  // Runtime notes (always appended)
  sections.push(
    [
      "## Runtime Notes",
      "- You may call tools to read/write files, browse, and automate tasks.",
      "- If you need human help (OTP/MFA/CAPTCHA), call `human_request`; the operator replies via Telegram `/act <ID> <response>`; then type it via `browser` action `type_action` with `actionId=<ID>`.",
      "- When you change your own prompts/tools, leave a short note in `NOTES.md`.",
      `- Current time: ${new Date().toISOString()}`,
    ].join("\n"),
  );

  return sections.filter(Boolean).join("\n\n---\n\n");
}

export { loadPersonalizationContext, type PersonalizationContext };
