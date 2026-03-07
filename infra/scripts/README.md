# Infra Scripts

This directory keeps only active **management/runtime** scripts.

Path defaults:
- New installs default to `~/.nexus` (`~/.nexus/code`, `~/.nexus/state`, `~/.nexus/config`, `~/.nexus/secrets`).
- Legacy `/data/*` layouts remain supported automatically.
- Set `NEXUS_HOME` (or explicit `CODE_DIR`/`CONFIG_ROOT`/`STATE_DIR`/`STORE_DIR`) to force a specific layout.
- For docker host bind mounts, scripts export/accept `NEXUS_HOST_CODE_DIR`, `NEXUS_HOST_STATE_DIR`, `NEXUS_HOST_WORKSPACE_DIR`, and `NEXUS_HOST_SECRETS_DIR`.

## Active Scripts

### `ha-secretctl.sh`
Manage HA secret material and propagation for the running stack.

Use for:
- checking or syncing secret state used by HA services
- routine secret management operations during steady-state operations

### `pull-deploy.sh`
Host-side update helper that syncs code to `origin/main` (including forced-history updates) and recreates the running compose stack.

Use for:
- operator-driven host updates after pulling repo changes
- service restarts/recreate cycles tied to code updates

Notes:
- Includes compose up/recreate flow and optional prune behavior.
- On macOS, auto-includes `infra/docker-compose.ha.macos.yml`.
- If `ha-deployer` files changed, it reloads/restarts the host autostart integration (`systemd` on Linux, `launchd` on macOS).

### `ha-rollout.sh`
Primary HA rollout manager for controlled slot-based deployments.

Commands:
- `status`
- `deploy [ref]`
- `apply-local [message] [remote] [branch]`
- `finalize [ref]`
- `rollback [ref]`

Use for:
- controlled cutovers with health/smoke validation
- rollback/finalize operations during incidents or maintenance

### `ha-deployer.sh`
Host daemon that watches deploy trigger files from in-container `ha_deploy` tool calls and executes rollout actions.

Use for:
- autonomous agent deploy pipeline (trigger -> apply-local -> ack wait -> finalize)

Run model:
- normally started via `infra/systemd/ha-deployer.service` on Linux
- or via the setup wizard's `launchd` job on macOS

## Directory Layout

- `node/`: node host/lite deploy and upgrade scripts
- `setup/`: one-time/bootstrap scripts (installation, cert generation, onboarding)
- `legacy/`: retained old scripts not part of standard operations
- `archive/`: historical/experimental/smoke/provisioning utilities

Only the four scripts above should be treated as current day-to-day management entrypoints.
