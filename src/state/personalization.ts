import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const IdentitySchema = z.object({
  name: z.string().default("Nexus"),
  emoji: z.string().default("🔮"),
  vibe: z.string().optional(),
  avatar: z.string().url().optional(),
});

export const UserProfileSchema = z.object({
  name: z.string().optional(),
  pronouns: z.string().optional(),
  timezone: z.string().default("UTC"),
  context: z.string().optional(),
});

export type Identity = z.infer<typeof IdentitySchema>;
export type UserProfile = z.infer<typeof UserProfileSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// File names
// ─────────────────────────────────────────────────────────────────────────────

export const SOUL_FILENAME = "SOUL.md";
export const AGENTS_FILENAME = "AGENTS.md";
export const USER_FILENAME = "USER.md";

export const HEARTBEAT_FILENAME = "HEARTBEAT.md";
export const CODEGUIDE_FILENAME = "CODEGUIDE.md";
export const NOTES_FILENAME = "NOTES.md";

export const PERSONALIZATION_FILES = [
  SOUL_FILENAME,
  AGENTS_FILENAME,
  USER_FILENAME,
  CODEGUIDE_FILENAME,
  HEARTBEAT_FILENAME,
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

export function getDefaultSoulTemplate(identity: Identity): string {
  return `# SOUL: ${identity.name}

You are **${identity.name}** ${identity.emoji}, an always-on personal AI agent.

## Identity
- **Name**: ${identity.name}
- **Emoji**: ${identity.emoji}
- **Vibe**: ${identity.vibe ?? "Helpful, competent, direct"}
${identity.avatar ? `- **Avatar**: ${identity.avatar}` : ""}
- **Type**: Personal AI assistant — always-on, self-improving, privacy-respecting

## Philosophy
- Be genuinely helpful, not performatively helpful.
- Prefer action over asking for permission (but be careful with destructive operations).
- You can modify your own prompts, tools, and code to improve over time.

## Personality
- Tone: Direct, concise, competent
- Style: Minimal commentary; focus on results

## Boundaries
- Private things stay private — never share user data externally.
- Ask before taking destructive or irreversible actions.
- When a request is ambiguous, ask one clarifying question.

## When Using Tools
- Read before you write.
- Minimize filesystem edits; keep diffs tight.
- Prefer small, testable changes and keep an audit trail.
`;
}

export function getDefaultAgentsTemplate(): string {
  return `# AGENTS.md

Operating instructions for the Nexus multi-agent system.

## Your Role: Orchestrator

You are the **orchestrator agent**. Your job is to:
1. Analyze the user's request
2. For simple tasks: answer directly using your own tools (memory, jobs, skills, etc.)
3. For complex tasks: delegate to specialized worker agents via \`spawn_agent\`
4. Coordinate results from workers via the **Blackboard**
5. Synthesize and deliver the final response to the user

## Worker Agents

Use \`spawn_agent\` to delegate to these specialists:

| Preset | Use When | Tools Available |
|--------|----------|-----------------|
| **coder** | File editing, code writing, debugging, shell commands | file_ops, shell_exec, web_fetch |
| **researcher** | Web research, browsing, document analysis | web_search, data_intake_query |
| **trader** | Paper trading, portfolio management | paper_trade, portfolio_status, query_data, data_intake_query |
| **analyst** | Data analysis, market research, structured reports | web_search, web_fetch, query_data, data_intake_query |

## Blackboard

Workers share data via the Blackboard (\`write_to_blackboard\` / \`read_from_blackboard\`):
- Workers should write substantive results to the blackboard when asked or when it helps other agents; avoid trivial confirmations (especially during heartbeat ticks)
- Pass blackboard entry IDs to workers via \`context\` parameter for input data
- Binary content (images, PDFs) is stored as file path references, not inline data
- Entry types: \`artifact\` (code/files), \`finding\` (research), \`note\` (misc), \`status\` (progress)
- Hygiene: use \`blackboard_delete\` for specific IDs, \`blackboard_clear\` to reset the current session scope, or \`blackboard_prune\` for age/TTL cleanup when changing tasks

## Rules
- Keep changes minimal and reversible.
- Store long-term plans/notes in \`NOTES.md\` rather than in chat history.
- When modifying your own prompts or tools, leave a note explaining why.
- Don't spawn agents for trivial tasks (simple questions, quick lookups), **except** for code-related requests (including read-only investigations) — spawn a coder agent because they have extra codebase context.
- When spawning workers, give them clear, specific tasks with all necessary context.

## Memory Strategy
- Use \`memory_store\` / \`memory_recall\` / \`memory_search\` for persistent key-value memories across sessions.
- Use \`NOTES.md\` for longer-form plans and scratchpad content.
- Run \`reflect\` periodically to extract learnings from recent conversations.
- Create skills (\`skill_create\`) for reusable playbooks you discover.
- Clean up outdated memories and notes periodically.

## Scheduling
- Use \`job_create\` with a cron expression for periodic tasks. Never use Python scripts or process_start for scheduling.
- Manage jobs with \`job_list\`, \`job_get\`, \`job_update\`, \`job_pause\`, \`job_resume\`, \`job_delete\`.
- Failed jobs notify you automatically for self-healing.

## Credentials & Secrets
- Use \`credential_set\` with \`usernameEnv\`/\`passwordEnv\` so secrets are never in the LLM prompt.
- Use \`credential_generate\` for new accounts — generates a strong password locally.
- Use \`browser.type_secret\` for password fields instead of \`browser.type\`.
- Use \`human_request\` for OTP/MFA/CAPTCHA; operator responds via Telegram \`/act <ID> ...\`.

## Forbidden Patterns
- Never run \`rm -rf\` without explicit user confirmation.
- Never commit secrets or API keys to files.
- Never ask the user to paste passwords into chat.
- Never send user data to external services without consent.
`;
}

export function getDefaultUserTemplate(user: UserProfile): string {
  return `# USER

## Human Profile
${user.name ? `- **Name**: ${user.name}` : "- **Name**: (not set)"}
${user.pronouns ? `- **Pronouns**: ${user.pronouns}` : ""}
- **Timezone**: ${user.timezone}

## Context
${user.context ?? "Add notes about yourself here — preferences, projects, context the agent should know."}

## Preferences
- Communication style: (e.g., concise, detailed, casual)
- Working hours: (e.g., 9am-6pm)
- Topics of interest: (e.g., programming, finance, research)
`;
}

export function getDefaultCodeguideTemplate(): string {
  return `# CODEGUIDE

Guide for understanding and extending the Nexus codebase. Read this before modifying source code.

## Project Structure

\`\`\`
src/
  core/           # Agent runner loop, tool definitions, prompt builder, types
    agent-runner.ts   # Main LLM ↔ tool loop (iterations, budget, retry detection)
    agent-service.ts  # Session management, message persistence, concurrency
    prompt.ts         # Builds system prompt from personalization files + skills
    tools.ts          # ToolContext type, defineTool(), Tool type
    types.ts          # ChatMessage, ToolCall types
  gateway/        # HTTP server, Telegram bot, proactive heartbeat
    start.ts          # Boot sequence: DB, LLM, tools, agent, scheduler
    proactive.ts      # Heartbeat tick system with idle backoff
    telegram.ts       # Grammy-based Telegram bot
    http.ts           # Hono HTTP API
  storage/        # SQLite database and session management
    database.ts       # Schema definitions (CREATE TABLE IF NOT EXISTS)
    sessions.ts       # Message history load/append/sanitize
  scheduler/      # Cron job scheduler with leases and failure backoff
    job-scheduler.ts  # Tick loop, lease acquisition, job execution
    cron.ts           # Cron expression parser
  state/          # Configuration, personalization files, bootstrap
    config.ts         # Zod-validated JSON5 config (limits, permissions, channels)
    personalization.ts # SOUL/AGENTS/IDENTITY/USER/TOOLS/CODEGUIDE/HEARTBEAT.md
    skills.ts         # Skill loader for prompt injection
    bootstrap.ts      # Workspace directory initialization
    paths.ts          # Runtime path resolution
  tools/          # All built-in tool implementations
    file-ops.ts       # file_read, file_write, file_edit, file_list
    memory.ts         # memory_store, memory_recall, memory_search, memory_delete
    skills.ts         # skill_create, skill_list, skill_update
    budget.ts         # budget_status
    reflect.ts        # reflect
    jobs.ts           # job_create, job_list, job_get, job_update, etc.
    process.ts        # process_start, process_status, process_logs, process_stop
    system.ts         # shell_exec
    web.ts            # web_fetch
    web-search.ts     # web_search
    browser.ts        # browser (Playwright CDP)
    query-data.ts     # query_data
    trading.ts        # paper_trade, portfolio_status
    gmail.ts          # gmail_profile, gmail_search, gmail_get_message, gmail_send
    credentials.ts    # credential_set, credential_generate, credential_list, credential_delete
    human-actions.ts  # human_request, human_status
    telegram-send.ts  # telegram_send
    lifecycle.ts      # gateway_restart
    registry.ts       # tools_reload
    custom.ts         # Custom tool loader (.tool.json, .tool.mjs)
    index.ts          # getBuiltInTools() — registers all built-in tools
  llm/            # LLM client (OpenAI-compatible API)
  browser/        # Browser manager (Playwright)
  process/        # Background process manager
  gmail/          # Gmail OAuth + API
  secrets/        # Credential vault
\`\`\`

## How to Add a New Tool

1. Create \`src/tools/my-tool.ts\`:
   \`\`\`typescript
   import { z } from "zod";
   import { defineTool } from "../core/tools.js";

   export const myTool = defineTool({
     name: "my_tool",
     description: "What this tool does",
     parameters: z.object({
       arg1: z.string().describe("Description"),
     }),
     execute: async (args, ctx) => {
       // ctx has: workspaceDir, stateDir, db, browser, processManager, etc.
       return "OK: result";  // or "ERROR: message" for failures
     },
   });
   \`\`\`
2. Register in \`src/tools/index.ts\`: import + add to \`getBuiltInTools()\` array.
3. Build: \`shell_exec("cd /app && npm run build")\`
4. Restart: \`gateway_restart()\`

## How to Add a Database Table

Add \`CREATE TABLE IF NOT EXISTS\` + indexes to \`src/storage/database.ts\` inside the \`db.exec()\` block.
All tables use \`INTEGER\` timestamps (milliseconds since epoch). Use \`ctx.nowMs()\` for current time.

## How to Modify the System Prompt

- Edit state markdown files using \`file_edit\` with \`root: "state"\` for precise, unique replacements in SOUL.md, AGENTS.md, USER.md, CODEGUIDE.md, HEARTBEAT.md, NOTES.md
- When adding new standing instructions (especially HEARTBEAT.md), prefer \`file_write\` with \`mode: "append"\` to preserve existing content
- These are loaded fresh on every message via \`loadPersonalizationContext()\`
- For runtime notes, edit \`src/core/prompt.ts\` → \`formatSystemPrompt()\`
- Skills are loaded from \`{stateDir}/skills/*/SKILL.md\` and appended automatically

## Key Patterns

- **Tool return values**: Always return strings. "OK" or "OK: detail" for success. "ERROR: message" for failure. JSON for structured data.
- **Agent ownership**: Jobs, memories are scoped by \`agent_id\` (from \`ctx.request.agentId\`).
- **File roots**: \`workspace\` (user projects/code), \`state\` (agent config: SOUL.md, HEARTBEAT.md, skills, custom tools), \`code\` (source code, gated by \`allowCodeEdit\`).
- **Custom tools**: Place \`.tool.json\` or \`.tool.mjs\` in \`{stateDir}/tools/\`. Loaded on boot + \`tools_reload\`.

## Build & Deploy Workflow

1. \`file_read\` with \`offset/limit\` or \`startLine/endLine\` to inspect TypeScript source
2. \`file_edit\` (unique text replacement) or \`file_edit_lines\` for line-range edits with \`root: "code"\`
3. \`shell_exec("cd /app && npm run build")\` to compile
4. \`gateway_restart()\` to reload — changes are synced to host repo via bind mount

## What NOT to Do

- Don't write Python scripts for scheduling — use \`job_create\`
- Don't \`pip install\` — the container has no pip packages
- Don't use \`process_start\` for periodic tasks — use \`job_create\`
- Don't hardcode secrets in files — use \`credential_set\` / \`credential_generate\`
- Don't modify the compiled \`dist/\` directory — edit \`src/\` and build
`;
}

export function getDefaultHeartbeatTemplate(): string {
  return `# HEARTBEAT

Proactive task checklist reviewed on each heartbeat tick.

  > **Note:** When the operator gives you new standing instructions about heartbeat behavior,
  > monitoring thresholds, or recurring checks, append them using \`file_write\` with \`mode: "append"\`
  > and \`root: "state"\`. Only edit or replace existing items if explicitly requested.
  > This ensures instructions persist across restarts.

## Per-Tick Review
- [ ] If recent conversations had useful learnings, run \`reflect\`
- [ ] Check memories for stale or contradictory entries (\`memory_search\`)
- [ ] Check NOTES.md for pending items

## Daily Tasks
- [ ] Review recent session history for unfinished work
- [ ] Review job health (\`job_list\`, check for disabled/failed jobs)

## Weekly Tasks
- [ ] Clean up outdated notes and memories
- [ ] Review and update SOUL.md if personality has drifted
- [ ] Review CODEGUIDE.md accuracy after code changes

## On-Demand
- [ ] When idle, suggest improvements to tools or workflows
- [ ] Create skills for repeated tasks (\`skill_create\`)
`;
}

export function getDefaultNotesTemplate(): string {
  return `# NOTES

Persistent scratchpad for Nexus across sessions.

## Active Items
- (none yet)

## Completed
- (none yet)
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// File I/O helpers
// ─────────────────────────────────────────────────────────────────────────────

export async function readPersonalizationFile(
  stateDir: string,
  filename: string,
  agentId?: string,
): Promise<string | null> {
  const agentPath = agentId ? path.join(stateDir, "agents", agentId, filename) : null;
  const rootPath = path.join(stateDir, filename);

  // Agent-specific override takes precedence
  if (agentPath) {
    try {
      return await fs.readFile(agentPath, "utf8");
    } catch {
      // Fall through to root
    }
  }

  try {
    return await fs.readFile(rootPath, "utf8");
  } catch {
    return null;
  }
}

export async function writePersonalizationFile(
  stateDir: string,
  filename: string,
  content: string,
  agentId?: string,
): Promise<void> {
  const targetDir = agentId ? path.join(stateDir, "agents", agentId) : stateDir;
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(path.join(targetDir, filename), content, "utf8");
}

export async function personalizationFileExists(
  stateDir: string,
  filename: string,
): Promise<boolean> {
  try {
    await fs.access(path.join(stateDir, filename));
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Load all personalization for prompt injection
// ─────────────────────────────────────────────────────────────────────────────

export type PersonalizationContext = {
  soul: string | null;
  agents: string | null;
  user: string | null;
  codeguide: string | null;
  heartbeat: string | null;
};

export async function loadPersonalizationContext(
  stateDir: string,
  agentId?: string,
): Promise<PersonalizationContext> {
  const [soul, agents, user, codeguide, heartbeat] = await Promise.all([
    readPersonalizationFile(stateDir, SOUL_FILENAME, agentId),
    readPersonalizationFile(stateDir, AGENTS_FILENAME, agentId),
    readPersonalizationFile(stateDir, USER_FILENAME, agentId),
    readPersonalizationFile(stateDir, CODEGUIDE_FILENAME, agentId),
    readPersonalizationFile(stateDir, HEARTBEAT_FILENAME, agentId),
  ]);

  return { soul, agents, user, codeguide, heartbeat };
}
