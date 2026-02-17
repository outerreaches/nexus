# Nexus Reference Node

Minimal reference implementation for the Nexus native node protocol on `/nx/nodes`.

Current scope:

- Ed25519 identity keypair generation/persistence (node-local)
- Signed `connect.hello` -> `connect.challenge` -> `connect.prove` handshake
- Signed protocol envelopes (`req` / `res` / `event`)
- `tool.execute` handlers for:
  - `system.run` (allowlisted commands only)
  - `system.which`
- Process primitives:
  - `process.start`
  - `process.status`
  - `process.logs`
  - `process.cancel`
- Policy management (command-gated):
  - `nexus-policyctl` builtin command (available via allowlisted `system.run` / `process.start`)
  - updates persisted to `hermes-policy.json`
  - policy firewall mode control (`transparent` | `audit-only` | `hermes`) with live capability advertisement refresh
- Symbol catalog:
  - `symbols.list` (catalog of available symbol kinds/keys/fields only, no values)
  - `system.run` / `process.start` symbol template resolution (`{{kind:key}}`, `{{kind:key:field}}`) against node-local stores
- Audit:
  - `audit.query` (append-only node-local audit retrieval with filters/pagination)
- File transfer (node allowlisted):
  - `file.pull` / `file.push` for moving small artifacts between node and gateway
- Sanitized Hermes outputs:
  - non-transparent modes return safe summaries + node-local reference handles (no raw payload mirroring to gateway metadata)
- Node-local durable state (`state/reference-node.db`):
  - persisted process records
  - durable outbox for terminal `process.update` payloads
  - `process.ack` handling to mark outbox deliveries complete
  - firewall session records with reuse/expiry handling
  - append-only audit events (`node_audit_events`)
  - sanitized reference artifacts (`node_references`)

## Run

From repository root:

```bash
npm run node:reference -- --gateway ws://127.0.0.1:18789/nx/nodes
```

Optional flags:

- `--node-id <id>`
- `--name <display-name>`
- `--state-dir <dir>` (default `~/.nexus-node`)
- `--caps <csv>`
- `--allow <csv>` (command allowlist for `system.run`/`process.start`; include `nexus-policyctl,file_pull,file_push` to enable control surfaces)
- `--policy-required 1` (fail startup if `hermes-policy.json` is missing/invalid)
- `--file-transfer-roots <csv>` (allowed roots for node file paths; default `<stateDir>/file-transfer`)
- `--file-transfer-max-bytes <n>` (max bytes per file transfer payload; default 5242880)
- `--gateway-tls-fingerprint <sha256-fp>` (pin server cert fingerprint for `wss://` gateways; useful for self-signed certs)
- `--insecure-allow-nonloopback-ws 1` (debug-only escape hatch for `ws://` on non-loopback hosts)

## Hermes symbol stores (node-local)

Reference-node reads symbol metadata from:

- `{stateDir}/hermes-stores/contacts.json`
- `{stateDir}/hermes-stores/accounts.json`
- `{stateDir}/hermes-stores/secrets.json`
- `{stateDir}/hermes-stores/user.json`

The `symbols.list` response includes only kinds/keys/fields (and derived `{{kind:key}}` forms), never raw values.

## Policy control (`nexus-policyctl`)

Runtime policy mutation is command-gated. There is no gateway `policy.update` control-plane method.

- To allow runtime policy changes, add `nexus-policyctl` to `NEXUS_NODE_ALLOW_COMMANDS` (or `--allow`).
- Preset files are loaded from `{stateDir}/policy-presets/`.
- Supported subcommands:
  - `nexus-policyctl show`
  - `nexus-policyctl apply-preset <name>`
  - `nexus-policyctl set-mode <transparent|audit-only|hermes>`
  - `nexus-policyctl deny add <command>`
  - `nexus-policyctl deny remove <command>`
- Guardrails:
  - policy field validation is strict (unknown fields rejected)
  - firewall-mode downgrade and deny-list clear require `--break-glass`
  - writes are atomic and applied immediately for new executions

### `NEXUS_NODE_ALLOW_COMMANDS` semantics

`NEXUS_NODE_ALLOW_COMMANDS` is the node execution allowlist for `system.run` / `process.start` command names.

- It is **not** the full firewall policy model.
- It gates command execution before process launch.
- Hermes `denyCommands` is an additional restriction layer in `firewallMode=hermes`.

Effective command behavior:

- `transparent` / `audit-only`: allowed set = `NEXUS_NODE_ALLOW_COMMANDS`
- `hermes`: allowed set = `NEXUS_NODE_ALLOW_COMMANDS` minus policy `denyCommands`

So Hermes can deny an allowlisted command, but Hermes cannot allow a command that is missing from `NEXUS_NODE_ALLOW_COMMANDS`.
Protocol capabilities (`symbols.list`, `audit.query`, process status/log/cancel) are separate from this command allowlist.

### Node-side preset deployment + verification

If you use `nexus-policyctl apply-preset <name>`, preset files must exist under `{stateDir}/policy-presets/`.

Typical helper-script deployment layout:

```bash
cd ~/nexus-node-deploy
rg "/data/nexus-node" docker-compose.yml
```

If compose uses a host bind mount like `~/.nexus-node:/data/nexus-node`:

```bash
STATE_DIR="$HOME/.nexus-node"
mkdir -p "$STATE_DIR/policy-presets"
cp -v /path/to/Nexus/examples/nexus-node/policies-live/*.json "$STATE_DIR/policy-presets/"
```

Then ensure allowlist + restart:

```bash
cd ~/nexus-node-deploy
# include nexus-policyctl only if runtime policy mutation should be enabled
sed -n '1,220p' .env | rg "NEXUS_NODE_ALLOW_COMMANDS"
docker compose up -d --build
docker compose logs --tail=120 nexus-node
```

Gateway/tool verification examples:

```text
node_system_which { "id": "reference-node-macos-1", "command": "nexus-policyctl" }
node_system_run { "id": "reference-node-macos-1", "command": "nexus-policyctl show" }
node_system_run { "id": "reference-node-macos-1", "command": "nexus-policyctl apply-preset 10-audit-soft" }
node_audit_query { "id": "reference-node-macos-1", "type": "policy.command.applied", "limit": 20 }
```

## MCP bridge (`mcp.bridge`)

The reference node can expose a node-local MCP bridge for tool/resource access over node protocol methods:

- `mcp.list`
- `mcp.call`
- `mcp.resources`

Enable it explicitly:

```bash
export NEXUS_NODE_MCP_BRIDGE=1
# optional override (default: {stateDir}/mcp-bridge.json)
export NEXUS_NODE_MCP_BRIDGE_CONFIG="$HOME/.nexus-node/mcp-bridge.json"
```

If running via Docker Compose, ensure these variables are actually mapped into the container environment (adding them only to `.env` is not sufficient unless compose references them).

Config file shape (`mcp-bridge.json`):

```json
{
  "enabled": true,
  "servers": [
    {
      "id": "smoke",
      "label": "Smoke MCP",
      "command": "/usr/bin/node",
      "args": ["/path/to/server.js"],
      "env": {},
      "timeoutMs": 30000,
      "allowTools": ["echo", "read_*"],
      "allowResources": ["mem://public/*"]
    }
  ]
}
```

Allowlist model:

- Only configured servers are reachable.
- `allowTools` gates `mcp.call` tool names.
- `allowResources` gates `mcp.resources` URI list/read access.
- Empty allowlists deny by default.

Gateway node tools:

```text
node_mcp_list { "id": "<node-id>", "includeTools": true, "includeResources": true }
node_mcp_call { "id": "<node-id>", "serverId": "smoke", "tool": "echo", "arguments": { "text": "hello" } }
node_mcp_resources { "id": "<node-id>", "serverId": "smoke", "action": "list" }
node_mcp_resources { "id": "<node-id>", "serverId": "smoke", "action": "read", "uri": "mem://public/info" }
```

### MCP live validation (operator flow)

Run after the node is online and approved:

1. `node_mcp_list` confirms visible server/tool/resource inventory.
2. `node_mcp_call` succeeds for an allowlisted tool.
3. `node_mcp_call` returns `PERMISSION_DENIED` for a blocked tool.
4. `node_mcp_resources action=list` returns allowlisted URIs.
5. `node_mcp_resources action=read` succeeds for allowlisted URI and returns `PERMISSION_DENIED` for blocked URI.

Expected success signal:

- `node_mcp_list`, `node_mcp_call`, and `node_mcp_resources` all return `status=ok` in gateway tool logs.

Common MCP troubleshooting:

- Symptom: `ERROR: Node <id> does not advertise tool capability mcp.list`.
- Cause: `NEXUS_NODE_MCP_BRIDGE=1` was added only to `.env`, but the compose file did not map `NEXUS_NODE_MCP_BRIDGE*` variables into container `environment:`.
- Fix:
  1. Ensure compose maps:
     - `NEXUS_NODE_MCP_BRIDGE`
     - `NEXUS_NODE_MCP_BRIDGE_CONFIG`
     - `NEXUS_NODE_MCP_BRIDGE_TIMEOUT_MS`
  2. Recreate the node container (`docker compose up -d --build --force-recreate`).
  3. Re-run `node_mcp_list`.

### MCP on macOS host mode (Puppeteer + GitHub)

For local automation on macOS (browser/session workflows), run the node on the host instead of inside Docker. The MCP bridge spawns servers locally via stdio, so host mode gives MCP servers direct access to host runtime and user session context.

Recommended `~/.nexus-node/mcp-bridge.json` (validated):

```json
{
  "enabled": true,
  "servers": [
    {
      "id": "puppeteer",
      "label": "Puppeteer MCP",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-puppeteer@2025.5.12"],
      "timeoutMs": 120000,
      "allowTools": ["*"],
      "allowResources": []
    },
    {
      "id": "github",
      "label": "GitHub MCP",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github@2025.4.8"],
      "timeoutMs": 120000,
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "<set token here>"
      },
      "allowTools": ["*"],
      "allowResources": []
    }
  ]
}
```

Host runtime env reminders:

- `NEXUS_NODE_MCP_BRIDGE=1`
- `NEXUS_NODE_MCP_BRIDGE_CONFIG=/Users/<user>/.nexus-node/mcp-bridge.json`
- `NEXUS_NODE_MCP_BRIDGE_TIMEOUT_MS=120000` (recommended for first-run MCP bootstrap)
- `GITHUB_PERSONAL_ACCESS_TOKEN=<pat>` (required for GitHub MCP calls)

Operational notes from live validation:

- First Puppeteer call can take noticeably longer due to `npx`/package bootstrap and first browser launch. Subsequent calls should be much faster.
- Keep exactly one node process writing to a given `stateDir` (`~/.nexus-node`). Running host and container nodes against the same state database can corrupt SQLite indexes.
- If logs show `database disk image is malformed`, stop the node, back up DB, run `REINDEX`, and restart:

```bash
~/nexus-node-host/stop-node.sh
cp ~/.nexus-node/state/reference-node.db ~/.nexus-node/state/reference-node.db.bak
sqlite3 ~/.nexus-node/state/reference-node.db "REINDEX; PRAGMA integrity_check;"
~/nexus-node-host/run-node-background.sh
```

Current Telegram behavior for MCP screenshots:

- `node_mcp_call` returns screenshot payload/resource data to the agent.
- Automatic Telegram file attachment from MCP screenshot output is not wired yet.
- Use explicit `telegram_send_file` with a gateway-local file path when sending files/images today.

## Node file transfer (`file.pull` / `file.push`)

To move small artifacts between node and gateway (e.g., screenshots, logs, generated files), the reference node exposes two protocol methods:

- `file.pull` — node -> gateway
- `file.push` — gateway -> node

This surface is **disabled by default** and must be explicitly allowlisted on the node:

```bash
# Enable by allowlisting the file transfer command names:
export NEXUS_NODE_ALLOW_COMMANDS="echo,uname,whoami,pwd,date,ls,nexus-policyctl,file_pull,file_push"
# optional: restrict paths to a subdir (recommended)
export NEXUS_NODE_FILE_TRANSFER_ROOTS="$HOME/.nexus-node/file-transfer"
export NEXUS_NODE_FILE_TRANSFER_MAX_BYTES=5242880
```

Gateway tools:

```text
node_file_pull { "id": "<node-id>", "remotePath": "/abs/path/on/node", "overwrite": false }
node_file_push { "id": "<node-id>", "localPath": "/abs/path/on/gateway", "remotePath": "/abs/path/on/node", "overwrite": false }
```

Notes:

- Node paths are constrained to `NEXUS_NODE_FILE_TRANSFER_ROOTS` (default `<stateDir>/file-transfer`). Relative node paths are resolved under `<stateDir>`.
- `node_file_pull` writes the downloaded bytes to a gateway-local file (under `stateDir/node-transfers/<node-id>/...` if `localPath` is omitted) and returns the saved path.
- Allowlist gate is `NEXUS_NODE_ALLOW_COMMANDS` via command names `file_pull` / `file_push`.
- Hermes gate: in `firewallMode=hermes`, `denyCommands` can deny `file_pull` / `file_push` like other command names.

## Transport security policy

- `ws://` is allowed for loopback/local-host style endpoints (`127.0.0.1`, `localhost`, `::1`, `host.docker.internal`).
- Non-loopback endpoints require `wss://` by default.
- Self-signed TLS is supported by pinning `NEXUS_NODE_GATEWAY_TLS_FINGERPRINT` (or `--gateway-tls-fingerprint`).
- Debug-only override: `NEXUS_NODE_INSECURE_ALLOW_NONLOOPBACK_WS=1`.

See all options:

```bash
npm run node:reference -- --help
```

## Smoke test

Run the automated signed-protocol smoke flow:

```bash
npm run node:reference:smoke
```

Run the gateway delivery/notifier smoke flow:

```bash
npm run node:gateway:smoke
```

Run the HA active/standby transition smoke (expects HA stack running):

```bash
npm run node:ha:smoke
```

What it validates:

- signed `connect.hello` -> `connect.challenge` -> `connect.prove` handshake
- signed envelope verification on both sides
- non-loopback transport policy: `ws://` endpoints are hard-rejected unless explicitly overridden
- `tool.execute` for `system.which`
- `tool.execute` allowlisted `system.run`
- rejection of a disallowed `system.run` command
- `process.start` / `process.status` / `process.logs` / `process.cancel`
- legacy `policy.update` is rejected (`METHOD_NOT_IMPLEMENTED`)
- `nexus-policyctl` applies policy updates via allowlisted command path and persists to `hermes-policy.json`
- `nexus-policyctl` firewall mode transitions: `transparent` -> `audit-only` -> `hermes` with capability refresh (`hermes.mode.*`)
- `nexus-policyctl` mutation guards: deny-list clear and firewall-mode downgrades require `--break-glass`
- `symbols.list`: symbol catalog returns kinds/keys/fields and excludes secret values
- symbol resolution: `system.run` / `process.start` resolve `{{kind:key}}` templates on-node (no gateway-side secret access)
- `audit.query`: filtered/cursored retrieval of node-local audit records (`symbols.list` + `process.start` audit assertions in smoke)
- sanitized Hermes outputs: in `audit-only`/`hermes` modes, `system.run` and process log/update payloads return safe summaries + references
- node-owned firewall session continuity: `process.start` returns `firewallSession`; known sessions are reused across reconnects, missing/expired sessions are replaced
- reconnect continuity: forced websocket drop -> reconnect -> process status/logs still queryable
- durable outbox replay: unacked terminal `process.update` is re-delivered after reconnect and acked via `process.ack`
- gateway delivery persistence: `process.update`/`log.append` persisted into gateway state + `process_runs`
- routing security constraints: gateway router can require `backend.nexus` + `hermes.mode.hermes` and hard-fails unmet constraints
- notifier duplicate suppression: two notifier loops share one DB and emit a single summary callback
- HA active/standby smoke: mode transitions, readiness gating, `/nx/nodes` standby rejection behavior, and replay dedupe across failover

Live operator validation runbook:

- `examples/nexus-node/internal-doc`

## Pairing flow

On first connection, the gateway records unknown fingerprints as `pending` and rejects the session.

Approve the node in Nexus:

```bash
# Inside a Nexus session/tooling context:
node_set_status { "id": "<node-id>", "status": "approved" }
```

Then restart/reconnect the reference node.

Pairing persistence expectations:

- Approval is tied to `nodeId` + node fingerprint (node Ed25519 public key).
- Normal gateway restart/redeploy should **not** require re-approval if:
  - gateway state persists under `/data/nexus`, and
  - node identity keys persist under `~/.nexus-node/auth`.
- Re-approval is expected only after identity drift (new/missing node auth keys, different node ID, or node record deletion/reset).

## Docker

Build image from repository root:

```bash
docker build -f examples/nexus-node/Dockerfile -t nexus-reference-node .
```

Run container:

```bash
docker run --rm \
  -e NEXUS_NODE_GATEWAY_URL=ws://host.docker.internal:18789/nx/nodes \
  -e NEXUS_NODE_ID=reference-node-1 \
  -e NEXUS_NODE_ALLOW_COMMANDS=echo,uname,whoami,pwd,date,ls,nexus-policyctl \
  -e TZ=America/Los_Angeles \
  -e NEXUS_NODE_INSECURE_ALLOW_NONLOOPBACK_WS=1 \
  -v nexus_node_state:/data/nexus-node \
  nexus-reference-node
```

The container reads the gateway endpoint from `NEXUS_NODE_GATEWAY_URL`.
For non-loopback production endpoints, use `wss://...` and set `NEXUS_NODE_GATEWAY_TLS_FINGERPRINT`.

For a compose template, see `examples/nexus-node/compose.example.yml`.

## Host deployment (Linux + macOS)

For host deployment helpers, use:

```bash
npm run node:deploy
npm run node:deploy:linux
npm run node:deploy:macos
```

Or run the script directly:

```bash
bash infra/scripts/deploy-nexus-node-linux.sh
```

Validate config generation locally without starting containers:

```bash
npm run node:deploy -- --dry-run
```

On macOS, the generated `.env` defaults to:

```bash
NEXUS_NODE_GATEWAY_URL=ws://host.docker.internal:18789/nx/nodes
```

Timezone note: Dockerized nodes run Linux userland. If `date` appears off by a day relative to local time, set:

```bash
NEXUS_NODE_TZ=America/Los_Angeles
```

The deploy script auto-detects a host timezone when possible and uses it as the default.

For secure non-loopback deployments, point the node at a TLS-enabled gateway endpoint and pin the cert fingerprint:

```bash
NEXUS_NODE_GATEWAY_URL=wss://<gateway-host-or-ip>:18790/nx/nodes
NEXUS_NODE_GATEWAY_TLS_FINGERPRINT=<sha256 fingerprint>
NEXUS_NODE_INSECURE_ALLOW_NONLOOPBACK_WS=0
```

If your local timezone is Eastern, set:

```bash
NEXUS_NODE_TZ=America/New_York
```

On Linux, `.env` starts with a `CHANGE_ME` placeholder for `NEXUS_NODE_GATEWAY_URL`.

If your repo is not at `/data/code`, set:

```bash
export NEXUS_NODE_CODE_DIR=/absolute/path/to/Nexus
npm run node:deploy:linux
```

This script:

- validates Docker + repo prerequisites
- creates `~/nexus-node-deploy/docker-compose.yml`
- creates `~/nexus-node-deploy/.env` on first run
- runs the reference node as a restartable Docker service

Platform roadmap:

- Linux: supported
- macOS: supported
- Windows: planned
