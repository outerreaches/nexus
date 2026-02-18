#!/usr/bin/env bash
# Smoke-check profile bootstrap paths by rendering profile-specific compose/config files.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SCRIPT="${SCRIPT_DIR}/deploy-instance-profile.sh"

if [[ ! -x "$DEPLOY_SCRIPT" ]]; then
  echo "missing deploy script: $DEPLOY_SCRIPT" >&2
  exit 1
fi

ROOT_TMP="${ROOT_TMP:-/tmp/nexus-profile-smoke}"
CODE_DIR="${CODE_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
mkdir -p "$ROOT_TMP"

profiles=(standard primary standby monetization)
for profile in "${profiles[@]}"; do
  deploy_dir="$ROOT_TMP/${profile}-deploy"
  state_dir="$ROOT_TMP/${profile}-state"
  workspace_dir="$ROOT_TMP/${profile}-workspace"
  echo "[smoke] profile=$profile"
  "$DEPLOY_SCRIPT" \
    --profile "$profile" \
    --deploy-dir "$deploy_dir" \
    --state-dir "$state_dir" \
    --workspace-dir "$workspace_dir" \
    --code-dir "$CODE_DIR" \
    --render-only \
    --skip-healthcheck
  if [[ ! -f "$deploy_dir/docker-compose.yml" ]]; then
    echo "missing compose output for profile=$profile" >&2
    exit 2
  fi
  if [[ ! -f "$state_dir/nexus.json" ]]; then
    echo "missing config output for profile=$profile" >&2
    exit 2
  fi
done

echo "Profile bootstrap smoke passed for: ${profiles[*]}"
