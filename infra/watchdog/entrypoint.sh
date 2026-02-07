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

set -e

PRIMARY_URL="${PRIMARY_URL:-http://nexus-primary:18789}"
STANDBY_URL="${STANDBY_URL:-http://nexus-standby:18789}"
CHECK_INTERVAL="${CHECK_INTERVAL:-5}"
FAILURE_THRESHOLD="${FAILURE_THRESHOLD:-3}"
RECOVERY_DELAY="${RECOVERY_DELAY:-30}"
DEACTIVATE_TIMEOUT="${DEACTIVATE_TIMEOUT:-5}"
ENABLE_FAILBACK="${ENABLE_FAILBACK:-false}"
FAILBACK_THRESHOLD="${FAILBACK_THRESHOLD:-3}"

consecutive_failures=0
current_primary="$PRIMARY_URL"
current_standby="$STANDBY_URL"
original_primary="$PRIMARY_URL"
failback_healthy_count=0

log() {
  echo "[watchdog] $(date -Iseconds) $1"
}

check_health() {
  url="$1"
  if curl -sf --max-time 5 "${url}/health/live" > /dev/null 2>&1; then
    return 0
  fi
  return 1
}

check_ready() {
  url="$1"
  if curl -sf --max-time 10 "${url}/health/ready" > /dev/null 2>&1; then
    return 0
  fi
  return 1
}

deactivate_primary() {
  url="$1"
  log "Attempting graceful deactivation of ${url}"
  response=$(curl -sf --max-time "$DEACTIVATE_TIMEOUT" -X POST "${url}/api/deactivate" 2>&1) || {
    log "WARN: Failed to deactivate primary (may be down): $response"
    return 1
  }
  log "Primary deactivated: $response"
  return 0
}

activate_standby() {
  url="$1"
  log "Activating standby at ${url}"
  response=$(curl -sf --max-time 10 -X POST "${url}/api/activate" 2>&1) || {
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
  curl -sf --max-time 5 -X POST "${url}/api/ha/event" \
    -H "Content-Type: application/json" \
    -d "{\"event\":\"$event\",\"from\":\"$from\",\"to\":\"$to\",\"reason\":\"$reason\"}" \
    > /dev/null 2>&1 || log "WARN: Failed to notify HA event"
}

failover() {
  log "FAILOVER: Primary ($current_primary) failed $FAILURE_THRESHOLD times"
  log "FAILOVER: Switching to standby ($current_standby)"

  # Check if standby is alive (liveness is sufficient here — it may be in
  # standby mode so /health/ready would fail on the role check, but we are
  # about to activate it).
  if ! check_health "$current_standby"; then
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
  local verify_attempts=0
  local verify_ok=0
  while [ "$verify_attempts" -lt 10 ]; do
    verify_attempts=$((verify_attempts + 1))
    mode_response=$(curl -sf --max-time 5 "${current_standby}/api/mode" 2>&1) || mode_response=""
    case "$mode_response" in
      *'"mode":"active"'*)
        verify_ok=1
        break
        ;;
    esac
    sleep 2
  done

  if [ "$verify_ok" -ne 1 ]; then
    log "ERROR: Standby activated but not reporting active mode after ${verify_attempts} attempts"
    return 1
  fi

  # Verify readiness (not just liveness) before trusting failover.
  if ! check_ready "$current_standby"; then
    log "WARN: Standby activated as active but /health/ready failing; proceeding cautiously"
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
  notify_ha_event "$current_primary" "failover" "$old_primary" "$current_primary" "health check failure"

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

  # Check if original primary is healthy
  if check_health "$original_primary" && check_ready "$original_primary"; then
    failback_healthy_count=$((failback_healthy_count + 1))
    log "FAILBACK: Original primary healthy ($failback_healthy_count/$FAILBACK_THRESHOLD)"

    if [ "$failback_healthy_count" -ge "$FAILBACK_THRESHOLD" ]; then
      log "FAILBACK: Initiating failback to original primary ($original_primary)"

      # Deactivate current primary
      deactivate_primary "$current_primary" || true

      # Activate original primary
      if activate_standby "$original_primary"; then
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
if [ "$ENABLE_FAILBACK" = "true" ]; then
  log "Failback threshold: $FAILBACK_THRESHOLD"
fi

# Wait for services to start
sleep 10

while true; do
  if check_health "$current_primary"; then
    if [ "$consecutive_failures" -gt 0 ]; then
      log "Primary recovered after $consecutive_failures failures"
    fi
    consecutive_failures=0
  else
    consecutive_failures=$((consecutive_failures + 1))
    log "Primary health check failed ($consecutive_failures/$FAILURE_THRESHOLD)"

    if [ "$consecutive_failures" -ge "$FAILURE_THRESHOLD" ]; then
      failover || log "Failover failed, will retry"
    fi
  fi

  # Check for failback opportunity
  check_failback

  sleep "$CHECK_INTERVAL"
done
