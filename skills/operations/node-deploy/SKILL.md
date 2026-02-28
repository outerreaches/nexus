---
name: node-deploy
description: Deploy or upgrade Nexus execution nodes (standard or lite) to remote hosts via SSH.
triggers: deploy node, deploy a node, node deploy, install node, install a node, setup node, setup a node, provision a node, provision a node, upgrade node, upgrade a node, node ssh, new node, lite node
---

# Node Deployment

Use this skill to deploy or upgrade Nexus execution nodes on remote hosts. Covers both the standard (Docker-based) and lite (SSH-deployed) variants.

## Node Variants

| | Standard Node | Lite Node |
|---|---|---|
| **Deployment** | Docker Compose on host | SSH + systemd service |
| **State backend** | SQLite | JSON files |
| **Profile** | `standard` | `minimal` |
| **Dependencies** | Docker, npm | Node.js 22+ only |
| **Build** | Builds Docker image on host | Pre-built bundle uploaded |
| **Best for** | Dedicated servers, GPU hosts | Lightweight VMs, edge devices |
| **Script** | `npm run node:deploy` | `npm run node:deploy:lite:ssh` |

## Preflight

1. Verify SSH access to the target host:
   ```
   ssh <user>@<host> "uname -a && node --version"
   ```
2. Verify the gateway is running and accessible:
   ```
   curl -s http://<gateway-host>:18789/health/live
   ```
3. For standard node: verify Docker is installed on the host:
   ```
   ssh <user>@<host> "docker --version && docker compose version"
   ```
4. For lite node: verify Node.js 22+ is available on the host:
   ```
   ssh <user>@<host> "node --version"
   ```

## Deploy Standard Node (Docker)

### Step 1: Run the deploy script

```bash
shell_exec: npm run node:deploy -- \
  --host <user>@<host> \
  --gateway ws://<gateway-host>:18789/nx/nodes
```

Or with more options:
```bash
shell_exec: npm run node:deploy -- \
  --host <user>@<host> \
  --gateway wss://<gateway-host>/nx/nodes \
  --node-id <unique-id> \
  --node-name "<human-readable-name>" \
  --state-dir /data/nexus-node \
  --caps "system.run,process.start,process.status,process.logs,process.cancel" \
  --allow "echo,uname,whoami,pwd,date,ls,cat,python3,pip3"
```

### Step 2: Edit the .env on the host

The script generates a `.env` template. SSH in and customize:
```bash
ssh <user>@<host> "cat /data/nexus-node/.env"
```

Key variables to verify:
- `NEXUS_NODE_GATEWAY_URL` — WebSocket endpoint
- `NEXUS_NODE_ID` — unique identifier
- `NEXUS_NODE_ALLOW_COMMANDS` — allowlisted shell commands
- `NEXUS_NODE_CAPS` — advertised capabilities
- `NEXUS_NODE_GATEWAY_TLS_FINGERPRINT` — if using self-signed TLS

### Step 3: Verify the node is online

```bash
node_manage(action: "list")
```

The new node should appear with status `pending`. Approve it:
```bash
node_manage(action: "set_status", id: "<node-id>", status: "approved")
```

### Step 4: Test connectivity

```bash
node_manage(action: "system_run", id: "<node-id>", command: "echo hello")
```

## Deploy Lite Node (SSH)

### Step 1: Run the deploy script

```bash
shell_exec: npm run node:deploy:lite:ssh -- \
  --host <user>@<host> \
  --gateway ws://<gateway-host>:18789/nx/nodes
```

With full options:
```bash
shell_exec: npm run node:deploy:lite:ssh -- \
  --host <user>@<host> \
  --gateway wss://<gateway-host>/nx/nodes \
  --gateway-fingerprint <SHA256-HEX> \
  --service-name nexus-node-lite \
  --node-id <unique-id> \
  --node-name "<human-readable-name>" \
  --allow "echo,uname,whoami,pwd,date,ls,cat,python3" \
  --caps "system.run,process.start,process.status,process.logs,process.cancel"
```

### Step 2: What the script does

1. Builds the lite artifact locally (`npm run node:lite:build`).
2. Bundles with ws module into a tarball.
3. Uploads to remote host via SCP.
4. Runs `--init` to bootstrap keys and state.
5. Creates `.env` file on remote.
6. Installs systemd service (system scope with sudo, user scope fallback).
7. Attempts to install tmux for shell_interactive support.
8. Starts the service.

### Step 3: Verify

Same as standard — check `node_manage(action: "list")`, approve, and test.

## Upgrade Lite Node

```bash
shell_exec: npm run node:upgrade:lite:ssh -- \
  --host <user>@<host>
```

Options:
- `--remote-dir <path>` — default `~/nexus-node-lite`
- `--layout auto` — auto-detect `releases` (versioned) or `flat` (legacy)
- `--skip-build` — upload without rebuilding (if artifact is current)
- `--dry-run` — test locally without remote changes

The upgrade script:
1. Builds new artifact (unless `--skip-build`).
2. Uploads to a new release directory.
3. Relinks the `current` symlink.
4. Restarts the systemd service.
5. Old releases are preserved for rollback.

## Post-Deploy Configuration

### Expand command allowlist

SSH into the host and edit `.env`:
```
NEXUS_NODE_ALLOW_COMMANDS=echo,uname,whoami,pwd,date,ls,cat,git,python3,pip3,npm,node
```

Then restart the service:
```bash
ssh <user>@<host> "sudo systemctl restart nexus-node-lite"
```

### Enable shell operators

By default, `&&`, `||`, `|`, `;`, `>` are blocked. To enable:
```
NEXUS_NODE_ALLOW_SHELL_OPERATORS=1
```

### Configure file transfer

```
NEXUS_NODE_FILE_TRANSFER_ROOTS=/home/user/projects,/tmp/nexus-transfer
NEXUS_NODE_FILE_TRANSFER_MAX_BYTES=10485760
```

### Enable MCP bridge

```
NEXUS_NODE_MCP_BRIDGE=1
NEXUS_NODE_MCP_BRIDGE_CONFIG=/path/to/mcp-bridge.json
```

### Set up Hermes firewall

Edit `{stateDir}/hermes-policy.json` on the node to move from `transparent` to `audit-only` or `hermes` mode.

## Remote Directory Structure

**Standard (Docker):**
```
/data/nexus-node/
├── keys/                    # Ed25519 keypair
├── reference-node.db        # SQLite state
├── hermes-policy.json       # Firewall policy
├── logs/                    # Rolling logs
└── file-transfer/           # Transfer staging
```

**Lite (SSH):**
```
~/nexus-node-lite/
├── releases/
│   ├── 20260228-143000/     # Versioned releases
│   └── 20260301-090000/
├── current -> releases/...  # Active symlink
└── state/
    ├── keys/                # Ed25519 keypair
    ├── state-json/          # JSON state files
    ├── hermes-policy.json
    └── logs/
```

## Troubleshooting

| Symptom | Check | Fix |
|---------|-------|-----|
| Node stays `pending` | Gateway received connection | Approve via `node_manage(action: "set_status", ...)` |
| Node offline | Service status | `ssh host "systemctl status nexus-node-lite"` |
| Auth failure | Key mismatch | Re-run `--init` to regenerate keys |
| Commands blocked | Allowlist | Edit `NEXUS_NODE_ALLOW_COMMANDS` in `.env`, restart |
| WebSocket refused | Wrong URL / firewall | Verify `NEXUS_NODE_GATEWAY_URL`, check port accessibility |
| TLS handshake fail | Fingerprint mismatch | Update `NEXUS_NODE_GATEWAY_TLS_FINGERPRINT` |
| tmux not found | shellctl needs tmux | `ssh host "sudo apt install -y tmux"` |
| Process tools fail | Caps not advertised | Add to `NEXUS_NODE_CAPS`, restart |

## Guardrails

1. Always verify SSH access before running deploy scripts.
2. Do not deploy with `NEXUS_NODE_ALLOW_SHELL_OPERATORS=1` unless explicitly needed — it enables pipes and redirects.
3. Use specific command allowlists rather than wildcards.
4. For production nodes, configure TLS (`wss://`) with fingerprint pinning.
5. After deploy, always test with a simple command before declaring success.
6. Keep old releases (lite) for rollback — do not prune automatically.

## Completion Protocol

1. Report: node ID, node type (standard/lite), host, gateway URL.
2. Confirm: node is online, approved, and test command succeeded.
3. List: configured capabilities and allowed commands.
4. Note: any warnings (no TLS, wide allowlist, missing tmux, etc.).
