#!/usr/bin/env bash
# HA rolling deploy with git-based rollback.
#
# Commands:
#   deploy [<target-ref>]               Build/recreate inactive slot, switch traffic, smoke test.
#                                       On failure, auto-rollback to last-good commit.
#   apply-local [<msg>] [<remote>] [<branch>]
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
#   CODE_DIR=/data/code
#   COMPOSE_FILES=/data/code/infra/docker-compose.ha.yml:/data/code/infra/docker-compose.ha.sidecar.yml:/data/code/infra/docker-compose.ha.tls.yml
#   COMPOSE_PROJECT=infra
#   STATE_DIR=/data/nexus
#   STATE_FILE=/data/nexus/deploy-state.env
#   API_PORT=18789
#   LIVE_TIMEOUT=90
#   READY_TIMEOUT=120
#   SMOKE_TIMEOUT=60
#   WS_SMOKE_TIMEOUT=20               # retry window for websocket smoke probe
#   SKIP_WS_SMOKE=0                   # set to 1 to skip websocket smoke probe
#   WS_SMOKE_WARN_ONLY=0              # set to 1 to warn (not fail) on websocket smoke timeout
#   WS_SMOKE_ATTEMPT_TIMEOUT_MS=8000  # per-attempt websocket probe timeout in milliseconds
#   NEXUS_HAPROXY_TLS_CERT_PEM=/data/code/infra/haproxy/certs/nexus.pem
#   ROLLBACK_RESTORE_GIT=1            # set to 0 to keep current checkout on failed deploy rollback
#   NEXUS_HA_API_KEY=<token>            # optional bearer token for /api/* control-plane calls
#                                        # fallback: NEXUS_HTTP_API_KEY, NEXUS_HTTP_AUTH_TOKEN, NEXUS_DASHBOARD_PASSWORD

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_CODE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

CODE_DIR="${CODE_DIR:-${DEFAULT_CODE_DIR}}"
DEFAULT_COMPOSE_FILES="${CODE_DIR}/infra/docker-compose.ha.yml:${CODE_DIR}/infra/docker-compose.ha.sidecar.yml:${CODE_DIR}/infra/docker-compose.ha.tls.yml"
COMPOSE_FILES_RAW="${COMPOSE_FILES:-${DEFAULT_COMPOSE_FILES}}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-infra}"
STATE_DIR="${STATE_DIR:-/data/nexus}"
STATE_FILE="${STATE_FILE:-${STATE_DIR}/deploy-state.env}"
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
ROLLBACK_RESTORE_GIT="${ROLLBACK_RESTORE_GIT:-1}"
CONTROL_PLANE_API_KEY="${NEXUS_HA_API_KEY:-${NEXUS_HTTP_API_KEY:-${NEXUS_HTTP_AUTH_TOKEN:-${NEXUS_DASHBOARD_PASSWORD:-}}}}"

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

usage() {
  cat <<'EOF'
Usage:
  ha-rollout.sh deploy [<target-ref>]
  ha-rollout.sh apply-local [<commit-message>] [<target-remote>] [<target-branch>]
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

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
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
    fail "TLS overlay selected but cert bundle missing: $TLS_CERT_PEM (run infra/scripts/ha-generate-tls-cert.sh)"
  fi
}

load_state() {
  LAST_GOOD_SHA=""
  LAST_DEPLOY_SHA=""
  LAST_STATUS=""
  LAST_ACTIVE_SLOT=""
  LAST_UPDATED_AT=""
  [ -f "$STATE_FILE" ] || return 0
  while IFS='=' read -r key value; do
    case "$key" in
      LAST_GOOD_SHA) LAST_GOOD_SHA="$value" ;;
      LAST_DEPLOY_SHA) LAST_DEPLOY_SHA="$value" ;;
      LAST_STATUS) LAST_STATUS="$value" ;;
      LAST_ACTIVE_SLOT) LAST_ACTIVE_SLOT="$value" ;;
      LAST_UPDATED_AT) LAST_UPDATED_AT="$value" ;;
      LAST_DEPLOY_PID) LAST_DEPLOY_PID="$value" ;;
    esac
  done <"$STATE_FILE"
}

write_state() {
  mkdir -p "$STATE_DIR"
  cat >"$STATE_FILE" <<EOF
LAST_GOOD_SHA=${LAST_GOOD_SHA}
LAST_DEPLOY_SHA=${LAST_DEPLOY_SHA}
LAST_STATUS=${LAST_STATUS}
LAST_ACTIVE_SLOT=${LAST_ACTIVE_SLOT}
LAST_UPDATED_AT=${LAST_UPDATED_AT}
LAST_DEPLOY_PID=${LAST_DEPLOY_PID}
EOF
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
    LAST_DEPLOY_PID=""
    LAST_UPDATED_AT="$(date +%s)"
    write_state
  fi
}

current_head_sha() {
  git -C "$CODE_DIR" rev-parse HEAD
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
  timeout "$BUILD_TIMEOUT" "${COMPOSE_BASE_CMD[@]}" build "$service"
}

recreate_slot() {
  local service="$1"
  log "recreating ${service} (timeout=${BUILD_TIMEOUT}s)"
  timeout "$BUILD_TIMEOUT" "${COMPOSE_BASE_CMD[@]}" up -d --no-deps --force-recreate "$service"
}

switch_to_slot() {
  local from="$1"
  local to="$2"
  log "deactivating ${from}"
  service_post "$from" "/api/deactivate" || warn "deactivate ${from} failed; continuing"
  log "activating ${to}"
  service_post "$to" "/api/activate"
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
  else
    LAST_STATUS="rollback_failed"
    warn "ROLLBACK INCOMPLETE — manual intervention may be required"
  fi
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
  echo "last_active_slot=${LAST_ACTIVE_SLOT}"
  echo "last_updated_at=${LAST_UPDATED_AT}"
  compose ps
}

cmd_apply_local() {
  local commit_message="${1:-}"
  local target_remote="${2:-}"
  local target_branch="${3:-main}"
  local base_sha rollback_sha old_active candidate switched new_sha standby_mode
  switched=0

  check_interrupted_deploy
  load_state

  if [ -z "$(git -C "$CODE_DIR" status --porcelain)" ]; then
    fail "git working tree is clean; nothing to apply"
  fi

  base_sha="$(current_head_sha)"
  rollback_sha="${LAST_GOOD_SHA:-$base_sha}"

  detect_slots
  old_active="$ACTIVE_SLOT"
  candidate="$INACTIVE_SLOT"

  LAST_DEPLOY_SHA="$base_sha"
  LAST_STATUS="applying_local"
  LAST_ACTIVE_SLOT="$old_active"
  LAST_DEPLOY_PID="$$"
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

  # Phase 2: Commit the code now that we know it builds and boots
  if [ -z "$commit_message" ]; then
    commit_message="ha-rollout: apply local changes $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi

  log "committing local code changes on host"
  if ! git -C "$CODE_DIR" add -A; then
    rollback_after_failure "git add failed" "$old_active" "$candidate" "$rollback_sha" "$switched" "$base_sha"
    fail "apply-local failed during git add"
  fi

  # Ensure git identity is configured (needed for commit)
  if [ -z "$(git -C "$CODE_DIR" config user.name 2>/dev/null)" ]; then
    git -C "$CODE_DIR" config user.name "Nexus Deploy"
  fi
  if [ -z "$(git -C "$CODE_DIR" config user.email 2>/dev/null)" ]; then
    git -C "$CODE_DIR" config user.email "nexus@deploy.local"
  fi

  # Commit if there are staged changes; skip gracefully if tree is clean
  if git -C "$CODE_DIR" diff --cached --quiet; then
    log "no staged changes to commit — proceeding with current HEAD"
  else
    if ! git -C "$CODE_DIR" commit -m "$commit_message" >/dev/null; then
      rollback_after_failure "git commit failed" "$old_active" "$candidate" "$rollback_sha" "$switched" "$base_sha"
      fail "apply-local failed during git commit"
    fi
  fi
  new_sha="$(current_head_sha)"

  # Phase 3: Switch traffic to the candidate
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

  # Phase 4: Push to remote (non-fatal — standby rebuild always proceeds)
  local push_failed=0
  if [ -n "$target_remote" ]; then
    log "pushing commit ${new_sha} to ${target_remote}/${target_branch}"
    if ! git -C "$CODE_DIR" push "$target_remote" "HEAD:${target_branch}" >/dev/null; then
      warn "push failed for ${target_remote}/${target_branch} — will continue with standby rebuild"
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
    write_state
    warn "apply-local complete but push to ${target_remote}/${target_branch} failed"
  else
    LAST_STATUS="applied_local"
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

  LAST_DEPLOY_SHA="$target_sha"
  LAST_STATUS="deploying"
  LAST_ACTIVE_SLOT="$old_active"
  LAST_DEPLOY_PID="$$"
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
  LAST_ACTIVE_SLOT="$candidate"
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
  LAST_ACTIVE_SLOT="$candidate"
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
  LAST_ACTIVE_SLOT="$active"
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
      init_compose_files
      cmd_status
      ;;
    deploy|apply-local|rollback|finalize)
      require_cmd git
      require_cmd docker
      require_cmd curl
      [ -d "$CODE_DIR" ] || fail "missing code dir: $CODE_DIR"
      init_compose_files
      ensure_tls_preflight
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
