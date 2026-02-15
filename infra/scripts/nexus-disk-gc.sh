#!/usr/bin/env bash
# Nexus VM disk garbage collection.
#
# Goal: keep / from filling up due to stale Docker images/layers and logs.
# This intentionally does NOT touch /data/nexus (including backups).
#
# Suggested install:
#   sudo install -m 0755 infra/scripts/nexus-disk-gc.sh /usr/local/sbin/nexus-disk-gc
#   sudo cp infra/systemd/nexus-disk-gc.* /etc/systemd/system/
#   sudo systemctl daemon-reload
#   sudo systemctl enable --now nexus-disk-gc.timer

set -euo pipefail

MIN_PCT="${MIN_PCT:-70}"
ROOT_MOUNT="${ROOT_MOUNT:-/}"
DOCKER_PRUNE_UNTIL="${DOCKER_PRUNE_UNTIL:-168h}" # 7 days
JOURNAL_VACUUM_TIME="${JOURNAL_VACUUM_TIME:-14d}"
JOURNAL_VACUUM_SIZE="${JOURNAL_VACUUM_SIZE:-300M}"

used_pct="$(df --output=pcent "$ROOT_MOUNT" | tail -1 | tr -dc '0-9' || true)"
if [[ -z "$used_pct" ]]; then
  echo "nexus-disk-gc: could not read disk usage for ${ROOT_MOUNT}" >&2
  exit 0
fi

if (( used_pct < MIN_PCT )); then
  exit 0
fi

echo "nexus-disk-gc: root_used_pct=${used_pct}% >= ${MIN_PCT}%: running cleanup" >&2

if command -v docker >/dev/null 2>&1; then
  docker container prune -f --filter "until=${DOCKER_PRUNE_UNTIL}" || true
  docker image prune -af --filter "until=${DOCKER_PRUNE_UNTIL}" || true
  docker builder prune -af --filter "until=${DOCKER_PRUNE_UNTIL}" || true
fi

if command -v journalctl >/dev/null 2>&1; then
  journalctl --vacuum-time="${JOURNAL_VACUUM_TIME}" || true
  journalctl --vacuum-size="${JOURNAL_VACUUM_SIZE}" || true
fi

if command -v apt-get >/dev/null 2>&1; then
  apt-get clean || true
fi

