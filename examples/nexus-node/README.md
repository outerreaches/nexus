# Nexus Reference Node

Minimal reference implementation for the Nexus native node protocol on `/nx/nodes`.

Current scope:

- Ed25519 identity keypair generation/persistence (node-local)
- Signed `connect.hello` -> `connect.challenge` -> `connect.prove` handshake
- Signed protocol envelopes (`req` / `res` / `event`)
- `tool.execute` handlers for:
  - `system.run` (allowlisted commands only)
  - `system.which`

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

What it validates:

- signed `connect.hello` -> `connect.challenge` -> `connect.prove` handshake
- signed envelope verification on both sides
- `tool.execute` for `system.which`
- `tool.execute` allowlisted `system.run`
- rejection of a disallowed `system.run` command

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
