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
Upgrade an existing Nexus reference-node-lite install over SSH.

Usage:
  upgrade-nexus-node-lite-ssh.sh --host <user@host> [options]

Options:
  --host <user@host>       SSH destination (required)
  --remote-dir <dir>       Remote install base (default ~/nexus-node-lite)
  --service-name <name>    systemd service name (default nexus-node-lite)
  --layout <auto|releases|flat>
                           Remote layout mode (default auto)
                           auto: detect existing install style
                           releases: update <remote-dir>/releases/<release-id> and relink current
                           flat: update files in <remote-dir> directly (legacy scp style)
  --release-id <id>        Release identifier (default timestamp YYYYmmdd-HHMMSS)
  --skip-build             Reuse local dist/node-lite output and skip build
  --dry-run                Build/check locally and print planned action only
  -h, --help               Show help

Environment fallback values:
  NEXUS_NODE_DEPLOY_HOST
EOF
}

HOST="${NEXUS_NODE_DEPLOY_HOST:-}"
REMOTE_DIR='~/nexus-node-lite'
SERVICE_NAME='nexus-node-lite'
LAYOUT='auto'
RELEASE_ID="$(date +%Y%m%d-%H%M%S)"
SKIP_BUILD=0
DRY_RUN=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host)
      HOST="${2:-}"
      shift 2
      ;;
    --remote-dir)
      REMOTE_DIR="${2:-}"
      shift 2
      ;;
    --service-name)
      SERVICE_NAME="${2:-}"
      shift 2
      ;;
    --layout)
      LAYOUT="${2:-}"
      shift 2
      ;;
    --release-id)
      RELEASE_ID="${2:-}"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
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
[ -n "$RELEASE_ID" ] || fail "--release-id cannot be empty"

case "$LAYOUT" in
  auto|releases|flat) ;;
  *) fail "--layout must be one of: auto, releases, flat" ;;
esac

for bin in ssh scp tar mktemp; do
  command -v "$bin" >/dev/null 2>&1 || fail "Missing required command: $bin"
done
if [ "$SKIP_BUILD" -ne 1 ]; then
  command -v npm >/dev/null 2>&1 || fail "Missing required command: npm"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [ "$SKIP_BUILD" -eq 1 ]; then
  log "Skipping build (--skip-build)"
else
  log "Building lite artifact"
  (
    cd "$REPO_ROOT"
    npm run node:lite:build
  )
fi

BUILD_DIR="$REPO_ROOT/dist/node-lite"
ENTRYPOINT="$BUILD_DIR/reference-node-lite.js"
[ -f "$ENTRYPOINT" ] || fail "Build output missing: $ENTRYPOINT"

WS_MODULE_DIR="$REPO_ROOT/node_modules/ws"
[ -d "$WS_MODULE_DIR" ] || fail "Missing ws module at $WS_MODULE_DIR (run npm ci first)"

TMP_TAR="$(mktemp -t nexus-node-lite-upgrade.XXXXXX.tgz)"
STAGE_DIR="$(mktemp -d -t nexus-node-lite-upgrade-stage.XXXXXX)"
trap 'rm -f "$TMP_TAR"; rm -rf "$STAGE_DIR"' EXIT

mkdir -p "$STAGE_DIR/node_modules"
cp -R "$BUILD_DIR"/. "$STAGE_DIR"/
cp -R "$WS_MODULE_DIR" "$STAGE_DIR/node_modules/ws"
tar -C "$STAGE_DIR" -czf "$TMP_TAR" .

detect_remote_layout() {
  ssh "$HOST" \
    REMOTE_DIR="$REMOTE_DIR" \
    SERVICE_NAME="$SERVICE_NAME" \
    'bash -s' <<'EOF'
set -euo pipefail

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

REMOTE_DIR="$(expand_home_path "${REMOTE_DIR:?}")"
SERVICE_NAME="${SERVICE_NAME:?}"
SERVICE_TEXT=""

if command -v systemctl >/dev/null 2>&1; then
  SERVICE_TEXT="$(systemctl --user cat "$SERVICE_NAME" 2>/dev/null || true)"
  if [ -z "$SERVICE_TEXT" ] && command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    SERVICE_TEXT="$(sudo systemctl cat "$SERVICE_NAME" 2>/dev/null || true)"
  fi
fi

if [ -n "$SERVICE_TEXT" ]; then
  if printf '%s\n' "$SERVICE_TEXT" | grep -Fq "$REMOTE_DIR/current/reference-node-lite.js"; then
    printf '%s\n' "releases"
    exit 0
  fi
  if printf '%s\n' "$SERVICE_TEXT" | grep -Fq "$REMOTE_DIR/reference-node-lite.js"; then
    printf '%s\n' "flat"
    exit 0
  fi
fi

if [ -L "$REMOTE_DIR/current" ] || [ -d "$REMOTE_DIR/releases" ] || [ -d "$REMOTE_DIR/current" ]; then
  printf '%s\n' "releases"
  exit 0
fi

if [ -f "$REMOTE_DIR/reference-node-lite.js" ]; then
  printf '%s\n' "flat"
  exit 0
fi

printf '%s\n' "releases"
EOF
}

if [ "$DRY_RUN" -eq 1 ]; then
  if [ "$LAYOUT" = "releases" ]; then
    REMOTE_TARGET_DESC="$REMOTE_DIR/releases/$RELEASE_ID"
  elif [ "$LAYOUT" = "flat" ]; then
    REMOTE_TARGET_DESC="$REMOTE_DIR"
  else
    REMOTE_TARGET_DESC="$REMOTE_DIR (auto-detected at runtime)"
  fi
  log "Prepared upgrade for $HOST"
  log "Layout: $LAYOUT"
  log "Target: $REMOTE_TARGET_DESC"
  log "Dry run complete. Artifact: $TMP_TAR"
  exit 0
fi

REMOTE_LAYOUT="$LAYOUT"
if [ "$LAYOUT" = "auto" ]; then
  log "Detecting remote layout"
  REMOTE_LAYOUT="$(detect_remote_layout)"
  case "$REMOTE_LAYOUT" in
    releases|flat) ;;
    *) fail "Remote layout detection returned unknown value: $REMOTE_LAYOUT" ;;
  esac
fi

if [ "$REMOTE_LAYOUT" = "releases" ]; then
  REMOTE_TARGET_DESC="$REMOTE_DIR/releases/$RELEASE_ID"
else
  REMOTE_TARGET_DESC="$REMOTE_DIR"
fi

log "Prepared upgrade for $HOST"
log "Layout: $REMOTE_LAYOUT"
log "Target: $REMOTE_TARGET_DESC"

REMOTE_UPLOAD_TAR="/tmp/nexus-node-lite-upgrade-${RELEASE_ID}.tgz"
log "Uploading artifact"
scp "$TMP_TAR" "$HOST:$REMOTE_UPLOAD_TAR"

log "Activating release and restarting service"
ssh "$HOST" \
  REMOTE_DIR="$REMOTE_DIR" \
  REMOTE_LAYOUT="$REMOTE_LAYOUT" \
  RELEASE_ID="$RELEASE_ID" \
  SERVICE_NAME="$SERVICE_NAME" \
  REMOTE_UPLOAD_TAR="$REMOTE_UPLOAD_TAR" \
  'bash -s' <<'EOF'
set -euo pipefail

REMOTE_DIR="${REMOTE_DIR:?}"
REMOTE_LAYOUT="${REMOTE_LAYOUT:?}"
RELEASE_ID="${RELEASE_ID:?}"
SERVICE_NAME="${SERVICE_NAME:?}"
REMOTE_UPLOAD_TAR="${REMOTE_UPLOAD_TAR:?}"

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

restart_user_service() {
  systemctl --user restart "$SERVICE_NAME" >/dev/null 2>&1 \
    || systemctl --user restart "${SERVICE_NAME}.service" >/dev/null 2>&1
}

restart_system_service() {
  sudo systemctl restart "$SERVICE_NAME" >/dev/null 2>&1 \
    || sudo systemctl restart "${SERVICE_NAME}.service" >/dev/null 2>&1
}

REMOTE_DIR="$(expand_home_path "$REMOTE_DIR")"
if [ "$REMOTE_LAYOUT" = "releases" ]; then
  TARGET_DIR="$REMOTE_DIR/releases/$RELEASE_ID"
else
  TARGET_DIR="$REMOTE_DIR"
fi

cleanup_upload() {
  rm -f "$REMOTE_UPLOAD_TAR" >/dev/null 2>&1 || true
}
trap cleanup_upload EXIT

mkdir -p "$TARGET_DIR"
tar -xzf "$REMOTE_UPLOAD_TAR" -C "$TARGET_DIR"

if [ "$REMOTE_LAYOUT" = "releases" ]; then
  ln -sfn "$TARGET_DIR" "$REMOTE_DIR/current"
  APP_PATH="$REMOTE_DIR/current/reference-node-lite.js"
else
  APP_PATH="$REMOTE_DIR/reference-node-lite.js"
fi

if [ ! -f "$APP_PATH" ]; then
  echo "missing runtime entrypoint after upgrade: $APP_PATH" >&2
  exit 1
fi

SERVICE_SCOPE="none"
if command -v systemctl >/dev/null 2>&1; then
  if restart_user_service; then
    SERVICE_SCOPE="user"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1 && restart_system_service; then
    SERVICE_SCOPE="system"
  fi
fi

echo "remote_layout=$REMOTE_LAYOUT"
echo "app_path=$APP_PATH"
echo "service_scope=$SERVICE_SCOPE"
if [ "$SERVICE_SCOPE" = "none" ]; then
  echo "note=No systemd service restart performed. Restart node manually."
fi
EOF

log "Upgrade complete"
