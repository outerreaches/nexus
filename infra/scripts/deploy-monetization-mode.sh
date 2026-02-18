#!/usr/bin/env bash
# Convenience wrapper for monetization-mode deployment.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_SCRIPT="${SCRIPT_DIR}/deploy-instance-profile.sh"

if [[ ! -x "$BASE_SCRIPT" ]]; then
  echo "missing helper script: $BASE_SCRIPT" >&2
  exit 1
fi

has_flag() {
  local needle="$1"
  shift
  for arg in "$@"; do
    if [[ "$arg" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

args=("$@")
if ! has_flag "--state-dir" "${args[@]}"; then
  args+=("--state-dir" "/data/nexus-monetization")
fi
if ! has_flag "--workspace-dir" "${args[@]}"; then
  args+=("--workspace-dir" "/data/workspace-monetization")
fi
if ! has_flag "--deploy-dir" "${args[@]}"; then
  args+=("--deploy-dir" "$HOME/nexus-monetization-deploy")
fi

exec "$BASE_SCRIPT" --profile monetization "${args[@]}"
