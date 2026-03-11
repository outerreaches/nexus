#!/usr/bin/env bash
# Prepare and migrate credentials store for sidecar-only secrets isolation.
#
# Defaults:
#   source: <state-dir>/secrets/credentials.json
#   target: <store-dir>/credentials.json
#   backup: <store-dir>/archive/credentials.legacy.<timestamp>.json
#
# Usage:
#   infra/scripts/setup/ha-sidecar-secrets-isolation.sh --status
#   infra/scripts/setup/ha-sidecar-secrets-isolation.sh --prepare
#   infra/scripts/setup/ha-sidecar-secrets-isolation.sh --migrate
#   infra/scripts/setup/ha-sidecar-secrets-isolation.sh --migrate --force
#
# Environment overrides:
#   NEXUS_HOME=~/.nexus
#   OLD_STORE_PATH=<state-dir>/secrets/credentials.json
#   NEW_STORE_DIR=<store-dir>
#   NEW_STORE_PATH=<store-dir>/credentials.json

set -euo pipefail

if [ -n "${NEXUS_HOME:-}" ]; then
  DEFAULT_STATE_DIR="${NEXUS_HOME}/state"
  DEFAULT_STORE_DIR="${NEXUS_HOME}/secrets"
elif [ -d "/data/nexus" ] || [ -d "/data/nexus-secrets" ]; then
  DEFAULT_STATE_DIR="/data/nexus"
  DEFAULT_STORE_DIR="/data/nexus-secrets"
else
  DEFAULT_STATE_DIR="${HOME}/.nexus/state"
  DEFAULT_STORE_DIR="${HOME}/.nexus/secrets"
fi

OLD_STORE_PATH="${OLD_STORE_PATH:-${DEFAULT_STATE_DIR}/secrets/credentials.json}"
NEW_STORE_DIR="${NEW_STORE_DIR:-${DEFAULT_STORE_DIR}}"
NEW_STORE_PATH="${NEW_STORE_PATH:-${NEW_STORE_DIR}/credentials.json}"
BACKUP_DIR="${BACKUP_DIR:-${NEW_STORE_DIR}/archive}"

ACTION="status"
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --status) ACTION="status" ;;
    --prepare) ACTION="prepare" ;;
    --migrate) ACTION="migrate" ;;
    --force) FORCE=1 ;;
    -h|--help)
      cat <<EOF
Usage: $(basename "$0") [--status|--prepare|--migrate] [--force]
  --status   Show source/target presence, size, and sha256
  --prepare  Create target dir with restrictive permissions (0700)
  --migrate  Back up, copy to target, then remove the legacy source store
  --force    Overwrite target when --migrate and target already exists
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

file_status() {
  local label="$1"
  local path="$2"
  if [[ -f "$path" ]]; then
    local size sha
    size="$(wc -c <"$path" | tr -d ' ')"
    if command -v sha256sum >/dev/null 2>&1; then
      sha="$(sha256sum "$path" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
      sha="$(shasum -a 256 "$path" | awk '{print $1}')"
    else
      sha="unavailable"
    fi
    echo "$label: present path=$path size=${size}B sha256=$sha"
  else
    echo "$label: missing path=$path"
  fi
}

prepare_target_dir() {
  mkdir -p "$NEW_STORE_DIR"
  chmod 700 "$NEW_STORE_DIR" || true
  echo "prepared target directory: $NEW_STORE_DIR (chmod 700 attempted)"
}

migrate_store() {
  if [[ ! -f "$OLD_STORE_PATH" ]]; then
    if [[ -f "$NEW_STORE_PATH" ]]; then
      echo "legacy source store already absent; target store already present: $NEW_STORE_PATH"
      return 0
    fi
    echo "source store not found: $OLD_STORE_PATH" >&2
    exit 1
  fi
  prepare_target_dir
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR" || true

  if [[ -f "$NEW_STORE_PATH" && "$FORCE" -ne 1 ]]; then
    echo "target store already exists: $NEW_STORE_PATH (use --force to overwrite)" >&2
    exit 1
  fi

  local timestamp backup_path
  timestamp="$(date +%Y%m%d-%H%M%S)"
  backup_path="${BACKUP_DIR}/credentials.legacy.${timestamp}.json"
  cp "$OLD_STORE_PATH" "$backup_path"
  chmod 600 "$backup_path" || true
  cp "$OLD_STORE_PATH" "$NEW_STORE_PATH"
  chmod 600 "$NEW_STORE_PATH" || true
  if ! cmp -s "$OLD_STORE_PATH" "$NEW_STORE_PATH"; then
    echo "target store verification failed after copy: $NEW_STORE_PATH" >&2
    exit 1
  fi
  rm -f "$OLD_STORE_PATH"
  rmdir "$(dirname "$OLD_STORE_PATH")" 2>/dev/null || true
  echo "migrated store: $OLD_STORE_PATH -> $NEW_STORE_PATH (backup: $backup_path)"
}

print_status() {
  section "Credentials Store Status"
  file_status "source" "$OLD_STORE_PATH"
  file_status "target" "$NEW_STORE_PATH"

  section "Directory Permissions"
  if [[ -d "$NEW_STORE_DIR" ]]; then
    ls -ld "$NEW_STORE_DIR" || true
  else
    echo "target dir missing: $NEW_STORE_DIR"
  fi
}

case "$ACTION" in
  status)
    print_status
    ;;
  prepare)
    prepare_target_dir
    print_status
    ;;
  migrate)
    migrate_store
    print_status
    ;;
esac
