#!/usr/bin/env bash
# Stop a background reference node launched with run-node-background.sh.

set -euo pipefail

log() { printf '[node-stop] %s\n' "$*"; }
warn() { printf '[node-stop] WARN: %s\n' "$*" >&2; }
fail() { printf '[node-stop] ERROR: %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
  for key in NEXUS_NODE_ID NEXUS_NODE_STATE_DIR; do
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

kill_wait() {
  local signal="$1"
  shift
  local pids=("$@")
  [ "${#pids[@]}" -gt 0 ] || return 0
  local pid
  for pid in "${pids[@]}"; do
    kill "-$signal" "$pid" 2>/dev/null || true
  done
}

ENV_FILE="$(discover_env_file || true)"
if [ -n "$ENV_FILE" ]; then
  validate_env_keys "$ENV_FILE"
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
  log "loaded env file: $ENV_FILE"
else
  warn "no env file found; using current shell environment"
fi

NEXUS_NODE_STATE_DIR="${NEXUS_NODE_STATE_DIR:-$HOME/.nexus-node}"
NEXUS_NODE_ID="${NEXUS_NODE_ID:-reference-node-host-1}"
RUN_DIR="${NEXUS_NODE_RUN_DIR:-$NEXUS_NODE_STATE_DIR/run}"
PID_FILE="${NEXUS_NODE_PID_FILE:-$RUN_DIR/reference-node.pid}"
LOCK_FILE="${NEXUS_NODE_LOCK_FILE:-$RUN_DIR/reference-node.lock}"

mkdir -p "$RUN_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || fail "another node start/stop operation is in progress"

declare -a pids=()
if [ -f "$PID_FILE" ]; then
  pid_from_file="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$pid_from_file" ]; then
    pids+=("$pid_from_file")
  fi
fi
while IFS= read -r pid; do
  [ -n "$pid" ] || continue
  pids+=("$pid")
done < <(list_matching_pids)

if [ "${#pids[@]}" -eq 0 ]; then
  rm -f "$PID_FILE"
  log "no matching node processes found"
  exit 0
fi

declare -A seen=()
declare -a unique_pids=()
for pid in "${pids[@]}"; do
  [[ "$pid" =~ ^[0-9]+$ ]] || continue
  if [ -z "${seen[$pid]:-}" ]; then
    seen[$pid]=1
    unique_pids+=("$pid")
  fi
done

log "stopping pid(s): ${unique_pids[*]}"
kill_wait TERM "${unique_pids[@]}"

for _ in $(seq 1 20); do
  alive=0
  for pid in "${unique_pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      alive=1
      break
    fi
  done
  [ "$alive" -eq 0 ] && break
  sleep 0.5
done

kill_wait KILL "${unique_pids[@]}"
rm -f "$PID_FILE"
log "stopped"
