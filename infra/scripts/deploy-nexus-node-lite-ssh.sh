#!/usr/bin/env bash

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
fail() { echo -e "${RED}[!]${NC} $*"; exit 1; }

print_help() {
  cat <<'EOF'
Deploy Nexus reference-node-lite to a remote Linux host over SSH.

Usage:
  deploy-nexus-node-lite-ssh.sh --host <user@host> [options]

Options:
  --host <user@host>          SSH destination (required)
  --gateway <ws-url>          Gateway websocket URL (required)
  --remote-dir <dir>          Remote install base (default ~/nexus-node-lite)
  --state-dir <dir>           Remote state dir (default ~/.nexus-node-lite)
  --env-file <path>           Remote env file path (default <remote-dir>/reference-node.env)
  --service-name <name>       systemd service name (default nexus-node-lite)
  --node-id <id>              Node ID override
  --node-name <name>          Node display name override
  --allow <csv>               Allowlisted command names
  --caps <csv>                Capability list
  --gateway-fingerprint <fp>  Optional SHA-256 TLS fingerprint for wss://
  --dry-run                   Build locally, print actions, skip remote changes
  -h, --help                  Show help

Environment fallback values:
  NEXUS_NODE_DEPLOY_HOST
  NEXUS_NODE_GATEWAY_URL
EOF
}

HOST="${NEXUS_NODE_DEPLOY_HOST:-}"
GATEWAY_URL="${NEXUS_NODE_GATEWAY_URL:-}"
REMOTE_DIR='~/nexus-node-lite'
STATE_DIR='~/.nexus-node-lite'
SERVICE_NAME='nexus-node-lite'
NODE_ID=''
NODE_NAME=''
ALLOW_COMMANDS='echo,uname,whoami,pwd,date,ls'
CAPS='system.run,system.which,process.start,process.status,process.logs,process.cancel,symbols.list,audit.query'
GATEWAY_FP=''
DRY_RUN=0
ENV_FILE=''

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host)
      HOST="${2:-}"
      shift 2
      ;;
    --gateway)
      GATEWAY_URL="${2:-}"
      shift 2
      ;;
    --remote-dir)
      REMOTE_DIR="${2:-}"
      shift 2
      ;;
    --state-dir)
      STATE_DIR="${2:-}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --service-name)
      SERVICE_NAME="${2:-}"
      shift 2
      ;;
    --node-id)
      NODE_ID="${2:-}"
      shift 2
      ;;
    --node-name)
      NODE_NAME="${2:-}"
      shift 2
      ;;
    --allow)
      ALLOW_COMMANDS="${2:-}"
      shift 2
      ;;
    --caps)
      CAPS="${2:-}"
      shift 2
      ;;
    --gateway-fingerprint)
      GATEWAY_FP="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

[ -n "$HOST" ] || fail "--host is required"
[ -n "$GATEWAY_URL" ] || fail "--gateway is required"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RELEASE_ID="$(date +%Y%m%d-%H%M%S)"

for bin in npm ssh tar; do
  command -v "$bin" >/dev/null 2>&1 || fail "Missing required command: $bin"
done

log "Building lite artifact"
(
  cd "$REPO_ROOT"
  npm run node:lite:build
)

BUILD_DIR="$REPO_ROOT/dist/node-lite"
ENTRYPOINT="$BUILD_DIR/reference-node-lite.js"
[ -f "$ENTRYPOINT" ] || fail "Build output missing: $ENTRYPOINT"
WS_MODULE_DIR="$REPO_ROOT/node_modules/ws"
[ -d "$WS_MODULE_DIR" ] || fail "Missing ws module at $WS_MODULE_DIR (run npm ci first)"

TMP_TAR="$(mktemp -t nexus-node-lite.XXXXXX.tgz)"
STAGE_DIR="$(mktemp -d -t nexus-node-lite-stage.XXXXXX)"
trap 'rm -f "$TMP_TAR"; rm -rf "$STAGE_DIR"' EXIT
mkdir -p "$STAGE_DIR/node_modules"
cp -R "$BUILD_DIR"/. "$STAGE_DIR"/
cp -R "$WS_MODULE_DIR" "$STAGE_DIR/node_modules/ws"
tar -C "$STAGE_DIR" -czf "$TMP_TAR" .

if [ -z "$ENV_FILE" ]; then
  ENV_FILE="$REMOTE_DIR/reference-node.env"
fi

log "Prepared release $RELEASE_ID for $HOST"
if [ "$DRY_RUN" -eq 1 ]; then
  log "Dry run complete. Artifact: $TMP_TAR"
  exit 0
fi

REMOTE_RELEASE_DIR="$REMOTE_DIR/releases/$RELEASE_ID"

log "Uploading artifact"
ssh "$HOST" "mkdir -p ${REMOTE_RELEASE_DIR}"
cat "$TMP_TAR" | ssh "$HOST" "tar -xzf - -C ${REMOTE_RELEASE_DIR}"

log "Configuring remote runtime and service"
ssh "$HOST" \
  REMOTE_DIR="$REMOTE_DIR" \
  RELEASE_ID="$RELEASE_ID" \
  STATE_DIR="$STATE_DIR" \
  ENV_FILE="$ENV_FILE" \
  SERVICE_NAME="$SERVICE_NAME" \
  GATEWAY_URL="$GATEWAY_URL" \
  GATEWAY_FP="$GATEWAY_FP" \
  NODE_ID="$NODE_ID" \
  NODE_NAME="$NODE_NAME" \
  ALLOW_COMMANDS="$ALLOW_COMMANDS" \
  CAPS="$CAPS" \
  'bash -s' <<'EOF'
set -euo pipefail

REMOTE_DIR="${REMOTE_DIR:?}"
RELEASE_ID="${RELEASE_ID:?}"
STATE_DIR="${STATE_DIR:?}"
ENV_FILE="${ENV_FILE:?}"
SERVICE_NAME="${SERVICE_NAME:?}"
GATEWAY_URL="${GATEWAY_URL:?}"

expand_home_path() {
  case "$1" in
    "~")
      printf '%s' "$HOME"
      ;;
    "~/"*)
      printf '%s/%s' "$HOME" "${1#~/}"
      ;;
    *)
      printf '%s' "$1"
      ;;
  esac
}

REMOTE_DIR="$(expand_home_path "$REMOTE_DIR")"
STATE_DIR="$(expand_home_path "$STATE_DIR")"
ENV_FILE="$(expand_home_path "$ENV_FILE")"

RELEASE_DIR="$REMOTE_DIR/releases/$RELEASE_ID"
CURRENT_LINK="$REMOTE_DIR/current"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ]; then
  echo "node is not installed on remote host" >&2
  exit 1
fi

mkdir -p "$REMOTE_DIR/releases" "$STATE_DIR" "$(dirname "$ENV_FILE")"
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"

APP="$CURRENT_LINK/reference-node-lite.js"
if [ ! -f "$APP" ]; then
  echo "missing runtime entrypoint: $APP" >&2
  exit 1
fi

upsert_env() {
  local key="$1"
  local value="$2"
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  if grep -qE "^[[:space:]]*${key}=" "$ENV_FILE"; then
    sed -i.bak -E "s|^[[:space:]]*${key}=.*$|${key}=${value}|" "$ENV_FILE"
    rm -f "$ENV_FILE.bak"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

"$NODE_BIN" "$APP" \
  --state-dir "$STATE_DIR" \
  --state-backend json \
  --profile minimal \
  --gateway "$GATEWAY_URL" \
  --env-file "$ENV_FILE" \
  --init

upsert_env NEXUS_NODE_GATEWAY_URL "$GATEWAY_URL"
upsert_env NEXUS_NODE_STATE_DIR "$STATE_DIR"
upsert_env NEXUS_NODE_STATE_BACKEND "json"
upsert_env NEXUS_NODE_PROFILE "minimal"
upsert_env NEXUS_NODE_ALLOW_COMMANDS "${ALLOW_COMMANDS}"
upsert_env NEXUS_NODE_CAPS "${CAPS}"
upsert_env NEXUS_NODE_LOG_FORMAT "json"
upsert_env NEXUS_NODE_LOG_FILE "$STATE_DIR/logs/reference-node.log"
upsert_env NEXUS_NODE_LOG_MAX_BYTES "5242880"
upsert_env NEXUS_NODE_LOG_MAX_FILES "5"
if [ -n "${NODE_ID}" ]; then
  upsert_env NEXUS_NODE_ID "$NODE_ID"
fi
if [ -n "${NODE_NAME}" ]; then
  upsert_env NEXUS_NODE_NAME "$NODE_NAME"
fi
if [ -n "${GATEWAY_FP}" ]; then
  upsert_env NEXUS_NODE_GATEWAY_TLS_FINGERPRINT "$GATEWAY_FP"
fi

"$NODE_BIN" "$APP" --state-dir "$STATE_DIR" --env-file "$ENV_FILE" --doctor

install_system_service() {
  local svc_path="/etc/systemd/system/${SERVICE_NAME}.service"
  local run_user
  run_user="$(id -un)"
  sudo tee "$svc_path" > /dev/null <<UNIT
[Unit]
Description=Nexus Reference Node Lite
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${run_user}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${APP} --state-dir ${STATE_DIR} --env-file ${ENV_FILE}
Restart=always
RestartSec=3
WorkingDirectory=${REMOTE_DIR}

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$SERVICE_NAME"
}

install_user_service() {
  local user_dir="$HOME/.config/systemd/user"
  local svc_path="$user_dir/${SERVICE_NAME}.service"
  mkdir -p "$user_dir"
  cat > "$svc_path" <<UNIT
[Unit]
Description=Nexus Reference Node Lite (user)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${APP} --state-dir ${STATE_DIR} --env-file ${ENV_FILE}
Restart=always
RestartSec=3
WorkingDirectory=${REMOTE_DIR}

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE_NAME"
}

if command -v systemctl > /dev/null 2>&1 && command -v sudo > /dev/null 2>&1 && sudo -n true > /dev/null 2>&1; then
  install_system_service
  echo "service_scope=system"
elif command -v systemctl > /dev/null 2>&1; then
  install_user_service
  echo "service_scope=user"
  echo "note=if this host reboots, enable linger for persistence: sudo loginctl enable-linger $(id -un)"
else
  echo "service_scope=none"
  echo "note=systemd not found; run manually: ${NODE_BIN} ${APP} --state-dir ${STATE_DIR}"
fi
EOF

log "Deployment complete"
log "Remote release: $REMOTE_RELEASE_DIR"
log "Service: $SERVICE_NAME"
