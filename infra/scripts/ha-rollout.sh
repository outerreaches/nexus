#!/usr/bin/env bash
# HA rolling deploy with git-based rollback.
#
# Commands:
#   deploy [<target-ref>]               Build/recreate inactive slot, switch traffic, smoke test.
#                                       On failure, auto-rollback to last-good commit.
#   apply-local [<msg>] [<remote>] [<branch>] [<source-code-dir>] [<source-base-sha>]
#                                       Deploy current local working-tree changes:
#                                       build candidate (standby) -> health check -> commit ->
#                                       switch traffic -> smoke -> push.
#                                       Old active left running as standby (rebuilt on next deploy).
#                                       If candidate fails, old active keeps serving.
#   rollback [<target-ref>]             Force rollback to a known commit (default: last-good).
#   finalize [<target-ref>]             Rebuild only inactive slot at target commit (no switchover).
#   status                              Show HA slot modes and rollout state.
#
# Environment overrides:
#   NEXUS_HOME=~/.nexus
#   CODE_DIR=<repo-root>
#   COMPOSE_FILES=<repo-root>/infra/docker-compose.ha.yml:<repo-root>/infra/docker-compose.ha.sidecar.yml:<repo-root>/infra/docker-compose.ha.tls.yml
#   COMPOSE_PROJECT=infra
#   STATE_DIR=<state-dir>
#   STATE_FILE=<state-dir>/deploy-state.env
#   CONFIG_ROOT=<config-root>
#   STORE_DIR=<secrets-store-dir>
#   API_PORT=18789
#   LIVE_TIMEOUT=90
#   READY_TIMEOUT=120
#   SMOKE_TIMEOUT=60
#   WS_SMOKE_TIMEOUT=20               # retry window for websocket smoke probe
#   SKIP_WS_SMOKE=0                   # set to 1 to skip websocket smoke probe
#   WS_SMOKE_WARN_ONLY=0              # set to 1 to warn (not fail) on websocket smoke timeout
#   WS_SMOKE_ATTEMPT_TIMEOUT_MS=8000  # per-attempt websocket probe timeout in milliseconds
#   NEXUS_HAPROXY_TLS_CERT_PEM=<repo-root>/infra/haproxy/certs/nexus.pem
#   ACTIVATION_GRACE_SECS=5            # seconds to wait after /api/activate before health checks
#   ROLLBACK_RESTORE_GIT=1            # set to 0 to keep current checkout on failed deploy rollback
#   NEXUS_HA_API_KEY=<token>            # bearer token for /api/* control-plane calls
#                                        # defaults to NEXUS_HTTP_API_KEY when unset

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_CODE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOST_OS="${NEXUS_HOST_OS:-$(uname -s 2>/dev/null || echo unknown)}"
IS_DARWIN=0
if [ "$HOST_OS" = "Darwin" ]; then
  IS_DARWIN=1
fi

if [ -n "${NEXUS_HOME:-}" ]; then
  DEFAULT_NEXUS_HOME="$NEXUS_HOME"
elif [ -d "/data/code" ] || [ -d "/data/nexus" ] || [ -d "/data/nexus-config" ]; then
  DEFAULT_NEXUS_HOME=""
else
  DEFAULT_NEXUS_HOME="${HOME}/.nexus"
fi

if [ -n "$DEFAULT_NEXUS_HOME" ]; then
  DEFAULT_CONFIG_ROOT="${DEFAULT_NEXUS_HOME}/config"
  DEFAULT_STATE_DIR="${DEFAULT_NEXUS_HOME}/state"
  DEFAULT_WORKSPACE_DIR="${DEFAULT_NEXUS_HOME}/workspace"
  DEFAULT_STORE_DIR="${DEFAULT_NEXUS_HOME}/secrets"
else
  DEFAULT_CONFIG_ROOT="/data/nexus-config"
  DEFAULT_STATE_DIR="/data/nexus"
  DEFAULT_WORKSPACE_DIR="/data/workspace"
  DEFAULT_STORE_DIR="/data/nexus-secrets"
fi

CODE_DIR="${CODE_DIR:-${NEXUS_CODE_DIR:-${DEFAULT_CODE_DIR}}}"
CONFIG_ROOT="${CONFIG_ROOT:-${DEFAULT_CONFIG_ROOT}}"
GATEWAY_ENV_FILE="${GATEWAY_ENV_FILE:-${CONFIG_ROOT}/gateway/nexus.env}"
SIDECAR_ENV_FILE="${SIDECAR_ENV_FILE:-${CONFIG_ROOT}/sidecar/nexus.env}"
WATCHDOG_ENV_FILE="${WATCHDOG_ENV_FILE:-${CONFIG_ROOT}/watchdog/nexus.env}"
DEFAULT_MACOS_COMPOSE="${CODE_DIR}/infra/docker-compose.ha.macos.yml"
DEFAULT_COMPOSE_FILES="${CODE_DIR}/infra/docker-compose.ha.yml:${CODE_DIR}/infra/docker-compose.ha.sidecar.yml:${CODE_DIR}/infra/docker-compose.ha.tls.yml"
if [ "$IS_DARWIN" -eq 1 ] && [ -f "$DEFAULT_MACOS_COMPOSE" ]; then
  DEFAULT_COMPOSE_FILES="${DEFAULT_COMPOSE_FILES}:${DEFAULT_MACOS_COMPOSE}"
fi
COMPOSE_FILES_RAW="${COMPOSE_FILES:-${DEFAULT_COMPOSE_FILES}}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-infra}"
STATE_DIR="${STATE_DIR:-${NEXUS_STATE_DIR:-${DEFAULT_STATE_DIR}}}"
WORKSPACE_DIR="${WORKSPACE_DIR:-${NEXUS_WORKSPACE_DIR:-${DEFAULT_WORKSPACE_DIR}}}"
STATE_FILE="${STATE_FILE:-${STATE_DIR}/deploy-state.env}"
STORE_DIR="${STORE_DIR:-${DEFAULT_STORE_DIR}}"
HOST_CODE_DIR="${NEXUS_HOST_CODE_DIR:-${CODE_DIR}}"
HOST_STATE_DIR="${NEXUS_HOST_STATE_DIR:-${STATE_DIR}}"
HOST_WORKSPACE_DIR="${NEXUS_HOST_WORKSPACE_DIR:-${WORKSPACE_DIR}}"
HOST_SECRETS_DIR="${NEXUS_HOST_SECRETS_DIR:-${STORE_DIR}}"
LOCK_DIR="${STATE_DIR}/ha-rollout.lock"
API_PORT="${API_PORT:-18789}"
LIVE_TIMEOUT="${LIVE_TIMEOUT:-90}"
READY_TIMEOUT="${READY_TIMEOUT:-120}"
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-60}"
WS_SMOKE_TIMEOUT="${WS_SMOKE_TIMEOUT:-20}"
SKIP_WS_SMOKE="${SKIP_WS_SMOKE:-0}"
WS_SMOKE_WARN_ONLY="${WS_SMOKE_WARN_ONLY:-0}"
WS_SMOKE_ATTEMPT_TIMEOUT_MS="${WS_SMOKE_ATTEMPT_TIMEOUT_MS:-8000}"
BUILD_TIMEOUT="${BUILD_TIMEOUT:-600}"
TLS_CERT_PEM="${NEXUS_HAPROXY_TLS_CERT_PEM:-${CODE_DIR}/infra/haproxy/certs/nexus.pem}"
SECRETS_PREFLIGHT_SCRIPT="${SECRETS_PREFLIGHT_SCRIPT:-${CODE_DIR}/infra/scripts/setup/ha-secrets-preflight.sh}"
ROLLBACK_RESTORE_GIT="${ROLLBACK_RESTORE_GIT:-1}"
CONTROL_PLANE_API_KEY="${NEXUS_HA_API_KEY:-${NEXUS_HTTP_API_KEY:-}}"

declare -a COMPOSE_FILES_LIST=()
declare -a COMPOSE_BASE_CMD=()
COMPOSE_HAS_TLS_OVERLAY=0
COMPOSE_HAS_SIDECAR_OVERLAY=0

LAST_GOOD_SHA=""
LAST_DEPLOY_SHA=""
LAST_STATUS=""
LAST_ACTIVE_SLOT=""
LAST_UPDATED_AT=""
LAST_DEPLOY_PID=""
LAST_EFFECTIVE_SHA=""
LAST_FAILURE_REASON=""
LAST_TRIGGER_ID=""

detect_stat_value() {
  local format_linux="$1"
  local format_bsd="$2"
  local target="$3"
  local value=""
  if value="$(stat -c "$format_linux" "$target" 2>/dev/null)"; then
    printf '%s' "$value"
    return 0
  fi
  if value="$(stat -f "$format_bsd" "$target" 2>/dev/null)"; then
    printf '%s' "$value"
    return 0
  fi
  return 1
}

RUNTIME_UID="${NEXUS_GATEWAY_UID:-$(detect_stat_value '%u' '%u' "$CODE_DIR" || true)}"
[ -n "$RUNTIME_UID" ] || RUNTIME_UID="$(id -u)"
RUNTIME_GID="${NEXUS_GATEWAY_GID:-$(detect_stat_value '%g' '%g' "$CODE_DIR" || true)}"
[ -n "$RUNTIME_GID" ] || RUNTIME_GID="$(id -g)"
export NEXUS_GATEWAY_ENV_FILE="${GATEWAY_ENV_FILE}"
export NEXUS_SIDECAR_ENV_FILE="${SIDECAR_ENV_FILE}"
export NEXUS_WATCHDOG_ENV_FILE="${WATCHDOG_ENV_FILE}"
export NEXUS_HA_API_KEY="${CONTROL_PLANE_API_KEY}"
export NEXUS_GATEWAY_UID="${RUNTIME_UID}"
export NEXUS_GATEWAY_GID="${RUNTIME_GID}"
export NEXUS_HOST_CODE_DIR="${HOST_CODE_DIR}"
export NEXUS_HOST_STATE_DIR="${HOST_STATE_DIR}"
export NEXUS_HOST_WORKSPACE_DIR="${HOST_WORKSPACE_DIR}"
export NEXUS_HOST_SECRETS_DIR="${HOST_SECRETS_DIR}"

usage() {
  cat <<'EOF'
Usage:
  ha-rollout.sh deploy [<target-ref>]
  ha-rollout.sh apply-local [<commit-message>] [<target-remote>] [<target-branch>] [<source-code-dir>] [<source-base-sha>]
  ha-rollout.sh rollback [<target-ref>]
  ha-rollout.sh finalize [<target-ref>]
  ha-rollout.sh status

Examples:
  infra/scripts/ha-rollout.sh status
  infra/scripts/ha-rollout.sh deploy HEAD
  infra/scripts/ha-rollout.sh deploy bfea957
  infra/scripts/ha-rollout.sh apply-local
  infra/scripts/ha-rollout.sh apply-local "Add canada CPI source"
  infra/scripts/ha-rollout.sh apply-local "Add canada CPI source" host main
  infra/scripts/ha-rollout.sh rollback
  infra/scripts/ha-rollout.sh rollback 82e7cc6
  infra/scripts/ha-rollout.sh finalize HEAD
EOF
}

log() {
  echo "[ha-rollout] $*"
}

warn() {
  echo "[ha-rollout] WARN: $*" >&2
}

fail() {
  echo "[ha-rollout] ERROR: $*" >&2
  exit 1
}

sanitize_state_value() {
  printf '%s' "${1:-}" | tr '\r\n' ' ' | sed -E 's/[[:space:]]+/ /g'
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

read_env_file_value() {
  local key="$1"
  local file="$2"
  [ -f "$file" ] || return 0
  local line raw
  line="$(grep -E "^${key}=" "$file" | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  raw="${line#*=}"
  raw="${raw%$'\r'}"
  if [[ "${raw:0:1}" == "\"" && "${raw: -1}" == "\"" && ${#raw} -ge 2 ]]; then
    raw="${raw:1:${#raw}-2}"
  elif [[ "${raw:0:1}" == "'" && "${raw: -1}" == "'" && ${#raw} -ge 2 ]]; then
    raw="${raw:1:${#raw}-2}"
  fi
  printf '%s' "$raw"
}

resolve_control_plane_api_key() {
  if [ -n "$CONTROL_PLANE_API_KEY" ]; then
    export NEXUS_HA_API_KEY="$CONTROL_PLANE_API_KEY"
    return 0
  fi

  local watchdog_key gateway_key
  watchdog_key="$(read_env_file_value "NEXUS_HA_API_KEY" "$WATCHDOG_ENV_FILE")"
  gateway_key="$(read_env_file_value "NEXUS_HTTP_API_KEY" "$GATEWAY_ENV_FILE")"
  CONTROL_PLANE_API_KEY="${watchdog_key:-$gateway_key}"
  [ -n "$CONTROL_PLANE_API_KEY" ] || fail \
    "missing control-plane API key. Set NEXUS_HA_API_KEY or NEXUS_HTTP_API_KEY, or populate ${WATCHDOG_ENV_FILE}/${GATEWAY_ENV_FILE}."
  export NEXUS_HA_API_KEY="$CONTROL_PLANE_API_KEY"
}

verify_control_plane_auth() {
  local mode_payload
  mode_payload="$(curl_with_auth -fsS --max-time 5 "http://localhost:${API_PORT}/api/mode" || true)"
  case "$mode_payload" in
    *'"mode":"active"'*|*'"mode":"standby"'*)
      return 0
      ;;
  esac
  fail \
    "control-plane auth probe failed for /api/mode. Verify NEXUS_HA_API_KEY and NEXUS_HTTP_API_KEY values in ${WATCHDOG_ENV_FILE} and ${GATEWAY_ENV_FILE}."
}

curl_with_auth() {
  if [ -n "$CONTROL_PLANE_API_KEY" ]; then
    curl -H "authorization: Bearer ${CONTROL_PLANE_API_KEY}" "$@"
  else
    curl "$@"
  fi
}

compose_service_get() {
  local service="$1"
  local path="$2"
  local timeout="${3:-5}"
  if [ -n "$CONTROL_PLANE_API_KEY" ]; then
    compose exec -T -e NEXUS_HA_API_KEY="$CONTROL_PLANE_API_KEY" "$service" sh -lc \
      "curl -fsS --max-time ${timeout} -H \"authorization: Bearer \$NEXUS_HA_API_KEY\" http://localhost:18789${path}"
  else
    compose exec -T "$service" sh -lc \
      "curl -fsS --max-time ${timeout} http://localhost:18789${path}"
  fi
}

compose_service_post() {
  local service="$1"
  local path="$2"
  local timeout="${3:-10}"
  if [ -n "$CONTROL_PLANE_API_KEY" ]; then
    compose exec -T -e NEXUS_HA_API_KEY="$CONTROL_PLANE_API_KEY" "$service" sh -lc \
      "curl -fsS --max-time ${timeout} -X POST -H \"authorization: Bearer \$NEXUS_HA_API_KEY\" http://localhost:18789${path}"
  else
    compose exec -T "$service" sh -lc \
      "curl -fsS --max-time ${timeout} -X POST http://localhost:18789${path}"
  fi
}

init_compose_files() {
  local raw="${COMPOSE_FILES_RAW}"
  local file
  local -a _raw_files=()
  COMPOSE_FILES_LIST=()
  COMPOSE_BASE_CMD=(docker compose -p "$COMPOSE_PROJECT")
  COMPOSE_HAS_TLS_OVERLAY=0
  COMPOSE_HAS_SIDECAR_OVERLAY=0

  IFS=':' read -r -a _raw_files <<< "$raw"
  for file in "${_raw_files[@]}"; do
    [ -n "$file" ] || continue
    [ -f "$file" ] || fail "missing compose file: $file"
    COMPOSE_FILES_LIST+=("$file")
    COMPOSE_BASE_CMD+=(-f "$file")
    case "$file" in
      *docker-compose.ha.tls.yml) COMPOSE_HAS_TLS_OVERLAY=1 ;;
      *docker-compose.ha.sidecar.yml) COMPOSE_HAS_SIDECAR_OVERLAY=1 ;;
    esac
  done

  if [ "${#COMPOSE_FILES_LIST[@]}" -eq 0 ]; then
    fail "no compose files configured (COMPOSE_FILES='${COMPOSE_FILES_RAW}')"
  fi

  if [ "$COMPOSE_HAS_SIDECAR_OVERLAY" -eq 0 ]; then
    fail "sidecar overlay not selected in COMPOSE_FILES. Include infra/docker-compose.ha.sidecar.yml."
  fi

  if [ "$COMPOSE_HAS_TLS_OVERLAY" -eq 0 ]; then
    fail "TLS overlay not selected in COMPOSE_FILES. Include infra/docker-compose.ha.tls.yml."
  fi
}

compose() {
  "${COMPOSE_BASE_CMD[@]}" "$@"
}

run_with_timeout() {
  local timeout_secs="$1"
  shift

  if command -v timeout >/dev/null 2>&1; then
    timeout "$timeout_secs" "$@"
    return $?
  fi

  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$timeout_secs" "$@"
    return $?
  fi

  local timeout_marker killer_pid cmd_pid status
  timeout_marker="$(mktemp "${STATE_DIR}/timeout-marker.XXXXXX")"
  rm -f "$timeout_marker"

  "$@" &
  cmd_pid=$!
  (
    sleep "$timeout_secs"
    if kill -0 "$cmd_pid" 2>/dev/null; then
      printf '1' >"$timeout_marker"
      kill -TERM "$cmd_pid" 2>/dev/null || true
      sleep 2
      kill -KILL "$cmd_pid" 2>/dev/null || true
    fi
  ) &
  killer_pid=$!

  status=0
  wait "$cmd_pid" || status=$?
  kill "$killer_pid" 2>/dev/null || true
  wait "$killer_pid" 2>/dev/null || true

  if [ -f "$timeout_marker" ]; then
    rm -f "$timeout_marker"
    return 124
  fi
  rm -f "$timeout_marker"
  return "$status"
}

ensure_runtime_dir_ownership() {
  local dir current_owner
  for dir in "$HOST_STATE_DIR" "$HOST_STATE_DIR/candidates" "$HOST_STATE_DIR/interactive-shell" "$HOST_WORKSPACE_DIR"; do
    if ! mkdir -p "$dir" 2>/dev/null; then
      if command -v sudo >/dev/null 2>&1 && sudo -n mkdir -p "$dir" 2>/dev/null; then
        :
      else
        fail "unable to create runtime directory: ${dir}"
      fi
    fi

    current_owner="$(detect_stat_value '%u:%g' '%u:%g' "$dir" || true)"
    if [ "$current_owner" != "${RUNTIME_UID}:${RUNTIME_GID}" ]; then
      if ! chown "${RUNTIME_UID}:${RUNTIME_GID}" "$dir" 2>/dev/null; then
        if command -v sudo >/dev/null 2>&1 && sudo -n chown "${RUNTIME_UID}:${RUNTIME_GID}" "$dir" 2>/dev/null; then
          :
        elif [ ! -w "$dir" ]; then
          fail "runtime directory is not writable and ownership repair failed: ${dir}"
        else
          warn "could not change ownership for ${dir}; continuing because it is already writable"
        fi
      fi
    fi
  done
}

check_docker_health() {
  docker ps > /dev/null 2>&1 || fail "Docker daemon is not running"
  compose config --quiet > /dev/null 2>&1 || fail "Docker Compose configuration is invalid — check COMPOSE_FILES"
}

compose_has_service() {
  local service="$1"
  compose config --services 2>/dev/null | grep -Fxq "$service"
}

refresh_secret_sidecar_if_present() {
  if ! compose_has_service "secret-sidecar"; then
    return 0
  fi
  log "secret-sidecar detected in compose; rebuilding/recreating"
  build_slot "secret-sidecar"
  recreate_slot "secret-sidecar"
  wait_for_service_container_ready "secret-sidecar" "$LIVE_TIMEOUT"
  log "secret-sidecar health check passed"
}

ensure_tls_preflight() {
  [ "$COMPOSE_HAS_TLS_OVERLAY" -eq 1 ] || fail "TLS overlay not selected in COMPOSE_FILES"
  if [ ! -f "$TLS_CERT_PEM" ]; then
    fail "TLS overlay selected but cert bundle missing: $TLS_CERT_PEM (run infra/scripts/setup/ha-generate-tls-cert.sh)"
  fi
}

ensure_secrets_preflight() {
  [ -f "$SECRETS_PREFLIGHT_SCRIPT" ] || fail "missing secrets preflight script: $SECRETS_PREFLIGHT_SCRIPT"
  local -a cmd=(
    bash "$SECRETS_PREFLIGHT_SCRIPT"
    --code-dir "$CODE_DIR"
    --gateway-env-file "${GATEWAY_ENV_FILE}"
    --sidecar-env-file "${SIDECAR_ENV_FILE}"
    --watchdog-env-file "${WATCHDOG_ENV_FILE}"
    --state-dir "$STATE_DIR"
    --store-dir "$STORE_DIR"
    --require-http-api-key
  )
  "${cmd[@]}"
}

load_state() {
  LAST_GOOD_SHA=""
  LAST_DEPLOY_SHA=""
  LAST_STATUS=""
  LAST_ACTIVE_SLOT=""
  LAST_UPDATED_AT=""
  LAST_EFFECTIVE_SHA=""
  LAST_FAILURE_REASON=""
  LAST_TRIGGER_ID=""
  [ -f "$STATE_FILE" ] || return 0
  while IFS='=' read -r key value; do
    case "$key" in
      LAST_GOOD_SHA) LAST_GOOD_SHA="$value" ;;
      LAST_DEPLOY_SHA) LAST_DEPLOY_SHA="$value" ;;
      LAST_STATUS) LAST_STATUS="$value" ;;
      LAST_ACTIVE_SLOT) LAST_ACTIVE_SLOT="$value" ;;
      LAST_UPDATED_AT) LAST_UPDATED_AT="$value" ;;
      LAST_DEPLOY_PID) LAST_DEPLOY_PID="$value" ;;
      LAST_EFFECTIVE_SHA) LAST_EFFECTIVE_SHA="$value" ;;
      LAST_FAILURE_REASON) LAST_FAILURE_REASON="$value" ;;
      LAST_TRIGGER_ID) LAST_TRIGGER_ID="$value" ;;
    esac
  done <"$STATE_FILE"
}

write_state() {
  mkdir -p "$STATE_DIR"
  local state_tmp="${STATE_FILE}.tmp.$$"
  cat >"$state_tmp" <<EOF
LAST_GOOD_SHA=${LAST_GOOD_SHA}
LAST_DEPLOY_SHA=${LAST_DEPLOY_SHA}
LAST_STATUS=${LAST_STATUS}
LAST_ACTIVE_SLOT=${LAST_ACTIVE_SLOT}
LAST_UPDATED_AT=${LAST_UPDATED_AT}
LAST_DEPLOY_PID=${LAST_DEPLOY_PID}
LAST_EFFECTIVE_SHA=$(sanitize_state_value "${LAST_EFFECTIVE_SHA}")
LAST_FAILURE_REASON=$(sanitize_state_value "${LAST_FAILURE_REASON}")
LAST_TRIGGER_ID=$(sanitize_state_value "${LAST_TRIGGER_ID}")
EOF
  mv "$state_tmp" "$STATE_FILE"
}

# Detect if a previous deploy was interrupted (state says "deploying" but no
# process is running).  Warn the operator so they can inspect before proceeding.
check_interrupted_deploy() {
  load_state
  if [ "$LAST_STATUS" = "deploying" ]; then
    if [ -n "$LAST_DEPLOY_PID" ] && kill -0 "$LAST_DEPLOY_PID" 2>/dev/null; then
      fail "another deploy is in progress (pid=${LAST_DEPLOY_PID}, status=deploying)"
    fi
    warn "previous deploy was interrupted (status=deploying, pid=${LAST_DEPLOY_PID:-unknown} not running)"
    warn "setting status to 'interrupted' — review state before proceeding"
    LAST_STATUS="interrupted"
    LAST_FAILURE_REASON="previous deploy was interrupted"
    LAST_DEPLOY_PID=""
    LAST_UPDATED_AT="$(date +%s)"
    write_state
  fi
}

current_head_sha() {
  git -C "$CODE_DIR" rev-parse HEAD
}

repo_head_sha() {
  local repo_dir="$1"
  git -C "$repo_dir" rev-parse HEAD
}

sync_source_worktree_to_code_dir() {
  local source_dir="$1"
  local expected_base_sha="${2:-}"
  local source_abs code_abs code_head source_head patch_file rel target_path

  [ -n "$source_dir" ] || return 0
  [ -d "$source_dir" ] || fail "source code dir does not exist: $source_dir"
  git -C "$source_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "source code dir is not a git repo: $source_dir"

  source_abs="$(cd "$source_dir" && pwd -P)"
  code_abs="$(cd "$CODE_DIR" && pwd -P)"
  if [ "$source_abs" = "$code_abs" ]; then
    return 0
  fi

  if [ -n "$(git -C "$CODE_DIR" status --porcelain)" ]; then
    fail "live code dir is dirty; cannot sync candidate source into ${CODE_DIR}"
  fi

  code_head="$(current_head_sha)"
  if [ -n "$expected_base_sha" ] && [ "$code_head" != "$expected_base_sha" ]; then
    fail "live code dir HEAD (${code_head}) does not match expected source base (${expected_base_sha})"
  fi

  source_head="$(repo_head_sha "$source_dir")"
  if [ "$source_head" != "$code_head" ]; then
    fail "source repo HEAD (${source_head}) does not match live code dir HEAD (${code_head})"
  fi

  patch_file="$(mktemp "${STATE_DIR}/candidate-sync.XXXXXX.patch")"

  log "syncing candidate source ${source_abs} into live code dir ${code_abs}"
  git -C "$source_dir" diff --binary HEAD >"$patch_file"
  if [ -s "$patch_file" ]; then
    if ! git -C "$CODE_DIR" apply --binary "$patch_file"; then
      rm -f "$patch_file"
      reset_clean_to_commit "$code_head"
      fail "failed to apply candidate patch into live code dir"
    fi
  fi

  while IFS= read -r -d '' rel; do
    target_path="${CODE_DIR}/${rel}"
    mkdir -p "$(dirname "$target_path")"
    if ! cp -a "${source_dir}/${rel}" "$target_path"; then
      rm -f "$patch_file"
      reset_clean_to_commit "$code_head"
      fail "failed to copy candidate file into live code dir: ${rel}"
    fi
  done < <(git -C "$source_dir" ls-files --others --exclude-standard -z)
  rm -f "$patch_file"
}

record_failure_state() {
  local status="$1"
  local reason="$2"
  local effective_sha="${3:-}"
  LAST_STATUS="$status"
  LAST_FAILURE_REASON="$reason"
  if [ -n "$effective_sha" ]; then
    LAST_EFFECTIVE_SHA="$effective_sha"
  fi
  LAST_TRIGGER_ID="${NEXUS_DEPLOY_TRIGGER_ID:-}"
  LAST_DEPLOY_PID=""
  LAST_UPDATED_AT="$(date +%s)"
  write_state
}

current_upstream_ref() {
  git -C "$CODE_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true
}

resolve_push_target() {
  local requested_remote="$1"
  local requested_branch="$2"
  local resolved_remote resolved_branch upstream_ref upstream_remote upstream_branch
  resolved_remote="$requested_remote"
  resolved_branch="$requested_branch"
  [ -n "$resolved_branch" ] || resolved_branch="main"

  upstream_ref="$(current_upstream_ref)"
  if [[ "$upstream_ref" == */* ]]; then
    upstream_remote="${upstream_ref%%/*}"
    upstream_branch="${upstream_ref#*/}"
  else
    upstream_remote=""
    upstream_branch=""
  fi

  if [ -n "$resolved_remote" ] && ! git -C "$CODE_DIR" remote get-url "$resolved_remote" >/dev/null 2>&1; then
    if [ -n "$upstream_remote" ] && git -C "$CODE_DIR" remote get-url "$upstream_remote" >/dev/null 2>&1; then
      warn "push remote '${resolved_remote}' not found; falling back to upstream '${upstream_remote}/${upstream_branch}'"
      resolved_remote="$upstream_remote"
      if [ "$requested_branch" = "main" ] && [ -n "$upstream_branch" ]; then
        resolved_branch="$upstream_branch"
      fi
    else
      warn "push remote '${resolved_remote}' not found and no branch upstream fallback is available"
    fi
  fi

  printf '%s|%s\n' "$resolved_remote" "$resolved_branch"
}

verify_push_target_fast_forwardable() {
  local push_remote="$1"
  local push_branch="$2"
  local base_sha="$3"
  local fetched_sha

  [ -n "$push_remote" ] || return 0

  if ! git -C "$CODE_DIR" fetch --quiet "$push_remote" "$push_branch"; then
    fail "could not fetch push target ${push_remote}/${push_branch} before rollout"
  fi

  if ! fetched_sha="$(git -C "$CODE_DIR" rev-parse FETCH_HEAD 2>/dev/null)"; then
    fail "could not resolve fetched push target ${push_remote}/${push_branch}"
  fi

  if ! git -C "$CODE_DIR" merge-base --is-ancestor "$fetched_sha" "$base_sha"; then
    fail "push target ${push_remote}/${push_branch} has advanced beyond live HEAD (${base_sha}); pull/redeploy before applying local changes"
  fi
}

resolve_commit() {
  local ref="$1"
  git -C "$CODE_DIR" rev-parse --verify "${ref}^{commit}"
}

require_clean_repo() {
  local status
  status="$(git -C "$CODE_DIR" status --porcelain)"
  [ -z "$status" ] || fail "git working tree is dirty; commit or stash changes before rollout"
}

checkout_commit() {
  local sha="$1"
  local current
  current="$(current_head_sha)"
  if [ "$current" = "$sha" ]; then
    return 0
  fi
  log "checking out rollback commit $sha"
  git -C "$CODE_DIR" checkout "$sha" >/dev/null
}

reset_clean_to_commit() {
  local sha="$1"
  log "restoring git checkout to ${sha}"
  git -C "$CODE_DIR" reset --hard "$sha" >/dev/null
  git -C "$CODE_DIR" clean -fd >/dev/null
}

service_mode() {
  local service="$1"
  local raw
  if ! raw="$(compose_service_get "$service" "/api/mode" 5 2>/dev/null)"; then
    echo "down"
    return 0
  fi
  case "$raw" in
    *'"mode":"active"'*) echo "active" ;;
    *'"mode":"standby"'*) echo "standby" ;;
    *) echo "unknown" ;;
  esac
}

wait_for_service_http() {
  local service="$1"
  local path="$2"
  local timeout="$3"
  local started now
  started="$(date +%s)"
  while true; do
    if compose_service_get "$service" "$path" 5 >/dev/null 2>&1; then
      return 0
    fi
    now="$(date +%s)"
    if [ $((now - started)) -ge "$timeout" ]; then
      return 1
    fi
    sleep 2
  done
}

wait_for_service_container_ready() {
  local service="$1"
  local timeout="$2"
  local started now cid status
  started="$(date +%s)"
  while true; do
    cid="$(compose ps -q "$service" 2>/dev/null | head -n1)"
    if [ -n "$cid" ]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)"
      case "$status" in
        healthy|running)
          return 0
          ;;
        unhealthy|exited|dead)
          return 1
          ;;
      esac
    fi
    now="$(date +%s)"
    if [ $((now - started)) -ge "$timeout" ]; then
      return 1
    fi
    sleep 2
  done
}

wait_for_public_http() {
  local path="$1"
  local timeout="$2"
  local started now
  started="$(date +%s)"
  while true; do
    if curl_with_auth -fsS --max-time 5 "http://localhost:${API_PORT}${path}" >/dev/null 2>&1; then
      return 0
    fi
    now="$(date +%s)"
    if [ $((now - started)) -ge "$timeout" ]; then
      return 1
    fi
    sleep 2
  done
}

service_post() {
  local service="$1"
  local path="$2"
  compose_service_post "$service" "$path" 10 >/dev/null
}

set_slots_from_modes() {
  local primary_mode="$1"
  local standby_mode="$2"

  if [ "$primary_mode" = "active" ] && [ "$standby_mode" != "active" ]; then
    ACTIVE_SLOT="nexus-primary"
    INACTIVE_SLOT="nexus-standby"
    return 0
  fi
  if [ "$standby_mode" = "active" ] && [ "$primary_mode" != "active" ]; then
    ACTIVE_SLOT="nexus-standby"
    INACTIVE_SLOT="nexus-primary"
    return 0
  fi
  return 1
}

try_activate_slot() {
  local slot="$1"
  local timeout="$2"
  local started now
  started="$(date +%s)"
  while true; do
    if compose_service_post "$slot" "/api/activate" 8 >/dev/null 2>&1; then
      wait_for_service_http "$slot" "/health/traffic" "$READY_TIMEOUT" || return 1
      return 0
    fi
    now="$(date +%s)"
    if [ $((now - started)) -ge "$timeout" ]; then
      return 1
    fi
    sleep 2
  done
}

recover_slot_state() {
  local primary_mode standby_mode
  primary_mode="$(service_mode nexus-primary)"
  standby_mode="$(service_mode nexus-standby)"

  if set_slots_from_modes "$primary_mode" "$standby_mode"; then
    return 0
  fi

  if [ "$primary_mode" = "standby" ] && [ "$standby_mode" = "standby" ]; then
    warn "both slots are standby; attempting bootstrap activation"
    if try_activate_slot "nexus-primary" "$READY_TIMEOUT"; then
      log "bootstrap activation succeeded on nexus-primary"
      return 0
    fi
    warn "bootstrap activation on nexus-primary failed; trying nexus-standby"
    if try_activate_slot "nexus-standby" "$READY_TIMEOUT"; then
      log "bootstrap activation succeeded on nexus-standby"
      return 0
    fi
    return 1
  fi

  if [ "$primary_mode" = "active" ] && [ "$standby_mode" = "active" ]; then
    warn "both slots report active; attempting to demote nexus-standby"
    service_post "nexus-standby" "/api/deactivate" || true
    sleep 2
    return 0
  fi

  return 1
}

detect_slots() {
  local primary_mode standby_mode
  primary_mode="$(service_mode nexus-primary)"
  standby_mode="$(service_mode nexus-standby)"
  if set_slots_from_modes "$primary_mode" "$standby_mode"; then
    return 0
  fi

  if ! recover_slot_state; then
    fail "unable to determine active slot (primary=${primary_mode}, standby=${standby_mode})"
  fi

  primary_mode="$(service_mode nexus-primary)"
  standby_mode="$(service_mode nexus-standby)"
  if set_slots_from_modes "$primary_mode" "$standby_mode"; then
    return 0
  fi
  fail "unable to determine active slot after recovery (primary=${primary_mode}, standby=${standby_mode})"
}

build_slot() {
  local service="$1"
  log "building ${service} (timeout=${BUILD_TIMEOUT}s)"
  run_with_timeout "$BUILD_TIMEOUT" "${COMPOSE_BASE_CMD[@]}" build "$service"
}

recreate_slot() {
  local service="$1"
  log "recreating ${service} (timeout=${BUILD_TIMEOUT}s)"
  run_with_timeout "$BUILD_TIMEOUT" "${COMPOSE_BASE_CMD[@]}" up -d --no-deps --force-recreate "$service"
}

switch_to_slot() {
  local from="$1"
  local to="$2"
  local grace="${ACTIVATION_GRACE_SECS:-5}"
  log "deactivating ${from}"
  service_post "$from" "/api/deactivate" || warn "deactivate ${from} failed; continuing"
  log "activating ${to}"
  service_post "$to" "/api/activate"
  log "waiting ${grace}s for lease acquisition grace period"
  sleep "$grace"
  log "waiting for ${to} traffic health"
  wait_for_service_http "$to" "/health/traffic" "$READY_TIMEOUT" || return 1
}

run_smoke_checks() {
  log "running smoke checks via HAProxy"
  wait_for_public_http "/health/traffic" "$SMOKE_TIMEOUT" || return 1

  # Verify mode is active
  local mode
  mode="$(curl_with_auth -fsS --max-time 5 "http://localhost:${API_PORT}/api/mode" || true)"
  case "$mode" in
    *'"mode":"active"'*) ;;
    *)
      warn "smoke: /api/mode not active: ${mode}"
      return 1
      ;;
  esac

  # Verify /health/ready for visibility, but do not fail deploy if only
  # non-traffic operational checks are degraded.
  local ready_body
  ready_body="$(curl_with_auth -fsS --max-time 10 "http://localhost:${API_PORT}/health/ready" || true)"
  case "$ready_body" in
    *'"ok":true'*) ;;
    *)
      warn "smoke: /health/ready not fully ok (non-blocking): ${ready_body}"
      ;;
  esac

  # Verify /status endpoint responds (exercises config loading + DB)
  local status_body
  status_body="$(curl_with_auth -fsS --max-time 10 "http://localhost:${API_PORT}/status" || true)"
  case "$status_body" in
    *'"ok":true'*) ;;
    *)
      warn "smoke: /status not ok: ${status_body}"
      return 1
      ;;
  esac

  # Validate node endpoint behavior over HAProxy (non-upgrade probe + real WS upgrade).
  local node_http_code
  node_http_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://localhost:${API_PORT}/nx/nodes" || true)"
  case "$node_http_code" in
    426) ;;
    *)
      warn "smoke: expected /nx/nodes HTTP probe to return 426, got ${node_http_code}"
      return 1
      ;;
  esac

  if [ "$SKIP_WS_SMOKE" = "1" ]; then
    warn "smoke: websocket upgrade probe skipped (SKIP_WS_SMOKE=1)"
    log "smoke checks passed"
    return 0
  fi

  local ws_smoke_script
  ws_smoke_script='const url=process.env.NEXUS_NODE_WS_SMOKE_URL||"ws://haproxy:18789/nx/nodes";const timeoutMs=Number(process.env.NEXUS_NODE_WS_SMOKE_TIMEOUT_MS||8000);let opened=false;const ws=new WebSocket(url);const timer=setTimeout(()=>{console.error(`timeout connecting ${url}`);try{ws.close();}catch{}process.exit(2);},timeoutMs);ws.addEventListener("open",()=>{opened=true;clearTimeout(timer);try{ws.close(1000,"ha-rollout-smoke");}catch{}});ws.addEventListener("close",(ev)=>{clearTimeout(timer);if(opened)process.exit(0);console.error(`closed before open code=${ev.code} reason=${ev.reason||""}`);process.exit(3);});ws.addEventListener("error",()=>{if(opened)return;clearTimeout(timer);console.error(`websocket error before open url=${url}`);process.exit(1);});'

  local ws_started ws_now ws_probe_out last_ws_probe_out compact_ws_probe_out
  ws_started="$(date +%s)"
  last_ws_probe_out=""
  while true; do
    if ws_probe_out="$(compose exec -T -e NEXUS_NODE_WS_SMOKE_TIMEOUT_MS="$WS_SMOKE_ATTEMPT_TIMEOUT_MS" "$ACTIVE_SLOT" node -e "$ws_smoke_script" 2>&1)"; then
      break
    fi
    last_ws_probe_out="$ws_probe_out"
    ws_now="$(date +%s)"
    if [ $((ws_now - ws_started)) -ge "$WS_SMOKE_TIMEOUT" ]; then
      warn "smoke: websocket upgrade check failed on /nx/nodes via HAProxy (timeout=${WS_SMOKE_TIMEOUT}s)"
      if [ -n "$last_ws_probe_out" ]; then
        compact_ws_probe_out="$(printf '%s' "$last_ws_probe_out" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g' | cut -c1-260)"
        warn "smoke: websocket probe detail: ${compact_ws_probe_out}"
      fi
      if [ "$WS_SMOKE_WARN_ONLY" = "1" ]; then
        warn "smoke: continuing despite websocket smoke failure (WS_SMOKE_WARN_ONLY=1)"
        log "smoke checks passed (websocket warn-only)"
        return 0
      fi
      return 1
    fi
    sleep 2
  done

  log "smoke checks passed"
  return 0
}

rollback_after_failure() {
  local reason="$1"
  local old_active="$2"
  local candidate="$3"
  local rollback_sha="$4"
  local switched="$5"
  local target_sha="$6"
  local rollback_ok=1

  warn "deploy failed: ${reason}"
  if [ "$switched" = "1" ]; then
    warn "attempting traffic rollback to ${old_active}"
    if ! service_post "$candidate" "/api/deactivate"; then
      warn "failed to deactivate candidate ${candidate}"
      rollback_ok=0
    fi
    if ! service_post "$old_active" "/api/activate"; then
      warn "failed to re-activate old active ${old_active}"
      rollback_ok=0
    fi
    if ! wait_for_service_http "$old_active" "/health/traffic" "$READY_TIMEOUT"; then
      warn "old active ${old_active} not traffic-healthy after re-activation"
      rollback_ok=0
    fi
  fi

  if [ -n "$rollback_sha" ]; then
    if [ "$ROLLBACK_RESTORE_GIT" != "1" ]; then
      warn "skipping git checkout restore (ROLLBACK_RESTORE_GIT=${ROLLBACK_RESTORE_GIT}); leaving host checkout unchanged"
    else
      warn "restoring git checkout to last-good ${rollback_sha}"
      if ! reset_clean_to_commit "$rollback_sha"; then
        warn "git restore to ${rollback_sha} failed"
        rollback_ok=0
      fi
      # Restore branch ref if we ended up in detached HEAD
      git -C "$CODE_DIR" checkout main >/dev/null 2>&1 || true
      if ! build_slot "$candidate"; then
        warn "rebuild of candidate ${candidate} failed"
        rollback_ok=0
      fi
      if ! recreate_slot "$candidate"; then
        warn "recreate of candidate ${candidate} failed"
        rollback_ok=0
      fi
      wait_for_service_http "$candidate" "/health/live" "$LIVE_TIMEOUT" || true
    fi
  fi

  LAST_DEPLOY_SHA="$target_sha"
  if [ "$rollback_ok" = "1" ]; then
    LAST_STATUS="rollback_after_failure"
    LAST_EFFECTIVE_SHA="$rollback_sha"
  else
    LAST_STATUS="rollback_failed"
    LAST_EFFECTIVE_SHA=""
    warn "ROLLBACK INCOMPLETE — manual intervention may be required"
  fi
  LAST_FAILURE_REASON="$reason"
  LAST_ACTIVE_SLOT="$old_active"
  LAST_GOOD_SHA="$rollback_sha"
  LAST_DEPLOY_PID=""
  LAST_UPDATED_AT="$(date +%s)"
  write_state
}

acquire_lock() {
  mkdir -p "$STATE_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ >"${LOCK_DIR}/pid"
    return 0
  fi

  # Lock exists — check if the owning process is still alive.
  local owner_pid
  owner_pid="$(cat "${LOCK_DIR}/pid" 2>/dev/null || echo "")"
  if [ -n "$owner_pid" ] && kill -0 "$owner_pid" 2>/dev/null; then
    fail "another rollout appears to be running (pid=${owner_pid}, lock: ${LOCK_DIR})"
  fi

  # Owning process is gone — stale lock.
  warn "removing stale lock (pid=${owner_pid:-unknown} is no longer running)"
  rm -f "${LOCK_DIR}/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || true

  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    fail "could not reclaim lock after stale removal (lock: ${LOCK_DIR})"
  fi
  echo $$ >"${LOCK_DIR}/pid"
}

release_lock() {
  rm -f "${LOCK_DIR}/pid" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

cmd_status() {
  load_state
  local head primary_mode standby_mode dirty
  head="$(current_head_sha)"
  primary_mode="$(service_mode nexus-primary)"
  standby_mode="$(service_mode nexus-standby)"
  if [ -n "$(git -C "$CODE_DIR" status --porcelain)" ]; then
    dirty="yes"
  else
    dirty="no"
  fi

  echo "head_sha=${head}"
  echo "git_dirty=${dirty}"
  echo "primary_mode=${primary_mode}"
  echo "standby_mode=${standby_mode}"
  echo "last_good_sha=${LAST_GOOD_SHA}"
  echo "last_deploy_sha=${LAST_DEPLOY_SHA}"
  echo "last_status=${LAST_STATUS}"
  echo "last_effective_sha=${LAST_EFFECTIVE_SHA}"
  echo "last_failure_reason=${LAST_FAILURE_REASON}"
  echo "last_active_slot=${LAST_ACTIVE_SLOT}"
  echo "last_updated_at=${LAST_UPDATED_AT}"
  compose ps
}

cmd_apply_local() {
  local commit_message="${1:-}"
  local target_remote="${2:-}"
  local target_branch="${3:-main}"
  local source_code_dir="${4:-}"
  local source_base_sha="${5:-}"
  local base_sha rollback_sha old_active candidate switched new_sha standby_mode
  local resolved_push_remote resolved_push_branch
  switched=0

  check_interrupted_deploy
  load_state
  base_sha="$(current_head_sha)"

  if [ -n "$source_code_dir" ]; then
    sync_source_worktree_to_code_dir "$source_code_dir" "$source_base_sha"
  fi

  if [ -n "$target_remote" ]; then
    IFS='|' read -r resolved_push_remote resolved_push_branch <<< "$(resolve_push_target "$target_remote" "$target_branch")"
    verify_push_target_fast_forwardable "$resolved_push_remote" "$resolved_push_branch" "$base_sha"
  fi

  if [ -z "$(git -C "$CODE_DIR" status --porcelain)" ]; then
    fail "git working tree is clean; nothing to apply"
  fi
  rollback_sha="${LAST_GOOD_SHA:-$base_sha}"

  detect_slots
  old_active="$ACTIVE_SLOT"
  candidate="$INACTIVE_SLOT"
  verify_control_plane_auth

  LAST_DEPLOY_SHA="$base_sha"
  LAST_STATUS="applying_local"
  LAST_FAILURE_REASON=""
  LAST_TRIGGER_ID="${NEXUS_DEPLOY_TRIGGER_ID:-}"
  LAST_ACTIVE_SLOT="$old_active"
  LAST_DEPLOY_PID="$$"
  LAST_EFFECTIVE_SHA="$rollback_sha"
  [ -n "$LAST_GOOD_SHA" ] || LAST_GOOD_SHA="$rollback_sha"
  LAST_UPDATED_AT="$(date +%s)"
  write_state

  if ! refresh_secret_sidecar_if_present; then
    rollback_after_failure "secret-sidecar refresh failed" "$old_active" "$candidate" "$rollback_sha" "$switched" "$base_sha"
    fail "apply-local failed during secret-sidecar refresh"
  fi

  # Phase 1: Build candidate and verify it's healthy
  if ! build_slot "$candidate"; then
    rollback_after_failure "build failed" "$old_active" "$candidate" "$rollback_sha" "$switched" "$base_sha"
    fail "apply-local failed during build"
  fi
  if ! recreate_slot "$candidate"; then
    rollback_after_failure "recreate failed" "$old_active" "$candidate" "$rollback_sha" "$switched" "$base_sha"
    fail "apply-local failed during recreate"
  fi
  if ! wait_for_service_http "$candidate" "/health/live" "$LIVE_TIMEOUT"; then
    rollback_after_failure "candidate liveness failed" "$old_active" "$candidate" "$rollback_sha" "$switched" "$base_sha"
    fail "apply-local failed waiting for candidate live health"
  fi

  # Phase 2: Switch traffic to the candidate and verify smoke checks before
  # mutating git history or pushing to the remote.
  switched=1
  if ! switch_to_slot "$old_active" "$candidate"; then
    rollback_after_failure "switchover failed" "$old_active" "$candidate" "$rollback_sha" "$switched" "$base_sha"
    fail "apply-local failed during switchover"
  fi
  ACTIVE_SLOT="$candidate"
  INACTIVE_SLOT="$old_active"
  if ! run_smoke_checks; then
    rollback_after_failure "smoke checks failed" "$old_active" "$candidate" "$rollback_sha" "$switched" "$base_sha"
    fail "apply-local failed during smoke checks"
  fi

  # Phase 3: Commit and push only after smoke checks pass.
  if [ -z "$commit_message" ]; then
    commit_message="ha-rollout: apply local changes $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi

  log "committing local code changes on host"
  if ! git -C "$CODE_DIR" add -A; then
    rollback_after_failure "git add failed" "$old_active" "$candidate" "$rollback_sha" "$switched" "$base_sha"
    fail "apply-local failed during git add"
  fi

  if [ -z "$(git -C "$CODE_DIR" config user.name 2>/dev/null)" ]; then
    git -C "$CODE_DIR" config user.name "Nexus Deploy"
  fi
  if [ -z "$(git -C "$CODE_DIR" config user.email 2>/dev/null)" ]; then
    git -C "$CODE_DIR" config user.email "nexus@deploy.local"
  fi

  if git -C "$CODE_DIR" diff --cached --quiet; then
    log "no staged changes to commit — proceeding with current HEAD"
  else
    if ! git -C "$CODE_DIR" commit -m "$commit_message" >/dev/null; then
      rollback_after_failure "git commit failed after smoke checks" "$old_active" "$candidate" "$rollback_sha" "$switched" "$base_sha"
      fail "apply-local failed during git commit"
    fi
  fi
  new_sha="$(current_head_sha)"

  # Phase 4: Push to remote (non-fatal — standby rebuild always proceeds)
  local push_failed=0
  local push_remote="${resolved_push_remote:-$target_remote}"
  local push_branch="${resolved_push_branch:-$target_branch}"
  local push_output
  if [ -n "$target_remote" ]; then
    log "pushing commit ${new_sha} to ${push_remote}/${push_branch}"
    if ! push_output="$(git -C "$CODE_DIR" push "$push_remote" "HEAD:${push_branch}" 2>&1)"; then
      local compact_push_output
      compact_push_output="$(printf '%s' "$push_output" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g' | cut -c1-320)"
      warn "push failed for ${push_remote}/${push_branch}: ${compact_push_output} — will continue with standby rebuild"
      push_failed=1
    fi
  fi

  # Old active container is left running in standby mode (old code).
  # It will be rebuilt as the candidate on the next deploy. This avoids
  # killing the container where the coder agent may still be running.
  log "old active (${old_active}) left running as standby — will be rebuilt on next deploy"

  LAST_GOOD_SHA="$new_sha"
  LAST_DEPLOY_SHA="$new_sha"
  LAST_ACTIVE_SLOT="$candidate"
  LAST_DEPLOY_PID=""
  LAST_UPDATED_AT="$(date +%s)"

  if [ "$push_failed" = "1" ]; then
    LAST_STATUS="applied_local_push_failed"
    LAST_FAILURE_REASON="push failed for ${push_remote}/${push_branch}"
    LAST_EFFECTIVE_SHA="$new_sha"
    write_state
    warn "apply-local complete but push to ${push_remote}/${push_branch} failed"
  else
    LAST_STATUS="applied_local"
    LAST_FAILURE_REASON=""
    LAST_EFFECTIVE_SHA="$new_sha"
    write_state
  fi

  log "apply-local complete: active=${candidate} commit=${new_sha}"
}

cmd_deploy() {
  local target_ref="${1:-HEAD}"
  local target_sha head_sha rollback_sha old_active candidate switched
  switched=0

  require_clean_repo
  check_interrupted_deploy
  target_sha="$(resolve_commit "$target_ref")"
  head_sha="$(current_head_sha)"
  [ "$head_sha" = "$target_sha" ] || fail "HEAD (${head_sha}) does not match target (${target_sha}); checkout target first"

  load_state
  rollback_sha="${LAST_GOOD_SHA:-$head_sha}"

  detect_slots
  old_active="$ACTIVE_SLOT"
  candidate="$INACTIVE_SLOT"
  verify_control_plane_auth

  LAST_DEPLOY_SHA="$target_sha"
  LAST_STATUS="deploying"
  LAST_FAILURE_REASON=""
  LAST_TRIGGER_ID="${NEXUS_DEPLOY_TRIGGER_ID:-}"
  LAST_ACTIVE_SLOT="$old_active"
  LAST_DEPLOY_PID="$$"
  LAST_EFFECTIVE_SHA="$rollback_sha"
  [ -n "$LAST_GOOD_SHA" ] || LAST_GOOD_SHA="$rollback_sha"
  LAST_UPDATED_AT="$(date +%s)"
  write_state

  if ! refresh_secret_sidecar_if_present; then
    rollback_after_failure "secret-sidecar refresh failed" "$old_active" "$candidate" "$rollback_sha" "$switched" "$target_sha"
    fail "deploy failed during secret-sidecar refresh"
  fi

  if ! build_slot "$candidate"; then
    rollback_after_failure "build failed" "$old_active" "$candidate" "$rollback_sha" "$switched" "$target_sha"
    fail "deploy failed during build"
  fi
  if ! recreate_slot "$candidate"; then
    rollback_after_failure "recreate failed" "$old_active" "$candidate" "$rollback_sha" "$switched" "$target_sha"
    fail "deploy failed during recreate"
  fi
  if ! wait_for_service_http "$candidate" "/health/live" "$LIVE_TIMEOUT"; then
    rollback_after_failure "candidate liveness failed" "$old_active" "$candidate" "$rollback_sha" "$switched" "$target_sha"
    fail "deploy failed waiting for candidate live health"
  fi
  switched=1
  if ! switch_to_slot "$old_active" "$candidate"; then
    rollback_after_failure "switchover failed" "$old_active" "$candidate" "$rollback_sha" "$switched" "$target_sha"
    fail "deploy failed during switchover"
  fi
  ACTIVE_SLOT="$candidate"
  INACTIVE_SLOT="$old_active"
  if ! run_smoke_checks; then
    rollback_after_failure "smoke checks failed" "$old_active" "$candidate" "$rollback_sha" "$switched" "$target_sha"
    fail "deploy failed during smoke checks"
  fi

  LAST_GOOD_SHA="$target_sha"
  LAST_DEPLOY_SHA="$target_sha"
  LAST_STATUS="deployed"
  LAST_FAILURE_REASON=""
  LAST_ACTIVE_SLOT="$candidate"
  LAST_EFFECTIVE_SHA="$target_sha"
  LAST_DEPLOY_PID=""
  LAST_UPDATED_AT="$(date +%s)"
  write_state

  log "deploy complete: active=${candidate} commit=${target_sha}"
  log "next step (recommended): $0 finalize ${target_sha}"
}

cmd_rollback() {
  local target_ref="${1:-}"
  local target_sha head_sha old_active candidate

  require_clean_repo
  check_interrupted_deploy
  load_state
  if [ -z "$target_ref" ]; then
    [ -n "$LAST_GOOD_SHA" ] || fail "no last_good_sha recorded; specify rollback ref explicitly"
    target_ref="$LAST_GOOD_SHA"
  fi
  target_sha="$(resolve_commit "$target_ref")"
  head_sha="$(current_head_sha)"
  [ "$head_sha" = "$target_sha" ] || checkout_commit "$target_sha"

  detect_slots
  old_active="$ACTIVE_SLOT"
  candidate="$INACTIVE_SLOT"
  verify_control_plane_auth

  LAST_DEPLOY_SHA="$target_sha"
  LAST_STATUS="rolling_back"
  LAST_FAILURE_REASON=""
  LAST_TRIGGER_ID="${NEXUS_DEPLOY_TRIGGER_ID:-}"
  LAST_ACTIVE_SLOT="$old_active"
  LAST_DEPLOY_PID="$$"
  LAST_EFFECTIVE_SHA="$head_sha"
  [ -n "$LAST_GOOD_SHA" ] || LAST_GOOD_SHA="$head_sha"
  LAST_UPDATED_AT="$(date +%s)"
  write_state

  if ! refresh_secret_sidecar_if_present; then
    fail "rollback failed during secret-sidecar refresh"
  fi

  build_slot "$candidate"
  recreate_slot "$candidate"
  wait_for_service_http "$candidate" "/health/live" "$LIVE_TIMEOUT" || fail "rollback candidate not live"
  switch_to_slot "$old_active" "$candidate" || fail "rollback switchover failed"
  ACTIVE_SLOT="$candidate"
  INACTIVE_SLOT="$old_active"
  run_smoke_checks || fail "rollback smoke checks failed"

  LAST_GOOD_SHA="$target_sha"
  LAST_DEPLOY_SHA="$target_sha"
  LAST_STATUS="rolled_back"
  LAST_FAILURE_REASON=""
  LAST_ACTIVE_SLOT="$candidate"
  LAST_EFFECTIVE_SHA="$target_sha"
  LAST_UPDATED_AT="$(date +%s)"
  write_state

  # Restore branch to avoid detached HEAD after rollback to a SHA
  local current_branch
  current_branch="$(git -C "$CODE_DIR" symbolic-ref --short HEAD 2>/dev/null || true)"
  if [ -z "$current_branch" ]; then
    log "restoring HEAD to main branch after rollback"
    git -C "$CODE_DIR" checkout main >/dev/null 2>&1 || warn "could not restore to main branch"
  fi

  log "rollback complete: active=${candidate} commit=${target_sha}"
}

cmd_finalize() {
  local target_ref="${1:-HEAD}"
  local target_sha head_sha candidate active candidate_mode

  require_clean_repo
  check_interrupted_deploy
  target_sha="$(resolve_commit "$target_ref")"
  head_sha="$(current_head_sha)"
  [ "$head_sha" = "$target_sha" ] || fail "HEAD (${head_sha}) does not match target (${target_sha}); checkout target first"

  detect_slots
  active="$ACTIVE_SLOT"
  candidate="$INACTIVE_SLOT"
  verify_control_plane_auth

  if ! refresh_secret_sidecar_if_present; then
    fail "finalize failed during secret-sidecar refresh"
  fi

  build_slot "$candidate"
  recreate_slot "$candidate"
  wait_for_service_http "$candidate" "/health/live" "$LIVE_TIMEOUT" || fail "finalize candidate not live"

  # Verify the standby is actually running and in standby mode (not crashed/errored).
  # Standby instances won't pass /health/ready (role check fails) so we verify
  # liveness + mode instead.
  candidate_mode="$(service_mode "$candidate")"
  case "$candidate_mode" in
    standby|active)
      log "finalize: ${candidate} mode=${candidate_mode} (ok)"
      ;;
    *)
      warn "finalize: ${candidate} in unexpected mode=${candidate_mode} after rebuild"
      fail "finalize candidate not healthy (mode=${candidate_mode})"
      ;;
  esac

  LAST_DEPLOY_SHA="$target_sha"
  LAST_STATUS="finalized"
  LAST_FAILURE_REASON=""
  LAST_ACTIVE_SLOT="$active"
  LAST_EFFECTIVE_SHA="$target_sha"
  [ -n "$LAST_GOOD_SHA" ] || LAST_GOOD_SHA="$target_sha"
  LAST_UPDATED_AT="$(date +%s)"
  write_state

  log "finalize complete: active=${active}, standby refreshed=${candidate}, commit=${target_sha}"
}

main() {
  local cmd="${1:-}"
  if [ -z "$cmd" ]; then
    usage
    exit 1
  fi
  shift || true

  case "$cmd" in
    status)
      require_cmd git
      require_cmd docker
      require_cmd curl
      [ -d "$CODE_DIR" ] || fail "missing code dir: $CODE_DIR"
      resolve_control_plane_api_key
      init_compose_files
      cmd_status
      ;;
    deploy|apply-local|rollback|finalize)
      require_cmd git
      require_cmd docker
      require_cmd curl
      [ -d "$CODE_DIR" ] || fail "missing code dir: $CODE_DIR"
      resolve_control_plane_api_key
      init_compose_files
      check_docker_health
      ensure_runtime_dir_ownership
      ensure_tls_preflight
      ensure_secrets_preflight
      acquire_lock
      trap release_lock EXIT
      case "$cmd" in
        deploy) cmd_deploy "$@" ;;
        apply-local) cmd_apply_local "$@" ;;
        rollback) cmd_rollback "$@" ;;
        finalize) cmd_finalize "$@" ;;
      esac
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      usage
      fail "unknown command: $cmd"
      ;;
  esac
}

main "$@"
