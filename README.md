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

Run the installer via curl:

```bash
curl -fsSL <raw-install-url> | bash -s -- --repo-url <git-repo-url>
```

What this does:

- clones/updates code under `~/.nexus/code`
- builds the CLI
- launches `nexus setup` (green-themed interactive wizard)
- prepares split env files and runtime config under `~/.nexus`
- runs TLS generation, secrets preflight, and deploy flow

You can also run the wizard directly from an existing checkout:

```bash
npm run build
node dist/index.js setup
```

## Start Here: New Instance Deployment

Use this for a fresh VM/host.

### Option A (Recommended): Automated Provision + Deploy

Run from your control machine:

```bash
infra/scripts/archive/provisioning/provision-libvirt-instance.sh \
  --vm-name nexus-service-vm \
  --hostname nexus-service-vm \
  --memory-mb 8192 \
  --disk-size 40G \
  --profile service_custom \
  --repo-url ssh://<host-user>@192.168.122.1/~/git/nexus.git \
  --repo-branch main
```

This provisions VM resources, prepares paths, creates split env files, runs preflight, deploys HA+sidecar+TLS, and bootstraps sidecar provider wiring.

### Option B: Manual Bootstrap on an Existing VM

```bash
# host paths
sudo mkdir -p /data/{code,nexus,workspace}
sudo mkdir -p /data/nexus-config/{gateway,sidecar,watchdog}
sudo chown -R "$USER:$USER" /data/code /data/nexus /data/workspace /data/nexus-config

# code
cd /data
git clone <repo-url> code
cd /data/code

# split env files
cp .env.gateway.example /data/nexus-config/gateway/nexus.env
cp .env.sidecar.example /data/nexus-config/sidecar/nexus.env
cp .env.watchdog.example /data/nexus-config/watchdog/nexus.env
chmod 600 /data/nexus-config/gateway/nexus.env /data/nexus-config/sidecar/nexus.env /data/nexus-config/watchdog/nexus.env
```

Set required values:

- `/data/nexus-config/gateway/nexus.env`
  - `NEXUS_HTTP_API_KEY`
  - `NEXUS_DASHBOARD_PASSWORD`
- `/data/nexus-config/sidecar/nexus.env`
  - `NEXUS_CREDENTIALS_KEY`
  - `NEXUS_SECRETCTL_PASSWORD`
- `/data/nexus-config/watchdog/nexus.env`
  - `NEXUS_HA_API_KEY` (must match `NEXUS_HTTP_API_KEY`)

Deploy:

```bash
cd /data/code
infra/scripts/setup/ha-secrets-preflight.sh --auto-fix --require-http-api-key
infra/scripts/pull-deploy.sh
```

If TLS cert does not exist yet:

```bash
bash infra/scripts/setup/ha-generate-tls-cert.sh --san "$(hostname -f)" --san "$(hostname)"
chmod 644 /data/code/infra/haproxy/certs/nexus.pem
```

## Post-Deploy Verification

```bash
cd /data/code
infra/scripts/ha-rollout.sh status
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
cd /data/code
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

## Secrets Workflow

Do not keep provider credentials as plaintext app vars in env files. Store them in sidecar credential storage and reference them in `nexus.json`.

Reference format:

```text
{{secret:sidecar-main/<path>#password}}
```

Common operations:

```bash
cd /data/code
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
- Keep `/data/nexus-config/*/nexus.env` file mode at `600`.
- Keep `/data/nexus-secrets` isolated for sidecar credential storage.

## Key Docs

- Deployment runbook: `infra/DEPLOYMENT.md`
- Node rollout inventory/runbook: `examples/nexus-node/README.md` and `infra/node-fleet/README.md`
- Secrets operations: `infra/internal-doc`
- HTTP auth rollout/migration: `infra/internal-doc`
- MCP operations: `infra/internal-doc`
- Architecture and federation details: see `src/gateway/start.ts`, `src/gateway/routes/federation.ts`, and `src/federation/*`
