#!/usr/bin/env bash
# Quick disk check + cleanup helper for Nexus VM.
# Safe by default: prunes old containers/images/build-cache, not volumes.
#
# Usage:
#   sudo ./infra/scripts/nexus-space-check-clean.sh
#   sudo ./infra/scripts/nexus-space-check-clean.sh --check-only
#   sudo ./infra/scripts/nexus-space-check-clean.sh --aggressive
#   sudo DOCKER_PRUNE_UNTIL=72h ./infra/scripts/nexus-space-check-clean.sh
#   sudo DOCKER_PRUNE_UNTIL=all ./infra/scripts/nexus-space-check-clean.sh

set -euo pipefail

CHECK_ONLY=0
AGGRESSIVE=0
DOCKER_PRUNE_UNTIL="${DOCKER_PRUNE_UNTIL:-168h}" # 7 days

for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=1 ;;
    --aggressive) AGGRESSIVE=1 ;;
    -h|--help)
      cat <<EOF
Usage: $(basename "$0") [--check-only] [--aggressive]
  --check-only  Print diagnostics only (no cleanup)
  --aggressive  Also prune unused Docker volumes (more reclaim, more risk)
Environment:
  DOCKER_PRUNE_UNTIL=168h (default)  prune only artifacts older than this
  DOCKER_PRUNE_UNTIL=all             prune all unused images/cache regardless of age
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

section() {
  printf '\n== %s ==\n' "$1"
}

run_checks() {
  section "Disk usage for /"
  df -h / || true

  if command -v docker >/dev/null 2>&1; then
    section "Docker disk usage"
    docker system df || true
  else
    echo "docker not found"
  fi

  section "Largest top-level directories on /"
  # -x keeps to root filesystem so mounted data disks are not mixed in.
  # du may return non-zero on permission-denied paths; keep checks best-effort.
  du -xhd1 / 2>/dev/null | sort -h | tail -n 12 || true
}

run_cleanup() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker not found; skipping Docker cleanup"
    return
  fi

  if [[ "$DOCKER_PRUNE_UNTIL" == "all" ]]; then
    section "Pruning all unused Docker artifacts (all ages)"
    docker container prune -f || true
    docker image prune -af || true
    docker builder prune -af || true
  else
    section "Pruning Docker artifacts older than ${DOCKER_PRUNE_UNTIL}"
    docker container prune -f --filter "until=${DOCKER_PRUNE_UNTIL}" || true
    docker image prune -af --filter "until=${DOCKER_PRUNE_UNTIL}" || true
    docker builder prune -af --filter "until=${DOCKER_PRUNE_UNTIL}" || true
  fi

  if (( AGGRESSIVE )); then
    section "Aggressive mode: pruning all unused Docker volumes"
    docker volume prune -f || true
  fi

  if command -v journalctl >/dev/null 2>&1; then
    section "Vacuuming systemd journal"
    journalctl --vacuum-time=14d || true
    journalctl --vacuum-size=300M || true
  fi

  if command -v apt-get >/dev/null 2>&1; then
    section "Cleaning apt cache"
    apt-get clean || true
  fi
}

section "Before cleanup"
run_checks

if (( CHECK_ONLY )); then
  exit 0
fi

if (( EUID != 0 )); then
  section "Warning"
  echo "Running without root. For full cleanup, rerun with sudo." >&2
fi

run_cleanup

section "After cleanup"
run_checks
