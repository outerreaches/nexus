#!/usr/bin/env bash
# Bootstrap or update the default sidecar secret-provider profile on an HA instance.
#
# Usage:
#   NEXUS_HTTP_API_KEY=... infra/scripts/setup/ha-sidecar-bootstrap.sh
#   NEXUS_HTTP_API_KEY=... PROVIDER_ID=sidecar-main infra/scripts/setup/ha-sidecar-bootstrap.sh --test-only
#
# Environment overrides:
#   API_BASE_URL=http://localhost:18789
#   PROVIDER_ID=sidecar-main
#   PROVIDER_ENDPOINT=unix:///run/nexus/secret-sidecar.sock
#   PROVIDER_AUTH_MODE=unix_peer
#   PROVIDER_STRICT_MODE=true
#   PROVIDER_ENABLED=true

set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:18789}"
PROVIDER_ID="${PROVIDER_ID:-sidecar-main}"
PROVIDER_ENDPOINT="${PROVIDER_ENDPOINT:-unix:///run/nexus/secret-sidecar.sock}"
PROVIDER_AUTH_MODE="${PROVIDER_AUTH_MODE:-unix_peer}"
PROVIDER_STRICT_MODE="${PROVIDER_STRICT_MODE:-true}"
PROVIDER_ENABLED="${PROVIDER_ENABLED:-true}"
HTTP_API_KEY="${NEXUS_HTTP_API_KEY:-${NEXUS_HA_API_KEY:-}}"
AUTH_HEADER_FILE=""

TEST_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --test-only) TEST_ONLY=1 ;;
    -h|--help)
      cat <<EOF
Usage: $(basename "$0") [--test-only]
  --test-only  Skip profile upsert and run provider test only

Environment:
  API_BASE_URL=${API_BASE_URL}
  PROVIDER_ID=${PROVIDER_ID}
  PROVIDER_ENDPOINT=${PROVIDER_ENDPOINT}
  PROVIDER_AUTH_MODE=${PROVIDER_AUTH_MODE}
  PROVIDER_STRICT_MODE=${PROVIDER_STRICT_MODE}
  PROVIDER_ENABLED=${PROVIDER_ENABLED}
  NEXUS_HTTP_API_KEY (or NEXUS_HA_API_KEY)
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

normalize_bool() {
  local raw
  raw="$(echo "$1" | tr '[:upper:]' '[:lower:]' | xargs)"
  case "$raw" in
    1|true|yes|on) echo "true" ;;
    0|false|no|off) echo "false" ;;
    *)
      echo "invalid boolean value: $1" >&2
      exit 1
      ;;
  esac
}

require_safe_json_field() {
  local name="$1"
  local value="$2"
  if [[ "$value" == *\"* || "$value" == *\\* || "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    echo "unsafe ${name} value for JSON payload: ${value}" >&2
    exit 1
  fi
}

api_call() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [[ -n "$AUTH_HEADER_FILE" ]]; then
    if [[ -n "$body" ]]; then
      curl -fsS -X "$method" \
        -H @"${AUTH_HEADER_FILE}" \
        -H "Content-Type: application/json" \
        -d "$body" \
        "${API_BASE_URL}${path}"
    else
      curl -fsS -X "$method" \
        -H @"${AUTH_HEADER_FILE}" \
        "${API_BASE_URL}${path}"
    fi
  else
    if [[ -n "$body" ]]; then
      curl -fsS -X "$method" \
        -H "Content-Type: application/json" \
        -d "$body" \
        "${API_BASE_URL}${path}"
    else
      curl -fsS -X "$method" "${API_BASE_URL}${path}"
    fi
  fi
}

require_cmd curl

PROVIDER_STRICT_MODE="$(normalize_bool "$PROVIDER_STRICT_MODE")"
PROVIDER_ENABLED="$(normalize_bool "$PROVIDER_ENABLED")"
require_safe_json_field "PROVIDER_ID" "$PROVIDER_ID"
require_safe_json_field "PROVIDER_ENDPOINT" "$PROVIDER_ENDPOINT"
require_safe_json_field "PROVIDER_AUTH_MODE" "$PROVIDER_AUTH_MODE"
if [[ -n "$HTTP_API_KEY" ]]; then
  AUTH_HEADER_FILE="$(mktemp)"
  chmod 600 "$AUTH_HEADER_FILE"
  printf 'Authorization: Bearer %s\n' "$HTTP_API_KEY" >"$AUTH_HEADER_FILE"
  trap 'rm -f "$AUTH_HEADER_FILE"' EXIT
fi

echo "[sidecar-bootstrap] checking control plane reachability"
api_call GET "/health/live" >/dev/null

if (( TEST_ONLY == 0 )); then
  echo "[sidecar-bootstrap] upserting provider profile: ${PROVIDER_ID}"
  upsert_payload="$(cat <<EOF
{"id":"${PROVIDER_ID}","kind":"sidecar_http","endpointRef":"${PROVIDER_ENDPOINT}","authMode":"${PROVIDER_AUTH_MODE}","strictMode":${PROVIDER_STRICT_MODE},"enabled":${PROVIDER_ENABLED}}
EOF
)"
  api_call POST "/api/secrets/providers" "$upsert_payload"
  echo
fi

echo "[sidecar-bootstrap] testing provider profile: ${PROVIDER_ID}"
test_payload="$(cat <<EOF
{"strictMode":${PROVIDER_STRICT_MODE}}
EOF
)"
api_call POST "/api/secrets/providers/${PROVIDER_ID}/test" "$test_payload"
echo

echo "[sidecar-bootstrap] latest secret access events"
api_call GET "/api/secrets/access-events?limit=10"
echo
