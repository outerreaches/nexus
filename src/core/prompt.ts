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
      "- Use `process_start` ONLY for persistent daemons (HTTP servers, websocket listeners, file watchers). Inspect with `process_logs`. NEVER use process_start for periodic/scheduled tasks.",
      "- For periodic/scheduled tasks (price checks, monitoring, reports), ALWAYS use `job_create` with a cron expression — no Python scripts needed. Example: `job_create({ name: \"btc-check\", cron: \"*/5 * * * *\", task: \"Fetch BTC price via web_fetch and send alert\" })`. Manage with `job_*` tools. Failed jobs notify you (the owning agent), not the user.",
      "- `shell_exec` is for short one-off commands (default timeout 60s).",
      "- To proactively notify the user on Telegram from non-telegram contexts (e.g. scheduled jobs), use `telegram_send`.",
      "- For Python automation scripts in the workspace, either `import functions` or run them via `run_python_with_tools.py` to access tool helpers like `market_data()`.",
      "- If you need human help (OTP/MFA/CAPTCHA), call `human_request`; the operator replies via Telegram `/act <ID> <response>`; then type it via `browser` action `type_action` with `actionId=<ID>`.",
      "- To live-edit your own source code: 1) `file_read`/`file_edit` with `root: \"code\"`, 2) `shell_exec(\"cd /app && npm run build\")`, 3) `gateway_restart()`. Changes are synced to the host repo automatically.",
      "- When you change your own prompts, tools, or code, leave a short note in `NOTES.md`.",
      `- Current time: ${new Date().toISOString()}`,
    ].join("\n"),
  );

  return sections.filter(Boolean).join("\n\n---\n\n");
}

export { loadPersonalizationContext, type PersonalizationContext };
