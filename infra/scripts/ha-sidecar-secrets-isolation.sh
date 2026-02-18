#!/usr/bin/env bash
# Prepare and migrate credentials store for sidecar-only secrets isolation.
#
# Defaults:
#   source: /data/nexus/secrets/credentials.json
#   target: /data/nexus-secrets/credentials.json
#
# Usage:
#   infra/scripts/ha-sidecar-secrets-isolation.sh --status
#   infra/scripts/ha-sidecar-secrets-isolation.sh --prepare
#   infra/scripts/ha-sidecar-secrets-isolation.sh --migrate
#   infra/scripts/ha-sidecar-secrets-isolation.sh --migrate --force
#
# Environment overrides:
#   OLD_STORE_PATH=/data/nexus/secrets/credentials.json
#   NEW_STORE_DIR=/data/nexus-secrets
#   NEW_STORE_PATH=/data/nexus-secrets/credentials.json

set -euo pipefail

OLD_STORE_PATH="${OLD_STORE_PATH:-/data/nexus/secrets/credentials.json}"
NEW_STORE_DIR="${NEW_STORE_DIR:-/data/nexus-secrets}"
NEW_STORE_PATH="${NEW_STORE_PATH:-${NEW_STORE_DIR}/credentials.json}"

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
  --migrate  Copy source store to target (non-destructive)
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
    echo "source store not found: $OLD_STORE_PATH" >&2
    exit 1
  fi
  prepare_target_dir

  if [[ -f "$NEW_STORE_PATH" && "$FORCE" -ne 1 ]]; then
    echo "target store already exists: $NEW_STORE_PATH (use --force to overwrite)" >&2
    exit 1
  fi

  cp "$OLD_STORE_PATH" "$NEW_STORE_PATH"
  chmod 600 "$NEW_STORE_PATH" || true
  echo "copied store: $OLD_STORE_PATH -> $NEW_STORE_PATH (chmod 600 attempted)"
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

