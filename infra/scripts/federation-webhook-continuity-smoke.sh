#!/usr/bin/env bash
# Smoke check: verify webhook queue drains after failover/rebind without duplicate explosion.

set -euo pipefail

usage() {
  cat <<USAGE
Usage: $(basename "$0") --service-url <url> [options]

Required:
  --service-url <url>          Service/monetization gateway base URL

Options:
  --max-wait-seconds <n>       Max wait for pending queue to drain (default: 180)
  --poll-interval-seconds <n>  Poll interval (default: 5)
  --help                       Show this help
USAGE
}

SERVICE_URL=""
MAX_WAIT_SECONDS="180"
POLL_INTERVAL_SECONDS="5"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service-url)
      SERVICE_URL="$2"
      shift 2
      ;;
    --max-wait-seconds)
      MAX_WAIT_SECONDS="$2"
      shift 2
      ;;
    --poll-interval-seconds)
      POLL_INTERVAL_SECONDS="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$SERVICE_URL" ]]; then
  usage
  echo "--service-url is required" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

snapshot_counts() {
  local payload
  payload="$(curl -sf "$SERVICE_URL/api/webhooks/deliveries?limit=1000")"
  local pending failed dead acked duplicate_keys duplicates
  pending="$(echo "$payload" | jq '[.rows[] | select(.status == "pending" or .status == "sending")] | length')"
  failed="$(echo "$payload" | jq '[.rows[] | select(.status == "failed")] | length')"
  dead="$(echo "$payload" | jq '[.rows[] | select(.status == "dead_letter")] | length')"
  acked="$(echo "$payload" | jq '[.rows[] | select(.status == "acked")] | length')"
  duplicate_keys="$(echo "$payload" | jq '[.rows[] | "\(.eventId // "none"):\(.endpointId)"]')"
  duplicates="$(echo "$duplicate_keys" | jq 'group_by(.) | map(select(length > 1)) | length')"
  echo "pending=$pending failed=$failed dead=$dead acked=$acked duplicate_keys=$duplicates"
}

start_ts="$(date +%s)"

echo "Initial delivery snapshot:"
snapshot_counts

while true; do
  now_ts="$(date +%s)"
  elapsed=$((now_ts - start_ts))
  metrics="$(snapshot_counts)"
  echo "[$elapsed s] $metrics"

  pending="$(echo "$metrics" | sed -n 's/.*pending=\([0-9]*\).*/\1/p')"
  duplicates="$(echo "$metrics" | sed -n 's/.*duplicate_keys=\([0-9]*\).*/\1/p')"

  if [[ "$pending" == "0" ]]; then
    if [[ "$duplicates" != "0" ]]; then
      echo "ERROR: duplicate eventId:endpoint keys detected after drain ($duplicates)" >&2
      exit 2
    fi
    echo "Webhook continuity check passed: pending queue drained with no duplicate key groups."
    exit 0
  fi

  if (( elapsed >= MAX_WAIT_SECONDS )); then
    echo "ERROR: pending webhook queue did not drain within ${MAX_WAIT_SECONDS}s" >&2
    exit 3
  fi

  sleep "$POLL_INTERVAL_SECONDS"
done
