# Nexus

Nexus is a multi-agent gateway with HA failover, sidecar-backed secrets, dynamic MCP integration, Telegram/CLI interaction, and self-editing workflows.

## Main Features

- Multi-agent orchestration with preset-based roles (orchestrator, coder, researcher, security, credential manager, MCP manager).
- HA runtime with active/standby slots, HAProxy routing, watchdog failover, and rollout/rollback tooling.
- Sidecar-first secrets with isolated credential storage, secret references in `nexus.json`, and operator CLIs (`ha-secretctl.sh`, `ha-secrets-onboard.sh`).
- Internal scheduler for cron-style jobs (`job_create`, `job_update`, `job_run_now`, run/event history, failure notifications).
- Data intake framework with source registry, scheduled/manual runs, normalized persistence, and query tooling.
- Dynamic MCP server lifecycle and profile-based delegation (`mcp_server_*`, `mcp_profile_*`, `mcp_delegate`).
- Federation + node connectivity primitives for cross-instance routing and remote node execution paths.
- Telegram and CLI interaction lanes, plus proactive heartbeat/background execution support.
- Self-editing workflows with guarded file/shell tools and HA-aware deploy handoff (`ha_deploy` / host rollout scripts).

## Deployment Standard

The supported deployment path is:

- HA gateway: `nexus-primary` + `nexus-standby` + `haproxy` + `watchdog`
- Secrets sidecar: `secret-sidecar` (sidecar-only secret resolution)
- TLS overlay enabled (`:18790` for node/websocket TLS entry)

## Quick Setup Wizard (Recommended)

Default install root is `~/.nexus`.

Run the bootstrap installer via curl:

```bash
curl -fsSL https://raw.githubusercontent.com/outerreaches/nexus/main/get.sh | bash -s -- --channel stable
```

Release channels:

```bash
# Stable (latest GitHub release tag; falls back to main if none)
curl -fsSL https://raw.githubusercontent.com/outerreaches/nexus/main/get.sh | bash -s -- --channel stable

# Main branch
curl -fsSL https://raw.githubusercontent.com/outerreaches/nexus/main/get.sh | bash -s -- --channel main

# Explicit ref (tag/branch/commit)
curl -fsSL https://raw.githubusercontent.com/outerreaches/nexus/main/get.sh | bash -s -- --ref v0.1.0
```

Forward additional install args (for example non-interactive):

```bash
curl -fsSL https://raw.githubusercontent.com/outerreaches/nexus/main/get.sh | \
  bash -s -- --channel stable --non-interactive --yes
```

What this does:

- clones/updates code under `~/.nexus/code`
- builds the CLI
- installs/updates a `nexus` launcher (default: `~/.local/bin/nexus`) that proxies runtime commands to the active HA container
- launches `nexus setup` (interactive wizard)
- prepares split env files and runtime config under `~/.nexus`
- runs required first-time initialization (personalization + prompt files)
- runs full secrets onboarding (provider selection + API key vaulting + config wiring)
- preserves existing split-env and sidecar credential values on rerun unless overwrite is explicitly confirmed
- runs TLS generation, secrets preflight, and deploy flow
- optionally enables `ha-deployer` autostart (`systemd` on Linux, `launchd` on macOS)

Platform notes:

- Linux is the primary production target (Docker + systemd)
- macOS is supported for local/single-host workflows (Docker Desktop + launchd user agent)

You can also run the wizard directly from an existing checkout:

```bash
npm run build
nexus setup
```

If `nexus` is not installed yet on an existing instance, install the launcher:

```bash
mkdir -p ~/.local/bin && cat > ~/.local/bin/nexus <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

LOCAL_ENTRYPOINT="$HOME/.nexus/code/dist/index.js"
CONTAINER_ENTRYPOINT="${NEXUS_CONTAINER_ENTRYPOINT:-/data/code/dist/index.js}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-infra}"
CLI_TARGET="${NEXUS_CLI_TARGET:-active-container}"

print_err() { printf '[nexus-launcher] ERROR: %s\n' "$*" >&2; }

first_subcommand() {
  local expect_config=0 arg
  for arg in "$@"; do
    if [[ "$expect_config" -eq 1 ]]; then expect_config=0; continue; fi
    case "$arg" in
      --config) expect_config=1 ;;
      --config=*|--verbose|-v|--help|-h|--*|-*) ;;
      *) printf '%s' "$arg"; return 0 ;;
    esac
  done
  return 1
}

container_id_for_service() {
  docker ps \
    --filter "label=com.docker.compose.project=$COMPOSE_PROJECT" \
    --filter "label=com.docker.compose.service=$1" \
    --format '{{.ID}}' | head -n1
}

resolve_active_service() {
  local cid mode_payload service
  for service in nexus-primary nexus-standby; do
    cid="$(container_id_for_service "$service")"; [[ -n "$cid" ]] || continue
    mode_payload="$(docker exec "$cid" sh -lc 'curl -fsS --max-time 2 http://localhost:18789/api/mode' 2>/dev/null || true)"
    [[ "$mode_payload" == *'"mode":"active"'* ]] && { printf '%s' "$service"; return 0; }
  done
  for service in nexus-primary nexus-standby; do
    cid="$(container_id_for_service "$service")"; [[ -n "$cid" ]] && { printf '%s' "$service"; return 0; }
  done
  return 1
}

subcommand="$(first_subcommand "$@" || true)"
if [[ "$CLI_TARGET" == "host" ]] || [[ "$subcommand" == "setup" ]] || [[ "$subcommand" == "uninstall" ]]; then
  exec node "$LOCAL_ENTRYPOINT" "$@"
fi

command -v docker >/dev/null 2>&1 || { print_err "docker is required for active-container mode"; exit 1; }
active_service="$(resolve_active_service || true)"
[[ -n "$active_service" ]] || { print_err "no running HA gateway containers found (project=$COMPOSE_PROJECT)"; exit 1; }
active_cid="$(container_id_for_service "$active_service")"
[[ -n "$active_cid" ]] || { print_err "failed to resolve container id for active service '$active_service'"; exit 1; }

if [[ -t 0 && -t 1 ]]; then
  exec docker exec -it "$active_cid" node "$CONTAINER_ENTRYPOINT" "$@"
fi
exec docker exec -i "$active_cid" node "$CONTAINER_ENTRYPOINT" "$@"
EOF
chmod +x ~/.local/bin/nexus
```

For legacy `/data/*` layouts, set `LOCAL_ENTRYPOINT="/data/code/dist/index.js"` in the launcher.

If needed, add to PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Default launcher mode is `active-container`. Use `NEXUS_CLI_TARGET=host` to force direct host execution when needed.

## Start Here: New Instance Deployment

Use this for a fresh VM/host.

### Recommended Flow (Wizard)

```bash
curl -fsSL https://raw.githubusercontent.com/outerreaches/nexus/main/get.sh | bash -s -- --channel stable
```

The wizard handles clone/build, split env setup, required first-time init, TLS generation, secrets preflight, deploy, and HA status checks.
It also supports provider onboarding for OpenRouter, Fireworks, Baseten, local, and additional common OpenAI-compatible providers, plus custom provider entries.

### Manual Flow from Existing Checkout

```bash
mkdir -p ~/.nexus
git clone <repo-url> ~/.nexus/code
cd ~/.nexus/code
npm ci
npm run build
node dist/index.js setup --root ~/.nexus --code-dir ~/.nexus/code --repo-url <repo-url>
```

Legacy `/data/*` layouts are still supported by infra scripts, but `~/.nexus` is the default standard for new installs.

## Post-Deploy Verification

```bash
cd ~/.nexus/code
infra/scripts/ha-rollout.sh status
source ~/.nexus/config/gateway/nexus.env
curl -s http://localhost:18789/health/traffic | jq .
curl -s -H "Authorization: Bearer $NEXUS_HTTP_API_KEY" http://localhost:18789/api/secrets/providers | jq .
```

Expected:

- both Nexus slots healthy
- one active / one standby
- `sidecar-main` enabled
- `secret-sidecar` healthy

## Updating an Existing Instance

On the instance:

```bash
cd ~/.nexus/code
infra/scripts/pull-deploy.sh
```

This performs:

- git fast-forward to `origin/main`
- HA+sidecar+TLS compose up with rebuild/recreate
- stale container/image/cache pruning

For controlled slot rollout operations:

```bash
infra/scripts/ha-rollout.sh deploy HEAD
infra/scripts/ha-rollout.sh finalize HEAD
infra/scripts/ha-rollout.sh status
```

## Uninstall Autostart Integration

To remove only the host autostart integration for `ha-deployer` (without deleting `~/.nexus` data):

```bash
node dist/index.js uninstall --yes
```

Behavior:

- Linux: disables/removes `ha-deployer` systemd unit wiring
- macOS: unloads/removes `ha-deployer` launchd user-agent plist

## Secrets Workflow

Do not keep provider credentials as plaintext app vars in env files. Store them in sidecar credential storage and reference them in `nexus.json`.

Reference format:

```text
{{secret:sidecar-main/<path>#password}}
```

Common operations:

```bash
cd ~/.nexus/code
infra/scripts/ha-secretctl.sh list
infra/scripts/ha-secretctl.sh set llm.openrouter.api --note "openrouter key"
infra/scripts/ha-secretctl.sh refs llm.openrouter.api
infra/scripts/setup/ha-secrets-onboard.sh
```

## Local Development (Non-HA)

For local iterative development:

```bash
npm install
npm run dev -- init
npm run dev -- gateway --verbose
```

Containerized/runtime deploys are HA-only and should use the HA scripts above (`pull-deploy.sh` / `ha-rollout.sh`).

## Security Notes

- Keep `/dashboard` and `/api/*` on trusted networks or behind authenticated reverse proxy.
- Use strong values for `NEXUS_HTTP_API_KEY` and dashboard credentials.
- Keep `~/.nexus/config/*/nexus.env` file mode at `600`.
- Keep `~/.nexus/secrets` isolated for sidecar credential storage.

## Key Docs

- Deployment runbook: `infra/DEPLOYMENT.md`
- Node rollout inventory/runbook: `examples/nexus-node/README.md` and `infra/node-fleet/README.md`
- Secrets operations: `infra/internal-doc`
- HTTP auth rollout/migration: `infra/internal-doc`
- MCP operations: `infra/internal-doc`
- Architecture and federation details: see `src/gateway/start.ts`, `src/gateway/routes/federation.ts`, and `src/federation/*`
- Shared CLI/setup TUI primitives: `src/cli/tui.ts` (panels, checkboxes, logo); palette definitions in `src/cli/terminal-theme.ts`
