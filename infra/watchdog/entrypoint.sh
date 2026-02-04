#!/bin/sh
# Nexus Watchdog - monitors primary and triggers failover to standby
#
# Environment variables:
#   PRIMARY_URL      - Primary Nexus URL (default: http://nexus-primary:18789)
#   STANDBY_URL      - Standby Nexus URL (default: http://nexus-standby:18789)
#   CHECK_INTERVAL   - Seconds between health checks (default: 5)
#   FAILURE_THRESHOLD - Consecutive failures before failover (default: 3)
#   RECOVERY_DELAY   - Seconds to wait after failover before checking again (default: 30)

set -e

PRIMARY_URL="${PRIMARY_URL:-http://nexus-primary:18789}"
STANDBY_URL="${STANDBY_URL:-http://nexus-standby:18789}"
CHECK_INTERVAL="${CHECK_INTERVAL:-5}"
FAILURE_THRESHOLD="${FAILURE_THRESHOLD:-3}"
RECOVERY_DELAY="${RECOVERY_DELAY:-30}"

consecutive_failures=0
current_primary="$PRIMARY_URL"
current_standby="$STANDBY_URL"

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

failover() {
  log "FAILOVER: Primary ($current_primary) failed $FAILURE_THRESHOLD times"
  log "FAILOVER: Switching to standby ($current_standby)"

  # Check if standby is alive
  if ! check_health "$current_standby"; then
    log "ERROR: Standby is also unhealthy! Cannot failover."
    return 1
  fi

  # Activate the standby
  if ! activate_standby "$current_standby"; then
    log "ERROR: Failed to activate standby"
    return 1
  fi

  # Swap primary and standby
  temp="$current_primary"
  current_primary="$current_standby"
  current_standby="$temp"

  log "FAILOVER: Complete. New primary: $current_primary"
  consecutive_failures=0

  # Wait before resuming checks
  log "Waiting ${RECOVERY_DELAY}s for services to stabilize"
  sleep "$RECOVERY_DELAY"
}

log "Starting watchdog"
log "Primary: $PRIMARY_URL"
log "Standby: $STANDBY_URL"
log "Check interval: ${CHECK_INTERVAL}s"
log "Failure threshold: $FAILURE_THRESHOLD"

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

  sleep "$CHECK_INTERVAL"
done
