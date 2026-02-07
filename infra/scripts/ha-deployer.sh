#!/usr/bin/env bash
# Host-side deploy daemon.
# Watches for /data/nexus/deploy-trigger.json written by the ha_deploy tool
# inside a container, then runs ha-rollout.sh apply-local on the host.
#
# After apply-local succeeds (state file written, agent can read result),
# runs ha-rollout.sh finalize to rebuild the old active as standby.
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
POLL_INTERVAL="${POLL_INTERVAL:-5}"
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

  if "$ROLLOUT_SCRIPT" apply-local "$msg" "$remote" "$branch"; then
    log "deploy succeeded — rebuilding standby with new code"
    # apply-local wrote deploy-state.env. The agent inside the old active
    # container can now read the result. Rebuild the old active (now standby)
    # so it has the new code for failover readiness.
    if "$ROLLOUT_SCRIPT" finalize; then
      log "standby rebuilt successfully"
    else
      warn "standby rebuild failed (non-fatal — active is serving new code)"
    fi
  else
    warn "deploy failed (exit $?)"
  fi

  rm -f "$PROCESSING_FILE"
}

log "starting (poll_interval=${POLL_INTERVAL}s state_dir=${STATE_DIR})"

while true; do
  if [ -f "$TRIGGER_FILE" ]; then
    process_trigger
  fi
  sleep "$POLL_INTERVAL"
done
