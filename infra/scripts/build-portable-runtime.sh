#!/usr/bin/env bash
# Build a portable Nexus runtime bundle + launcher manifest.

set -euo pipefail

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Options:
  --output-dir <path>      Bundle output directory (default: infra/portable/dist)
  --runtime-version <ver>  Runtime version label (default: git short SHA or dev)
  --instance-mode <mode>   portable | portable_federated | execution_node_host (default: portable)
  --help                   Show this help
USAGE
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/infra/portable/dist}"
INSTANCE_MODE="${INSTANCE_MODE:-portable}"
RUNTIME_VERSION="${RUNTIME_VERSION:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --runtime-version)
      RUNTIME_VERSION="$2"
      shift 2
      ;;
    --instance-mode)
      INSTANCE_MODE="$2"
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

case "$INSTANCE_MODE" in
  portable|portable_federated|execution_node_host)
    ;;
  *)
    echo "Invalid instance mode: $INSTANCE_MODE" >&2
    exit 1
    ;;
esac

if [[ -z "$RUNTIME_VERSION" ]]; then
  if command -v git >/dev/null 2>&1 && git -C "$REPO_ROOT" rev-parse --short HEAD >/dev/null 2>&1; then
    RUNTIME_VERSION="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  else
    RUNTIME_VERSION="dev"
  fi
fi

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/runtime" "$OUTPUT_DIR/launcher" "$OUTPUT_DIR/logs" "$OUTPUT_DIR/state.enc"

if [[ -d "$REPO_ROOT/dist" ]]; then
  cp -R "$REPO_ROOT/dist" "$OUTPUT_DIR/runtime/dist"
fi
cp "$REPO_ROOT/package.json" "$OUTPUT_DIR/runtime/package.json"
cp "$REPO_ROOT/infra/scripts/portable-launcher.sh" "$OUTPUT_DIR/launcher/portable-launcher.sh"
chmod +x "$OUTPUT_DIR/launcher/portable-launcher.sh"

# Optional profile installer payload for execution-node-host mode.
cp "$REPO_ROOT/infra/scripts/install-execution-node-host.sh" "$OUTPUT_DIR/launcher/install-execution-node-host.sh"
chmod +x "$OUTPUT_DIR/launcher/install-execution-node-host.sh"

RUNTIME_SHA=""
if command -v shasum >/dev/null 2>&1; then
  RUNTIME_SHA="$(cd "$OUTPUT_DIR/runtime" && tar -cf - . | shasum -a 256 | awk '{print $1}')"
fi

MANIFEST="$OUTPUT_DIR/portable-manifest.json"
cat > "$MANIFEST" <<MANIFEST_JSON
{
  "schemaVersion": "portable.v1",
  "runtimeVersion": "$RUNTIME_VERSION",
  "instanceMode": "$INSTANCE_MODE",
  "profile": "$([ "$INSTANCE_MODE" = "execution_node_host" ] && echo "execution_node_host" || echo "portable")",
  "federation": {
    "enabled": $([ "$INSTANCE_MODE" = "portable_federated" ] && echo "true" || echo "false"),
    "requiresOperatorApproval": true
  },
  "state": {
    "encrypted": true,
    "mountPath": "./state.enc",
    "cipher": "aes-256-gcm"
  },
  "entrypoint": {
    "command": "nexus",
    "args": [
      "gateway",
      "--verbose",
      "--profile",
      "$([ "$INSTANCE_MODE" = "execution_node_host" ] && echo "execution_node_host" || echo "portable")"
    ],
    "env": {
      "NEXUS_STATE_DIR": "./state.enc",
      "NEXUS_WORKSPACE_DIR": "./workspace"
    }
  },
  "integrity": {
    "runtimeSha256": "$RUNTIME_SHA"
  }
}
MANIFEST_JSON

echo "Portable bundle ready: $OUTPUT_DIR"
echo "Manifest: $MANIFEST"
