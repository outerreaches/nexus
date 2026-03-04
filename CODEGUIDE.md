# CODEGUIDE

Architecture and implementation guide for the **coder** preset.

## Mission
- Make focused code changes in the Nexus codebase.
- Preserve existing architecture and behavior unless the task explicitly requires redesign.
- Finish end-to-end: edit, validate, deploy (`ha_deploy`), then hand off.
- Spend minimal budget on navigation: use structured code discovery tools first (`code_search`, `file_glob`).

## Coder Task Types (`spawn_agent.taskType`)
- `taskType` is recommended when spawning a coder, but not required.
- If omitted, coder defaults to `write` mode for backward compatibility.
- Use `plan`, `review`, or `walkthrough` for read-only runs (no code edits or deploy actions).
- Use `write` when implementation changes are expected.
- Optional hard enforcement exists via `NEXUS_CODER_TASK_TYPE_ENFORCEMENT=hard`; default is soft prompt enforcement.

## Node-Target Worker Execution (`spawn_agent.execution`)
- Use `execution: { "target": "node", "nodeId": "<node-id>" }` to run a spawned worker against a specific node tmux shell.
- Node-target workers are shell-driven (`shell_interactive`) and require:
  - node status `online`
  - node backend `nexus`
  - node capability `system.run`
  - node firewall mode `transparent`
- In node-target mode, local file/code/deploy tools are removed; use shell workflow (`open -> send -> read -> close`).

## Execution Mode Selection (Strict)
- Use one-shot execution for short stateless commands:
  - local: `shell_exec`
  - node: `node_manage` action=`system_run`
- Use `shell_interactive` for short stateful multi-step workflows (`open -> send -> read -> close`).
- Use process tools for long-running/background tasks:
  - local: `process_start` -> `process_status` / `process_logs` -> `process_stop`
  - node: `node_manage` action=`process_start|process_status|process_logs|process_stop`
- Never use sleep loops as a waiting strategy in interactive shell.
- If a long foreground command was started accidentally in interactive shell, interrupt it and relaunch via process tools.

## Absolute Paths
- Use absolute file paths only.
- Primary source root: `/data/code`
- Runtime state root: `/data/nexus`
- Scratch root: `/data/workspace`
- Treat `/data/code` as Nexus source only. Do not create unrelated app/scripts there.
- Place non-Nexus code under `/data/workspace/projects/<slug>/` (create a slug first if missing).
- Persistent SSH path: `/data/nexus/.ssh` (`~/.ssh` in gateway containers because `HOME=/data/nexus`)
- Runtime prompt source of truth is `/data/nexus/CODEGUIDE.md`.

## System Architecture

### Startup and Wiring
- `src/gateway/start.ts`: main composition root.
  - Loads `nexus.json` via `src/state/config.ts`.
  - Resolves runtime paths and bootstrap/init state.
  - Opens DB and initializes service managers.
  - Resolves secret-backed config values before consumers start.
  - Starts HTTP server, scheduler, telegram, proactive, federation workers, node gateway.

### Agent Runtime
- `src/core/agent-service.ts`: sessioning, preset resolution, tool filtering, prompt assembly.
- `src/core/agent-runner.ts`: LLM/tool loop, retry policy enforcement, deploy handoff guard.
- `src/core/isolated-worker.ts`: isolated worker execution for presets like coder; includes auto-deploy safeguard when coder edits+builds but skips deploy.

### Presets and Prompts
- `src/core/presets/*.ts`: tool allowlists, budgets, role behavior, model defaults.
- `src/core/presets/coder.ts`: coder-specific hard rules.
- Prompt/state markdown files live in `/data/nexus` (`SOUL.md`, `AGENTS.md`, `USER.md`, `CODEGUIDE.md`, `MEMORY.md`, `HEARTBEAT.md`, `NOTES.md`).
- `MEMORY.md` is an authoritative archive (manually read when concrete historical facts are needed).

### Tooling Layer
- `src/tools/*.ts`: tool implementations.
- `src/tools/file-ops.ts`: absolute-path file tools with root restrictions and write guards.
- `src/tools/code-intel.ts`: code navigation/diff tools (`code_search`, `file_glob`, `code_diff`).
- `src/tools/system.ts`: `shell_exec` plus mutating-git block on code repo.
- `src/tools/ha-deploy.ts`: deploy trigger/status tool.

### Storage and Config
- `src/state/config.ts`: schema/defaults for `nexus.json`.
- `src/storage/database.ts`: SQLite schema and migrations.
- `src/state/personalization.ts`: default templates for state markdown files.

### Domain Areas
- Federation: `src/federation/*`, `src/gateway/routes/federation.ts`, federation storage modules.
- Nodes: `src/nodes/*`, node routes in `src/gateway/routes/nodes.ts`.
- Secrets: `src/secrets/*`, secret provider/storage modules, startup resolution in `start.ts`.

## Extensible Systems

### Secret Reference Pattern
- Secret refs must use: `{{secret:<provider-id>/<path>#<field>}}`.
- Standard field is `#password` unless a provider explicitly uses another field (for example `username`).
- Preferred provider in production is sidecar-backed (`sidecar-main`).
- Main resolution paths:
  - startup env-secret registry: `config.secrets.env` -> `src/secrets/resolve-env.ts` -> `getSecret(...)`.
  - direct runtime resolution: `parseSecretReference` / `resolveSecretReference` in `src/secrets/provider.ts`.
- When adding new config secrets:
  1. Add key to `config.secrets.env` usage.
  2. Resolve through existing startup/runtime secret helpers (do not add plaintext-only bypasses).
  3. Add/update tests in `src/secrets/*.test.ts` or consumer tests.

### LLM Provider Extension Pattern
- All LLM routing is config-driven in `nexus.json` — **preset files must not contain `llm` blocks**.
- Architecture: `src/state/config.ts` (schema) → `src/gateway/start.ts` (wiring) → `src/llm/model-router.ts` (resolution) → `src/llm/openai-compat.ts` (client).
- Circuit breaker (`src/llm/circuit-breaker.ts`) monitors the default provider and fails over to `routing.localProvider`.
- Routing priority chain (highest wins):
  1. `routing.default` — base route for all agents
  2. `routing.byPreset[presetName]` — per-preset override
  3. `routing.byAgent[agentId]` — per-agent override (highest)
- To add a new LLM provider:
  1. **Request the user to create the API key credential** in the sidecar vault (e.g. `llm.<provider>.api`). Do not proceed until confirmed.
  2. Add env-var mapping in `nexus.json` `secrets.env`: `"<PROVIDER>_API_KEY": "{{secret:sidecar-main/llm.<provider>.api#password}}"`.
  3. Add the provider entry in `nexus.json` `llm.providers`:
     ```json
     "<provider-name>": {
       "baseUrl": "https://<provider-api-base>/v1",
       "apiKey": "${<PROVIDER>_API_KEY}",
       "model": "<default-model-id>"
     }
     ```
  4. **Note:** Model IDs are provider-specific and may be case-sensitive (e.g. OpenRouter normalizes to lowercase, Baseten preserves original casing).
  5. Add routing rules in `routing.byPreset` or `routing.default` to direct traffic:
     ```json
     "<preset-name>": {
       "primary": { "provider": "<provider-name>", "model": "<model-id>" },
       "fallback": { "provider": "local" }
     }
     ```
  6. Always include `"fallback": { "provider": "local" }` for resilience.
  7. Validate via typecheck + build, then deploy with `ha_deploy`.
- **Tool-vs-agent LLM separation**: Agent reasoning models are selected via `llm.routing`, while generation/analysis tools use `llm.toolRouting` (with optional preset/agent overrides) so tool models/providers are independent from worker reasoning routes. Image/video tools still support preset fallbacks (`imageModel`/`imageProvider`, `videoModel`/`videoProvider`) when `llm.toolRouting` is not configured.

### New Agent Preset Pattern
1. Create/update preset file in `src/core/presets/<name>.ts` with:
   - clear role boundary,
   - tool allowlist,
   - budget (`maxIterations`, `maxToolCalls`),
   - optional `toolCallCaps`,
   - optional `spawnAllowlist`,
   - optional `allowPinnedSpawnEscape` (default false; node-pinned runs of this preset must keep child spawns on the same node).
2. Register in `src/core/presets.ts` (import + map wiring).
3. Keep orchestrator delegation logic coherent in `src/core/presets/orchestrator.ts`.
4. If preset depends on prompt files, ensure those files are stable in runtime state.
5. Add tests for critical routing/behavior changes.

### Data Intake Extension Pattern
1. Add source implementation under `src/data-intake/sources/`.
2. Register source in `src/data-intake/sources/index.ts`.
3. Define clear params + `usageNote` + normalization output shape.
4. Ensure scheduling compatibility (source store + `data_intake_run` paths).
5. Expose only through existing intake tools (`data_intake_source_add/update/delete`, `data_intake_run`, `data_intake_query`).
6. Add tests for params, normalization, and persistence behavior.

### Node Architecture Extension Pattern
- Node runtime path is capability-routed, not direct local execution:
  - registry/session state: `src/nodes/registry.ts`
  - tool-to-method routing: `src/nodes/router.ts`
  - websocket protocol handling: `src/nodes/ws-gateway.ts`
  - gateway-facing node tools: `src/tools/nodes.ts`
- Webhook architecture invariants:
  - Node-local webhook ingress belongs on the node listener (`NEXUS_NODE_WEBHOOK_*` / `--webhook-port` + `--webhook-path`), not a new gateway route.
  - Enable/disable switch is `NEXUS_NODE_WEBHOOK_PORT`: `>0` enables listener; `0` or unset disables. `reference-node-lite` also accepts `NEXUS_NODE_LITE_WEBHOOK_PORT` as an alias when `NEXUS_NODE_WEBHOOK_PORT` is not set.
  - Node forwards webhook events to gateway over the node websocket session (`webhook.deliver`), and gateway processes them via existing APIs/routes.
  - Dashboard integrations should read/write through existing gateway APIs (`/api/webhooks/*`, `/api/nodes/*`); do not add a parallel ad-hoc HTTP webhook transport unless explicitly requested.
- For new node-exposed operations:
  1. Define protocol method + payload validation.
  2. Add router mapping and gateway execution path.
  3. Enforce allowlist/firewall constraints (Hermes/transparent/audit mode behavior).
  4. Add integration tests in node router/ws areas.

### Webhook Implementation (Nexus-Specific, Do Not Genericize)
- Treat webhooks in Nexus as a routed pipeline with ownership + signature policy, not as ad-hoc HTTP handlers.
- Canonical implementation files:
  - `src/gateway/routes/api.ts` (`/api/webhooks/*`, `/federation-webhook`, `/api/federation/inbox`)
  - `src/nodes/webhook-ingress.ts` (node WS webhook ingestion + run report enqueue)
  - `src/federation/webhook-ingress.ts` (shared ingress normalizer/validator)
  - `src/federation/webhook-worker.ts` (delivery worker)
  - `examples/nexus-node/README.md` (node-local webhook setup and expected flow)
- Node webhooks (node -> gateway):
  - Ingress starts on node-local HTTP listener (`reference-node` / `reference-node-lite`), then node emits `webhook.deliver` over `/nx/nodes`.
  - Gateway node ingress path is `src/nodes/webhook-ingress.ts` and ultimately `ingestWebhookIngressEvent(...)`.
  - Destination endpoint must be `ownerScope="local"`; node ingress is rejected for non-local endpoint ownership.
  - Expected endpoint/subscription control plane is `/api/webhooks/endpoints` + `/api/webhooks/subscriptions` (typically `node.webhook.*` kinds).
- Federation webhooks (peer gateway -> peer gateway):
  - Ingress endpoint is `POST /federation-webhook`, not node WS.
  - Requires canonical webhook signature headers (`x-nexus-event-id`, `x-nexus-timestamp`, `x-nexus-nonce`, `x-nexus-signature`, `x-nexus-key-id`), trusted peer state, firewall allow, key-scope verification, and replay nonce checks.
  - For `ownerScope="federation_peer"` endpoints, `peerId` binding is required and `signingMode` must be `ed25519`.
- Federation inbox transport (task/control envelopes):
  - `POST /api/federation/inbox` handles signed federation protocol envelopes (task/control transport), distinct from `/federation-webhook`.
  - Do not route node webhook payloads into federation inbox.
- Hard anti-patterns:
  - Do not create new generic webhook routes like `/api/webhook`, `/webhooks/:vendor`, or dashboard-only ad-hoc ingress handlers.
  - Do not bypass `/api/webhooks/*` endpoint/subscription registration for production webhook flows.
  - Do not implement node integrations by posting directly to gateway custom endpoints when node-local listener + WS relay is the intended path.
  - Do not weaken ownerScope/signing/peer/firewall constraints to make integrations "just work".

### Tool Surface Extension Pattern
1. Implement tool with `defineTool(...)` in `src/tools/*`.
2. Keep zod schema strict and error messages actionable.
3. Register tool in `src/tools/index.ts`.
4. Add tool to preset allowlists intentionally (never blanket-add to orchestrator/coder).
5. Add focused tests for success + failure paths.

### Config/Schema Extension Pattern
1. Add schema/default in `src/state/config.ts`.
2. Wire consumers in startup/runtime modules.
3. Preserve backward compatibility for existing `nexus.json` where possible.
4. Update operator docs/examples when behavior changes.

## Editing and Validation Workflow
1. Discover relevant files/symbols first:
   - `file_glob` for path discovery
   - `code_search` for cross-file text lookup
2. Read relevant files (`file_read` with line numbers when needed; use `search` mode for focused in-file lookup).
3. Make minimal edits (`file_edit_lines` preferred for precise changes; use `file_patch` for multi-hunk unified diffs).
4. Validate:
   - `npm run typecheck`
   - `npm run build`
   - targeted tests for touched behavior when available
5. Review aggregate changes with `code_diff` before deploy (especially for multi-file edits).
6. Deploy in the same coder run:
   - `ha_deploy` with `action="apply"`
7. If deploy returns `ERROR`, stop and report recovery steps from `infra/DEPLOYMENT.md`.
8. If deploy succeeds, stop runtime/schema checks in that same run and request a fresh follow-up validation run.

## Guardrails
- Do not run git commands in `/data/code` (Nexus repo). This repository is managed externally by host-side deploy tooling.
- For other repositories under `/data/workspace`, git usage is allowed when relevant to the task.
- Treat auto-deploy fallback as a safety net only; always call `ha_deploy action="apply"` explicitly.
- Custom tool/runtime refresh is deploy-only; do not attempt hot-reload paths.
- Keep SSH keys/config in persistent state-backed paths only (`~/.ssh` or `/data/nexus/.ssh`). Do not store keys in ephemeral container paths (for example `/tmp/*`).
- Avoid shell control operators in probe commands by default; run a single command and treat expected no-match/not-found outcomes as signal.

## Retry Policy (Enforced)
Tool errors may include normalized tags like `[ERROR_CLASS=... retry=...]`. This policy is now **enforced** by the runner:
- `retry=no`: do not repeat the same tool call with identical args; it will be blocked for the rest of the run.
- `retry=yes`: at most one identical retry is allowed; further identical calls are blocked.
- `retry=after_backoff`: same as `retry=yes`, but wait/back off first.

## Shell Probes (Avoid False Failures)
For exploratory `shell_exec` probes (grep/head/curl checks), treat “no match” as an expected outcome:
- Avoid shell control operators by default; run a single command and interpret expected no-match/not-found outcomes without retry loops.
- Prefer small single-purpose commands over long pipelines so failures are easier to interpret.

## Troubleshooting
- `ERROR: full absolute path is required`: retry with full absolute path.
- Code root read-only errors: confirm writable code mount and `NEXUS_ALLOW_CODE_WRITE=1`.
- Missing files: verify `/data/code` contains `package.json` and `src/`.
- `ha_deploy` timeout/pending: check deploy status/logs via infra runbook in `infra/DEPLOYMENT.md`.
- Infra runbooks (deploy validation, rollout recovery, TLS/compose issues) live in `infra/DEPLOYMENT.md`.
- HA issues: verify only one active node via dashboard HA status.
