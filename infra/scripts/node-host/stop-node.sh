#!/usr/bin/env bash
# Stop the host-mode reference node, including all child processes.
# Handles both PID-file-based shutdown and orphan cleanup.
set -euo pipefail

BASE="${NEXUS_NODE_HOST_DIR:-$HOME/nexus-node-host}"
PID_FILE="$BASE/node.pid"
GRACE_WAIT=5     # seconds to wait for graceful shutdown
KILL_WAIT=3      # seconds to wait after SIGKILL

killed_any=0

# ── 1. Kill the recorded process group ──────────────────────────────
if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    # Try to kill the entire process group rooted at $PID.
    PGID="$(ps -o pgid= -p "$PID" 2>/dev/null | tr -d ' ')" || true
    if [ -n "$PGID" ] && [ "$PGID" != "0" ]; then
      kill -- -"$PGID" 2>/dev/null || kill "$PID" 2>/dev/null || true
    else
      kill "$PID" 2>/dev/null || true
    fi
    # Wait for graceful exit.
    for _ in $(seq 1 $((GRACE_WAIT * 4))); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.25
    done
    # Force kill if still alive.
    if kill -0 "$PID" 2>/dev/null; then
      if [ -n "$PGID" ] && [ "$PGID" != "0" ]; then
        kill -9 -- -"$PGID" 2>/dev/null || true
      fi
      kill -9 "$PID" 2>/dev/null || true
      sleep "$KILL_WAIT"
    fi
    echo "[host-node] stopped pid=$PID"
    killed_any=1
  else
    echo "[host-node] pid $PID is not running"
  fi
  rm -f "$PID_FILE"
fi

# ── 2. Sweep orphaned reference-node processes ─────────────────────
# Catches children that survived the group kill or were left by previous
# starts that didn't record a PID file (e.g. manual tsx invocations).
orphan_pids="$(pgrep -f 'reference-node\.ts' 2>/dev/null || true)"
if [ -n "$orphan_pids" ]; then
  echo "[host-node] killing orphaned reference-node processes: $orphan_pids"
  echo "$orphan_pids" | xargs kill 2>/dev/null || true
  sleep 2
  # Force-kill any that remain.
  still_alive="$(pgrep -f 'reference-node\.ts' 2>/dev/null || true)"
  if [ -n "$still_alive" ]; then
    echo "$still_alive" | xargs kill -9 2>/dev/null || true
  fi
  killed_any=1
fi

if [ "$killed_any" -eq 0 ]; then
  echo "[host-node] nothing to stop"
fi
