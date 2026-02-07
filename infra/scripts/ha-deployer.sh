#!/usr/bin/env bash
# Host-side deploy daemon.
# Watches for /data/nexus/deploy-trigger.json written by the ha_deploy tool
# inside a container, then runs ha-rollout.sh apply-local on the host.
#
# apply-local builds the standby with new code, health-checks it, switches
# traffic, then leaves the old active running. After the in-container agent
# acks the result (deploy-ack file), this daemon rebuilds the old active
# with the new code so both containers are up to date.
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
ACK_FILE="${STATE_DIR}/deploy-ack"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
ACK_TIMEOUT="${ACK_TIMEOUT:-120}"
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

  log "processing deploy: msg='${msg}' remote=${remote} branch=${branch}"

  # Clear any stale ack from a previous deploy
  rm -f "$ACK_FILE"

  if "$ROLLOUT_SCRIPT" apply-local "$msg" "$remote" "$branch"; then
    log "deploy succeeded — waiting for agent ack before rebuilding old primary"
    rm -f "$PROCESSING_FILE"

    # Wait for the in-container ha_deploy tool to write deploy-ack, confirming
    # it read the result and the coder session is done with this container.
    local waited=0
    while [ ! -f "$ACK_FILE" ] && [ "$waited" -lt "$ACK_TIMEOUT" ]; do
      sleep "$POLL_INTERVAL"
      waited=$((waited + POLL_INTERVAL))
    done
    rm -f "$ACK_FILE"

    if [ "$waited" -ge "$ACK_TIMEOUT" ]; then
      warn "ack timeout (${ACK_TIMEOUT}s) — rebuilding old primary anyway"
    else
      log "agent acked after ${waited}s"
    fi

    log "rebuilding old primary with new code"
    if "$ROLLOUT_SCRIPT" finalize; then
      log "old primary rebuilt successfully"
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
