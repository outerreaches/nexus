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
  gender: z.boolean().default(true),
  timezone: z.string().default("UTC"),
  context: z.string().optional(),
});

export type Identity = z.infer<typeof IdentitySchema>;
export type UserProfile = z.infer<typeof UserProfileSchema>;

export type PersonalizationTemplatePaths = {
  stateDir: string;
  workspaceDir: string;
  codeDir: string;
};

function promptPath(p: string): string {
  // Keep prompt examples stable across platforms.
  return p.replace(/\\/g, "/");
}

// ─────────────────────────────────────────────────────────────────────────────
// File names
// ─────────────────────────────────────────────────────────────────────────────

export const SOUL_FILENAME = "SOUL.md";
export const AGENTS_FILENAME = "AGENTS.md";
export const USER_FILENAME = "USER.md";

export const HEARTBEAT_FILENAME = "HEARTBEAT.md";
export const CODEGUIDE_FILENAME = "CODEGUIDE.md";
export const MEMORY_FILENAME = "MEMORY.md";
export const NOTES_FILENAME = "NOTES.md";

export const PERSONALIZATION_FILES = [
  SOUL_FILENAME,
  AGENTS_FILENAME,
  USER_FILENAME,
  CODEGUIDE_FILENAME,
  HEARTBEAT_FILENAME,
  NOTES_FILENAME,
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

Global orchestration rules and high-signal durable context.

## Purpose
- Keep this file short, current, and factual.
- Treat this file as the canonical source for high-impact concrete facts the orchestrator must not hallucinate.
- If a critical fact changes, update this file in the same run where you discover or verify it.
- Keep this file as a **hot set** of the most frequently used critical facts; archive older authoritative facts in \`MEMORY.md\`.
- Update this file as you learn.

## Memory Tiers (Use This Split)
1. **Tier A — Critical concrete facts (store in \`AGENTS.md\`)**
   - Frequently used endpoints, identifiers, paths, constraints, and commands needed for safe execution.
2. **Tier M — Authoritative archive (store in \`MEMORY.md\`)**
   - Verified concrete facts that are important but not needed in the hot set every run.
   - Use timestamps and provenance so facts can be trusted and audited.
   - This file is intentionally not auto-injected in prompts; read it explicitly when needed.
3. **Tier B — Long-lived but lower-risk context (store in memory system)**
   - Preferences, recurring defaults, lightweight behavioral context.
   - Use \`memory_store\` / \`memory_search\` / \`memory_recall\`.
4. **Tier C — Working scratchpad (store in \`NOTES.md\`)**
   - Drafts, temporary plans, investigation logs, and in-progress thoughts.
   - \`NOTES.md\` is not authoritative for critical concrete facts.

## Critical Fact Workflow
- Before using concrete values in commands or recommendations, check \`AGENTS.md\` first.
- If \`AGENTS.md\` is missing or uncertain, check \`MEMORY.md\` next.
- Never invent concrete identifiers, addresses, endpoints, or IDs.
- For each critical fact, include:
  - value
  - \`captured_at\` (YYYY-MM-DD)
  - \`last_verified\` (YYYY-MM-DD)
  - \`source\` (tool/command/API)
  - \`status\` (active/superseded/deprecated)
- Remove or mark superseded values immediately to avoid stale lookups.
- Document new critical facts as you discover them.

## Critical Facts

### Environment & Access
- primary_environments:
- key_endpoints:
- critical_identifiers:
- important_paths:

### Active Work Domains
- current_projects_or_systems:
- key_integrations:
- non_default_constraints:

### Runbook Commands
- health_check_command:
- deploy_command:
- rollback_or_recovery_command:

## Archive Pointer
- Authoritative archive path: \`MEMORY.md\`
- Keep this file compact by moving lower-frequency factual records to \`MEMORY.md\` with timestamps.

## Collaboration Rules
- Delegate implementation tasks to worker presets and keep task prompts explicit.
- Use blackboard for cross-agent handoff; keep entries concise and actionable.
- Keep destructive actions confirmed by the user.
- When changing prompts/tools/workflows, add a brief changelog entry in \`NOTES.md\`.
`;
}

export function getDefaultUserTemplate(user: UserProfile): string {
  return `# USER

## Human Profile
${user.name ? `- **Name**: ${user.name}` : "- **Name**: (not set)"}
- **Gender**: ${user.gender ? "male" : "female"}
- **Timezone**: ${user.timezone}

## Context
${user.context ?? "Add notes about yourself here — preferences, projects, context the agent should know."}

## Preferences
- Communication style: (e.g., concise, detailed, casual)
- Working hours: (e.g., 9am-6pm)
- Topics of interest: (e.g., programming, finance, research)
`;
}

export function getDefaultCodeguideTemplate(paths: PersonalizationTemplatePaths): string {
  const stateDirPath = promptPath(paths.stateDir);
  const codeDirPath = promptPath(paths.codeDir);
  const workspaceDirPath = promptPath(paths.workspaceDir);
  return `# CODEGUIDE

Architecture and implementation guide for the **coder** preset.

## Mission
- Make focused code changes in the Nexus codebase.
- Preserve existing architecture and behavior unless the task explicitly requires redesign.
- Finish end-to-end: edit, validate, deploy (\`ha_deploy\`), then hand off.
- Spend minimal budget on navigation: use structured code discovery tools first (\`code_search\`, \`file_glob\`, \`code_symbols\`).

## Coder Task Types (\`spawn_agent.taskType\`)
- \`taskType\` is recommended when spawning a coder, but not required.
- If omitted, coder defaults to \`write\` mode for backward compatibility.
- Use \`plan\`, \`review\`, or \`walkthrough\` for read-only runs (no code edits or deploy actions).
- Use \`write\` when implementation changes are expected.
- Optional hard enforcement exists via \`NEXUS_CODER_TASK_TYPE_ENFORCEMENT=hard\`; default is soft prompt enforcement.

## Node-Target Worker Execution (\`spawn_agent.execution\`)
- Use \`execution: { "target": "node", "nodeId": "<node-id>" }\` to run a spawned worker against a specific node tmux shell.
- Node-target workers are shell-driven (\`shell_interactive\`) and require:
  - node status \`online\`
  - node backend \`nexus\`
  - node capability \`system.run\`
  - node firewall mode \`transparent\`
- In node-target mode, local file/code/deploy tools are removed; use shell workflow (\`open -> send -> read -> close\`).

## Absolute Paths
- Use absolute file paths only.
- Primary source root: \`${codeDirPath}\`
- Runtime state root: \`${stateDirPath}\`
- Scratch root: \`${workspaceDirPath}\`
- Persistent SSH path: \`${stateDirPath}/.ssh\` (\`~/.ssh\` in gateway containers because \`HOME=\${stateDirPath}\`)
- Runtime prompt source of truth is \`${stateDirPath}/CODEGUIDE.md\`.

## System Architecture

### Startup and Wiring
- \`src/gateway/start.ts\`: main composition root.
  - Loads \`nexus.json\` via \`src/state/config.ts\`.
  - Resolves runtime paths and bootstrap/init state.
  - Opens DB and initializes service managers.
  - Resolves secret-backed config values before consumers start.
  - Starts HTTP server, scheduler, telegram, proactive, federation workers, node gateway.

### Agent Runtime
- \`src/core/agent-service.ts\`: sessioning, preset resolution, tool filtering, prompt assembly.
- \`src/core/agent-runner.ts\`: LLM/tool loop, retry policy enforcement, deploy handoff guard.
- \`src/core/isolated-worker.ts\`: isolated worker execution for presets like coder; includes auto-deploy safeguard when coder edits+builds but skips deploy.

### Presets and Prompts
- \`src/core/presets/*.ts\`: tool allowlists, budgets, role behavior, model defaults.
- \`src/core/presets/coder.ts\`: coder-specific hard rules.
- Prompt/state markdown files live in \`${stateDirPath}\` (\`SOUL.md\`, \`AGENTS.md\`, \`USER.md\`, \`CODEGUIDE.md\`, \`MEMORY.md\`, \`HEARTBEAT.md\`, \`NOTES.md\`).
- \`MEMORY.md\` is an authoritative archive (manually read when concrete historical facts are needed).

### Tooling Layer
- \`src/tools/*.ts\`: tool implementations.
- \`src/tools/file-ops.ts\`: absolute-path file tools with root restrictions and write guards.
- \`src/tools/code-intel.ts\`: code navigation/diff tools (\`code_search\`, \`file_glob\`, \`code_symbols\`, \`code_diff\`).
- \`src/tools/system.ts\`: \`shell_exec\` plus mutating-git block on code repo.
- \`src/tools/ha-deploy.ts\`: deploy trigger/status tool.

### Storage and Config
- \`src/state/config.ts\`: schema/defaults for \`nexus.json\`.
- \`src/storage/database.ts\`: SQLite schema and migrations.
- \`src/state/personalization.ts\`: default templates for state markdown files.

### Domain Areas
- Federation: \`src/federation/*\`, \`src/gateway/routes/federation.ts\`, federation storage modules.
- Nodes: \`src/nodes/*\`, node routes in \`src/gateway/routes/nodes.ts\`.
- Secrets: \`src/secrets/*\`, secret provider/storage modules, startup resolution in \`start.ts\`.

## Extensible Systems

### Secret Reference Pattern
- Secret refs must use: \`{{secret:<provider-id>/<path>#<field>}}\`.
- Standard field is \`#password\` unless a provider explicitly uses another field (for example \`username\`).
- Preferred provider in production is sidecar-backed (\`sidecar-main\`).
- Main resolution paths:
  - startup env-secret registry: \`config.secrets.env\` -> \`src/secrets/resolve-env.ts\` -> \`getSecret(...)\`.
  - direct runtime resolution: \`parseSecretReference\` / \`resolveSecretReference\` in \`src/secrets/provider.ts\`.
- When adding new config secrets:
  1. Add key to \`config.secrets.env\` usage.
  2. Resolve through existing startup/runtime secret helpers (do not add plaintext-only bypasses).
  3. Add/update tests in \`src/secrets/*.test.ts\` or consumer tests.

### LLM Provider Extension Pattern
- All LLM routing is config-driven in \`nexus.json\` — **preset files must not contain \`llm\` blocks**.
- Architecture: \`src/state/config.ts\` (schema) → \`src/gateway/start.ts\` (wiring) → \`src/llm/model-router.ts\` (resolution) → \`src/llm/openai-compat.ts\` (client).
- Circuit breaker (\`src/llm/circuit-breaker.ts\`) monitors the default provider and fails over to \`routing.localProvider\`.
- Routing priority chain (highest wins):
  1. \`routing.default\` — base route for all agents
  2. \`routing.byPreset[presetName]\` — per-preset override
  3. \`routing.byAgent[agentId]\` — per-agent override (highest)
- To add a new LLM provider:
  1. **Request the user to create the API key credential** in the sidecar vault (e.g. \`llm.<provider>.api\`). Do not proceed until confirmed.
  2. Add env-var mapping in \`nexus.json\` \`secrets.env\`: \`"<PROVIDER>_API_KEY": "{{secret:sidecar-main/llm.<provider>.api#password}}"\`.
  3. Add the provider entry in \`nexus.json\` \`llm.providers\`:
     \\\`\\\`\\\`json
     "<provider-name>": {
       "baseUrl": "https://<provider-api-base>/v1",
       "apiKey": "\${<PROVIDER>_API_KEY}",
       "model": "<default-model-id>"
     }
     \\\`\\\`\\\`
  4. **Note:** Model IDs are provider-specific and may be case-sensitive (e.g. OpenRouter normalizes to lowercase, Baseten preserves original casing).
  5. Add routing rules in \`routing.byPreset\` or \`routing.default\` to direct traffic:
     \\\`\\\`\\\`json
     "<preset-name>": {
       "primary": { "provider": "<provider-name>", "model": "<model-id>" },
       "fallback": { "provider": "local" }
     }
     \\\`\\\`\\\`
  6. Always include \`"fallback": { "provider": "local" }\` for resilience.
  7. Validate via typecheck + build, then deploy with \`ha_deploy\`.
- **Image provider decoupling**: Presets can specify \`imageProvider\` to route image tool API calls to a different provider than the agent's reasoning model. Example: \`imageProvider: "openrouter"\` on the \`graphic-designer\` preset sends image generation through OpenRouter while reasoning uses the default provider. This field is consumed by \`src/tools/image-generate.ts\` and \`src/tools/image-edit.ts\`.

### New Agent Preset Pattern
1. Create/update preset file in \`src/core/presets/<name>.ts\` with:
   - clear role boundary,
   - tool allowlist,
   - budget (\`maxIterations\`, \`maxToolCalls\`),
   - optional \`toolCallCaps\`,
   - optional \`spawnAllowlist\`.
2. Register in \`src/core/presets.ts\` (import + map wiring).
3. Keep orchestrator delegation logic coherent in \`src/core/presets/orchestrator.ts\`.
4. If preset depends on prompt files, ensure those files are stable in runtime state.
5. Add tests for critical routing/behavior changes.

### Data Intake Extension Pattern
1. Add source implementation under \`src/data-intake/sources/\`.
2. Register source in \`src/data-intake/sources/index.ts\`.
3. Define clear params + \`usageNote\` + normalization output shape.
4. Ensure scheduling compatibility (source store + \`data_intake_run\` paths).
5. Expose only through existing intake tools (\`data_intake_source_add/update/delete\`, \`data_intake_run\`, \`data_intake_query\`).
6. Add tests for params, normalization, and persistence behavior.

### Node Architecture Extension Pattern
- Node runtime path is capability-routed, not direct local execution:
  - registry/session state: \`src/nodes/registry.ts\`
  - tool-to-method routing: \`src/nodes/router.ts\`
  - websocket protocol handling: \`src/nodes/ws-gateway.ts\`
  - gateway-facing node tools: \`src/tools/nodes.ts\`
- Webhook architecture invariants:
  - Node-local webhook ingress belongs on the node listener (\`NEXUS_NODE_WEBHOOK_*\` / \`--webhook-port\` + \`--webhook-path\`), not a new gateway route.
  - Enable/disable switch is \`NEXUS_NODE_WEBHOOK_PORT\`: \`>0\` enables listener; \`0\` or unset disables. \`reference-node-lite\` also accepts \`NEXUS_NODE_LITE_WEBHOOK_PORT\` as an alias when \`NEXUS_NODE_WEBHOOK_PORT\` is not set.
  - Node forwards webhook events to gateway over the node websocket session (\`webhook.deliver\`), and gateway processes them via existing APIs/routes.
  - Dashboard integrations should read/write through existing gateway APIs (\`/api/webhooks/*\`, \`/api/nodes/*\`); do not add a parallel ad-hoc HTTP webhook transport unless explicitly requested.
- For new node-exposed operations:
  1. Define protocol method + payload validation.
  2. Add router mapping and gateway execution path.
  3. Enforce allowlist/firewall constraints (Hermes/transparent/audit mode behavior).
  4. Add integration tests in node router/ws areas.

### Webhook Implementation (Nexus-Specific, Do Not Genericize)
- Treat webhooks in Nexus as a routed pipeline with ownership + signature policy, not as ad-hoc HTTP handlers.
- Canonical implementation files:
  - \`src/gateway/routes/api.ts\` (\`/api/webhooks/*\`, \`/federation-webhook\`, \`/api/federation/inbox\`)
  - \`src/nodes/webhook-ingress.ts\` (node WS webhook ingestion + run report enqueue)
  - \`src/federation/webhook-ingress.ts\` (shared ingress normalizer/validator)
  - \`src/federation/webhook-worker.ts\` (delivery worker)
  - \`examples/nexus-node/README.md\` (node-local webhook setup and expected flow)
- Node webhooks (node -> gateway):
  - Ingress starts on node-local HTTP listener (\`reference-node\` / \`reference-node-lite\`), then node emits \`webhook.deliver\` over \`/nx/nodes\`.
  - Gateway node ingress path is \`src/nodes/webhook-ingress.ts\` and ultimately \`ingestWebhookIngressEvent(...)\`.
  - Destination endpoint must be \`ownerScope="local"\`; node ingress is rejected for non-local endpoint ownership.
  - Expected endpoint/subscription control plane is \`/api/webhooks/endpoints\` + \`/api/webhooks/subscriptions\` (typically \`node.webhook.*\` kinds).
- Federation webhooks (peer gateway -> peer gateway):
  - Ingress endpoint is \`POST /federation-webhook\`, not node WS.
  - Requires canonical webhook signature headers (\`x-nexus-event-id\`, \`x-nexus-timestamp\`, \`x-nexus-nonce\`, \`x-nexus-signature\`, \`x-nexus-key-id\`), trusted peer state, firewall allow, key-scope verification, and replay nonce checks.
  - For \`ownerScope="federation_peer"\` endpoints, \`peerId\` binding is required and \`signingMode\` must be \`ed25519\`.
- Federation inbox transport (task/control envelopes):
  - \`POST /api/federation/inbox\` handles signed federation protocol envelopes (task/control transport), distinct from \`/federation-webhook\`.
  - Do not route node webhook payloads into federation inbox.
- Hard anti-patterns:
  - Do not create new generic webhook routes like \`/api/webhook\`, \`/webhooks/:vendor\`, or dashboard-only ad-hoc ingress handlers.
  - Do not bypass \`/api/webhooks/*\` endpoint/subscription registration for production webhook flows.
  - Do not implement node integrations by posting directly to gateway custom endpoints when node-local listener + WS relay is the intended path.
  - Do not weaken ownerScope/signing/peer/firewall constraints to make integrations "just work".

### Tool Surface Extension Pattern
1. Implement tool with \`defineTool(...)\` in \`src/tools/*\`.
2. Keep zod schema strict and error messages actionable.
3. Register tool in \`src/tools/index.ts\`.
4. Add tool to preset allowlists intentionally (never blanket-add to orchestrator/coder).
5. Add focused tests for success + failure paths.

### Config/Schema Extension Pattern
1. Add schema/default in \`src/state/config.ts\`.
2. Wire consumers in startup/runtime modules.
3. Preserve backward compatibility for existing \`nexus.json\` where possible.
4. Update operator docs/examples when behavior changes.

## Editing and Validation Workflow
1. Discover relevant files/symbols first:
   - \`file_glob\` for path discovery
   - \`code_search\` for cross-file text lookup
   - \`code_symbols\` for exports/definitions/references
2. Read relevant files (\`file_read\` with line numbers when needed; use \`search\` mode for focused in-file lookup).
3. Make minimal edits (\`file_edit_lines\` preferred for precise changes; use \`file_patch\` for multi-hunk unified diffs).
4. Validate:
   - \`npm run typecheck\`
   - \`npm run build\`
   - targeted tests for touched behavior when available
5. Review aggregate changes with \`code_diff\` before deploy (especially for multi-file edits).
6. Deploy in the same coder run:
   - \`ha_deploy\` with \`action="apply"\`
7. If deploy returns \`ERROR\`, stop and report recovery steps from \`infra/DEPLOYMENT.md\`.
8. If deploy succeeds, stop runtime/schema checks in that same run and request a fresh follow-up validation run.

## Guardrails
- Do not run git commands in \`${codeDirPath}\` (Nexus repo). This repository is managed externally by host-side deploy tooling.
- For other repositories under \`${workspaceDirPath}\`, git usage is allowed when relevant to the task.
- Treat auto-deploy fallback as a safety net only; always call \`ha_deploy action="apply"\` explicitly.
- Custom tool/runtime refresh is deploy-only; do not attempt hot-reload paths.
- Keep SSH keys/config in persistent state-backed paths only (\`~/.ssh\` or \`${stateDirPath}/.ssh\`). Do not store keys in ephemeral container paths (for example \`/tmp/*\`).
- Keep probes non-fatal (\`|| true\`) when checking existence/grep-style conditions.

## Retry Policy (Enforced)
Tool errors may include normalized tags like \`[ERROR_CLASS=... retry=...]\`. This policy is now **enforced** by the runner:
- \`retry=no\`: do not repeat the same tool call with identical args; it will be blocked for the rest of the run.
- \`retry=yes\`: at most one identical retry is allowed; further identical calls are blocked.
- \`retry=after_backoff\`: same as \`retry=yes\`, but wait/back off first.

## Shell Probes (Avoid False Failures)
For exploratory \`shell_exec\` probes (grep/head/curl checks), treat “no match” as an expected outcome:
- Make probes non-fatal: append \`|| true\`, or emit explicit \`YES/NO\` output.
- Prefer small single-purpose commands over long pipelines so failures are easier to interpret.

## Troubleshooting
- \`ERROR: full absolute path is required\`: retry with full absolute path.
- Code root read-only errors: confirm writable code mount and \`NEXUS_ALLOW_CODE_WRITE=1\`.
- Missing files: verify \`${codeDirPath}\` contains \`package.json\` and \`src/\`.
- \`ha_deploy\` timeout/pending: check deploy status/logs via infra runbook in \`infra/DEPLOYMENT.md\`.
- Infra runbooks (deploy validation, rollout recovery, TLS/compose issues) live in \`infra/DEPLOYMENT.md\`.
- HA issues: verify only one active node via dashboard HA status.
`;
}

export function getDefaultHeartbeatTemplate(stateDir: string): string {
  const stateDirPath = promptPath(stateDir);
  return `# HEARTBEAT

Proactive task checklist reviewed on each heartbeat tick.

  > **Note:** When the operator gives you new standing instructions about heartbeat behavior,
  > monitoring thresholds, or recurring checks, append them using \`file_write\` with \`mode: "append"\`
  > and an absolute \`${stateDirPath}/HEARTBEAT.md\` path. Only replace the entire file when explicitly requested,
  > using \`file_write\` with \`mode: "overwrite"\`.
  > This ensures instructions persist across restarts.
  > For state markdown files (\`SOUL.md\`, \`AGENTS.md\`, \`USER.md\`, \`CODEGUIDE.md\`, \`HEARTBEAT.md\`, \`MEMORY.md\`, \`NOTES.md\`),
  > always use absolute paths under \`stateDir\`. Example:
  > \`file_read({ path: "${stateDirPath}/NOTES.md", limit: 200 })\`

## Per-Tick Review
- [ ] If there were meaningful learnings outside the daily reflection run, store them with \`memory_store\`
- [ ] Check memories for stale or contradictory entries (\`memory_search\`)
- [ ] Check \`NOTES.md\` for pending items using \`file_read({ path: "${stateDirPath}/NOTES.md", limit: 200 })\`

## Daily Tasks
- [ ] Review recent session history for unfinished work
- [ ] Review job health (run \`job_manage\` action=\`list\` and check disabled/failed jobs)

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

Persistent working notebook across sessions.

## What Belongs Here
- Temporary plans, investigations, hypothesis logs, and execution scratch.
- Medium-priority reminders that are useful but not critical for safe operations.

## What Does NOT Belong Here
- Canonical concrete facts that must be exact at execution time (critical endpoints, identifiers, policy constraints, production paths).
- Critical runbook values required for safe execution.

If a note becomes critical and frequently used, promote it to \`AGENTS.md\`.
If a note becomes critical but lower-frequency, archive it in \`MEMORY.md\`.
Use \`captured_at\`, \`last_verified\`, and \`source\` for promoted factual records.
For non-critical reusable context, prefer \`memory_store\`.

## Active Work
- (none yet)

## Investigations
- (none yet)

## Parking Lot
- (none yet)

## Completed
- (none yet)
`;
}

export function getDefaultMemoryTemplate(): string {
  return `# MEMORY.md

Authoritative archive for verified concrete facts.

This file is not auto-injected into prompts.
Read it intentionally when tasks depend on exact historical values, then copy currently needed facts into \`AGENTS.md\`.

## Record Format
- key:
  value:
  scope:
  captured_at: YYYY-MM-DD
  last_verified: YYYY-MM-DD
  source: tool/command/API
  status: active|superseded|deprecated
  notes:

## Active Records
- (none yet)

## Superseded Records
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
