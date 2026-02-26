#!/usr/bin/env bash
# Start the host-mode reference node in the background.
# Stops any existing instance first (including orphans).
set -euo pipefail

BASE="${NEXUS_NODE_HOST_DIR:-$HOME/nexus-node-host}"
LOG_DIR="$BASE/logs"
LOG_FILE="$LOG_DIR/node.log"

mkdir -p "$LOG_DIR"

# Ensure clean slate — kills process group + orphans.
"$BASE/stop-node.sh" 2>/dev/null || true

# Start in a new process group (setsid) so stop-node.sh can kill the
# entire tree reliably via kill -- -$PGID.
nohup setsid "$BASE/start-node.sh" >> "$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" > "$BASE/node.pid"

echo "[host-node] started pid=$PID"
echo "[host-node] log=$LOG_FILE"
