#!/usr/bin/env bash
# Start the host-mode reference node (foreground).
# Expects .env.host next to this script or at $NEXUS_NODE_HOST_DIR.
set -euo pipefail

BASE="${NEXUS_NODE_HOST_DIR:-$HOME/nexus-node-host}"
REPO_ROOT="$BASE/code"
ENV_FILE="$BASE/.env.host"
STATE_DIR="${NEXUS_NODE_STATE_DIR:-$HOME/.nexus-node}"

# Ensure Node >=22 via nvm.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use 22 >/dev/null
else
  echo "[host-node] missing nvm at $NVM_DIR; install Node >=22 first" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "[host-node] missing env file: $ENV_FILE" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

: "${NEXUS_NODE_GATEWAY_URL:?NEXUS_NODE_GATEWAY_URL is required}"
: "${NEXUS_NODE_ID:?NEXUS_NODE_ID is required}"
: "${NEXUS_NODE_NAME:?NEXUS_NODE_NAME is required}"
: "${NEXUS_NODE_CAPS:?NEXUS_NODE_CAPS is required}"
: "${NEXUS_NODE_ALLOW_COMMANDS:?NEXUS_NODE_ALLOW_COMMANDS is required}"

cd "$REPO_ROOT"

CMD=(npm run node:reference --
  --gateway "$NEXUS_NODE_GATEWAY_URL"
  --state-dir "$STATE_DIR"
  --node-id "$NEXUS_NODE_ID"
  --name "$NEXUS_NODE_NAME"
  --caps "$NEXUS_NODE_CAPS"
  --allow "$NEXUS_NODE_ALLOW_COMMANDS"
)

if [ -n "${NEXUS_NODE_MCP_BRIDGE_CONFIG:-}" ] && [ -f "$NEXUS_NODE_MCP_BRIDGE_CONFIG" ]; then
  CMD+=(
    --mcp-bridge "${NEXUS_NODE_MCP_BRIDGE:-1}"
    --mcp-bridge-config "$NEXUS_NODE_MCP_BRIDGE_CONFIG"
    --mcp-bridge-timeout-ms "${NEXUS_NODE_MCP_BRIDGE_TIMEOUT_MS:-60000}"
  )
fi

if [ -n "${NEXUS_NODE_GATEWAY_TLS_FINGERPRINT:-}" ]; then
  CMD+=(--gateway-tls-fingerprint "$NEXUS_NODE_GATEWAY_TLS_FINGERPRINT")
fi

exec "${CMD[@]}"
