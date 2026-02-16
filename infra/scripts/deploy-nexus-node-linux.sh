#!/bin/bash
# Deploy the Nexus reference node on Linux or macOS using Docker Compose.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[!]${NC} $1"; exit 1; }

print_help() {
  cat <<'EOF'
Usage: deploy-nexus-node-linux.sh [--dry-run]

Options:
  --dry-run   Generate/validate deployment files but skip Docker build/up.
  -h, --help  Show this help message.

Environment overrides:
  NEXUS_NODE_CODE_DIR
  NEXUS_NODE_DEPLOY_DIR
  NEXUS_NODE_STATE_HOST_DIR
  NEXUS_NODE_TZ
EOF
}

DRY_RUN=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      error "Unknown argument: $1"
      ;;
  esac
done

OS_NAME="$(uname -s)"
case "$OS_NAME" in
  Linux)
    PLATFORM_LABEL="Linux"
    DEFAULT_STATE_DIR="/data/nexus-node"
    DEFAULT_GATEWAY_URL="ws://CHANGE_ME:18789/nx/nodes"
    DEFAULT_NODE_ID="reference-node-linux-1"
    DEFAULT_NODE_NAME="Nexus Linux Reference Node"
    ;;
  Darwin)
    PLATFORM_LABEL="macOS"
    DEFAULT_STATE_DIR="$HOME/.nexus-node"
    DEFAULT_GATEWAY_URL="ws://host.docker.internal:18789/nx/nodes"
    DEFAULT_NODE_ID="reference-node-macos-1"
    DEFAULT_NODE_NAME="Nexus macOS Reference Node"
    ;;
  *)
    error "Unsupported OS: $OS_NAME (currently supports Linux and macOS)."
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

detect_default_timezone() {
  if [ -n "${NEXUS_NODE_TZ:-}" ]; then
    printf '%s' "$NEXUS_NODE_TZ"
    return 0
  fi

  local tz=""
  if command -v timedatectl > /dev/null 2>&1; then
    tz="$(timedatectl show -p Timezone --value 2> /dev/null || true)"
    tz="$(printf '%s' "$tz" | tr -d '\r\n[:space:]')"
    if [ -n "$tz" ] && [ "$tz" != "n/a" ]; then
      printf '%s' "$tz"
      return 0
    fi
  fi

  if [ -f /etc/timezone ]; then
    tz="$(tr -d '\r\n[:space:]' < /etc/timezone)"
    if [ -n "$tz" ]; then
      printf '%s' "$tz"
      return 0
    fi
  fi

  if [ -L /etc/localtime ]; then
    local target=""
    target="$(readlink /etc/localtime || true)"
    case "$target" in
      *zoneinfo/*)
        tz="${target#*zoneinfo/}"
        if [ -n "$tz" ]; then
          printf '%s' "$tz"
          return 0
        fi
        ;;
    esac
  fi

  printf '%s' "UTC"
}

if [ -n "${NEXUS_NODE_CODE_DIR:-}" ]; then
  CODE_DIR="$NEXUS_NODE_CODE_DIR"
elif [ -f "/data/code/examples/nexus-node/reference-node.ts" ]; then
  CODE_DIR="/data/code"
else
  CODE_DIR="$REPO_ROOT"
fi

DEPLOY_DIR="${NEXUS_NODE_DEPLOY_DIR:-$HOME/nexus-node-deploy}"
STATE_DIR="${NEXUS_NODE_STATE_HOST_DIR:-$DEFAULT_STATE_DIR}"
DEFAULT_NODE_TZ="$(detect_default_timezone)"

log "Platform: $PLATFORM_LABEL"
log "Using deployment directory: $DEPLOY_DIR"
log "Using code directory: $CODE_DIR"
log "Using node state directory: $STATE_DIR"
log "Using node timezone: $DEFAULT_NODE_TZ"

if [ ! -d "$CODE_DIR" ]; then
  error "Code directory not found: $CODE_DIR"
fi

if [ ! -f "$CODE_DIR/examples/nexus-node/reference-node.ts" ]; then
  error "reference-node.ts not found under $CODE_DIR/examples/nexus-node"
fi

if [ ! -f "$CODE_DIR/examples/nexus-node/Dockerfile" ]; then
  error "Dockerfile not found under $CODE_DIR/examples/nexus-node"
fi

if ! command -v docker > /dev/null 2>&1; then
  error "Docker is required but was not found."
fi

if [ "$DRY_RUN" -eq 0 ] && ! docker ps > /dev/null 2>&1; then
  error "Cannot connect to Docker daemon. Check Docker service and user permissions."
fi

mkdir -p "$DEPLOY_DIR" "$STATE_DIR"
cd "$DEPLOY_DIR"

log "Writing docker-compose.yml..."
cat > docker-compose.yml <<EOF
services:
  nexus-node:
    build:
      context: $CODE_DIR
      dockerfile: examples/nexus-node/Dockerfile
    container_name: nexus-reference-node
    command: ["sh", "-lc", "npm run node:reference -- --gateway \"\$NEXUS_NODE_GATEWAY_URL\""]
    environment:
      NEXUS_NODE_GATEWAY_URL: \${NEXUS_NODE_GATEWAY_URL}
      NEXUS_NODE_GATEWAY_TLS_FINGERPRINT: \${NEXUS_NODE_GATEWAY_TLS_FINGERPRINT:-}
      NEXUS_NODE_INSECURE_ALLOW_NONLOOPBACK_WS: \${NEXUS_NODE_INSECURE_ALLOW_NONLOOPBACK_WS:-0}
      NEXUS_NODE_MCP_BRIDGE: \${NEXUS_NODE_MCP_BRIDGE:-0}
      NEXUS_NODE_MCP_BRIDGE_CONFIG: \${NEXUS_NODE_MCP_BRIDGE_CONFIG:-/data/nexus-node/mcp-bridge.json}
      NEXUS_NODE_MCP_BRIDGE_TIMEOUT_MS: \${NEXUS_NODE_MCP_BRIDGE_TIMEOUT_MS:-30000}
      NEXUS_NODE_ID: \${NEXUS_NODE_ID:-$DEFAULT_NODE_ID}
      NEXUS_NODE_NAME: \${NEXUS_NODE_NAME:-$DEFAULT_NODE_NAME}
      NEXUS_NODE_CAPS: \${NEXUS_NODE_CAPS:-system.run,system.which,process.start,process.status,process.logs,process.cancel,symbols.list,audit.query}
      NEXUS_NODE_ALLOW_COMMANDS: \${NEXUS_NODE_ALLOW_COMMANDS:-echo,uname,whoami,pwd,date,ls}
      NEXUS_NODE_RECONNECT_MIN_MS: \${NEXUS_NODE_RECONNECT_MIN_MS:-2000}
      NEXUS_NODE_RECONNECT_MAX_MS: \${NEXUS_NODE_RECONNECT_MAX_MS:-30000}
      TZ: \${NEXUS_NODE_TZ:-$DEFAULT_NODE_TZ}
      NEXUS_NODE_STATE_DIR: /data/nexus-node
    volumes:
      - $STATE_DIR:/data/nexus-node
    restart: unless-stopped
EOF

if [ ! -f .env ]; then
  log "Creating .env template..."
  cat > .env <<EOF
# Required: gateway endpoint for native Nexus node protocol.
# Example (Linux same host): NEXUS_NODE_GATEWAY_URL=ws://127.0.0.1:18789/nx/nodes
# Example (macOS same host): NEXUS_NODE_GATEWAY_URL=ws://host.docker.internal:18789/nx/nodes
# Example (remote host):      NEXUS_NODE_GATEWAY_URL=wss://gateway.example.com/nx/nodes
NEXUS_NODE_GATEWAY_URL=$DEFAULT_GATEWAY_URL
# Optional for self-signed remote TLS:
# NEXUS_NODE_GATEWAY_TLS_FINGERPRINT=AB:CD:...:EF
# Optional debug-only escape hatch for non-loopback ws:// endpoints:
# NEXUS_NODE_INSECURE_ALLOW_NONLOOPBACK_WS=1

# Optional overrides:
# NEXUS_NODE_ID=$DEFAULT_NODE_ID
# NEXUS_NODE_NAME=$DEFAULT_NODE_NAME
# NEXUS_NODE_CAPS=system.run,system.which,process.start,process.status,process.logs,process.cancel,symbols.list,audit.query
# NEXUS_NODE_ALLOW_COMMANDS=echo,uname,whoami,pwd,date,ls
# Add nexus-policyctl only if runtime policy mutation is intentionally enabled.
# NEXUS_NODE_MCP_BRIDGE=1
# NEXUS_NODE_MCP_BRIDGE_CONFIG=/data/nexus-node/mcp-bridge.json
# NEXUS_NODE_MCP_BRIDGE_TIMEOUT_MS=30000
# NEXUS_NODE_RECONNECT_MIN_MS=2000
# NEXUS_NODE_RECONNECT_MAX_MS=30000
# NEXUS_NODE_TZ=$DEFAULT_NODE_TZ
EOF

  if grep -q "CHANGE_ME" .env; then
    warn "Edit $DEPLOY_DIR/.env and set NEXUS_NODE_GATEWAY_URL, then rerun."
    exit 0
  fi
fi

if grep -q "CHANGE_ME" .env; then
  error "NEXUS_NODE_GATEWAY_URL still contains CHANGE_ME in $DEPLOY_DIR/.env"
fi

if ! grep -Eq '^NEXUS_NODE_GATEWAY_URL=wss?://.*/nx/nodes$' .env; then
  warn "NEXUS_NODE_GATEWAY_URL should usually end with /nx/nodes (ws://.../nx/nodes)."
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "Dry run complete. Skipping Docker build/up."
  exit 0
fi

log "Building reference node image..."
docker compose build

log "Starting reference node..."
docker compose up -d

if ! docker compose ps nexus-node | grep -q "Up"; then
  warn "Container did not reach Up state. Showing logs:"
  docker compose logs --tail=80 nexus-node || true
  error "Deployment failed."
fi

log "Deployment started."
echo ""
echo "======================================"
log "Nexus node deployed ($PLATFORM_LABEL)"
echo "======================================"
echo ""
echo "Deployment dir: $DEPLOY_DIR"
echo "State dir:      $STATE_DIR"
echo ""
echo "Useful commands:"
echo "  cd $DEPLOY_DIR"
echo "  docker compose logs -f nexus-node"
echo "  docker compose restart nexus-node"
echo "  docker compose down"
echo ""
echo "Pairing reminder:"
echo "  First connect appears as pending. Approve in gateway:"
echo "  node_set_status { \"id\": \"<node-id>\", \"status\": \"approved\" }"
echo ""
