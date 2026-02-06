#!/usr/bin/env bash
# HA rolling deploy with git-based rollback.
#
# Commands:
#   deploy [<target-ref>]   Build/recreate inactive slot, switch traffic, smoke test.
#                           On failure, auto-rollback to last-good commit.
#   rollback [<target-ref>] Force rollback to a known commit (default: last-good).
#   finalize [<target-ref>] Rebuild only inactive slot at target commit (no switchover).
#   status                  Show HA slot modes and rollout state.
#
# Environment overrides:
#   CODE_DIR=/data/code
#   COMPOSE_FILE=/data/code/infra/docker-compose.ha.yml
#   COMPOSE_PROJECT=infra
#   STATE_DIR=/data/nexus
#   STATE_FILE=/data/nexus/deploy-state.env
#   API_PORT=18789
#   LIVE_TIMEOUT=90
#   READY_TIMEOUT=120
#   SMOKE_TIMEOUT=60

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_CODE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

CODE_DIR="${CODE_DIR:-${DEFAULT_CODE_DIR}}"
COMPOSE_FILE="${COMPOSE_FILE:-${CODE_DIR}/infra/docker-compose.ha.yml}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-infra}"
STATE_DIR="${STATE_DIR:-/data/nexus}"
STATE_FILE="${STATE_FILE:-${STATE_DIR}/deploy-state.env}"
LOCK_DIR="${STATE_DIR}/ha-rollout.lock"
API_PORT="${API_PORT:-18789}"
LIVE_TIMEOUT="${LIVE_TIMEOUT:-90}"
READY_TIMEOUT="${READY_TIMEOUT:-120}"
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-60}"

LAST_GOOD_SHA=""
LAST_DEPLOY_SHA=""
LAST_STATUS=""
LAST_ACTIVE_SLOT=""
LAST_UPDATED_AT=""

usage() {
  cat <<'EOF'
Usage:
  ha-rollout.sh deploy [<target-ref>]
  ha-rollout.sh rollback [<target-ref>]
  ha-rollout.sh finalize [<target-ref>]
  ha-rollout.sh status

Examples:
  infra/scripts/ha-rollout.sh status
  infra/scripts/ha-rollout.sh deploy HEAD
  infra/scripts/ha-rollout.sh deploy bfea957
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

compose() {
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" "$@"
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
EOF
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

service_mode() {
  local service="$1"
  local raw
  if ! raw="$(compose exec -T "$service" sh -lc "curl -fsS --max-time 5 http://localhost:18789/api/mode" 2>/dev/null)"; then
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
    if compose exec -T "$service" sh -lc "curl -fsS --max-time 5 http://localhost:18789${path}" >/dev/null 2>&1; then
      return 0
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
    if curl -fsS --max-time 5 "http://localhost:${API_PORT}${path}" >/dev/null 2>&1; then
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
  compose exec -T "$service" sh -lc "curl -fsS --max-time 10 -X POST http://localhost:18789${path}" >/dev/null
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
    if compose exec -T "$slot" sh -lc "curl -fsS --max-time 8 -X POST http://localhost:18789/api/activate" >/dev/null 2>&1; then
      wait_for_service_http "$slot" "/health/ready" "$READY_TIMEOUT" || return 1
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
  log "building ${service}"
  compose build "$service"
}

recreate_slot() {
  local service="$1"
  log "recreating ${service}"
  compose up -d --no-deps --force-recreate "$service"
}

switch_to_slot() {
  local from="$1"
  local to="$2"
  log "deactivating ${from}"
  service_post "$from" "/api/deactivate" || warn "deactivate ${from} failed; continuing"
  log "activating ${to}"
  service_post "$to" "/api/activate"
  log "waiting for ${to} readiness"
  wait_for_service_http "$to" "/health/ready" "$READY_TIMEOUT" || return 1
}

run_smoke_checks() {
  log "running smoke checks via HAProxy"
  wait_for_public_http "/health/ready" "$SMOKE_TIMEOUT" || return 1
  local mode
  mode="$(curl -fsS --max-time 5 "http://localhost:${API_PORT}/api/mode" || true)"
  case "$mode" in
    *'"mode":"active"'*) return 0 ;;
    *) return 1 ;;
  esac
}

rollback_after_failure() {
  local reason="$1"
  local old_active="$2"
  local candidate="$3"
  local rollback_sha="$4"
  local switched="$5"
  local target_sha="$6"

  warn "deploy failed: ${reason}"
  if [ "$switched" = "1" ]; then
    warn "attempting traffic rollback to ${old_active}"
    service_post "$candidate" "/api/deactivate" || true
    service_post "$old_active" "/api/activate" || true
    wait_for_service_http "$old_active" "/health/ready" "$READY_TIMEOUT" || true
  fi

  if [ -n "$rollback_sha" ]; then
    warn "restoring git checkout to last-good ${rollback_sha}"
    checkout_commit "$rollback_sha" || true
    build_slot "$candidate" || true
    recreate_slot "$candidate" || true
    wait_for_service_http "$candidate" "/health/live" "$LIVE_TIMEOUT" || true
  fi

  LAST_DEPLOY_SHA="$target_sha"
  LAST_STATUS="rollback_after_failure"
  LAST_ACTIVE_SLOT="$old_active"
  LAST_GOOD_SHA="$rollback_sha"
  LAST_UPDATED_AT="$(date +%s)"
  write_state
}

acquire_lock() {
  mkdir -p "$STATE_DIR"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    fail "another rollout appears to be running (lock: ${LOCK_DIR})"
  fi
}

release_lock() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

cmd_status() {
  load_state
  local head primary_mode standby_mode
  head="$(current_head_sha)"
  primary_mode="$(service_mode nexus-primary)"
  standby_mode="$(service_mode nexus-standby)"

  echo "head_sha=${head}"
  echo "primary_mode=${primary_mode}"
  echo "standby_mode=${standby_mode}"
  echo "last_good_sha=${LAST_GOOD_SHA}"
  echo "last_deploy_sha=${LAST_DEPLOY_SHA}"
  echo "last_status=${LAST_STATUS}"
  echo "last_active_slot=${LAST_ACTIVE_SLOT}"
  echo "last_updated_at=${LAST_UPDATED_AT}"
  compose ps
}

cmd_deploy() {
  local target_ref="${1:-HEAD}"
  local target_sha head_sha rollback_sha old_active candidate switched
  switched=0

  require_clean_repo
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
  [ -n "$LAST_GOOD_SHA" ] || LAST_GOOD_SHA="$rollback_sha"
  LAST_UPDATED_AT="$(date +%s)"
  write_state

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
  if ! run_smoke_checks; then
    rollback_after_failure "smoke checks failed" "$old_active" "$candidate" "$rollback_sha" "$switched" "$target_sha"
    fail "deploy failed during smoke checks"
  fi

  LAST_GOOD_SHA="$target_sha"
  LAST_DEPLOY_SHA="$target_sha"
  LAST_STATUS="deployed"
  LAST_ACTIVE_SLOT="$candidate"
  LAST_UPDATED_AT="$(date +%s)"
  write_state

  log "deploy complete: active=${candidate} commit=${target_sha}"
  log "next step (recommended): $0 finalize ${target_sha}"
}

cmd_rollback() {
  local target_ref="${1:-}"
  local target_sha head_sha old_active candidate

  require_clean_repo
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

  build_slot "$candidate"
  recreate_slot "$candidate"
  wait_for_service_http "$candidate" "/health/live" "$LIVE_TIMEOUT" || fail "rollback candidate not live"
  switch_to_slot "$old_active" "$candidate" || fail "rollback switchover failed"
  run_smoke_checks || fail "rollback smoke checks failed"

  LAST_GOOD_SHA="$target_sha"
  LAST_DEPLOY_SHA="$target_sha"
  LAST_STATUS="rolled_back"
  LAST_ACTIVE_SLOT="$candidate"
  LAST_UPDATED_AT="$(date +%s)"
  write_state

  log "rollback complete: active=${candidate} commit=${target_sha}"
}

cmd_finalize() {
  local target_ref="${1:-HEAD}"
  local target_sha head_sha candidate active

  require_clean_repo
  target_sha="$(resolve_commit "$target_ref")"
  head_sha="$(current_head_sha)"
  [ "$head_sha" = "$target_sha" ] || fail "HEAD (${head_sha}) does not match target (${target_sha}); checkout target first"

  detect_slots
  active="$ACTIVE_SLOT"
  candidate="$INACTIVE_SLOT"

  build_slot "$candidate"
  recreate_slot "$candidate"
  wait_for_service_http "$candidate" "/health/live" "$LIVE_TIMEOUT" || fail "finalize candidate not live"

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
      [ -f "$COMPOSE_FILE" ] || fail "missing compose file: $COMPOSE_FILE"
      cmd_status
      ;;
    deploy|rollback|finalize)
      require_cmd git
      require_cmd docker
      require_cmd curl
      [ -d "$CODE_DIR" ] || fail "missing code dir: $CODE_DIR"
      [ -f "$COMPOSE_FILE" ] || fail "missing compose file: $COMPOSE_FILE"
      acquire_lock
      trap release_lock EXIT
      case "$cmd" in
        deploy) cmd_deploy "$@" ;;
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
