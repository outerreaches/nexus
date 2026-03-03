#!/usr/bin/env bash
# Install path for execution-node-host mode (no full gateway instance).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_DEPLOY_SCRIPT="${SCRIPT_DIR}/deploy-nexus-node-linux.sh"

if [[ ! -x "$NODE_DEPLOY_SCRIPT" ]]; then
  echo "missing node deploy script: $NODE_DEPLOY_SCRIPT" >&2
  exit 1
fi

export NEXUS_NODE_DEPLOY_DIR="${NEXUS_NODE_DEPLOY_DIR:-$HOME/nexus-node-host-deploy}"
export NEXUS_NODE_STATE_HOST_DIR="${NEXUS_NODE_STATE_HOST_DIR:-/data/nexus-node-host}"

exec "$NODE_DEPLOY_SCRIPT" "$@"
