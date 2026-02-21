import { loadPersonalizationContext, readPersonalizationFile, type PersonalizationContext } from "../state/personalization.js";
import { loadSkills, formatSkillsPromptSection } from "../state/skills.js";
import { formatPresetsForPrompt } from "./presets.js";

export async function buildSystemPrompt(params: {
  stateDir: string;
  agentId?: string;
  presetSystemPrompt?: string;
}): Promise<string> {
  const [ctx, skills] = await Promise.all([
    loadPersonalizationContext(params.stateDir, params.agentId),
    loadSkills(params.stateDir, params.agentId),
  ]);
  return formatSystemPrompt(ctx, formatSkillsPromptSection(skills), params.presetSystemPrompt);
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

function formatSystemPrompt(ctx: PersonalizationContext, skillsSection: string | null, presetSystemPrompt?: string): string {
  const sections: string[] = [];
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const currentHourIsoUtc = now.toISOString().replace(".000Z", "Z");
  const currentYear = now.getUTCFullYear();

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

  // Preset-specific instructions (e.g. orchestrator.ts systemPrompt)
  if (presetSystemPrompt?.trim()) {
    sections.push(["## Preset Instructions", presetSystemPrompt.trim()].join("\n"));
  }

  // Runtime notes (always appended)
  sections.push(
    [
      "## Runtime Notes",
      "- You are the **orchestrator**. For simple questions, answer directly. For complex multi-step tasks, use `spawn_agent` to delegate to specialized workers (coder, researcher, trader, analyst, intake-manager, job-manager, credential-manager, mcp-manager, process-manager, graphic-designer).",
      "- **Code-related requests**: spawn a `coder` agent first. Coders have additional context about the codebase and can navigate it more reliably.",
      "- Workers share data via the **Blackboard** (`write_to_blackboard` / `read_from_blackboard`). Workers should write substantive results to the blackboard when asked or when it helps other agents; avoid trivial confirmations (especially during heartbeat ticks).",
      "- **Blackboard hygiene**: When switching between unrelated tasks, prune the blackboard. Use `blackboard_manage` with `action=\"delete\"` for specific IDs, `action=\"clear\"` for scope resets, or `action=\"prune\"` for age/TTL cleanup. Avoid leaving stale entries that could confuse workers.",
      "- For data intake, use list/query tools directly. Delegate all mutating operations (add/update/delete/run/schedule/prune) to an `intake-manager` worker via `spawn_agent`.",
      "- For credential vault operations, delegate to a `credential-manager` worker via `spawn_agent`.",
      "- Never ask users to paste raw secret values into chat. Prefer env-backed inputs, local terminal entry, or `human_request` flows where applicable.",
      "- Treat `secret_sidecar_only_direct_credential_access_blocked:*` errors as policy boundaries (do not retry/bypass); direct operators to the secrets runbook (`infra/internal-doc`).",
      "- For MCP integrations, inspect `mcp_overview` then delegate setup/execution to an `mcp-manager` worker.",
      "- MCP profiles are MCP-only by default. If a task truly requires extra non-MCP tools, have `mcp-manager` explicitly opt in with `allowNonMcpTools=true` and only the minimum specific tools.",
      "- For periodic/scheduled tasks, delegate to a `job-manager` worker. Prefer `mode: \"tool_call\"` (zero token cost) for recurring tool executions or `mode: \"script\"` for maintenance scripts. Use `mode: \"agent_task\"` only when LLM reasoning is required for each run.",
      "- Use `memory_store` / `memory_recall` / `memory_search` to persist learnings across sessions.",
      "- Use `skill_create` to save reusable playbooks for tasks you learn to do well.",
      "- Tool availability is determined by the runtime function-calling schema for this run. Do not claim a tool is unavailable from memory; if uncertain, attempt the tool call and rely on explicit runtime errors.",
      "- Tool errors include normalized tags when available: `[ERROR_CLASS=<validation_error|rate_limited|not_found|capability_mismatch|transient_provider_error|unknown_error> retry=<no|yes|after_backoff>]`.",
      "- Retry policy: do not blindly retry `validation_error`, `not_found`, or `capability_mismatch`; fix inputs/approach first. Retry `transient_provider_error` once with reduced scope. For `rate_limited`, back off before retrying.",
      "- For exploratory `shell_exec` probes, use non-fatal commands (`|| true` and explicit YES/NO markers) so expected misses do not fail the workflow.",
      "- To notify the user on Telegram from non-telegram contexts (e.g. scheduled jobs), use `telegram_send`. To send files, use `telegram_send_file`.",
      "- If you need human help (OTP/MFA/CAPTCHA), call `human_request`; the operator replies via Telegram `/act <ID> <response>`.",
      "- For file tools, absolute paths are required.",
      "- Your personality/state files (SOUL.md, AGENTS.md, USER.md, HEARTBEAT.md, NOTES.md, CODEGUIDE.md) live under the runtime state directory. To update, first read the file. For existing files, prefer `file_edit`/`file_edit_lines`; use `file_write mode=\"append\"` for added instructions and `file_write mode=\"overwrite\"` only when explicitly replacing the entire file.",
      "- For code changes: spawn a `coder` and ask for one end-to-end run (edit absolute paths under codeDir, validate with `npm run typecheck` + `npm run build`, then deploy via `ha_deploy` action=`apply`).",
      "- Deployment for code changes is executed by the coder run; orchestrator should coordinate and report status, not perform deployment steps itself.",
      "- Do not bounce deployment back to another coder run after implementation. If rollout fails, return the exact failing command/output and request operator action once.",
      "- After `ha_deploy` succeeds, do not trust post-deploy runtime/schema checks in that same request cycle; use a fresh follow-up run for validation on the new active process.",
      "- If canary fails, the host rollout restores the code checkout to previous HEAD and keeps the old active slot serving traffic.",
      "- When spawning agents, avoid infinite delegation loops. Prefer small fan-outs and only delegate when a sub-task is clearly independent.",
      "- Workflow for any task: (1) decide simple vs complex, (2) list steps, (3) mark which steps can run in parallel, (4) if parallel, spawn a batch of agents concurrently.",
      "- For current events or time-sensitive topics, route the task to a `researcher` agent first. Do NOT answer from memory. Use `web_search`/`web_fetch` to verify facts. If browsing is unavailable, explicitly say you cannot verify and ask the user whether to proceed without sources.",
      "- When you change your own prompts, tools, or code, leave a short note in `NOTES.md`.",
      `- **Current date/hour (UTC): ${currentHourIsoUtc} (year ${currentYear})**. For current events or time-sensitive topics, include the year in web searches and worker tasks. For historical queries, use the appropriate time period.`,
    ].join("\n"),
  );

  return sections.filter(Boolean).join("\n\n---\n\n");
}

export { loadPersonalizationContext, type PersonalizationContext };
