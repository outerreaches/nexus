#!/usr/bin/env bash
# Legacy deployment smoke check:
# verifies single-instance deploy entry points are blocked.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

scripts=(
  "$SCRIPT_DIR/deploy-instance-profile.sh"
  "$SCRIPT_DIR/deploy-monetization-mode.sh"
  "$SCRIPT_DIR/deploy-nexus.sh"
)

for script in "${scripts[@]}"; do
  echo "[smoke] expect-blocked: ${script}"
  out_file="$(mktemp)"
  if "$script" >"$out_file" 2>&1; then
    echo "expected failure for legacy deploy script: $script" >&2
    cat "$out_file" >&2
    rm -f "$out_file"
    exit 2
  fi
  if ! grep -qi "single-instance deployment is retired" "$out_file"; then
    echo "missing retirement message for script: $script" >&2
    cat "$out_file" >&2
    rm -f "$out_file"
    exit 2
  fi
  rm -f "$out_file"
done

echo "Legacy deployment scripts are correctly blocked."
