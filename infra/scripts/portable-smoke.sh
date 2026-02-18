#!/usr/bin/env bash
# Smoke checks for portable runtime bundle and launcher modes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_SCRIPT="${SCRIPT_DIR}/build-portable-runtime.sh"
LAUNCHER_SCRIPT="${SCRIPT_DIR}/portable-launcher.sh"

if [[ ! -x "$BUILD_SCRIPT" || ! -x "$LAUNCHER_SCRIPT" ]]; then
  echo "portable scripts missing" >&2
  exit 1
fi

TMP_ROOT="${TMP_ROOT:-/tmp/nexus-portable-smoke}"
rm -rf "$TMP_ROOT"
mkdir -p "$TMP_ROOT"

modes=(portable portable_federated execution_node_host)
for mode in "${modes[@]}"; do
  out="$TMP_ROOT/$mode"
  echo "[smoke] building mode=$mode"
  "$BUILD_SCRIPT" --instance-mode "$mode" --output-dir "$out"

  manifest="$out/portable-manifest.json"
  if [[ ! -f "$manifest" ]]; then
    echo "missing manifest for mode=$mode" >&2
    exit 2
  fi

  echo "[smoke] launcher dry-run mode=$mode"
  PORTABLE_STATE_PASSPHRASE="test-passphrase" \
  NEXUS_FEDERATION_JOIN_APPROVED=1 \
  "$LAUNCHER_SCRIPT" --manifest "$manifest" --mode "$mode" --dry-run >/dev/null

done

echo "Portable smoke checks passed for modes: ${modes[*]}"
