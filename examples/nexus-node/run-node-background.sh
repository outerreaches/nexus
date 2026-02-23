#!/usr/bin/env bash
# Start the reference node in background mode with single-instance guards.

set -euo pipefail

log() { printf '[node-start] %s\n' "$*"; }
warn() { printf '[node-start] WARN: %s\n' "$*" >&2; }
fail() { printf '[node-start] ERROR: %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

resolve_code_dir() {
  local candidates=()
  if [ -n "${NEXUS_NODE_CODE_DIR:-}" ]; then
    candidates+=("$NEXUS_NODE_CODE_DIR")
  fi
  candidates+=(
    "$SCRIPT_DIR/../.."
    "$SCRIPT_DIR/code"
    "$PWD"
    "/data/code"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    [ -f "$candidate/examples/nexus-node/reference-node.ts" ] || continue
    (cd "$candidate" && pwd -P)
    return 0
  done
  return 1
}

discover_env_file() {
  local candidates=()
  if [ -n "${NEXUS_NODE_ENV_FILE:-}" ]; then
    candidates+=("$NEXUS_NODE_ENV_FILE")
  fi
  candidates+=(
    "$SCRIPT_DIR/.env"
    "$HOME/nexus-node-host/.env"
    "$HOME/nexus-node-host-deploy/.env"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    [ -f "$candidate" ] || continue
    printf '%s' "$candidate"
    return 0
  done
  return 1
}

count_env_key() {
  local env_file="$1"
  local key="$2"
  grep -cE "^[[:space:]]*${key}=" "$env_file" || true
}

validate_env_keys() {
  local env_file="$1"
  local key count
  for key in \
    NEXUS_NODE_GATEWAY_URL \
    NEXUS_NODE_GATEWAY_TLS_FINGERPRINT \
    NEXUS_NODE_ID \
    NEXUS_NODE_STATE_DIR \
    NEXUS_NODE_NAME \
    NEXUS_NODE_CAPS \
    NEXUS_NODE_ALLOW_COMMANDS \
    NEXUS_NODE_WEBHOOK_HOST \
    NEXUS_NODE_WEBHOOK_PORT \
    NEXUS_NODE_WEBHOOK_PATH \
    NEXUS_NODE_WEBHOOK_TOKEN \
    NEXUS_NODE_WEBHOOK_MAX_BODY_BYTES
  do
    count="$(count_env_key "$env_file" "$key")"
    [ "${count:-0}" -le 1 ] || fail "duplicate ${key} entries in ${env_file}"
  done
}

list_matching_pids() {
  ps -eo pid=,args= | awk -v node_id="$NEXUS_NODE_ID" -v state_dir="$NEXUS_NODE_STATE_DIR" '
    /examples\/nexus-node\/reference-node\.ts/ {
      if (index($0, "--node-id " node_id) && index($0, "--state-dir " state_dir)) {
        gsub(/^ +/, "", $0);
        split($0, parts, / +/);
        print parts[1];
      }
    }
  '
}

terminate_pids() {
  local pids=("$@")
  [ "${#pids[@]}" -gt 0 ] || return 0

  local pid
  for pid in "${pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done

  local i any_alive
  for i in $(seq 1 20); do
    any_alive=0
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        any_alive=1
        break
      fi
    done
    [ "$any_alive" -eq 0 ] && return 0
    sleep 0.5
  done

  for pid in "${pids[@]}"; do
    kill -KILL "$pid" 2>/dev/null || true
  done
}

CODE_DIR="$(resolve_code_dir)" || fail "unable to find Nexus code dir (set NEXUS_NODE_CODE_DIR)"
ENV_FILE="$(discover_env_file || true)"
if [ -n "$ENV_FILE" ]; then
  validate_env_keys "$ENV_FILE"
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
  log "loaded env file: $ENV_FILE"
else
  warn "no env file found; using current shell environment"
fi

NEXUS_NODE_GATEWAY_URL="${NEXUS_NODE_GATEWAY_URL:-ws://127.0.0.1:18789/nx/nodes}"
NEXUS_NODE_STATE_DIR="${NEXUS_NODE_STATE_DIR:-$HOME/.nexus-node}"
NEXUS_NODE_ID="${NEXUS_NODE_ID:-reference-node-host-1}"
NEXUS_NODE_NAME="${NEXUS_NODE_NAME:-Nexus Host Node}"
NEXUS_NODE_CAPS="${NEXUS_NODE_CAPS:-system.run,system.which,process.start,process.status,process.logs,process.cancel,symbols.list,audit.query}"
NEXUS_NODE_ALLOW_COMMANDS="${NEXUS_NODE_ALLOW_COMMANDS:-echo,uname,whoami,pwd,date,ls}"
NEXUS_NODE_RECONNECT_MIN_MS="${NEXUS_NODE_RECONNECT_MIN_MS:-2000}"
NEXUS_NODE_RECONNECT_MAX_MS="${NEXUS_NODE_RECONNECT_MAX_MS:-30000}"
NEXUS_NODE_REPLACE_RUNNING="${NEXUS_NODE_REPLACE_RUNNING:-1}"

fp_clean="${NEXUS_NODE_GATEWAY_TLS_FINGERPRINT:-}"
fp_clean="${fp_clean//:/}"
if [ -n "$fp_clean" ] && [[ ! "$fp_clean" =~ ^[A-Fa-f0-9]{64}$ ]]; then
  fail "invalid NEXUS_NODE_GATEWAY_TLS_FINGERPRINT format"
fi

RUN_DIR="${NEXUS_NODE_RUN_DIR:-$NEXUS_NODE_STATE_DIR/run}"
PID_FILE="${NEXUS_NODE_PID_FILE:-$RUN_DIR/reference-node.pid}"
LOG_FILE="${NEXUS_NODE_LOG_FILE:-$RUN_DIR/reference-node.log}"
LOCK_FILE="${NEXUS_NODE_LOCK_FILE:-$RUN_DIR/reference-node.lock}"
TSX_BIN="$CODE_DIR/node_modules/.bin/tsx"
NODE_SCRIPT="$CODE_DIR/examples/nexus-node/reference-node.ts"

[ -x "$TSX_BIN" ] || fail "tsx binary not found at $TSX_BIN (run: cd $CODE_DIR && npm ci)"
[ -f "$NODE_SCRIPT" ] || fail "reference node script not found at $NODE_SCRIPT"

mkdir -p "$RUN_DIR" "$NEXUS_NODE_STATE_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || fail "another node start/stop operation is in progress"

if [ -f "$PID_FILE" ]; then
  existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    if [ "$NEXUS_NODE_REPLACE_RUNNING" != "1" ]; then
      fail "node is already running with pid=$existing_pid (set NEXUS_NODE_REPLACE_RUNNING=1 to replace)"
    fi
  else
    rm -f "$PID_FILE"
  fi
fi

mapfile -t matching_pids < <(list_matching_pids)
if [ "${#matching_pids[@]}" -gt 0 ]; then
  if [ "$NEXUS_NODE_REPLACE_RUNNING" != "1" ]; then
    fail "matching node process already running: ${matching_pids[*]}"
  fi
  log "replacing existing node process(es): ${matching_pids[*]}"
  terminate_pids "${matching_pids[@]}"
fi

cmd=(
  "$TSX_BIN"
  "$NODE_SCRIPT"
  --gateway "$NEXUS_NODE_GATEWAY_URL"
  --state-dir "$NEXUS_NODE_STATE_DIR"
  --node-id "$NEXUS_NODE_ID"
  --name "$NEXUS_NODE_NAME"
  --caps "$NEXUS_NODE_CAPS"
  --allow "$NEXUS_NODE_ALLOW_COMMANDS"
  --reconnect-min-ms "$NEXUS_NODE_RECONNECT_MIN_MS"
  --reconnect-max-ms "$NEXUS_NODE_RECONNECT_MAX_MS"
)

if [ -n "${NEXUS_NODE_GATEWAY_TLS_FINGERPRINT:-}" ]; then
  cmd+=(--gateway-tls-fingerprint "$NEXUS_NODE_GATEWAY_TLS_FINGERPRINT")
fi
if [ "${NEXUS_NODE_MCP_BRIDGE:-0}" = "1" ]; then
  cmd+=(--mcp-bridge 1)
fi
if [ -n "${NEXUS_NODE_MCP_BRIDGE_CONFIG:-}" ]; then
  cmd+=(--mcp-bridge-config "$NEXUS_NODE_MCP_BRIDGE_CONFIG")
fi
if [ -n "${NEXUS_NODE_MCP_BRIDGE_TIMEOUT_MS:-}" ]; then
  cmd+=(--mcp-bridge-timeout-ms "$NEXUS_NODE_MCP_BRIDGE_TIMEOUT_MS")
fi
if [ -n "${NEXUS_NODE_FILE_TRANSFER_ROOTS:-}" ]; then
  cmd+=(--file-transfer-roots "$NEXUS_NODE_FILE_TRANSFER_ROOTS")
fi
if [ -n "${NEXUS_NODE_FILE_TRANSFER_MAX_BYTES:-}" ]; then
  cmd+=(--file-transfer-max-bytes "$NEXUS_NODE_FILE_TRANSFER_MAX_BYTES")
fi
if [ -n "${NEXUS_NODE_WEBHOOK_HOST:-}" ]; then
  cmd+=(--webhook-host "$NEXUS_NODE_WEBHOOK_HOST")
fi
if [ -n "${NEXUS_NODE_WEBHOOK_PORT:-}" ]; then
  cmd+=(--webhook-port "$NEXUS_NODE_WEBHOOK_PORT")
fi
if [ -n "${NEXUS_NODE_WEBHOOK_PATH:-}" ]; then
  cmd+=(--webhook-path "$NEXUS_NODE_WEBHOOK_PATH")
fi
if [ -n "${NEXUS_NODE_WEBHOOK_TOKEN:-}" ]; then
  cmd+=(--webhook-token "$NEXUS_NODE_WEBHOOK_TOKEN")
fi
if [ -n "${NEXUS_NODE_WEBHOOK_MAX_BODY_BYTES:-}" ]; then
  cmd+=(--webhook-max-bytes "$NEXUS_NODE_WEBHOOK_MAX_BODY_BYTES")
fi
if [ "${NEXUS_NODE_POLICY_REQUIRED:-0}" = "1" ]; then
  cmd+=(--policy-required 1)
fi

cd "$CODE_DIR"
nohup "${cmd[@]}" >>"$LOG_FILE" 2>&1 &
new_pid="$!"
echo "$new_pid" > "$PID_FILE"
sleep 1

if ! kill -0 "$new_pid" 2>/dev/null; then
  rm -f "$PID_FILE"
  fail "node failed to start (see log: $LOG_FILE)"
fi

log "started pid=$new_pid"
log "log file: $LOG_FILE"
