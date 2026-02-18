#!/usr/bin/env bash
# Smoke drill: promote standby and rebind monetization/service peer to new primary endpoint.

set -euo pipefail

usage() {
  cat <<USAGE
Usage: $(basename "$0") --standby-url <url> --service-url <url> --peer-id <id> --new-primary-endpoint <url> [--apply]

Required:
  --standby-url <url>            Standby gateway base URL (example: http://10.0.0.12:18789)
  --service-url <url>            Service/monetization gateway base URL
  --peer-id <id>                 Peer id on service that points to the active primary
  --new-primary-endpoint <url>   Endpoint value to persist into the service peer record

Options:
  --apply                        Execute mutation calls (default: read-only)
  --help                         Show this help
USAGE
}

STANDBY_URL=""
SERVICE_URL=""
PEER_ID=""
NEW_PRIMARY_ENDPOINT=""
APPLY="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --standby-url)
      STANDBY_URL="$2"
      shift 2
      ;;
    --service-url)
      SERVICE_URL="$2"
      shift 2
      ;;
    --peer-id)
      PEER_ID="$2"
      shift 2
      ;;
    --new-primary-endpoint)
      NEW_PRIMARY_ENDPOINT="$2"
      shift 2
      ;;
    --apply)
      APPLY="1"
      shift
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

if [[ -z "$STANDBY_URL" || -z "$SERVICE_URL" || -z "$PEER_ID" || -z "$NEW_PRIMARY_ENDPOINT" ]]; then
  usage
  echo "missing required arguments" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

echo "[check] standby status"
curl -sf "$STANDBY_URL/status" | jq '{mode, runtime: .runtime.profile, federation: .federation.derivedState}'

echo "[check] service peer before rebind"
PEER_JSON="$(curl -sf "$SERVICE_URL/api/federation/peers/$PEER_ID")"
echo "$PEER_JSON" | jq '.peer | {id, label, endpoint, trustState, enabled}'

if [[ "$APPLY" != "1" ]]; then
  echo "Dry-run complete. Use --apply to execute promotion + rebind."
  exit 0
fi

echo "[apply] activating standby"
curl -sf -X POST "$STANDBY_URL/api/activate" -H 'content-type: application/json' -d '{}' | jq .

SIGNING_KEY="$(echo "$PEER_JSON" | jq -r '.peer.signingKey')"
LABEL="$(echo "$PEER_JSON" | jq -r '.peer.label')"
TRUST_STATE="$(echo "$PEER_JSON" | jq -r '.peer.trustState')"
ENABLED="$(echo "$PEER_JSON" | jq -r '.peer.enabled')"

if [[ -z "$SIGNING_KEY" || "$SIGNING_KEY" == "null" ]]; then
  echo "peer signing key is missing; cannot rebind safely" >&2
  exit 2
fi

echo "[apply] rebinding service peer endpoint -> $NEW_PRIMARY_ENDPOINT"
curl -sf -X POST "$SERVICE_URL/api/federation/peers" \
  -H 'content-type: application/json' \
  -d "{\"id\":\"$PEER_ID\",\"label\":\"$LABEL\",\"endpoint\":\"$NEW_PRIMARY_ENDPOINT\",\"signingKey\":\"$SIGNING_KEY\",\"trustState\":\"$TRUST_STATE\",\"enabled\":$ENABLED}" \
  | jq .

echo "[check] service peer after rebind"
curl -sf "$SERVICE_URL/api/federation/peers/$PEER_ID" | jq '.peer | {id, endpoint, trustState, enabled}'

echo "Failover rebind drill complete."
