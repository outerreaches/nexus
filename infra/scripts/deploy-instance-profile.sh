#!/usr/bin/env bash
# Deploy Nexus with a specific runtime profile inside a VM/host.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[!]${NC} $1"; exit 1; }

usage() {
  cat <<USAGE
Usage: $(basename "$0") --profile <profile> [options]

Required:
  --profile <profile>          standard | primary | standby | monetization | service_custom | portable

Options:
  --deploy-dir <path>          Deployment directory (default: ~/nexus-deploy)
  --code-dir <path>            Nexus code root (default: /data/code)
  --state-dir <path>           State directory (default: /data/nexus)
  --workspace-dir <path>       Workspace directory (default: /data/workspace)
  --port <port>                Host port mapped to gateway 18789 (default: 18789)
  --compose-project <name>     Docker compose project name (default: nexus)
  --render-only                Render compose/config artifacts only (skip docker up/health checks)
  --skip-healthcheck           Skip post-deploy health probe
  --help                       Show this help message
USAGE
}

PROFILE=""
DEPLOY_DIR="${DEPLOY_DIR:-$HOME/nexus-deploy}"
CODE_DIR="${CODE_DIR:-/data/code}"
STATE_DIR="${STATE_DIR:-/data/nexus}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/data/workspace}"
PORT="${PORT:-18789}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-nexus}"
RENDER_ONLY="0"
SKIP_HEALTHCHECK="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    --deploy-dir)
      DEPLOY_DIR="$2"
      shift 2
      ;;
    --code-dir)
      CODE_DIR="$2"
      shift 2
      ;;
    --state-dir)
      STATE_DIR="$2"
      shift 2
      ;;
    --workspace-dir)
      WORKSPACE_DIR="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --compose-project)
      COMPOSE_PROJECT="$2"
      shift 2
      ;;
    --render-only)
      RENDER_ONLY="1"
      shift
      ;;
    --skip-healthcheck)
      SKIP_HEALTHCHECK="1"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      error "Unknown option: $1"
      ;;
  esac
done

if [[ -z "$PROFILE" ]]; then
  usage
  error "--profile is required"
fi

case "$PROFILE" in
  standard|primary|standby|monetization|service_custom|portable)
    ;;
  execution_node_host)
    error "execution_node_host is not a full gateway profile. Use infra/scripts/install-execution-node-host.sh"
    ;;
  *)
    error "Unsupported profile: $PROFILE"
    ;;
esac

if [[ ! -d "$CODE_DIR" ]]; then
  error "Code directory not found: $CODE_DIR"
fi
if [[ ! -f "$CODE_DIR/Dockerfile" ]]; then
  error "Dockerfile missing in code directory: $CODE_DIR"
fi
if [[ "$RENDER_ONLY" != "1" ]]; then
  if ! command -v docker >/dev/null 2>&1; then
    error "docker is required"
  fi
  if ! docker ps >/dev/null 2>&1; then
    error "docker daemon is not reachable"
  fi
fi

ALLOW_SHELL_EXEC="0"
ALLOW_CODE_WRITE="0"
PROACTIVE="1"
STANDBY_FLAG=""

case "$PROFILE" in
  standard|primary)
    ALLOW_SHELL_EXEC="1"
    ALLOW_CODE_WRITE="1"
    ;;
  standby)
    STANDBY_FLAG=" --standby"
    PROACTIVE="0"
    ;;
  monetization)
    ALLOW_SHELL_EXEC="0"
    ALLOW_CODE_WRITE="0"
    ;;
  service_custom|portable)
    ALLOW_SHELL_EXEC="0"
    ALLOW_CODE_WRITE="0"
    ;;
esac

log "Preparing deploy directories"
mkdir -p "$DEPLOY_DIR" "$STATE_DIR" "$WORKSPACE_DIR"

COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"

log "Writing compose file: $COMPOSE_FILE"
cat > "$COMPOSE_FILE" <<COMPOSE
services:
  nexus:
    build:
      context: $CODE_DIR
      dockerfile: Dockerfile
    command: gateway --verbose --profile $PROFILE$STANDBY_FLAG
    volumes:
      - $CODE_DIR:/data/code:rw
      - $STATE_DIR:/data/nexus
      - $WORKSPACE_DIR:/data/workspace
    environment:
      NEXUS_STATE_DIR: /data/nexus
      NEXUS_CODE_DIR: /data/code
      NEXUS_WORKSPACE_DIR: /data/workspace
      NEXUS_ALLOW_SHELL_EXEC: "$ALLOW_SHELL_EXEC"
      NEXUS_ALLOW_CODE_WRITE: "$ALLOW_CODE_WRITE"
      NEXUS_PROACTIVE: "$PROACTIVE"
    env_file:
      - .env
    ports:
      - "$PORT:18789"
    restart: unless-stopped
COMPOSE

ENV_FILE="$DEPLOY_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  log "Creating .env template in $ENV_FILE"
  cat > "$ENV_FILE" <<'ENVFILE'
OPENROUTER_API_KEY=your_api_key_here
TELEGRAM_BOT_TOKEN=
TZ=UTC
ENVFILE
  warn "Update $ENV_FILE with your keys before production use"
fi

CONFIG_FILE="$STATE_DIR/nexus.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
  log "Writing baseline config: $CONFIG_FILE"
  cat > "$CONFIG_FILE" <<CONFIG
{
  "port": 18789,
  "runtime": {
    "profile": "$PROFILE"
  },
  "llm": {
    "openaiCompat": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "\${OPENROUTER_API_KEY}",
      "model": "moonshotai/kimi-k2.5"
    }
  },
  "permissions": {
    "allowShellExec": false,
    "allowCodeEdit": true,
    "allowCodeWrite": false
  },
  "channels": {
    "telegram": {
      "enabled": false
    }
  },
  "scheduler": {
    "enabled": true
  },
  "proactive": {
    "enabled": true
  }
}
CONFIG
fi

log "Building and launching profile=$PROFILE"
if [[ "$RENDER_ONLY" == "1" ]]; then
  log "Render-only mode complete (docker launch skipped)"
  exit 0
fi

(
  cd "$DEPLOY_DIR"
  docker compose -p "$COMPOSE_PROJECT" up -d --build
)

if [[ "$SKIP_HEALTHCHECK" == "1" ]]; then
  log "Deploy finished (healthcheck skipped)"
  exit 0
fi

log "Waiting for health endpoint on port $PORT"
for _ in {1..45}; do
  if curl -sf "http://127.0.0.1:$PORT/health/live" >/dev/null 2>&1; then
    log "Deployment healthy"
    exit 0
  fi
  sleep 2
done

error "Deployment started but health check did not pass in time"
