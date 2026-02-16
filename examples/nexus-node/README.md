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
- Node-local durable state (`state/reference-node.db`):
  - persisted process records
  - durable outbox for terminal `process.update` payloads
  - `process.ack` handling to mark outbox deliveries complete

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
- `tool.execute` for `system.which`
- `tool.execute` allowlisted `system.run`
- rejection of a disallowed `system.run` command
- `process.start` / `process.status` / `process.logs` / `process.cancel`
- reconnect continuity: forced websocket drop -> reconnect -> process status/logs still queryable
- durable outbox replay: unacked terminal `process.update` is re-delivered after reconnect and acked via `process.ack`
- gateway delivery persistence: `process.update`/`log.append` persisted into gateway state + `process_runs`
- notifier duplicate suppression: two notifier loops share one DB and emit a single summary callback
- HA active/standby smoke: mode transitions, readiness gating, and `/nx/nodes` standby rejection behavior

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
  -v nexus_node_state:/data/nexus-node \
  nexus-reference-node
```

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
