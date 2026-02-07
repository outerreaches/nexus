# CODEGUIDE

This file is loaded into the **coder** agent's prompt. Keep it accurate and concise.

## TL;DR — Safe Self-Modification Workflow

1. **Locate the correct repo root** in `root="code"` (must contain `package.json` + `src/`).
2. **Read before editing** (`file_read` with line ranges / `withLineNumbers`).
3. **Apply minimal direct edits** to `root="code"` (`file_edit`, `file_edit_lines`, `file_write`).
4. **Typecheck + build** (`shell_exec`).
5. **Deploy** using `ha_deploy` (`action="apply"`). This writes a trigger for the host daemon and polls for the result. The host daemon builds the standby with new code, health-checks it, commits, and switches traffic. This container stays alive throughout.

## IMPORTANT: Deployment Boundaries

- **Coder may edit code directly** under `root="code"`.
- **Mutating git commands are blocked** in `shell_exec` for the code repo. Git is allowed on other repos.
- **Coder must not use** `gateway_restart` as deployment.
- **Coder should use** `ha_deploy` action=`apply` for deployment.
- Use `root="workspace"` for scratch scripts and temporary artifacts.

`ha_deploy` action=`apply` writes a trigger file. The host-side `ha-deployer` daemon picks it up and runs:

```bash
infra/scripts/ha-rollout.sh apply-local "<commit message>" host main
```

`apply-local` flow:
1. Build/recreate standby slot with current working-tree changes.
2. Verify candidate health (`/health/live`).
3. Commit + push on host.
4. Switch traffic to candidate, run smoke checks.
5. Old active left running as standby (rebuilt separately by ha-deployer after result is written).
6. If candidate fails, old active keeps serving and coder gets the error.

---

## Runtime Directories

Nexus resolves three key directories at runtime:

- **stateDir**: persistent state (SQLite DB, config, personalization files)
- **codeDir**: source tree used by `root="code"`
- **workspaceDir**: scratch/work area used by `root="workspace"`

File tools map roots like this:
- `root="state"` → `stateDir`
- `root="code"` → `codeDir`
- `root="workspace"` → `workspaceDir`

### Production/VM recommendation

In `{stateDir}/nexus.json`, set:

```json
{
  "codeDir": "${NEXUS_CODE_DIR}",
  "workspaceDir": "${NEXUS_WORKSPACE_DIR}"
}
```

Mounts in Compose:
- `/data/code` → `NEXUS_CODE_DIR` (writable git working tree)
- `/data/workspace` → `NEXUS_WORKSPACE_DIR`

Set:
- `NEXUS_ALLOW_CODE_WRITE=1`

Sanity check:

```text
file_list root="code" path="."
```

You should see `package.json`, `src/`, `tsconfig.json`.

---

## Project Structure (Source)

```text
src/
  index.ts
  core/
  gateway/
  scheduler/
  data-intake/
  maintenance/
  storage/
  state/
  tools/
```

Infra:

```text
infra/
  DEPLOYMENT.md
  docker-compose.ha.yml
  haproxy/
  watchdog/
  scripts/ha-rollout.sh
```

---

## Multi-Agent Architecture

- **orchestrator**: plans, delegates, coordinates jobs/memory.
- **coder**: code edits + validation (`typecheck`/`build`) + `ha_deploy` action=`apply`.
- **researcher/analyst/trader**: specialized non-code tasks.

Workers should write meaningful results to blackboard and avoid noisy status spam.

---

## Database Integration (SQLite)

Schema is in `src/storage/database.ts`.

Key tables:
- `sessions`, `messages`
- `jobs`, `job_runs`, `job_events`, `job_leases`
- `gateway_leases`
- `data_intake_sources`, `data_items`, `data_item_events`
- `memories`, `blackboard`, `agent_runs`
- `db_backups`, `ha_events`

Timestamps are integer epoch ms.

---

## Tools

Built-in tools live in `src/tools/*` and are registered in `src/tools/index.ts`.

Rules:
- Tool `execute` returns a string.
- Prefix success with `OK:` and failures with `ERROR:`.
- Keep outputs concise.

Adding a tool:
1. Add `src/tools/my-tool.ts` (`defineTool` + `zod`).
2. Register in `src/tools/index.ts`.
3. Run `npm run typecheck` and `npm run build`.
4. Document rollout verification steps (`ha_deploy` for code-changing workflows).

---

## Troubleshooting Self-Mod

- **Edits blocked as read-only**: confirm writable `/data/code` mount and `NEXUS_ALLOW_CODE_WRITE=1`.
- **Can’t find files**: verify `file_list root="code" path="."`.
- **Behavior unchanged**: rollout not executed; run `ha_deploy` with `action="apply"`. Check `action="status"` for deploy state.
- **HA oddities**: confirm one active slot and healthy standby via `/status` and HA dashboard.
