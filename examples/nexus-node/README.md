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
- Policy delivery:
  - `policy.update` (persisted to `hermes-policy.json`)
  - policy firewall mode control (`transparent` | `audit-only` | `hermes`) with live capability advertisement refresh
- Symbol catalog:
  - `symbols.list` (catalog of available symbol kinds/keys/fields only, no values)
  - `system.run` / `process.start` symbol template resolution (`{{kind:key}}`, `{{kind:key:field}}`) against node-local stores
- Audit:
  - `audit.query` (append-only node-local audit retrieval with filters/pagination)
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
- `--state-dir <dir>`
- `--caps <csv>`
- `--allow <csv>` (command allowlist for `system.run`)
- `--policy-required 1` (fail startup if `hermes-policy.json` is missing/invalid)
- `--gateway-tls-fingerprint <sha256-fp>` (pin server cert fingerprint for `wss://` gateways; useful for self-signed certs)
- `--insecure-allow-nonloopback-ws 1` (debug-only escape hatch for `ws://` on non-loopback hosts)

## Hermes symbol stores (node-local)

Reference-node reads symbol metadata from:

- `{stateDir}/hermes-stores/contacts.json`
- `{stateDir}/hermes-stores/accounts.json`
- `{stateDir}/hermes-stores/secrets.json`
- `{stateDir}/hermes-stores/user.json`

The `symbols.list` response includes only kinds/keys/fields (and derived `{{kind:key}}` forms), never raw values.

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
- `policy.update`: policy document persists to `hermes-policy.json` and affects new firewall session defaults without restart
- `policy.update` firewall mode transitions: `transparent` -> `audit-only` -> `hermes` with capability refresh (`hermes.mode.*`)
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

## Pairing flow

On first connection, the gateway records unknown fingerprints as `pending` and rejects the session.

Approve the node in Nexus:

```bash
# Inside a Nexus session/tooling context:
node_set_status { "id": "<node-id>", "status": "approved" }
```

Then restart/reconnect the reference node.

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
  -e NEXUS_NODE_ALLOW_COMMANDS=echo,uname,whoami,pwd,date,ls \
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
