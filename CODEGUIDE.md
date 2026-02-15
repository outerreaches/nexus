# CODEGUIDE

This file is loaded into the **coder** agent's prompt. Keep it accurate and concise.

## TL;DR — Safe Self-Modification Workflow

1. **Locate the correct repo root** via absolute path under `codeDir` (must contain `package.json` + `src/`).
2. **Read before editing** (`file_read` with line ranges).
3. **Apply minimal direct edits** using absolute paths under `codeDir` (`file_edit`, `file_edit_lines`, `file_write`).
4. **Validate locally** (`npm run typecheck`, `npm run build`).
5. **Deploy in the same coder run** (`ha_deploy` with `action="apply"`).

### IMPORTANT: Write + Deploy Boundaries

- **Coder may write directly to absolute paths under `codeDir`.**
- **Do NOT run raw `git add`, `git commit`, or `git push` from coder runs.**
- **Do NOT call `gateway_restart` for code deploys.**
- **Use `ha_deploy` for deployment.**
- **Use absolute paths under `workspaceDir` for scratch files.**

If changes "disappear" after a restart, you probably edited the image filesystem (`/app`) instead of a persistent mounted code directory.

---

## Runtime Directories (Critical for Self-Mod)

Nexus resolves three key directories at runtime:

- **stateDir**: persistent state (SQLite DB, config, personalization files)
- **codeDir**: the source code tree for absolute-path code edits
- **workspaceDir**: agent scratch/work area for absolute-path workspace files

File tools require absolute paths under `stateDir`, `codeDir`, or `workspaceDir`.

### How codeDir/workspaceDir are chosen

- `stateDir` defaults from `NEXUS_STATE_DIR` (or `~/.nexus`).
- `codeDir` **defaults to the built image source tree** (usually `/app`) unless configured.
- `workspaceDir` defaults to `{stateDir}/workspace` unless configured.

### Production/VM recommendation (persistent self-editing)

In your `{stateDir}/nexus.json`, explicitly set:

```json
{
  "codeDir": "${NEXUS_CODE_DIR}",
  "workspaceDir": "${NEXUS_WORKSPACE_DIR}"
}
```

...then mount those paths in Docker Compose:

- `/data/code` -> `NEXUS_CODE_DIR` (a real git working tree)
- `/data/workspace` -> `NEXUS_WORKSPACE_DIR`

### Sanity check (always do this first)

```
file_list path="/data/code"
```

You should see `package.json`, `src/`, `tsconfig.json`, etc.

---

## Project Structure (Source)

```
src/
  index.ts              # CLI entry (commander) — starts gateway/chat/etc.
  core/                 # Agent runner, presets, prompt builder
    agent-runner.ts     # LLM ↔ tool loop, iterations/budget
    agent-service.ts    # Session orchestration, persistence, concurrency
    agent-tracker.ts    # Tracks running/recent agent runs (dashboard)
    presets/            # Orchestrator/coder/researcher/analyst/trader prompts
    prompt.ts           # Builds prompt from state files + skills
  gateway/              # Runtime gateway services
    start.ts            # Boot: DB, tools, agent, HTTP, scheduler, telegram
    http.ts             # Hono HTTP API + dashboard UI
    proactive.ts        # Heartbeat tick loop
    telegram.ts         # Telegram bot + pairing/allowlist
  scheduler/            # Job scheduler
    job-scheduler.ts    # Tick loop + job execution + leases
    cron.ts             # Cron parsing
  data-intake/          # Data sources + scheduling + storage
    sources/            # Source implementations (stocks, weather, etc.)
    source-store.ts     # data_intake_sources table CRUD
    store.ts            # data_items store/query
  maintenance/          # System jobs + cleanup + backups
    system-jobs.ts      # Seeds SYS_* jobs
    db-backup.ts        # Backup implementation + status
  storage/              # SQLite schema and session persistence
    database.ts         # CREATE TABLE IF NOT EXISTS ... (schema)
    sessions.ts         # Chat message persistence
  state/                # Config + personalization + bootstrap
    config.ts           # JSON5 config with env expansion (${...})
    personalization.ts  # Seeds SOUL/AGENTS/USER/CODEGUIDE/HEARTBEAT/NOTES
    bootstrap.ts        # Seeds state markdown files if missing
    paths.ts            # Runtime path resolution
  tools/                # Built-in tools (all tool implementations)
    index.ts            # Registers tools (getBuiltInTools)
```

Infra (deployment/HA) lives in:

```
infra/
  DEPLOYMENT.md
  docker-compose.ha.yml
  haproxy/
  watchdog/
```

---

## Multi-Agent Architecture (Who does what)

- **orchestrator**: main brain; plans; spawns workers; owns jobs/memory.
- **coder** (you): reads/edits code, runs builds, and executes `ha_deploy` rollout.
- **researcher/analyst/trader**: task specialists (generally should not mutate code).
- **intake-manager**: manages data intake sources (when enabled).
- **job-manager**: manages scheduled jobs and execution policies.
- **credential-manager**: manages credential vault operations.
- **mcp-manager**: manages MCP servers/profiles and delegates MCP-scoped workers.

Workers share results via the blackboard; use clear titles and structured output.

---

## Database Integration (SQLite)

Schema is defined in `src/storage/database.ts` (idempotent creates).

Key tables (high level):
- `sessions`, `messages`: chat history
- `jobs`, `job_runs`, `job_events`, `job_leases`: active scheduler + execution
- `jobs_archive`, `job_runs_archive`, `job_events_archive`: archived deleted/one-shot job history
- `gateway_leases`: HA active-lease (prevents dual-active gateways)
- `data_intake_sources`, `data_items`, `data_item_events`: intake sources + cached data
- `memories`: long-term key/value memory
- `blackboard`: cross-agent scratchpad
- `agent_runs`: agent run tracking
- `mcp_servers`, `mcp_profiles`, `mcp_events`: MCP control plane
- `db_backups`: backup run tracking
- `ha_events`: failover/failback/activation audit trail

Timestamps are **INTEGER ms since epoch**.

### Adding/changing schema
- Add `CREATE TABLE IF NOT EXISTS` and indexes in `src/storage/database.ts`.
- Prefer additive migrations (new columns/tables); avoid destructive schema changes.

---

## Tools (How they’re defined)

All built-in tools live in `src/tools/*` and are registered in `src/tools/index.ts`.

Rules:
- Tool `execute` **returns a string**.
- Use `"OK:"` for success and `"ERROR:"` for failures.
- Keep outputs concise; use JSON when structure helps.

### Adding a tool
1. Add `src/tools/my-tool.ts` (use `defineTool` + `zod` params)
2. Register in `src/tools/index.ts`
3. `shell_exec`: run `npm run typecheck` + `npm run build`
4. Document rollout/verification steps for coder execution (`ha_deploy` when code changes are involved)

---

## Scheduling & Maintenance

- Use the scheduler (jobs) for periodic work. Prefer `mode: "tool_call"` for zero-token automation.
- For one-time execution, create one-shot jobs with `job_create` + `at` (epoch ms or ISO timestamp); they are archived then removed after completion.
- System jobs are seeded in `src/maintenance/system-jobs.ts` (e.g., `SYS_DB_BACKUP`).
- Backups are written under `{stateDir}/backups/YYYY-MM-DD/`.

---

## HA / Standby Mode (Hot Standby)

HA design:
- One gateway should be **active**, others **standby**.
- Active is enforced by a DB-backed lease in `gateway_leases` (`key="gateway_active"`).
- Standby can be promoted via `POST /api/activate`; active can step down via `POST /api/deactivate`.

When modifying code:
- Expect **two containers**. Changes must be deployed/rebuilt so both run the same version.
- A restart of the active instance may cause failover; plan rollouts accordingly.

---

## Prompt / State Files

State markdown files live at `{stateDir}`:
- `SOUL.md`, `AGENTS.md`, `USER.md`, `CODEGUIDE.md`, `HEARTBEAT.md`, `NOTES.md`

Edit them with:

```
file_edit path="/data/nexus/CODEGUIDE.md"
```

For existing files, prefer `file_edit`/`file_edit_lines`; use `file_write mode="append"` for additions and `file_write mode="overwrite"` only when explicitly replacing the entire file.

---

## Troubleshooting Self-Mod

- **Edits fail with read-only errors**: ensure writable `/data/code` mount and `NEXUS_ALLOW_CODE_WRITE=1`.
- **Can’t find files**: verify `file_list path="/data/code"` includes `package.json`.
- **Behavior unchanged after deploy**: verify `ha_deploy` (`action="apply"`) completed and check rollout logs/state.
- **HA oddities**: confirm only one instance is active (dashboard HA section + `/status.activeLease`).
