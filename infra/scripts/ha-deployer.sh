#!/usr/bin/env bash
# Host-side deploy queue worker for Nexus HA rollouts.
#
# Reads JSON deploy requests from:
#   /data/nexus/deploy-queue/pending/*.json
# Runs:
#   infra/scripts/ha-rollout.sh deploy <commitSha>
#   infra/scripts/ha-rollout.sh finalize <commitSha>   (if request.finalize=true)
#
# Usage:
#   ha-deployer.sh daemon
#   ha-deployer.sh once
#   ha-deployer.sh status

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_CODE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

CODE_DIR="${CODE_DIR:-${DEFAULT_CODE_DIR}}"
STATE_DIR="${STATE_DIR:-/data/nexus}"
QUEUE_ROOT="${QUEUE_ROOT:-${STATE_DIR}/deploy-queue}"
PENDING_DIR="${QUEUE_ROOT}/pending"
PROCESSING_DIR="${QUEUE_ROOT}/processing"
DONE_DIR="${QUEUE_ROOT}/done"
FAILED_DIR="${QUEUE_ROOT}/failed"
LOG_DIR="${QUEUE_ROOT}/logs"
LOCK_DIR="${STATE_DIR}/ha-deployer.lock"

ROLLOUT_SCRIPT="${ROLLOUT_SCRIPT:-${CODE_DIR}/infra/scripts/ha-rollout.sh}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
API_URL="${API_URL:-http://localhost:18789}"
GIT_TIMEOUT="${GIT_TIMEOUT:-120}"
DEPLOY_TIMEOUT="${DEPLOY_TIMEOUT:-600}"
FINALIZE_TIMEOUT="${FINALIZE_TIMEOUT:-600}"
PUSH_AFTER_DEPLOY="${PUSH_AFTER_DEPLOY:-1}"
PUSH_REMOTE="${PUSH_REMOTE:-host}"
PUSH_BRANCH="${PUSH_BRANCH:-main}"
PUSH_TIMEOUT="${PUSH_TIMEOUT:-120}"
PUSH_REQUIRED="${PUSH_REQUIRED:-0}"

log() {
  echo "[ha-deployer] $*"
}

warn() {
  echo "[ha-deployer] WARN: $*" >&2
}

fail() {
  echo "[ha-deployer] ERROR: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  ha-deployer.sh daemon
  ha-deployer.sh once
  ha-deployer.sh status
EOF
}

is_true() {
  case "${1,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

ensure_dirs() {
  mkdir -p "$PENDING_DIR" "$PROCESSING_DIR" "$DONE_DIR" "$FAILED_DIR" "$LOG_DIR"
}

queue_count() {
  local dir="$1"
  find "$dir" -maxdepth 1 -type f -name "*.json" | wc -l | tr -d ' '
}

next_pending_file() {
  find "$PENDING_DIR" -maxdepth 1 -type f -name "*.json" | sort | head -n 1
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
    fail "another deployer instance is already running (pid=${owner_pid}, lock: $LOCK_DIR)"
  fi

  # Owning process is gone — stale lock.
  warn "removing stale lock (pid=${owner_pid:-unknown} is no longer running)"
  rm -f "${LOCK_DIR}/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || true

  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    fail "could not reclaim lock after stale removal (lock: $LOCK_DIR)"
  fi
  echo $$ >"${LOCK_DIR}/pid"
}

release_lock() {
  rm -f "${LOCK_DIR}/pid" 2>/dev/null || true
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

notify_event() {
  local event="$1"
  local request_id="$2"
  local commit_sha="$3"
  local reason="$4"

  local payload
  payload="$(jq -nc \
    --arg event "$event" \
    --arg reason "$reason" \
    --arg requestId "$request_id" \
    --arg commitSha "$commit_sha" \
    '{event:$event, from:"ha-deployer", to:$commitSha, reason:$reason, details:{requestId:$requestId, commitSha:$commitSha}}')"

  curl -fsS --max-time 10 \
    -X POST "${API_URL}/api/ha/event" \
    -H "Content-Type: application/json" \
    -d "$payload" >/dev/null 2>&1 || true
}

set_processing_state() {
  local file="$1"
  local started_at="$2"
  local tmp
  tmp="$(mktemp)"
  jq --arg startedAt "$started_at" '. + {state:"processing", startedAt:$startedAt}' "$file" >"$tmp"
  mv "$tmp" "$file"
}

finalize_request() {
  local state="$1"          # done | failed
  local processing_file="$2"
  local message="$3"
  local log_file="$4"
  local finished_at="$5"
  local dest_dir
  local tmp
  local dest_file

  if [ "$state" = "done" ]; then
    dest_dir="$DONE_DIR"
  else
    dest_dir="$FAILED_DIR"
  fi

  tmp="$(mktemp)"
  jq \
    --arg state "$state" \
    --arg finishedAt "$finished_at" \
    --arg message "$message" \
    --arg logFile "$log_file" \
    '. + {state:$state, finishedAt:$finishedAt, message:$message, logFile:$logFile}' \
    "$processing_file" >"$tmp"

  dest_file="${dest_dir}/$(basename "$processing_file")"
  mv "$tmp" "$dest_file"
  rm -f "$processing_file"
  log "request finalized state=${state} file=${dest_file}"
}

push_deployed_commit() {
  local commit_sha="$1"
  local log_file="$2"

  if ! git -C "$CODE_DIR" remote get-url "$PUSH_REMOTE" >/dev/null 2>&1; then
    echo "push skipped: remote '${PUSH_REMOTE}' not found in ${CODE_DIR}" >>"$log_file"
    return 2
  fi

  echo "\$ git -C ${CODE_DIR} push ${PUSH_REMOTE} ${commit_sha}:refs/heads/${PUSH_BRANCH} (timeout=${PUSH_TIMEOUT}s)" >>"$log_file"
  local push_code=0
  set +e
  timeout "$PUSH_TIMEOUT" git -C "$CODE_DIR" push "$PUSH_REMOTE" "${commit_sha}:refs/heads/${PUSH_BRANCH}" >>"$log_file" 2>&1
  push_code=$?
  set -e
  return "$push_code"
}

process_request_file() {
  local pending_file="$1"
  local processing_file
  local request_id
  local commit_sha
  local finalize
  local started_at
  local finished_at
  local log_file
  local deploy_code
  local finalize_code
  local deploy_reason
  local event
  local current_sha
  local push_required
  local push_message
  local push_code

  processing_file="${PROCESSING_DIR}/$(basename "$pending_file")"
  if ! mv "$pending_file" "$processing_file" 2>/dev/null; then
    return 0
  fi

  request_id="$(jq -r '.id // empty' "$processing_file")"
  commit_sha="$(jq -r '.commitSha // empty' "$processing_file")"
  finalize="$(jq -r '.finalize // true' "$processing_file")"
  started_at="$(date -Iseconds)"
  set_processing_state "$processing_file" "$started_at"

  if [ -z "$request_id" ] || [ -z "$commit_sha" ]; then
    finished_at="$(date -Iseconds)"
    finalize_request "failed" "$processing_file" "invalid request payload: missing id or commitSha" "" "$finished_at"
    return 0
  fi

  if ! [[ "$commit_sha" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
    finished_at="$(date -Iseconds)"
    finalize_request "failed" "$processing_file" "invalid commitSha format: ${commit_sha}" "" "$finished_at"
    return 0
  fi

  log_file="${LOG_DIR}/${request_id}-$(date +%s).log"
  touch "$log_file"

  {
    echo "request_id=${request_id}"
    echo "commit_sha=${commit_sha}"
    echo "started_at=${started_at}"
    echo "code_dir=${CODE_DIR}"
    echo
  } >>"$log_file"

  deploy_reason="deploy request ${request_id}"
  event="deploy_started"
  notify_event "$event" "$request_id" "$commit_sha" "$deploy_reason"
  push_required=0
  if is_true "$PUSH_REQUIRED"; then
    push_required=1
  fi

  if [ -n "$(git -C "$CODE_DIR" status --porcelain)" ]; then
    finished_at="$(date -Iseconds)"
    finalize_request "failed" "$processing_file" "git working tree is dirty in ${CODE_DIR}" "$log_file" "$finished_at"
    notify_event "deploy_failed" "$request_id" "$commit_sha" "git tree dirty"
    return 0
  fi

  if ! git -C "$CODE_DIR" cat-file -e "${commit_sha}^{commit}" 2>/dev/null; then
    finished_at="$(date -Iseconds)"
    finalize_request "failed" "$processing_file" "commit not found in ${CODE_DIR}: ${commit_sha}" "$log_file" "$finished_at"
    notify_event "deploy_failed" "$request_id" "$commit_sha" "commit missing"
    return 0
  fi

  current_sha="$(git -C "$CODE_DIR" rev-parse HEAD)"
  if [ "$current_sha" != "$commit_sha" ]; then
    echo "\$ git -C ${CODE_DIR} checkout ${commit_sha} (timeout=${GIT_TIMEOUT}s)" >>"$log_file"
    if ! timeout "$GIT_TIMEOUT" git -C "$CODE_DIR" checkout "$commit_sha" >>"$log_file" 2>&1; then
      finished_at="$(date -Iseconds)"
      finalize_request "failed" "$processing_file" "git checkout failed or timed out for ${commit_sha}" "$log_file" "$finished_at"
      notify_event "deploy_failed" "$request_id" "$commit_sha" "git checkout failed"
      return 0
    fi
  fi

  deploy_code=0
  echo "\$ ${ROLLOUT_SCRIPT} deploy ${commit_sha} (timeout=${DEPLOY_TIMEOUT}s)" >>"$log_file"
  set +e
  timeout "$DEPLOY_TIMEOUT" "$ROLLOUT_SCRIPT" deploy "$commit_sha" >>"$log_file" 2>&1
  deploy_code=$?
  set -e
  if [ "$deploy_code" -ne 0 ]; then
    warn "deploy failed for request ${request_id} (exit=${deploy_code}); attempting rollback"
    echo "\$ ${ROLLOUT_SCRIPT} rollback (timeout=${DEPLOY_TIMEOUT}s)" >>"$log_file"
    local rollback_code=0
    set +e
    timeout "$DEPLOY_TIMEOUT" "$ROLLOUT_SCRIPT" rollback >>"$log_file" 2>&1
    rollback_code=$?
    set -e
    finished_at="$(date -Iseconds)"
    if [ "$rollback_code" -ne 0 ]; then
      warn "rollback ALSO failed for request ${request_id} (exit=${rollback_code}); MANUAL INTERVENTION REQUIRED"
      finalize_request "failed" "$processing_file" "deploy failed (exit=${deploy_code}) AND rollback failed (exit=${rollback_code}); manual intervention required" "$log_file" "$finished_at"
      notify_event "rollback_failed" "$request_id" "$commit_sha" "deploy and rollback both failed"
    else
      finalize_request "failed" "$processing_file" "ha-rollout deploy failed (exit=${deploy_code}); rolled back successfully" "$log_file" "$finished_at"
      notify_event "deploy_failed" "$request_id" "$commit_sha" "ha-rollout deploy failed; rollback ok"
    fi
    return 0
  fi

  if [ "$finalize" = "true" ]; then
    finalize_code=0
    echo "\$ ${ROLLOUT_SCRIPT} finalize ${commit_sha} (timeout=${FINALIZE_TIMEOUT}s)" >>"$log_file"
    set +e
    timeout "$FINALIZE_TIMEOUT" "$ROLLOUT_SCRIPT" finalize "$commit_sha" >>"$log_file" 2>&1
    finalize_code=$?
    set -e
    if [ "$finalize_code" -ne 0 ]; then
      finished_at="$(date -Iseconds)"
      finalize_request "failed" "$processing_file" "ha-rollout finalize failed (exit=${finalize_code})" "$log_file" "$finished_at"
      notify_event "deploy_failed" "$request_id" "$commit_sha" "ha-rollout finalize failed"
      return 0
    fi
  fi

  push_message="publish skipped"
  if is_true "$PUSH_AFTER_DEPLOY"; then
    push_code=0
    set +e
    push_deployed_commit "$commit_sha" "$log_file"
    push_code=$?
    set -e
    if [ "$push_code" -eq 0 ]; then
      push_message="published to ${PUSH_REMOTE}/${PUSH_BRANCH}"
      notify_event "publish_success" "$request_id" "$commit_sha" "published to ${PUSH_REMOTE}/${PUSH_BRANCH}"
    else
      push_message="publish failed (${PUSH_REMOTE}/${PUSH_BRANCH}, exit=${push_code})"
      notify_event "publish_failed" "$request_id" "$commit_sha" "$push_message"
      if [ "$push_required" -eq 1 ]; then
        finished_at="$(date -Iseconds)"
        finalize_request "failed" "$processing_file" "deployment completed but ${push_message}" "$log_file" "$finished_at"
        notify_event "deploy_failed" "$request_id" "$commit_sha" "deployment completed but publish failed"
        return 0
      fi
    fi
  fi

  finished_at="$(date -Iseconds)"
  finalize_request "done" "$processing_file" "deployment completed; ${push_message}" "$log_file" "$finished_at"
  notify_event "deploy_success" "$request_id" "$commit_sha" "deployment completed"
  return 0
}

run_once() {
  ensure_dirs
  local file
  file="$(next_pending_file)"
  if [ -z "$file" ]; then
    return 1
  fi
  process_request_file "$file"
  return 0
}

run_daemon() {
  ensure_dirs
  acquire_lock
  trap release_lock EXIT
  log "deployer daemon started (poll=${POLL_INTERVAL}s queue=${QUEUE_ROOT})"
  while true; do
    if ! run_once; then
      sleep "$POLL_INTERVAL"
    fi
  done
}

run_status() {
  ensure_dirs
  echo "queue_root=${QUEUE_ROOT}"
  echo "pending=$(queue_count "$PENDING_DIR")"
  echo "processing=$(queue_count "$PROCESSING_DIR")"
  echo "done=$(queue_count "$DONE_DIR")"
  echo "failed=$(queue_count "$FAILED_DIR")"
  echo "logs=$(find "$LOG_DIR" -maxdepth 1 -type f | wc -l | tr -d ' ')"
  echo "push_after_deploy=${PUSH_AFTER_DEPLOY}"
  echo "push_remote=${PUSH_REMOTE}"
  echo "push_branch=${PUSH_BRANCH}"
  echo "push_required=${PUSH_REQUIRED}"
}

main() {
  local cmd="${1:-}"
  require_cmd git
  require_cmd docker
  require_cmd curl
  require_cmd jq
  require_cmd timeout
  [ -d "$CODE_DIR" ] || fail "missing CODE_DIR: ${CODE_DIR}"
  [ -x "$ROLLOUT_SCRIPT" ] || fail "missing executable rollout script: ${ROLLOUT_SCRIPT}"

  case "$cmd" in
    daemon)
      run_daemon
      ;;
    once)
      run_once || true
      ;;
    status)
      run_status
      ;;
    -h|--help|help|"")
      usage
      ;;
    *)
      usage
      fail "unknown command: $cmd"
      ;;
  esac
}

main "${1:-}"
