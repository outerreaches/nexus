#!/bin/sh
# Nexus Watchdog - monitors primary and triggers failover to standby
#
# Environment variables:
#   PRIMARY_URL        - Primary Nexus URL (default: http://nexus-primary:18789)
#   STANDBY_URL        - Standby Nexus URL (default: http://nexus-standby:18789)
#   CHECK_INTERVAL     - Seconds between health checks (default: 5)
#   FAILURE_THRESHOLD  - Consecutive failures before failover (default: 3)
#   RECOVERY_DELAY     - Seconds to wait after failover before checking again (default: 30)
#   DEACTIVATE_TIMEOUT - Seconds to wait for graceful deactivation (default: 5)
#   ENABLE_FAILBACK    - Enable automatic failback to original primary (default: false)
#   FAILBACK_THRESHOLD - Consecutive healthy checks before failback (default: 3)
#   NEXUS_HA_API_KEY   - Bearer token for /api/* control-plane calls
#                        (defaults to NEXUS_HTTP_API_KEY)

set -e

PRIMARY_URL="${PRIMARY_URL:-http://nexus-primary:18789}"
STANDBY_URL="${STANDBY_URL:-http://nexus-standby:18789}"
CHECK_INTERVAL="${CHECK_INTERVAL:-5}"
FAILURE_THRESHOLD="${FAILURE_THRESHOLD:-3}"
RECOVERY_DELAY="${RECOVERY_DELAY:-30}"
DEACTIVATE_TIMEOUT="${DEACTIVATE_TIMEOUT:-5}"
ENABLE_FAILBACK="${ENABLE_FAILBACK:-false}"
FAILBACK_THRESHOLD="${FAILBACK_THRESHOLD:-3}"
CONTROL_PLANE_API_KEY="${NEXUS_HA_API_KEY:-${NEXUS_HTTP_API_KEY:-}}"

consecutive_failures=0
current_primary="$PRIMARY_URL"
current_standby="$STANDBY_URL"
original_primary="$PRIMARY_URL"
failback_healthy_count=0

log() {
  echo "[watchdog] $(date -Iseconds) $1"
}

curl_with_auth() {
  if [ -n "$CONTROL_PLANE_API_KEY" ]; then
    curl -H "authorization: Bearer ${CONTROL_PLANE_API_KEY}" "$@"
  else
    curl "$@"
  fi
}

check_live() {
  url="$1"
  if curl_with_auth -sf --max-time 5 "${url}/health/live" > /dev/null 2>&1; then
    return 0
  fi
  return 1
}

check_traffic() {
  url="$1"
  if curl_with_auth -sf --max-time 5 "${url}/health/traffic" > /dev/null 2>&1; then
    return 0
  fi
  return 1
}

wait_for_active_mode() {
  url="$1"
  attempts="${2:-10}"
  i=0
  while [ "$i" -lt "$attempts" ]; do
    i=$((i + 1))
    mode_response=$(curl_with_auth -sf --max-time 5 "${url}/api/mode" 2>&1) || mode_response=""
    case "$mode_response" in
      *'"mode":"active"'*)
        return 0
        ;;
    esac
    sleep 2
  done
  return 1
}

deactivate_primary() {
  url="$1"
  log "Attempting graceful deactivation of ${url}"
  response=$(curl_with_auth -sf --max-time "$DEACTIVATE_TIMEOUT" -X POST "${url}/api/deactivate" 2>&1) || {
    log "WARN: Failed to deactivate primary (may be down): $response"
    return 1
  }
  log "Primary deactivated: $response"
  return 0
}

activate_standby() {
  url="$1"
  log "Activating standby at ${url}"
  response=$(curl_with_auth -sf --max-time 10 -X POST "${url}/api/activate" 2>&1) || {
    log "ERROR: Failed to activate standby: $response"
    return 1
  }
  log "Standby activated: $response"
  return 0
}

notify_ha_event() {
  url="$1"
  event="$2"
  from="$3"
  to="$4"
  reason="$5"

  log "Notifying HA event: $event"
  curl_with_auth -sf --max-time 5 -X POST "${url}/api/ha/event" \
    -H "Content-Type: application/json" \
    -d "{\"event\":\"$event\",\"from\":\"$from\",\"to\":\"$to\",\"reason\":\"$reason\"}" \
    > /dev/null 2>&1 || log "WARN: Failed to notify HA event"
}

DEPLOY_LOCK_DIR="${DEPLOY_LOCK_DIR:-/data/nexus/ha-rollout.lock}"
DEPLOY_LOCK_STALE_SECONDS="${DEPLOY_LOCK_STALE_SECONDS:-1800}"

normalize_positive_int() {
  value="$1"
  fallback="$2"
  case "$value" in
    ''|*[!0-9]*) echo "$fallback" ;;
    *) echo "$value" ;;
  esac
}

DEPLOY_LOCK_STALE_SECONDS="$(normalize_positive_int "$DEPLOY_LOCK_STALE_SECONDS" 1800)"

check_deploy_in_progress() {
  if [ ! -d "$DEPLOY_LOCK_DIR" ]; then
    return 1  # no deploy running
  fi

  # Important: ha-rollout runs on the host, while watchdog runs in a container.
  # Host PID checks are not reliable across PID namespaces, so lock directory
  # presence is the primary signal.
  lock_mtime="$(stat -c %Y "$DEPLOY_LOCK_DIR" 2>/dev/null || echo "")"
  now_ts="$(date +%s)"
  if [ -z "$lock_mtime" ]; then
    return 0
  fi
  case "$lock_mtime" in
    ''|*[!0-9]*) return 0 ;;
  esac
  lock_age=$((now_ts - lock_mtime))
  if [ "$lock_age" -lt 0 ]; then
    lock_age=0
  fi
  if [ "$lock_age" -le "$DEPLOY_LOCK_STALE_SECONDS" ]; then
    return 0  # deploy likely in progress
  fi

  owner_pid="$(cat "${DEPLOY_LOCK_DIR}/pid" 2>/dev/null || echo "")"
  if [ -n "$owner_pid" ] && kill -0 "$owner_pid" 2>/dev/null; then
    return 0  # pid visible in current namespace
  fi
  log "WARN: Ignoring stale deploy lock (age=${lock_age}s > ${DEPLOY_LOCK_STALE_SECONDS}s)"
  return 1
}

failover() {
  # Skip failover if an HA deploy is in progress — the active container may
  # be temporarily down during switchover and will recover.
  if check_deploy_in_progress; then
    log "FAILOVER: Skipped — HA deploy in progress (lock held). Will retry next cycle."
    consecutive_failures=0
    return 0
  fi

  log "FAILOVER: Primary ($current_primary) failed $FAILURE_THRESHOLD times"
  log "FAILOVER: Switching to standby ($current_standby)"

  # Check if standby is alive (liveness is sufficient here — it may be in
  # standby mode so /health/traffic would fail on the role check, but we are
  # about to activate it).
  if ! check_live "$current_standby"; then
    log "ERROR: Standby is also unhealthy (liveness failed)! Cannot failover."
    return 1
  fi

  # Try to gracefully deactivate primary first (best effort)
  deactivate_primary "$current_primary" || true

  # Activate the standby
  if ! activate_standby "$current_standby"; then
    log "ERROR: Failed to activate standby"
    return 1
  fi

  # Verify standby is actually serving as active before declaring success.
  log "FAILOVER: Verifying new primary reports active mode"
  if ! wait_for_active_mode "$current_standby" 10; then
    log "ERROR: Standby activated but not reporting active mode"
    return 1
  fi

  # Verify traffic health before trusting failover.
  if ! check_traffic "$current_standby"; then
    log "WARN: Standby activated as active but /health/traffic failing; proceeding cautiously"
  fi

  # Swap primary and standby
  old_primary="$current_primary"
  temp="$current_primary"
  current_primary="$current_standby"
  current_standby="$temp"

  log "FAILOVER: Complete. New primary: $current_primary (verified active)"
  consecutive_failures=0
  failback_healthy_count=0

  # Notify HA event on new primary
  notify_ha_event "$current_primary" "failover" "$old_primary" "$current_primary" "traffic health check failure"

  # Wait before resuming checks
  log "Waiting ${RECOVERY_DELAY}s for services to stabilize"
  sleep "$RECOVERY_DELAY"
}

check_failback() {
  # Only check if failback is enabled and we've failed over
  if [ "$ENABLE_FAILBACK" != "true" ]; then
    return
  fi

  if [ "$original_primary" = "$current_primary" ]; then
    return  # Already on original primary
  fi

  # Check if original primary is alive enough to attempt activation.
  if check_live "$original_primary"; then
    failback_healthy_count=$((failback_healthy_count + 1))
    log "FAILBACK: Original primary live ($failback_healthy_count/$FAILBACK_THRESHOLD)"

    if [ "$failback_healthy_count" -ge "$FAILBACK_THRESHOLD" ]; then
      log "FAILBACK: Initiating failback to original primary ($original_primary)"

      # Deactivate current primary
      deactivate_primary "$current_primary" || true

      # Activate original primary
      if activate_standby "$original_primary"; then
        if ! wait_for_active_mode "$original_primary" 10; then
          log "FAILBACK: Original primary activated but not reporting active mode"
          failback_healthy_count=0
          return
        fi
        if ! check_traffic "$original_primary"; then
          log "WARN: Original primary active after failback but /health/traffic failing"
        fi

        # Swap back
        old_primary="$current_primary"
        temp="$current_primary"
        current_primary="$original_primary"
        current_standby="$temp"
        failback_healthy_count=0

        log "FAILBACK: Complete. Primary restored to: $current_primary"

        # Notify HA event
        notify_ha_event "$current_primary" "failback" "$old_primary" "$current_primary" "original primary recovered"

        sleep "$RECOVERY_DELAY"
      else
        log "FAILBACK: Failed to activate original primary"
        failback_healthy_count=0
      fi
    fi
  else
    failback_healthy_count=0
  fi
}

log "Starting watchdog"
log "Primary: $PRIMARY_URL"
log "Standby: $STANDBY_URL"
log "Check interval: ${CHECK_INTERVAL}s"
log "Failure threshold: $FAILURE_THRESHOLD"
log "Deactivate timeout: ${DEACTIVATE_TIMEOUT}s"
log "Failback enabled: $ENABLE_FAILBACK"
if [ -n "$CONTROL_PLANE_API_KEY" ]; then
  log "Control-plane auth: enabled (bearer)"
fi
if [ "$ENABLE_FAILBACK" = "true" ]; then
  log "Failback threshold: $FAILBACK_THRESHOLD"
fi
log "Deploy lock guard: dir=${DEPLOY_LOCK_DIR} stale_after=${DEPLOY_LOCK_STALE_SECONDS}s"

# Wait for services to start
sleep 10

while true; do
  if check_traffic "$current_primary"; then
    if [ "$consecutive_failures" -gt 0 ]; then
      log "Primary recovered after $consecutive_failures failures"
    fi
    consecutive_failures=0
  else
    consecutive_failures=$((consecutive_failures + 1))
    log "Primary traffic health check failed ($consecutive_failures/$FAILURE_THRESHOLD)"

    if [ "$consecutive_failures" -ge "$FAILURE_THRESHOLD" ]; then
      failover || log "Failover failed, will retry"
    fi
  fi

  # Check for failback opportunity
  check_failback

  sleep "$CHECK_INTERVAL"
done
