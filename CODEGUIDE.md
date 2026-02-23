# CODEGUIDE

Architecture and implementation guide for the **coder** preset.

## Mission
- Make focused code changes in the Nexus codebase.
- Preserve existing architecture and behavior unless the task explicitly requires redesign.
- Finish end-to-end: edit, validate, deploy (`ha_deploy`), then hand off.

## Coder Task Types (`spawn_agent.taskType`)
- `taskType` is recommended when spawning a coder, but not required.
- If omitted, coder defaults to `write` mode for backward compatibility.
- Use `plan`, `review`, or `walkthrough` for read-only runs (no code edits or deploy actions).
- Use `write` when implementation changes are expected.
- Optional hard enforcement exists via `NEXUS_CODER_TASK_TYPE_ENFORCEMENT=hard`; default is soft prompt enforcement.

## Absolute Paths
- Use absolute file paths only.
- Primary source root: `/data/code`
- Runtime state root: `/data/nexus`
- Scratch root: `/data/workspace`
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
- Prompt/state markdown files live in `/data/nexus` (`SOUL.md`, `AGENTS.md`, `USER.md`, `CODEGUIDE.md`, `HEARTBEAT.md`, `NOTES.md`).

### Tooling Layer
- `src/tools/*.ts`: tool implementations.
- `src/tools/file-ops.ts`: absolute-path file tools with root restrictions and write guards.
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
- **Image provider decoupling**: Presets can specify `imageProvider` to route image tool API calls to a different provider than the agent's reasoning model. Example: `imageProvider: "openrouter"` on the `graphic-designer` preset sends image generation through OpenRouter while reasoning uses the default provider. This field is consumed by `src/tools/image-generate.ts` and `src/tools/image-edit.ts`.

### New Agent Preset Pattern
1. Create/update preset file in `src/core/presets/<name>.ts` with:
   - clear role boundary,
   - tool allowlist,
   - budget (`maxIterations`, `maxToolCalls`),
   - optional `toolCallCaps`,
   - optional `spawnAllowlist`.
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
- For new node-exposed operations:
  1. Define protocol method + payload validation.
  2. Add router mapping and gateway execution path.
  3. Enforce allowlist/firewall constraints (Hermes/transparent/audit mode behavior).
  4. Add integration tests in node router/ws areas.

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
1. Read relevant files first (`file_read` with line numbers when needed).
2. Make minimal edits (`file_edit_lines` preferred for precise changes).
3. Validate:
   - `npm run typecheck`
   - `npm run build`
   - targeted tests for touched behavior when available
4. Deploy in the same coder run:
   - `ha_deploy` with `action="apply"`
5. If deploy returns `ERROR`, stop and report recovery steps from `infra/DEPLOYMENT.md`.
6. If deploy succeeds, stop runtime/schema checks in that same run and request a fresh follow-up validation run.

## Guardrails
- Do not run git commands in `/data/code` (Nexus repo). This repository is managed externally by host-side deploy tooling.
- For other repositories under `/data/workspace`, git usage is allowed when relevant to the task.
- Treat auto-deploy fallback as a safety net only; always call `ha_deploy action="apply"` explicitly.
- Keep probes non-fatal (`|| true`) when checking existence/grep-style conditions.

## Troubleshooting
- `ERROR: full absolute path is required`: retry with full absolute path.
- Code root read-only errors: confirm writable code mount and `NEXUS_ALLOW_CODE_WRITE=1`.
- `ha_deploy` timeout/pending: check deploy status/logs via infra runbook in `infra/DEPLOYMENT.md`.
