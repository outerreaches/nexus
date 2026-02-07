#!/usr/bin/env bash
# Host-side code change worker for Nexus HA rollouts.
#
# Reads JSON change requests from:
#   /data/nexus/change-queue/pending/*.json
#
# Applies structured changes to /data/code, validates, then performs HA-safe rollout:
#   1) Build/recreate inactive slot (candidate)
#   2) Verify candidate health
#   3) Commit + push to target remote/branch
#   4) Promote candidate to active
#   5) Rebuild old active slot
#
# Usage:
#   change-worker.sh daemon
#   change-worker.sh once
#   change-worker.sh status

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_CODE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

CODE_DIR="${CODE_DIR:-${DEFAULT_CODE_DIR}}"
STATE_DIR="${STATE_DIR:-/data/nexus}"
QUEUE_ROOT="${QUEUE_ROOT:-${STATE_DIR}/change-queue}"
PENDING_DIR="${QUEUE_ROOT}/pending"
PROCESSING_DIR="${QUEUE_ROOT}/processing"
DONE_DIR="${QUEUE_ROOT}/done"
FAILED_DIR="${QUEUE_ROOT}/failed"
LOG_DIR="${QUEUE_ROOT}/logs"
LOCK_DIR="${STATE_DIR}/change-worker.lock"

COMPOSE_FILE="${COMPOSE_FILE:-${CODE_DIR}/infra/docker-compose.ha.yml}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-infra}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
API_URL="${API_URL:-http://localhost:18789}"
GIT_TIMEOUT="${GIT_TIMEOUT:-120}"
VALIDATE_TIMEOUT="${VALIDATE_TIMEOUT:-600}"
BUILD_TIMEOUT="${BUILD_TIMEOUT:-900}"
PUSH_TIMEOUT="${PUSH_TIMEOUT:-120}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
# Set to 1 to test apply/validate/candidate-boot without commit/push/promote.
CHANGE_WORKER_DRY_RUN="${CHANGE_WORKER_DRY_RUN:-0}"

log() {
  echo "[change-worker] $*"
}

warn() {
  echo "[change-worker] WARN: $*" >&2
}

fail() {
  echo "[change-worker] ERROR: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  change-worker.sh daemon
  change-worker.sh once
  change-worker.sh status
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

compose() {
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" "$@"
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

  local owner_pid
  owner_pid="$(cat "${LOCK_DIR}/pid" 2>/dev/null || echo "")"
  if [ -n "$owner_pid" ] && kill -0 "$owner_pid" 2>/dev/null; then
    fail "another change worker instance is already running (pid=${owner_pid}, lock: $LOCK_DIR)"
  fi

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
  local to_ref="$3"
  local reason="$4"

  local payload
  payload="$(jq -nc \
    --arg event "$event" \
    --arg reason "$reason" \
    --arg requestId "$request_id" \
    --arg to "$to_ref" \
    '{event:$event, from:"change-worker", to:$to, reason:$reason, details:{requestId:$requestId}}')"

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
  local commit_sha="$6"
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
    --arg commitSha "$commit_sha" \
    '. + {state:$state, finishedAt:$finishedAt, message:$message, logFile:$logFile, commitSha:$commitSha}' \
    "$processing_file" >"$tmp"

  dest_file="${dest_dir}/$(basename "$processing_file")"
  mv "$tmp" "$dest_file"
  rm -f "$processing_file"
  log "request finalized state=${state} file=${dest_file}"
}

validate_rel_path() {
  local rel="$1"
  [ -n "$rel" ] || return 1
  case "$rel" in
    /*) return 1 ;;
    *\\*) return 1 ;;
    *$'\r'*) return 1 ;;
    *$'\n'*) return 1 ;;
  esac
  local IFS='/'
  local parts=()
  read -r -a parts <<<"$rel"
  local part
  for part in "${parts[@]}"; do
    if [ "$part" = ".." ]; then
      return 1
    fi
  done
  return 0
}

apply_ops() {
  local request_file="$1"
  local log_file="$2"
  local format
  format="$(jq -r '.changeSet.format // "ops"' "$request_file")"

  if [ "$format" = "patch" ]; then
    local patch_tmp
    patch_tmp="$(mktemp)"
    jq -r '.changeSet.patch // empty' "$request_file" >"$patch_tmp"
    [ -s "$patch_tmp" ] || {
      rm -f "$patch_tmp"
      echo "changeSet.patch is empty" >>"$log_file"
      return 1
    }
    echo "\$ git -C ${CODE_DIR} apply ${patch_tmp}" >>"$log_file"
    if ! git -C "$CODE_DIR" apply "$patch_tmp" >>"$log_file" 2>&1; then
      rm -f "$patch_tmp"
      return 1
    fi
    rm -f "$patch_tmp"
    return 0
  fi

  local op_count
  op_count="$(jq '.changeSet.ops | length' "$request_file")"
  if [ "$op_count" -le 0 ]; then
    echo "changeSet.ops must be non-empty" >>"$log_file"
    return 1
  fi

  local i
  for ((i=0; i<op_count; i++)); do
    local op
    op="$(jq -r ".changeSet.ops[$i].op // empty" "$request_file")"
    local rel
    rel="$(jq -r ".changeSet.ops[$i].path // empty" "$request_file")"
    if ! validate_rel_path "$rel"; then
      echo "invalid path for op[$i]: $rel" >>"$log_file"
      return 1
    fi
    local full
    full="${CODE_DIR}/${rel}"
    case "$op" in
      write_file)
        local mode
        mode="$(jq -r ".changeSet.ops[$i].mode // \"overwrite\"" "$request_file")"
        mkdir -p "$(dirname "$full")"
        if [ "$mode" = "create" ] && [ -e "$full" ]; then
          echo "write_file(create) failed, exists: $rel" >>"$log_file"
          return 1
        fi
        jq -r ".changeSet.ops[$i].content" "$request_file" >"${full}.tmp-change-worker"
        mv "${full}.tmp-change-worker" "$full"
        ;;
      edit_text)
        local find_tmp replace_tmp replace_all
        find_tmp="$(mktemp)"
        replace_tmp="$(mktemp)"
        jq -r ".changeSet.ops[$i].find" "$request_file" >"$find_tmp"
        jq -r ".changeSet.ops[$i].replace" "$request_file" >"$replace_tmp"
        replace_all="$(jq -r ".changeSet.ops[$i].replaceAll // false" "$request_file")"
        if ! python3 - "$full" "$find_tmp" "$replace_tmp" "$replace_all" >>"$log_file" 2>&1 <<'PY'
import pathlib, sys
target = pathlib.Path(sys.argv[1])
find_text = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
replace_text = pathlib.Path(sys.argv[3]).read_text(encoding="utf-8")
replace_all = sys.argv[4].lower() in ("1", "true", "yes", "on")
text = target.read_text(encoding="utf-8")
count = text.count(find_text)
if count == 0:
    raise SystemExit("find text not found")
if not replace_all and count != 1:
    raise SystemExit(f"find text not unique ({count} matches)")
if replace_all:
    out = text.replace(find_text, replace_text)
else:
    out = text.replace(find_text, replace_text, 1)
target.write_text(out, encoding="utf-8")
PY
        then
          rm -f "$find_tmp" "$replace_tmp"
          return 1
        fi
        rm -f "$find_tmp" "$replace_tmp"
        ;;
      edit_lines)
        local start_line end_line content_tmp
        start_line="$(jq -r ".changeSet.ops[$i].startLine" "$request_file")"
        end_line="$(jq -r ".changeSet.ops[$i].endLine // empty" "$request_file")"
        content_tmp="$(mktemp)"
        jq -r ".changeSet.ops[$i].content" "$request_file" >"$content_tmp"
        if ! python3 - "$full" "$start_line" "$end_line" "$content_tmp" >>"$log_file" 2>&1 <<'PY'
import pathlib, sys
target = pathlib.Path(sys.argv[1])
start = int(sys.argv[2])
end_raw = sys.argv[3]
content = pathlib.Path(sys.argv[4]).read_text(encoding="utf-8")
text = target.read_text(encoding="utf-8")
newline = "\r\n" if "\r\n" in text else "\n"
raw = text.splitlines(keepends=False)
had_newline = text.endswith("\n")
end = int(end_raw) if end_raw else start
if start < 1 or end < start:
    raise SystemExit("invalid line range")
if end > len(raw):
    raise SystemExit(f"line range out of bounds (1-{len(raw)})")
start_idx = start - 1
end_idx = end - 1
replacement = [] if content == "" else content.splitlines()
raw[start_idx:end_idx+1] = replacement
out = newline.join(raw)
if had_newline:
    out += newline
target.write_text(out, encoding="utf-8")
PY
        then
          rm -f "$content_tmp"
          return 1
        fi
        rm -f "$content_tmp"
        ;;
      delete_file)
        rm -f "$full"
        ;;
      *)
        echo "unsupported op '$op' at index $i" >>"$log_file"
        return 1
        ;;
    esac
  done
  return 0
}

run_validations() {
  local request_file="$1"
  local log_file="$2"
  local cmd_count
  cmd_count="$(jq '.validate | length' "$request_file")"
  if [ "$cmd_count" -le 0 ]; then
    return 0
  fi
  local i
  for ((i=0; i<cmd_count; i++)); do
    local cmd
    cmd="$(jq -r ".validate[$i]" "$request_file")"
    [ -n "$cmd" ] || continue
    echo "\$ (validate) cd ${CODE_DIR} && ${cmd} (timeout=${VALIDATE_TIMEOUT}s)" >>"$log_file"
    if ! timeout "$VALIDATE_TIMEOUT" /bin/bash -lc "cd \"$CODE_DIR\" && ${cmd}" >>"$log_file" 2>&1; then
      return 1
    fi
  done
  return 0
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

determine_slots() {
  local primary_mode standby_mode
  primary_mode="$(service_mode nexus-primary)"
  standby_mode="$(service_mode nexus-standby)"
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

  if [ "$primary_mode" = "standby" ] && [ "$standby_mode" = "standby" ]; then
    warn "both slots report standby; attempting bootstrap activation on nexus-primary"
    service_post "nexus-primary" "/api/activate" >/dev/null 2>&1 || true
    sleep 2
    primary_mode="$(service_mode nexus-primary)"
    standby_mode="$(service_mode nexus-standby)"
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
  fi

  return 1
}

wait_for_service_ready() {
  local service="$1"
  local timeout="$2"
  local started now
  started="$(date +%s)"
  while true; do
    if compose exec -T "$service" sh -lc "curl -fsS --max-time 5 http://localhost:18789/health/ready" >/dev/null 2>&1; then
      return 0
    fi
    now="$(date +%s)"
    if [ $((now - started)) -ge "$timeout" ]; then
      return 1
    fi
    sleep 2
  done
}

rebuild_slot() {
  local service="$1"
  local log_file="$2"
  echo "\$ compose build ${service} (timeout=${BUILD_TIMEOUT}s)" >>"$log_file"
  timeout "$BUILD_TIMEOUT" compose build "$service" >>"$log_file" 2>&1
  echo "\$ compose up -d --no-deps --force-recreate ${service} (timeout=${BUILD_TIMEOUT}s)" >>"$log_file"
  timeout "$BUILD_TIMEOUT" compose up -d --no-deps --force-recreate "$service" >>"$log_file" 2>&1
}

service_post() {
  local service="$1"
  local path="$2"
  compose exec -T "$service" sh -lc "curl -fsS --max-time 10 -X POST http://localhost:18789${path}" >/dev/null
}

restore_slot_from_base() {
  local slot="$1"
  local base_sha="$2"
  local log_file="$3"
  warn "restoring slot ${slot} from base ${base_sha}"
  git -C "$CODE_DIR" reset --hard "$base_sha" >>"$log_file" 2>&1 || return 1
  rebuild_slot "$slot" "$log_file" || return 1
  wait_for_service_ready "$slot" "$HEALTH_TIMEOUT" || return 1
  return 0
}

process_request_file() {
  local pending_file="$1"
  local processing_file
  local request_id title base_sha auto_apply target_remote target_branch
  local started_at finished_at
  local log_file
  local current_sha commit_sha
  local dry_run
  local old_active old_inactive

  processing_file="${PROCESSING_DIR}/$(basename "$pending_file")"
  if ! mv "$pending_file" "$processing_file" 2>/dev/null; then
    return 0
  fi

  request_id="$(jq -r '.id // empty' "$processing_file")"
  title="$(jq -r '.title // "untitled"' "$processing_file")"
  base_sha="$(jq -r '.baseSha // empty' "$processing_file")"
  auto_apply="$(jq -r '.autoApply // true' "$processing_file")"
  target_remote="$(jq -r '.targetRemote // "host"' "$processing_file")"
  target_branch="$(jq -r '.targetBranch // "main"' "$processing_file")"
  started_at="$(date -Iseconds)"
  set_processing_state "$processing_file" "$started_at"

  if [ -z "$request_id" ] || [ -z "$base_sha" ]; then
    finished_at="$(date -Iseconds)"
    finalize_request "failed" "$processing_file" "invalid request payload: missing id or baseSha" "" "$finished_at" ""
    return 0
  fi

  log_file="${LOG_DIR}/${request_id}-$(date +%s).log"
  touch "$log_file"

  {
    echo "request_id=${request_id}"
    echo "title=${title}"
    echo "base_sha=${base_sha}"
    echo "started_at=${started_at}"
    echo "code_dir=${CODE_DIR}"
    echo "auto_apply=${auto_apply}"
    echo "target=${target_remote}/${target_branch}"
    echo
  } >>"$log_file"

  notify_event "change_started" "$request_id" "$base_sha" "change request ${request_id}"

  if ! is_true "$auto_apply"; then
    finished_at="$(date -Iseconds)"
    finalize_request "failed" "$processing_file" "autoApply=false is not supported by host worker" "$log_file" "$finished_at" ""
    notify_event "change_failed" "$request_id" "$base_sha" "autoApply disabled"
    return 0
  fi

  if [ -n "$(git -C "$CODE_DIR" status --porcelain)" ]; then
    finished_at="$(date -Iseconds)"
    finalize_request "failed" "$processing_file" "git working tree is dirty in ${CODE_DIR}" "$log_file" "$finished_at" ""
    notify_event "change_failed" "$request_id" "$base_sha" "git tree dirty"
    return 0
  fi

  if ! git -C "$CODE_DIR" cat-file -e "${base_sha}^{commit}" 2>/dev/null; then
    finished_at="$(date -Iseconds)"
    finalize_request "failed" "$processing_file" "baseSha not found in ${CODE_DIR}: ${base_sha}" "$log_file" "$finished_at" ""
    notify_event "change_failed" "$request_id" "$base_sha" "base sha missing"
    return 0
  fi

  current_sha="$(git -C "$CODE_DIR" rev-parse HEAD)"
  if [ "$current_sha" != "$base_sha" ]; then
    finished_at="$(date -Iseconds)"
    finalize_request "failed" "$processing_file" "stale baseSha: HEAD=${current_sha} request.baseSha=${base_sha}" "$log_file" "$finished_at" ""
    notify_event "change_failed" "$request_id" "$base_sha" "stale base sha"
    return 0
  fi

  if ! determine_slots; then
    finished_at="$(date -Iseconds)"
    finalize_request "failed" "$processing_file" "unable to determine active/inactive slots" "$log_file" "$finished_at" ""
    notify_event "change_failed" "$request_id" "$base_sha" "slot detection failed"
    return 0
  fi
  old_active="$ACTIVE_SLOT"
  old_inactive="$INACTIVE_SLOT"
  echo "active_slot=${old_active}" >>"$log_file"
  echo "inactive_slot=${old_inactive}" >>"$log_file"

  echo "# apply ops" >>"$log_file"
  if ! apply_ops "$processing_file" "$log_file"; then
    git -C "$CODE_DIR" reset --hard "$base_sha" >>"$log_file" 2>&1 || true
    finished_at="$(date -Iseconds)"
    finalize_request "failed" "$processing_file" "failed to apply changeSet ops" "$log_file" "$finished_at" ""
    notify_event "change_failed" "$request_id" "$base_sha" "apply failed"
    return 0
  fi

  echo "# validations" >>"$log_file"
  if ! run_validations "$processing_file" "$log_file"; then
    git -C "$CODE_DIR" reset --hard "$base_sha" >>"$log_file" 2>&1 || true
    finished_at="$(date -Iseconds)"
    finalize_request "failed" "$processing_file" "validation failed" "$log_file" "$finished_at" ""
    notify_event "change_failed" "$request_id" "$base_sha" "validation failed"
    return 0
  fi

  echo "# candidate boot (${old_inactive})" >>"$log_file"
  if ! rebuild_slot "$old_inactive" "$log_file" || ! wait_for_service_ready "$old_inactive" "$HEALTH_TIMEOUT"; then
    restore_slot_from_base "$old_inactive" "$base_sha" "$log_file" || true
    finished_at="$(date -Iseconds)"
    finalize_request "failed" "$processing_file" "candidate slot failed health checks" "$log_file" "$finished_at" ""
    notify_event "change_failed" "$request_id" "$base_sha" "candidate unhealthy"
    return 0
  fi

  dry_run=0
  if is_true "$CHANGE_WORKER_DRY_RUN"; then
    dry_run=1
  fi
  if [ "$dry_run" -eq 1 ]; then
    echo "# dry-run cleanup" >>"$log_file"
    git -C "$CODE_DIR" reset --hard "$base_sha" >>"$log_file" 2>&1 || true
    restore_slot_from_base "$old_inactive" "$base_sha" "$log_file" || true
    finished_at="$(date -Iseconds)"
    finalize_request "done" "$processing_file" "dry-run success: apply/validate/candidate boot passed (no commit/push/promote)" "$log_file" "$finished_at" ""
    notify_event "change_dry_run_success" "$request_id" "$base_sha" "dry-run passed"
    return 0
  fi

  echo "# commit + push" >>"$log_file"
  if [ -z "$(git -C "$CODE_DIR" status --porcelain)" ]; then
    restore_slot_from_base "$old_inactive" "$base_sha" "$log_file" || true
    finished_at="$(date -Iseconds)"
    finalize_request "failed" "$processing_file" "no repo changes after apply" "$log_file" "$finished_at" ""
    notify_event "change_failed" "$request_id" "$base_sha" "no changes"
    return 0
  fi

  git -C "$CODE_DIR" add -A >>"$log_file" 2>&1
  if ! timeout "$GIT_TIMEOUT" git -C "$CODE_DIR" commit -m "change-worker: ${title}" >>"$log_file" 2>&1; then
    git -C "$CODE_DIR" reset --hard "$base_sha" >>"$log_file" 2>&1 || true
    restore_slot_from_base "$old_inactive" "$base_sha" "$log_file" || true
    finished_at="$(date -Iseconds)"
    finalize_request "failed" "$processing_file" "commit failed" "$log_file" "$finished_at" ""
    notify_event "change_failed" "$request_id" "$base_sha" "commit failed"
    return 0
  fi
  commit_sha="$(git -C "$CODE_DIR" rev-parse HEAD)"

  if ! timeout "$PUSH_TIMEOUT" git -C "$CODE_DIR" push "$target_remote" "${commit_sha}:refs/heads/${target_branch}" >>"$log_file" 2>&1; then
    git -C "$CODE_DIR" reset --hard "$base_sha" >>"$log_file" 2>&1 || true
    restore_slot_from_base "$old_inactive" "$base_sha" "$log_file" || true
    finished_at="$(date -Iseconds)"
    finalize_request "failed" "$processing_file" "push failed to ${target_remote}/${target_branch}" "$log_file" "$finished_at" "$commit_sha"
    notify_event "change_failed" "$request_id" "$commit_sha" "push failed"
    return 0
  fi

  echo "# promote ${old_inactive} -> active" >>"$log_file"
  if ! service_post "$old_active" "/api/deactivate" >>"$log_file" 2>&1; then
    finished_at="$(date -Iseconds)"
    finalize_request "failed" "$processing_file" "failed to deactivate ${old_active}" "$log_file" "$finished_at" "$commit_sha"
    notify_event "change_failed" "$request_id" "$commit_sha" "deactivate failed"
    return 0
  fi
  if ! service_post "$old_inactive" "/api/activate" >>"$log_file" 2>&1; then
    service_post "$old_active" "/api/activate" >/dev/null 2>&1 || true
    finished_at="$(date -Iseconds)"
    finalize_request "failed" "$processing_file" "failed to activate ${old_inactive}" "$log_file" "$finished_at" "$commit_sha"
    notify_event "change_failed" "$request_id" "$commit_sha" "activate failed"
    return 0
  fi

  local promote_started now mode
  promote_started="$(date +%s)"
  while true; do
    mode="$(service_mode "$old_inactive")"
    if [ "$mode" = "active" ]; then
      break
    fi
    now="$(date +%s)"
    if [ $((now - promote_started)) -ge "$HEALTH_TIMEOUT" ]; then
      service_post "$old_active" "/api/activate" >/dev/null 2>&1 || true
      service_post "$old_inactive" "/api/deactivate" >/dev/null 2>&1 || true
      finished_at="$(date -Iseconds)"
      finalize_request "failed" "$processing_file" "promotion timed out" "$log_file" "$finished_at" "$commit_sha"
      notify_event "change_failed" "$request_id" "$commit_sha" "promotion timeout"
      return 0
    fi
    sleep 2
  done

  echo "# finalize old active slot (${old_active})" >>"$log_file"
  if ! rebuild_slot "$old_active" "$log_file" || ! wait_for_service_ready "$old_active" "$HEALTH_TIMEOUT"; then
    finished_at="$(date -Iseconds)"
    finalize_request "failed" "$processing_file" "new active is up, but finalize of ${old_active} failed" "$log_file" "$finished_at" "$commit_sha"
    notify_event "change_failed" "$request_id" "$commit_sha" "finalize failed"
    return 0
  fi

  finished_at="$(date -Iseconds)"
  finalize_request "done" "$processing_file" "change applied, deployed, promoted, and finalized" "$log_file" "$finished_at" "$commit_sha"
  notify_event "change_success" "$request_id" "$commit_sha" "change workflow completed"
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
  log "change worker daemon started (poll=${POLL_INTERVAL}s queue=${QUEUE_ROOT})"
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
  echo "dry_run=${CHANGE_WORKER_DRY_RUN}"
}

main() {
  local cmd="${1:-}"
  require_cmd git
  require_cmd docker
  require_cmd curl
  require_cmd jq
  require_cmd timeout
  require_cmd python3
  [ -d "$CODE_DIR" ] || fail "missing CODE_DIR: ${CODE_DIR}"
  [ -f "$COMPOSE_FILE" ] || fail "missing compose file: ${COMPOSE_FILE}"

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
