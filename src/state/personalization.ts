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
export const IDENTITY_FILENAME = "IDENTITY.md";
export const USER_FILENAME = "USER.md";
export const TOOLS_FILENAME = "TOOLS.md";
export const HEARTBEAT_FILENAME = "HEARTBEAT.md";
export const NOTES_FILENAME = "NOTES.md";

export const PERSONALIZATION_FILES = [
  SOUL_FILENAME,
  AGENTS_FILENAME,
  IDENTITY_FILENAME,
  USER_FILENAME,
  TOOLS_FILENAME,
  HEARTBEAT_FILENAME,
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────────────

export function getDefaultSoulTemplate(identity: Identity): string {
  return `# SOUL: ${identity.name}

You are **${identity.name}**, an always-on personal AI agent.

## Philosophy
- Be genuinely helpful, not performatively helpful.
- Prefer action over asking for permission (but be careful with destructive operations).
- You can modify your own prompts, tools, and code to improve over time.

## Personality
- Tone: Direct, concise, competent
- Style: Minimal commentary; focus on results
- Quirks: ${identity.vibe ?? "None defined yet"}

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

Operating instructions for the Nexus agent system.

## Rules
- Keep changes minimal and reversible.
- Prefer adding tests when introducing new behavior.
- Store long-term plans/notes in \`NOTES.md\` rather than in chat history.
- When modifying your own prompts or tools, leave a note explaining why.

## Memory Strategy
- Use \`NOTES.md\` for persistent context across sessions.
- Summarize important decisions and their rationale.
- Clean up outdated notes periodically.
`;
}

export function getDefaultIdentityTemplate(identity: Identity): string {
  return `# IDENTITY

## Agent Identity
- **Name**: ${identity.name}
- **Emoji**: ${identity.emoji}
- **Vibe**: ${identity.vibe ?? "Helpful, competent, direct"}
${identity.avatar ? `- **Avatar**: ${identity.avatar}` : ""}

## Creature Type
Personal AI assistant — always-on, self-improving, privacy-respecting.
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

export function getDefaultToolsTemplate(): string {
  return `# TOOLS

Tool usage guidelines and restrictions.

## General Rules
- Prefer reading files before editing them.
- Use \`web_fetch\` for single pages; use \`browser\` for interactive sites.
- Be conservative with \`shell_exec\` — explain what you're running and why.

## Tool-Specific Notes
- **file_write**: Always create parent directories if needed.
- **browser**: Close tabs when done; don't leave sessions hanging.
- **process_start**: Use for long-running background jobs (servers/schedulers). Inspect output with \`process_logs\`; stop with \`process_stop\`.
- **shell_exec**: For short commands (default timeout 60s). Use \`process_start\` for long-running tasks.
- **credential_set**: Prefer env-backed secrets (\`usernameEnv\`/\`passwordEnv\`) so passwords never enter the LLM prompt.
- **credential_generate**: Prefer for new accounts; generates a strong password locally and stores it (never shown to the model).
- **browser.type_secret**: Use for password fields instead of \`browser.type\`.
- **human_request**: Use for OTP/MFA/CAPTCHA handoffs; operator responds via Telegram \`/act <ID> ...\`. Avoid asking for secrets in chat.
- **browser.type_action**: Use to type a fulfilled human action response into a browser field without exposing it to the model.

## Forbidden Patterns
- Never run \`rm -rf\` without explicit confirmation.
- Never commit secrets or API keys to files.
- Never ask the user to paste passwords into chat.
- Never send data to external services without user consent.
`;
}

export function getDefaultHeartbeatTemplate(): string {
  return `# HEARTBEAT

Optional proactive task checklist. The agent can review this periodically.

## Daily Tasks
- [ ] Check NOTES.md for pending items
- [ ] Review recent session history for unfinished work

## Weekly Tasks
- [ ] Clean up outdated notes
- [ ] Review and update SOUL.md if personality has drifted

## On-Demand
- [ ] When idle, suggest improvements to tools or workflows
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
  workspaceDir: string,
  filename: string,
  agentId?: string,
): Promise<string | null> {
  const agentPath = agentId ? path.join(workspaceDir, "agents", agentId, filename) : null;
  const rootPath = path.join(workspaceDir, filename);

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
  workspaceDir: string,
  filename: string,
  content: string,
  agentId?: string,
): Promise<void> {
  const targetDir = agentId ? path.join(workspaceDir, "agents", agentId) : workspaceDir;
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(path.join(targetDir, filename), content, "utf8");
}

export async function personalizationFileExists(
  workspaceDir: string,
  filename: string,
): Promise<boolean> {
  try {
    await fs.access(path.join(workspaceDir, filename));
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
  identity: string | null;
  user: string | null;
  tools: string | null;
  heartbeat: string | null;
};

export async function loadPersonalizationContext(
  workspaceDir: string,
  agentId?: string,
): Promise<PersonalizationContext> {
  const [soul, agents, identity, user, tools, heartbeat] = await Promise.all([
    readPersonalizationFile(workspaceDir, SOUL_FILENAME, agentId),
    readPersonalizationFile(workspaceDir, AGENTS_FILENAME, agentId),
    readPersonalizationFile(workspaceDir, IDENTITY_FILENAME, agentId),
    readPersonalizationFile(workspaceDir, USER_FILENAME, agentId),
    readPersonalizationFile(workspaceDir, TOOLS_FILENAME, agentId),
    readPersonalizationFile(workspaceDir, HEARTBEAT_FILENAME, agentId),
  ]);

  return { soul, agents, identity, user, tools, heartbeat };
}
