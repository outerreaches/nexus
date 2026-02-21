#!/usr/bin/env bash
# Validate HA + sidecar secrets prerequisites.
#
# Checks:
# - NEXUS_HTTP_API_KEY is set
# - NEXUS_HA_API_KEY is set and matches NEXUS_HTTP_API_KEY
# - NEXUS_DASHBOARD_PASSWORD is set
# - NEXUS_SECRETCTL_PASSWORD is set
# - NEXUS_CREDENTIALS_KEY is set
#
# Optional autofix:
# - --auto-fix: align HA/API key values and fill default usernames
# - --auto-generate-credentials-key: generate key only when store file does not yet exist

set -euo pipefail

CODE_DIR="${CODE_DIR:-/data/code}"
ENV_FILE="${ENV_FILE:-${CODE_DIR}/.env}"
STATE_DIR="${STATE_DIR:-/data/nexus}"
STORE_DIR="${STORE_DIR:-/data/nexus-secrets}"
STORE_PATH="${STORE_PATH:-${STORE_DIR}/credentials.json}"
STORE_PATH_EXPLICIT=0

AUTO_FIX=0
AUTO_GENERATE_CREDENTIALS_KEY=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --code-dir <path>                      Code directory (default: ${CODE_DIR})
  --env-file <path>                      Env file path (default: ${ENV_FILE})
  --state-dir <path>                     State directory (default: ${STATE_DIR})
  --store-dir <path>                     Credential store directory (default: ${STORE_DIR})
  --store-path <path>                    Credential store file path (default: ${STORE_PATH})
  --auto-fix                             Apply safe env fixes (HA key alignment/default usernames)
  --auto-generate-credentials-key        Generate NEXUS_CREDENTIALS_KEY when missing and store is absent
  -h, --help                             Show this help
EOF
}

log() {
  printf '[secrets-preflight] %s\n' "$*"
}

fail() {
  printf '[secrets-preflight] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

read_env_file_value() {
  local key="$1"
  local file="$2"
  [[ -f "$file" ]] || return 0
  local line
  line="$(grep -E "^${key}=" "$file" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 0
  local raw="${line#*=}"
  raw="${raw%$'\r'}"
  if [[ "${raw:0:1}" == "\"" && "${raw: -1}" == "\"" && ${#raw} -ge 2 ]]; then
    raw="${raw:1:${#raw}-2}"
  elif [[ "${raw:0:1}" == "'" && "${raw: -1}" == "'" && ${#raw} -ge 2 ]]; then
    raw="${raw:1:${#raw}-2}"
  fi
  printf '%s' "$raw"
}

upsert_env_value() {
  local key="$1"
  local value="$2"
  local file="$3"
  local tmp
  tmp="$(mktemp)"
  if [[ -f "$file" ]]; then
    awk -v key="$key" -v value="$value" '
      BEGIN { done = 0 }
      $0 ~ ("^" key "=") {
        print key "=" value
        done = 1
        next
      }
      { print }
      END {
        if (done == 0) {
          print key "=" value
        }
      }
    ' "$file" >"$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >"$tmp"
  fi
  mv "$tmp" "$file"
}

mask_len() {
  local value="$1"
  if [[ -z "$value" ]]; then
    printf 'missing'
  else
    printf 'set(len=%d)' "${#value}"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --code-dir)
      CODE_DIR="$2"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --state-dir)
      STATE_DIR="$2"
      shift 2
      ;;
    --store-dir)
      STORE_DIR="$2"
      shift 2
      ;;
    --store-path)
      STORE_PATH="$2"
      STORE_PATH_EXPLICIT=1
      shift 2
      ;;
    --auto-fix)
      AUTO_FIX=1
      shift
      ;;
    --auto-generate-credentials-key)
      AUTO_GENERATE_CREDENTIALS_KEY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[[ -f "$ENV_FILE" ]] || fail "env file not found: ${ENV_FILE}"

if [[ "$STORE_PATH_EXPLICIT" != "1" ]]; then
  STORE_PATH="${STORE_DIR%/}/credentials.json"
fi

# Honor env overrides when present.
env_store_path="$(read_env_file_value "NEXUS_CREDENTIALS_STORE_PATH" "$ENV_FILE")"
env_store_dir="$(read_env_file_value "NEXUS_CREDENTIALS_STORE_DIR" "$ENV_FILE")"
if [[ -n "$env_store_path" ]]; then
  STORE_PATH="$env_store_path"
  STORE_DIR="$(dirname "$STORE_PATH")"
elif [[ -n "$env_store_dir" ]]; then
  STORE_DIR="$env_store_dir"
  STORE_PATH="${STORE_DIR%/}/credentials.json"
fi

if (( AUTO_FIX )); then
  mkdir -p "$STORE_DIR" || fail "unable to create store dir: ${STORE_DIR}"
  chmod 700 "$STORE_DIR" 2>/dev/null || true
fi

http_api_key="$(read_env_file_value "NEXUS_HTTP_API_KEY" "$ENV_FILE")"
ha_api_key="$(read_env_file_value "NEXUS_HA_API_KEY" "$ENV_FILE")"
dashboard_user="$(read_env_file_value "NEXUS_DASHBOARD_USERNAME" "$ENV_FILE")"
dashboard_password="$(read_env_file_value "NEXUS_DASHBOARD_PASSWORD" "$ENV_FILE")"
secretctl_user="$(read_env_file_value "NEXUS_SECRETCTL_USERNAME" "$ENV_FILE")"
secretctl_password="$(read_env_file_value "NEXUS_SECRETCTL_PASSWORD" "$ENV_FILE")"

if [[ -z "$dashboard_user" ]] && (( AUTO_FIX )); then
  upsert_env_value "NEXUS_DASHBOARD_USERNAME" "admin" "$ENV_FILE"
  dashboard_user="admin"
  log "set NEXUS_DASHBOARD_USERNAME=admin"
fi
if [[ -z "$secretctl_user" ]] && (( AUTO_FIX )); then
  upsert_env_value "NEXUS_SECRETCTL_USERNAME" "admin" "$ENV_FILE"
  secretctl_user="admin"
  log "set NEXUS_SECRETCTL_USERNAME=admin"
fi
if [[ -z "$secretctl_password" && -n "$dashboard_password" ]] && (( AUTO_FIX )); then
  upsert_env_value "NEXUS_SECRETCTL_PASSWORD" "$dashboard_password" "$ENV_FILE"
  secretctl_password="$dashboard_password"
  log "set NEXUS_SECRETCTL_PASSWORD from NEXUS_DASHBOARD_PASSWORD"
fi

[[ -n "$http_api_key" ]] || fail "NEXUS_HTTP_API_KEY is required"
[[ -n "$dashboard_password" ]] || fail "NEXUS_DASHBOARD_PASSWORD is required"
[[ -n "$secretctl_password" ]] || fail "NEXUS_SECRETCTL_PASSWORD is required"

if [[ -n "$http_api_key" ]]; then
  if [[ -z "$ha_api_key" ]]; then
    if (( AUTO_FIX )); then
      upsert_env_value "NEXUS_HA_API_KEY" "$http_api_key" "$ENV_FILE"
      ha_api_key="$http_api_key"
      log "set NEXUS_HA_API_KEY to match NEXUS_HTTP_API_KEY"
    else
      fail "NEXUS_HA_API_KEY is missing; set it to match NEXUS_HTTP_API_KEY"
    fi
  elif [[ "$ha_api_key" != "$http_api_key" ]]; then
    if (( AUTO_FIX )); then
      upsert_env_value "NEXUS_HA_API_KEY" "$http_api_key" "$ENV_FILE"
      ha_api_key="$http_api_key"
      log "aligned NEXUS_HA_API_KEY with NEXUS_HTTP_API_KEY"
    else
      fail "NEXUS_HA_API_KEY must match NEXUS_HTTP_API_KEY"
    fi
  fi
fi

credentials_key="$(read_env_file_value "NEXUS_CREDENTIALS_KEY" "$ENV_FILE")"
if [[ -z "$credentials_key" ]]; then
  if (( AUTO_GENERATE_CREDENTIALS_KEY )); then
    if [[ -s "$STORE_PATH" ]]; then
      fail "credential store exists at ${STORE_PATH} but NEXUS_CREDENTIALS_KEY is missing; refusing auto-generation"
    fi
    require_cmd openssl
    credentials_key="$(openssl rand -hex 32)"
    upsert_env_value "NEXUS_CREDENTIALS_KEY" "$credentials_key" "$ENV_FILE"
    log "generated NEXUS_CREDENTIALS_KEY"
  else
    fail "NEXUS_CREDENTIALS_KEY is required"
  fi
fi

if [[ ${#credentials_key} -lt 32 ]]; then
  fail "NEXUS_CREDENTIALS_KEY appears too short (len=${#credentials_key}); expected >= 32 chars"
fi

log "ok http_api_key=$(mask_len "$http_api_key") ha_api_key=$(mask_len "$ha_api_key") dashboard_password=$(mask_len "$dashboard_password") secretctl_password=$(mask_len "$secretctl_password") credentials_key_len=${#credentials_key} env_file=${ENV_FILE} store_path=${STORE_PATH}"
