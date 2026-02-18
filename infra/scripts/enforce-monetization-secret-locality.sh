#!/usr/bin/env bash
# Validate and enforce that monetization secrets stay on monetization instance storage.

set -euo pipefail

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Options:
  --primary-state-dir <path>         Primary state dir (default: /data/nexus)
  --monetization-state-dir <path>    Monetization state dir (default: /data/nexus-monetization)
  --apply-perms                      Apply restrictive permissions to monetization secret paths
  --help                             Show help
USAGE
}

PRIMARY_STATE_DIR="${PRIMARY_STATE_DIR:-/data/nexus}"
MONETIZATION_STATE_DIR="${MONETIZATION_STATE_DIR:-/data/nexus-monetization}"
APPLY_PERMS="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --primary-state-dir)
      PRIMARY_STATE_DIR="$2"
      shift 2
      ;;
    --monetization-state-dir)
      MONETIZATION_STATE_DIR="$2"
      shift 2
      ;;
    --apply-perms)
      APPLY_PERMS="1"
      shift
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

PRIMARY_FINDINGS=()
if [[ -d "$PRIMARY_STATE_DIR" ]]; then
  while IFS= read -r hit; do
    PRIMARY_FINDINGS+=("$hit")
  done < <(find "$PRIMARY_STATE_DIR" -type f \( \
      -name '*wallet*' -o \
      -name '*exchange*' -o \
      -name 'risk-policy.json' -o \
      -path '*/secrets/credentials.json' \
    \) 2>/dev/null)
fi

if (( ${#PRIMARY_FINDINGS[@]} > 0 )); then
  echo "ERROR: sensitive monetization artifacts detected in primary state dir: $PRIMARY_STATE_DIR" >&2
  printf '  %s\n' "${PRIMARY_FINDINGS[@]}" >&2
  exit 2
fi

echo "Primary state check passed: no monetization-local secret artifacts found in $PRIMARY_STATE_DIR"

if [[ "$APPLY_PERMS" == "1" ]]; then
  mkdir -p "$MONETIZATION_STATE_DIR/secrets" "$MONETIZATION_STATE_DIR/monetization"
  chmod 700 "$MONETIZATION_STATE_DIR" "$MONETIZATION_STATE_DIR/secrets" "$MONETIZATION_STATE_DIR/monetization"
  if [[ -f "$MONETIZATION_STATE_DIR/secrets/credentials.json" ]]; then
    chmod 600 "$MONETIZATION_STATE_DIR/secrets/credentials.json"
  fi
  if [[ -f "$MONETIZATION_STATE_DIR/monetization/risk-policy.json" ]]; then
    chmod 600 "$MONETIZATION_STATE_DIR/monetization/risk-policy.json"
  fi
  echo "Applied restrictive permissions in $MONETIZATION_STATE_DIR"
else
  echo "Permission changes not applied (use --apply-perms to enforce filesystem modes)."
fi
