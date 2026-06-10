#!/usr/bin/env bash
# Host-side deploy daemon.
# Watches for <state-dir>/deploy-trigger.json written by the ha_deploy tool
# inside a container, then runs ha-rollout.sh apply-local on the host.
#
# apply-local builds the standby with new code, health-checks it, switches
# traffic, then leaves the old active running with old code.
#
# After apply-local succeeds, this daemon writes a finalize-pending marker
# and waits for the in-container agent to write deploy-ack (signalling the
# orchestrator has finished its full request cycle). Then it runs finalize
# to rebuild the old active with new code so both containers are up to date.
#
# Run as systemd service (see infra/systemd/ha-deployer.service) or manually:
#   ./infra/scripts/ha-deployer.sh
#
# Requires: jq, git, docker

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "${NEXUS_HOME:-}" ]; then
  DEFAULT_STATE_DIR="${NEXUS_HOME}/state"
elif [ -d "/data/nexus" ]; then
  DEFAULT_STATE_DIR="/data/nexus"
else
  DEFAULT_STATE_DIR="${HOME}/.nexus/state"
fi

STATE_DIR="${STATE_DIR:-${NEXUS_STATE_DIR:-${DEFAULT_STATE_DIR}}}"
TRIGGER_FILE="${STATE_DIR}/deploy-trigger.json"
PROCESSING_FILE="${STATE_DIR}/deploy-trigger.processing.json"
COMPLETIONS_DIR="${STATE_DIR}/deploy-completions"
FINALIZE_PENDING="${STATE_DIR}/finalize-pending"
ACK_DIR="${STATE_DIR}/deploy-acks"
STATE_FILE="${STATE_DIR}/deploy-state.env"
LOCK_DIR="${STATE_DIR}/ha-rollout.lock"
DAEMON_LOCK_DIR="${STATE_DIR}/ha-deployer.instance.lock"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
ACK_TIMEOUT="${ACK_TIMEOUT:-600}"
PROCESSING_STALE_SEC="${PROCESSING_STALE_SEC:-900}"
ROLLOUT_SCRIPT="${SCRIPT_DIR}/ha-rollout.sh"

iso_timestamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[ha-deployer] $(iso_timestamp) $*"; }
warn() { echo "[ha-deployer] $(iso_timestamp) WARN: $*" >&2; }

sanitize_state_value() {
  printf '%s' "${1:-}" | tr '\r\n' ' ' | sed -E 's/[[:space:]]+/ /g'
}

require_cmd() { command -v "$1" >/dev/null 2>&1 || { warn "missing required command: $1"; exit 1; }; }

require_cmd jq
require_cmd git
require_cmd docker

[ -x "$ROLLOUT_SCRIPT" ] || { warn "rollout script not found or not executable: $ROLLOUT_SCRIPT"; exit 1; }

file_age_seconds() {
  local target="$1"
  [ -e "$target" ] || { echo 0; return 0; }
  local now mtime
  now="$(date +%s)"
  if mtime="$(stat -c %Y "$target" 2>/dev/null)"; then
    :
  elif mtime="$(stat -f %m "$target" 2>/dev/null)"; then
    :
  else
    echo 0
    return 0
  fi
  echo $((now - mtime))
}

lock_is_active() {
  local dir="${1:-$LOCK_DIR}"
  [ -d "$dir" ] || return 1
  local owner_pid
  owner_pid="$(cat "${dir}/pid" 2>/dev/null || echo "")"
  [ -n "$owner_pid" ] || return 1
  kill -0 "$owner_pid" 2>/dev/null
}

release_daemon_lock() {
  if [ -d "$DAEMON_LOCK_DIR" ]; then
    local owner_pid
    owner_pid="$(cat "${DAEMON_LOCK_DIR}/pid" 2>/dev/null || echo "")"
    if [ -z "$owner_pid" ] || [ "$owner_pid" = "$$" ]; then
      rm -rf "$DAEMON_LOCK_DIR" 2>/dev/null || true
    fi
  fi
}

acquire_daemon_lock() {
  local attempts=0
  while ! mkdir "$DAEMON_LOCK_DIR" 2>/dev/null; do
    if lock_is_active "$DAEMON_LOCK_DIR"; then
      local owner_pid
      owner_pid="$(cat "${DAEMON_LOCK_DIR}/pid" 2>/dev/null || echo unknown)"
      warn "another ha-deployer instance is already running for ${STATE_DIR} (pid=${owner_pid})"
      return 1
    fi
    attempts=$((attempts + 1))
    if [ "$attempts" -gt 3 ]; then
      warn "unable to recover stale daemon lock at ${DAEMON_LOCK_DIR}"
      return 1
    fi
    warn "recovering stale daemon lock at ${DAEMON_LOCK_DIR}"
    rm -rf "$DAEMON_LOCK_DIR" 2>/dev/null || true
    sleep 1
  done

  printf '%s\n' "$$" > "${DAEMON_LOCK_DIR}/pid"
  trap release_daemon_lock EXIT INT TERM
  return 0
}

recover_stale_processing() {
  [ -f "$PROCESSING_FILE" ] || return 0
  [ -f "$TRIGGER_FILE" ] && return 0
  if lock_is_active; then
    return 0
  fi
  local age
  age="$(file_age_seconds "$PROCESSING_FILE")"
  if [ "$age" -lt "$PROCESSING_STALE_SEC" ]; then
    return 0
  fi
  warn "found stale processing trigger (${age}s old); re-queueing deploy trigger"
  if mv "$PROCESSING_FILE" "$TRIGGER_FILE" 2>/dev/null; then
    log "stale processing trigger moved back to pending queue"
  fi
}

read_last_deploy_sha() {
  [ -f "$STATE_FILE" ] || return 0
  awk -F= '/^LAST_DEPLOY_SHA=/{print $2}' "$STATE_FILE" | tail -n 1
}

read_state_value() {
  local key="$1"
  [ -f "$STATE_FILE" ] || return 0
  awk -F= -v key="$key" '$1 == key {print substr($0, length(key) + 2)}' "$STATE_FILE" | tail -n 1
}

extract_last_nonempty_line() {
  local file="$1"
  [ -f "$file" ] || return 0
  awk 'NF { line = $0 } END { print line }' "$file"
}

write_failure_state() {
  local status="$1"
  local reason="$2"
  local last_good_sha last_deploy_sha last_active_slot last_effective_sha last_trigger_id
  last_good_sha="$(read_state_value "LAST_GOOD_SHA")"
  last_deploy_sha="$(read_state_value "LAST_DEPLOY_SHA")"
  last_active_slot="$(read_state_value "LAST_ACTIVE_SLOT")"
  last_effective_sha="$(read_state_value "LAST_EFFECTIVE_SHA")"
  last_trigger_id="$(read_state_value "LAST_TRIGGER_ID")"
  [ -n "$last_effective_sha" ] || last_effective_sha="${last_good_sha}"
  [ -n "$last_trigger_id" ] || last_trigger_id="${NEXUS_DEPLOY_TRIGGER_ID:-}"

  local state_tmp="${STATE_FILE}.tmp.$$"
  cat >"$state_tmp" <<EOF
LAST_GOOD_SHA=${last_good_sha}
LAST_DEPLOY_SHA=${last_deploy_sha}
LAST_STATUS=${status}
LAST_ACTIVE_SLOT=${last_active_slot}
LAST_UPDATED_AT=$(date +%s)
LAST_DEPLOY_PID=
LAST_EFFECTIVE_SHA=$(sanitize_state_value "${last_effective_sha}")
LAST_FAILURE_REASON=$(sanitize_state_value "${reason}")
LAST_TRIGGER_ID=$(sanitize_state_value "${last_trigger_id}")
EOF
  mv "$state_tmp" "$STATE_FILE"
}

write_finalize_state() {
  local finalize_status="$1"
  local deployed_sha="$2"
  local failure_reason="$3"
  local trigger_id="$4"
  local state_tmp="${STATE_FILE}.tmp.$$"
  cat >"$state_tmp" <<EOF
LAST_GOOD_SHA=${deployed_sha}
LAST_DEPLOY_SHA=${deployed_sha}
LAST_STATUS=${finalize_status}
LAST_ACTIVE_SLOT=$(sanitize_state_value "$(read_state_value "LAST_ACTIVE_SLOT")")
LAST_UPDATED_AT=$(date +%s)
LAST_DEPLOY_PID=
LAST_EFFECTIVE_SHA=$(sanitize_state_value "${deployed_sha}")
LAST_FAILURE_REASON=$(sanitize_state_value "${failure_reason}")
LAST_TRIGGER_ID=$(sanitize_state_value "${trigger_id}")
EOF
  mv "$state_tmp" "$STATE_FILE"
}

write_completion_artifact() {
  local action="$1"
  local status="$2"
  local trigger_id="$3"
  local approval_id="$4"
  local candidate_id="$5"
  local request_channel="$6"
  local request_channel_key="$7"
  local request_agent_id="$8"
  local request_home_agent_id="$9"
  local request_session_id="${10}"
  local request_run_id="${11}"
  local request_parent_run_id="${12}"
  local effective_sha="${13}"
  local last_good_sha="${14}"
  local failure_reason="${15}"
  local created_at completion_id final_file tmp_file

  mkdir -p "$COMPLETIONS_DIR"
  created_at="$(iso_timestamp)"
  completion_id="DC$(date +%s)-$$-$RANDOM"
  final_file="${COMPLETIONS_DIR}/${completion_id}.json"
  tmp_file="${final_file}.tmp"

  jq -n \
    --arg id "$completion_id" \
    --arg action "$action" \
    --arg status "$status" \
    --arg triggerId "$trigger_id" \
    --arg approvalId "$approval_id" \
    --arg candidateId "$candidate_id" \
    --arg effectiveSha "$effective_sha" \
    --arg lastGoodSha "$last_good_sha" \
    --arg failureReason "$failure_reason" \
    --arg createdAt "$created_at" \
    --arg channel "$request_channel" \
    --arg channelKey "$request_channel_key" \
    --arg agentId "$request_agent_id" \
    --arg homeAgentId "$request_home_agent_id" \
    --arg sessionId "$request_session_id" \
    --arg runId "$request_run_id" \
    --arg parentRunId "$request_parent_run_id" \
    '{
      id: $id,
      action: $action,
      status: $status,
      triggerId: (if $triggerId == "" then null else $triggerId end),
      approvalId: (if $approvalId == "" then null else $approvalId end),
      candidateId: (if $candidateId == "" then null else $candidateId end),
      effectiveSha: (if $effectiveSha == "" then null else $effectiveSha end),
      lastGoodSha: (if $lastGoodSha == "" then null else $lastGoodSha end),
      failureReason: (if $failureReason == "" then null else $failureReason end),
      createdAt: $createdAt,
      request: {
        channel: (if $channel == "" then null else $channel end),
        channelKey: (if $channelKey == "" then null else $channelKey end),
        agentId: (if $agentId == "" then null else $agentId end),
        homeAgentId: (if $homeAgentId == "" then null else $homeAgentId end),
        sessionId: (if $sessionId == "" then null else $sessionId end),
        runId: (if $runId == "" then null else $runId end),
        parentRunId: (if $parentRunId == "" then null else $parentRunId end)
      }
    }' > "$tmp_file"
  mv "$tmp_file" "$final_file"
  log "wrote deploy completion artifact ${final_file}"
}

ack_file_path() {
  local trigger_id="$1"
  local safe_trigger="${trigger_id:-legacy}"
  printf '%s/%s.json' "$ACK_DIR" "$safe_trigger"
}

process_trigger() {
  local action msg remote branch trigger_id source_code_dir source_base_sha target_ref
  local request_channel request_channel_key request_agent_id request_home_agent_id request_session_id request_run_id request_parent_run_id
  local approval_id candidate_id
  local expected_ack_run_id deployed_sha rollout_log apply_status state_before_updated state_after_updated state_after_status failure_reason
  local ack_file waited acked ack_timeout_reason finalize_log finalize_status finalize_reason

  # Atomically claim the trigger
  if ! mv "$TRIGGER_FILE" "$PROCESSING_FILE" 2>/dev/null; then
    return 0  # Another process claimed it or it disappeared
  fi

  if ! msg="$(jq -r '.commitMessage // empty' "$PROCESSING_FILE" 2>/dev/null)"; then
    warn "invalid trigger payload (not JSON); dropping ${PROCESSING_FILE}"
    rm -f "$PROCESSING_FILE"
    return 0
  fi
  remote="$(jq -r '.remote // "host"' "$PROCESSING_FILE" 2>/dev/null || echo "host")"
  branch="$(jq -r '.branch // "main"' "$PROCESSING_FILE" 2>/dev/null || echo "main")"
  action="$(jq -r '.action // "apply"' "$PROCESSING_FILE" 2>/dev/null || echo "apply")"
  trigger_id="$(jq -r '.id // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  source_code_dir="$(jq -r '.sourceCodeDir // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  source_base_sha="$(jq -r '.sourceBaseSha // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  target_ref="$(jq -r '.targetRef // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  approval_id="$(jq -r '.approvalId // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  candidate_id="$(jq -r '.candidateId // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  request_channel="$(jq -r '.request.channel // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  request_channel_key="$(jq -r '.request.channelKey // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  request_agent_id="$(jq -r '.request.agentId // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  request_home_agent_id="$(jq -r '.request.homeAgentId // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  request_session_id="$(jq -r '.request.sessionId // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  request_run_id="$(jq -r '.request.runId // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  request_parent_run_id="$(jq -r '.request.parentRunId // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  expected_ack_run_id="${request_parent_run_id:-$request_run_id}"

  [ -n "$msg" ] || msg="ha-rollout: apply local changes $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  ack_file="$(ack_file_path "$trigger_id")"
  mkdir -p "$ACK_DIR"

  # Clean up stale ack/pending from previous deploys
  rm -f "$ack_file" "$FINALIZE_PENDING"

  log "processing ${action}: id=${trigger_id:-unknown} msg='${msg}' remote=${remote} branch=${branch} source=${source_code_dir:-default} target_ref=${target_ref:-default}"
  write_completion_artifact \
    "$action" \
    "started" \
    "$trigger_id" \
    "$approval_id" \
    "$candidate_id" \
    "$request_channel" \
    "$request_channel_key" \
    "$request_agent_id" \
    "$request_home_agent_id" \
    "$request_session_id" \
    "$request_run_id" \
    "$request_parent_run_id" \
    "" \
    "$(read_state_value "LAST_GOOD_SHA")" \
    ""
  state_before_updated="$(read_state_value "LAST_UPDATED_AT")"
  rollout_log="$(mktemp "${STATE_DIR}/ha-deployer-apply-local.XXXXXX.log")"

  if {
    if [ "$action" = "rollback" ]; then
      if [ -n "$target_ref" ]; then
        NEXUS_DEPLOY_TRIGGER_ID="$trigger_id" \
          "$ROLLOUT_SCRIPT" rollback "$target_ref" 2>&1 | tee "$rollout_log"
      else
        NEXUS_DEPLOY_TRIGGER_ID="$trigger_id" \
          "$ROLLOUT_SCRIPT" rollback 2>&1 | tee "$rollout_log"
      fi
    else
      NEXUS_DEPLOY_TRIGGER_ID="$trigger_id" \
        "$ROLLOUT_SCRIPT" apply-local "$msg" "$remote" "$branch" "$source_code_dir" "$source_base_sha" 2>&1 | tee "$rollout_log"
    fi
  }; then
    if [ "$action" = "rollback" ]; then
      write_completion_artifact \
        "$action" \
        "$(read_state_value "LAST_STATUS")" \
        "$trigger_id" \
        "$approval_id" \
        "$candidate_id" \
        "$request_channel" \
        "$request_channel_key" \
        "$request_agent_id" \
        "$request_home_agent_id" \
        "$request_session_id" \
        "$request_run_id" \
        "$request_parent_run_id" \
        "$(read_state_value "LAST_EFFECTIVE_SHA")" \
        "$(read_state_value "LAST_GOOD_SHA")" \
        "$(read_state_value "LAST_FAILURE_REASON")"
      log "rollback succeeded"
      rm -f "$PROCESSING_FILE"
      rm -f "$rollout_log"
      return 0
    fi
    write_completion_artifact \
      "$action" \
      "$(read_state_value "LAST_STATUS")" \
      "$trigger_id" \
      "$approval_id" \
      "$candidate_id" \
      "$request_channel" \
      "$request_channel_key" \
      "$request_agent_id" \
      "$request_home_agent_id" \
      "$request_session_id" \
      "$request_run_id" \
      "$request_parent_run_id" \
      "$(read_state_value "LAST_EFFECTIVE_SHA")" \
      "$(read_state_value "LAST_GOOD_SHA")" \
      "$(read_state_value "LAST_FAILURE_REASON")"
    log "deploy succeeded — waiting for orchestrator ack before rebuilding old primary"
    rm -f "$PROCESSING_FILE"
    rm -f "$rollout_log"

    deployed_sha="$(read_last_deploy_sha)"
    if [ -z "$deployed_sha" ]; then
      warn "could not read LAST_DEPLOY_SHA from ${STATE_FILE}; finalize will default to HEAD"
    fi

    # Signal to the container that finalize is pending
    local pending_tmp="${FINALIZE_PENDING}.tmp.$$"
    jq -n \
      --arg triggerId "${trigger_id}" \
      --arg expectedSha "${deployed_sha}" \
      --arg expectedAckRunId "${expected_ack_run_id}" \
      --arg channel "${request_channel}" \
      --arg channelKey "${request_channel_key}" \
      --arg agentId "${request_agent_id}" \
      --arg sessionId "${request_session_id}" \
      --arg runId "${request_run_id}" \
      --arg parentRunId "${request_parent_run_id}" \
      --arg createdAt "$(iso_timestamp)" \
      '{
        triggerId: (if $triggerId == "" then null else $triggerId end),
        expectedSha: (if $expectedSha == "" then null else $expectedSha end),
        expectedAckRunId: (if $expectedAckRunId == "" then null else $expectedAckRunId end),
        createdAt: $createdAt,
        request: {
          channel: (if $channel == "" then null else $channel end),
          channelKey: (if $channelKey == "" then null else $channelKey end),
          agentId: (if $agentId == "" then null else $agentId end),
          sessionId: (if $sessionId == "" then null else $sessionId end),
          runId: (if $runId == "" then null else $runId end),
          parentRunId: (if $parentRunId == "" then null else $parentRunId end)
        }
      }' > "$pending_tmp"
    mv "$pending_tmp" "$FINALIZE_PENDING"

    # Wait for the orchestrator to write deploy-ack after its full request
    # cycle completes (coder done + orchestrator sends reply).
    waited=0
    acked=0
    while [ "$waited" -lt "$ACK_TIMEOUT" ]; do
      if [ -f "$ack_file" ]; then
        acked=1
        break
      fi
      sleep "$POLL_INTERVAL"
      waited=$((waited + POLL_INTERVAL))
    done
    # One final check: ack may have arrived during the last sleep interval
    if [ "$acked" -eq 0 ] && [ -f "$ack_file" ]; then
      acked=1
    fi
    rm -f "$ack_file" "$FINALIZE_PENDING"

    if [ "$acked" -eq 1 ]; then
      log "orchestrator acked after ${waited}s"
      ack_timeout_reason=""
    else
      warn "ack timeout (${ACK_TIMEOUT}s) — rebuilding old primary anyway"
      ack_timeout_reason="finalize proceeded after ack timeout (${ACK_TIMEOUT}s)"
    fi

    log "rebuilding old primary with new code (target=${deployed_sha:-HEAD})"
    finalize_log="$(mktemp "${STATE_DIR}/ha-deployer-finalize.XXXXXX.log")"
    if {
      if [ -n "$deployed_sha" ]; then
        "$ROLLOUT_SCRIPT" finalize "$deployed_sha" 2>&1 | tee "$finalize_log"
      else
        "$ROLLOUT_SCRIPT" finalize 2>&1 | tee "$finalize_log"
      fi
    }; then
      finalize_status="finalized"
      finalize_reason=""
      if [ "$acked" != "1" ]; then
        finalize_status="finalized_without_ack"
        finalize_reason="$ack_timeout_reason"
      fi
      write_finalize_state "$finalize_status" "$deployed_sha" "$finalize_reason" "$trigger_id"
      write_completion_artifact \
        "$action" \
        "$finalize_status" \
        "$trigger_id" \
        "$approval_id" \
        "$candidate_id" \
        "$request_channel" \
        "$request_channel_key" \
        "$request_agent_id" \
        "$request_home_agent_id" \
        "$request_session_id" \
        "$request_run_id" \
        "$request_parent_run_id" \
        "$deployed_sha" \
        "$deployed_sha" \
        "$finalize_reason"
      log "old primary rebuilt successfully — both containers up to date"
    else
      tail -n 5 "$finalize_log" 2>/dev/null | while IFS= read -r _line; do warn "finalize log: ${_line}"; done
      failure_reason="$(extract_last_nonempty_line "$finalize_log")"
      [ -n "$failure_reason" ] || failure_reason="finalize failed rebuilding old primary"
      finalize_status="finalize_failed"
      if [ "$acked" != "1" ]; then
        finalize_status="finalize_failed_without_ack"
        failure_reason="${failure_reason}; ${ack_timeout_reason}"
      fi
      write_finalize_state "$finalize_status" "$deployed_sha" "$failure_reason" "$trigger_id"
      write_completion_artifact \
        "$action" \
        "$finalize_status" \
        "$trigger_id" \
        "$approval_id" \
        "$candidate_id" \
        "$request_channel" \
        "$request_channel_key" \
        "$request_agent_id" \
        "$request_home_agent_id" \
        "$request_session_id" \
        "$request_run_id" \
        "$request_parent_run_id" \
        "$deployed_sha" \
        "$deployed_sha" \
        "$failure_reason"
      warn "old primary rebuild failed (new active is still serving): ${failure_reason}"
    fi
    rm -f "$finalize_log"
  else
    apply_status=$?
    state_after_updated="$(read_state_value "LAST_UPDATED_AT")"
    state_after_status="$(read_state_value "LAST_STATUS")"
    tail -n 5 "$rollout_log" 2>/dev/null | while IFS= read -r _line; do warn "rollout log: ${_line}"; done
    failure_reason="$(extract_last_nonempty_line "$rollout_log")"
    if [ -z "$failure_reason" ]; then
      if [ "$action" = "rollback" ]; then
        failure_reason="rollback exited with status ${apply_status}"
      else
        failure_reason="apply-local exited with status ${apply_status}"
      fi
    fi
    if [ "$action" = "rollback" ]; then
      if [ "$state_after_updated" = "$state_before_updated" ] || [ -z "$state_after_status" ] || [ "$state_after_status" = "rolling_back" ]; then
        write_failure_state "rollback_failed" "$failure_reason"
      fi
      write_completion_artifact \
        "$action" \
        "$(read_state_value "LAST_STATUS")" \
        "$trigger_id" \
        "$approval_id" \
        "$candidate_id" \
        "$request_channel" \
        "$request_channel_key" \
        "$request_agent_id" \
        "$request_home_agent_id" \
        "$request_session_id" \
        "$request_run_id" \
        "$request_parent_run_id" \
        "$(read_state_value "LAST_EFFECTIVE_SHA")" \
        "$(read_state_value "LAST_GOOD_SHA")" \
        "$failure_reason"
      warn "rollback failed (exit ${apply_status}): ${failure_reason}"
    else
      if [ "$state_after_updated" = "$state_before_updated" ] || [ -z "$state_after_status" ] || [ "$state_after_status" = "applying_local" ]; then
        write_failure_state "apply_local_failed" "$failure_reason"
      fi
      write_completion_artifact \
        "$action" \
        "$(read_state_value "LAST_STATUS")" \
        "$trigger_id" \
        "$approval_id" \
        "$candidate_id" \
        "$request_channel" \
        "$request_channel_key" \
        "$request_agent_id" \
        "$request_home_agent_id" \
        "$request_session_id" \
        "$request_run_id" \
        "$request_parent_run_id" \
        "$(read_state_value "LAST_EFFECTIVE_SHA")" \
        "$(read_state_value "LAST_GOOD_SHA")" \
        "$failure_reason"
      warn "deploy failed (exit ${apply_status}): ${failure_reason}"
    fi
    rm -f "$PROCESSING_FILE"
    rm -f "$rollout_log"
  fi
}

if ! acquire_daemon_lock; then
  exit 1
fi

log "starting (poll_interval=${POLL_INTERVAL}s state_dir=${STATE_DIR})"

while true; do
  recover_stale_processing
  if [ -f "$TRIGGER_FILE" ]; then
    process_trigger
  fi
  sleep "$POLL_INTERVAL"
done
