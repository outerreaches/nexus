#!/usr/bin/env bash
# Host-side deploy daemon.
# Watches for /data/nexus/deploy-trigger.json written by the ha_deploy tool
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
STATE_DIR="${STATE_DIR:-/data/nexus}"
TRIGGER_FILE="${STATE_DIR}/deploy-trigger.json"
PROCESSING_FILE="${STATE_DIR}/deploy-trigger.processing.json"
FINALIZE_PENDING="${STATE_DIR}/finalize-pending"
ACK_FILE="${STATE_DIR}/deploy-ack"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
ACK_TIMEOUT="${ACK_TIMEOUT:-600}"
ROLLOUT_SCRIPT="${SCRIPT_DIR}/ha-rollout.sh"

log() { echo "[ha-deployer] $(date -Iseconds) $*"; }
warn() { echo "[ha-deployer] $(date -Iseconds) WARN: $*" >&2; }

require_cmd() { command -v "$1" >/dev/null 2>&1 || { warn "missing required command: $1"; exit 1; }; }

require_cmd jq
require_cmd git
require_cmd docker

[ -x "$ROLLOUT_SCRIPT" ] || { warn "rollout script not found or not executable: $ROLLOUT_SCRIPT"; exit 1; }

process_trigger() {
  local msg remote branch

  # Atomically claim the trigger
  if ! mv "$TRIGGER_FILE" "$PROCESSING_FILE" 2>/dev/null; then
    return 0  # Another process claimed it or it disappeared
  fi

  msg="$(jq -r '.commitMessage // empty' "$PROCESSING_FILE")"
  remote="$(jq -r '.remote // "host"' "$PROCESSING_FILE")"
  branch="$(jq -r '.branch // "main"' "$PROCESSING_FILE")"

  [ -n "$msg" ] || msg="ha-rollout: apply local changes $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Clean up stale ack/pending from previous deploys
  rm -f "$ACK_FILE" "$FINALIZE_PENDING"

  log "processing deploy: msg='${msg}' remote=${remote} branch=${branch}"

  if "$ROLLOUT_SCRIPT" apply-local "$msg" "$remote" "$branch"; then
    log "deploy succeeded — waiting for orchestrator ack before rebuilding old primary"
    rm -f "$PROCESSING_FILE"

    # Signal to the container that finalize is pending
    date -Iseconds > "$FINALIZE_PENDING"

    # Wait for the orchestrator to write deploy-ack after its full request
    # cycle completes (coder done + orchestrator sends reply).
    local waited=0
    while [ ! -f "$ACK_FILE" ] && [ "$waited" -lt "$ACK_TIMEOUT" ]; do
      sleep "$POLL_INTERVAL"
      waited=$((waited + POLL_INTERVAL))
    done
    rm -f "$ACK_FILE" "$FINALIZE_PENDING"

    if [ "$waited" -ge "$ACK_TIMEOUT" ]; then
      warn "ack timeout (${ACK_TIMEOUT}s) — rebuilding old primary anyway"
    else
      log "orchestrator acked after ${waited}s"
    fi

    log "rebuilding old primary with new code"
    if "$ROLLOUT_SCRIPT" finalize; then
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
  if [ -f "$TRIGGER_FILE" ]; then
    process_trigger
  fi
  sleep "$POLL_INTERVAL"
done
