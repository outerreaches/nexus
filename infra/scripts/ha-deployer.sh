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
FINALIZE_PENDING="${STATE_DIR}/finalize-pending"
ACK_FILE="${STATE_DIR}/deploy-ack"
STATE_FILE="${STATE_DIR}/deploy-state.env"
LOCK_DIR="${STATE_DIR}/ha-rollout.lock"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
ACK_TIMEOUT="${ACK_TIMEOUT:-600}"
PROCESSING_STALE_SEC="${PROCESSING_STALE_SEC:-900}"
ROLLOUT_SCRIPT="${SCRIPT_DIR}/ha-rollout.sh"

log() { echo "[ha-deployer] $(date -Iseconds) $*"; }
warn() { echo "[ha-deployer] $(date -Iseconds) WARN: $*" >&2; }

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
  [ -d "$LOCK_DIR" ] || return 1
  local owner_pid
  owner_pid="$(cat "${LOCK_DIR}/pid" 2>/dev/null || echo "")"
  [ -n "$owner_pid" ] || return 1
  kill -0 "$owner_pid" 2>/dev/null
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

ack_matches_trigger() {
  local expected_trigger="$1"
  [ -f "$ACK_FILE" ] || return 1
  [ -n "$expected_trigger" ] || return 0
  local got
  got="$(jq -r '.triggerId // empty' "$ACK_FILE" 2>/dev/null || true)"
  [ -n "$got" ] && [ "$got" = "$expected_trigger" ]
}

process_trigger() {
  local msg remote branch trigger_id
  local request_channel request_channel_key request_agent_id request_session_id request_run_id request_parent_run_id
  local expected_ack_run_id deployed_sha

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
  trigger_id="$(jq -r '.id // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  request_channel="$(jq -r '.request.channel // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  request_channel_key="$(jq -r '.request.channelKey // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  request_agent_id="$(jq -r '.request.agentId // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  request_session_id="$(jq -r '.request.sessionId // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  request_run_id="$(jq -r '.request.runId // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  request_parent_run_id="$(jq -r '.request.parentRunId // empty' "$PROCESSING_FILE" 2>/dev/null || true)"
  expected_ack_run_id="${request_parent_run_id:-$request_run_id}"

  [ -n "$msg" ] || msg="ha-rollout: apply local changes $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Clean up stale ack/pending from previous deploys
  rm -f "$ACK_FILE" "$FINALIZE_PENDING"

  log "processing deploy: id=${trigger_id:-unknown} msg='${msg}' remote=${remote} branch=${branch}"

  if "$ROLLOUT_SCRIPT" apply-local "$msg" "$remote" "$branch"; then
    log "deploy succeeded — waiting for orchestrator ack before rebuilding old primary"
    rm -f "$PROCESSING_FILE"

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
      --arg createdAt "$(date -Iseconds)" \
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
    local waited=0
    local acked=0
    while [ "$waited" -lt "$ACK_TIMEOUT" ]; do
      if [ -f "$ACK_FILE" ]; then
        if ack_matches_trigger "$trigger_id"; then
          acked=1
          break
        fi
        warn "ignoring deploy-ack that does not match trigger id=${trigger_id:-unknown}"
        rm -f "$ACK_FILE"
      fi
      sleep "$POLL_INTERVAL"
      waited=$((waited + POLL_INTERVAL))
    done
    rm -f "$ACK_FILE" "$FINALIZE_PENDING"

    if [ "$acked" -eq 1 ]; then
      log "orchestrator acked after ${waited}s"
    else
      warn "ack timeout (${ACK_TIMEOUT}s) — rebuilding old primary anyway"
    fi

    log "rebuilding old primary with new code (target=${deployed_sha:-HEAD})"
    if [ -n "$deployed_sha" ] && "$ROLLOUT_SCRIPT" finalize "$deployed_sha"; then
      log "old primary rebuilt successfully — both containers up to date"
    elif [ -z "$deployed_sha" ] && "$ROLLOUT_SCRIPT" finalize; then
      log "old primary rebuilt successfully — both containers up to date"
    else
      warn "old primary rebuild failed (non-fatal — new active is serving)"
    fi
  else
    warn "deploy failed (exit $?)"
    rm -f "$PROCESSING_FILE"
  fi
}

log "starting (poll_interval=${POLL_INTERVAL}s state_dir=${STATE_DIR})"

while true; do
  recover_stale_processing
  if [ -f "$TRIGGER_FILE" ]; then
    process_trigger
  fi
  sleep "$POLL_INTERVAL"
done
