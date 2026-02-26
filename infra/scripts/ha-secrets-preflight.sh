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
CONFIG_ROOT="${CONFIG_ROOT:-/data/nexus-config}"
GATEWAY_ENV_FILE="${GATEWAY_ENV_FILE:-${CONFIG_ROOT}/gateway/nexus.env}"
SIDECAR_ENV_FILE="${SIDECAR_ENV_FILE:-${CONFIG_ROOT}/sidecar/nexus.env}"
WATCHDOG_ENV_FILE="${WATCHDOG_ENV_FILE:-${CONFIG_ROOT}/watchdog/nexus.env}"
STATE_DIR="${STATE_DIR:-/data/nexus}"
STORE_DIR="${STORE_DIR:-/data/nexus-secrets}"
STORE_PATH="${STORE_PATH:-${STORE_DIR}/credentials.json}"

AUTO_FIX=0
AUTO_GENERATE_CREDENTIALS_KEY=0
REQUIRE_HTTP_API_KEY=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --code-dir <path>                      Code directory (default: ${CODE_DIR})
  --config-root <path>                   Root dir for split env files (default: ${CONFIG_ROOT})
  --gateway-env-file <path>              Gateway env file (default: ${GATEWAY_ENV_FILE})
  --sidecar-env-file <path>              Sidecar env file (default: ${SIDECAR_ENV_FILE})
  --watchdog-env-file <path>             Watchdog env file (default: ${WATCHDOG_ENV_FILE})
  --env-file <path>                      Legacy alias; sets all env files to this path
  --state-dir <path>                     State directory (default: ${STATE_DIR})
  --store-dir <path>                     Credential store directory (default: ${STORE_DIR})
  --auto-fix                             Apply safe env fixes (HA key alignment/default usernames)
  --auto-generate-credentials-key        Generate NEXUS_CREDENTIALS_KEY when missing and store is absent
  --require-http-api-key                 Require NEXUS_HTTP_API_KEY to be present
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
      GATEWAY_ENV_FILE="$2"
      SIDECAR_ENV_FILE="$2"
      WATCHDOG_ENV_FILE="$2"
      shift 2
      ;;
    --config-root)
      CONFIG_ROOT="$2"
      GATEWAY_ENV_FILE="${CONFIG_ROOT}/gateway/nexus.env"
      SIDECAR_ENV_FILE="${CONFIG_ROOT}/sidecar/nexus.env"
      WATCHDOG_ENV_FILE="${CONFIG_ROOT}/watchdog/nexus.env"
      shift 2
      ;;
    --gateway-env-file)
      GATEWAY_ENV_FILE="$2"
      shift 2
      ;;
    --sidecar-env-file)
      SIDECAR_ENV_FILE="$2"
      shift 2
      ;;
    --watchdog-env-file)
      WATCHDOG_ENV_FILE="$2"
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
      fail "--store-path is not supported. Use --store-dir."
      ;;
    --auto-fix)
      AUTO_FIX=1
      shift
      ;;
    --auto-generate-credentials-key)
      AUTO_GENERATE_CREDENTIALS_KEY=1
      shift
      ;;
    --require-http-api-key)
      REQUIRE_HTTP_API_KEY=1
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

if [[ ! -f "$GATEWAY_ENV_FILE" ]]; then
  if (( AUTO_FIX )); then
    mkdir -p "$(dirname "$GATEWAY_ENV_FILE")" || fail "unable to create gateway env dir: $(dirname "$GATEWAY_ENV_FILE")"
    : >"$GATEWAY_ENV_FILE"
    log "created gateway env file: ${GATEWAY_ENV_FILE}"
  else
    fail "gateway env file not found: ${GATEWAY_ENV_FILE}"
  fi
fi
if [[ ! -f "$SIDECAR_ENV_FILE" ]]; then
  if (( AUTO_FIX )); then
    mkdir -p "$(dirname "$SIDECAR_ENV_FILE")" || fail "unable to create sidecar env dir: $(dirname "$SIDECAR_ENV_FILE")"
    : >"$SIDECAR_ENV_FILE"
    log "created sidecar env file: ${SIDECAR_ENV_FILE}"
  else
    fail "sidecar env file not found: ${SIDECAR_ENV_FILE}"
  fi
fi
if [[ ! -f "$WATCHDOG_ENV_FILE" ]]; then
  if (( AUTO_FIX )); then
    mkdir -p "$(dirname "$WATCHDOG_ENV_FILE")" || fail "unable to create watchdog env dir: $(dirname "$WATCHDOG_ENV_FILE")"
    : >"$WATCHDOG_ENV_FILE"
    log "created watchdog env file: ${WATCHDOG_ENV_FILE}"
  else
    fail "watchdog env file not found: ${WATCHDOG_ENV_FILE}"
  fi
fi

STORE_PATH="${STORE_DIR%/}/credentials.json"

# Honor env overrides when present.
env_store_dir="$(read_env_file_value "NEXUS_CREDENTIALS_STORE_DIR" "$SIDECAR_ENV_FILE")"
if [[ -n "$env_store_dir" ]]; then
  STORE_DIR="$env_store_dir"
  STORE_PATH="${STORE_DIR%/}/credentials.json"
fi

if (( AUTO_FIX )); then
  mkdir -p "$STORE_DIR" || fail "unable to create store dir: ${STORE_DIR}"
  chmod 700 "$STORE_DIR" 2>/dev/null || true
fi

http_api_key="$(read_env_file_value "NEXUS_HTTP_API_KEY" "$GATEWAY_ENV_FILE")"
ha_api_key="$(read_env_file_value "NEXUS_HA_API_KEY" "$WATCHDOG_ENV_FILE")"
dashboard_user="$(read_env_file_value "NEXUS_DASHBOARD_USERNAME" "$GATEWAY_ENV_FILE")"
dashboard_password="$(read_env_file_value "NEXUS_DASHBOARD_PASSWORD" "$GATEWAY_ENV_FILE")"
secretctl_user="$(read_env_file_value "NEXUS_SECRETCTL_USERNAME" "$SIDECAR_ENV_FILE")"
secretctl_password="$(read_env_file_value "NEXUS_SECRETCTL_PASSWORD" "$SIDECAR_ENV_FILE")"

if [[ -z "$dashboard_user" ]] && (( AUTO_FIX )); then
  upsert_env_value "NEXUS_DASHBOARD_USERNAME" "admin" "$GATEWAY_ENV_FILE"
  dashboard_user="admin"
  log "set NEXUS_DASHBOARD_USERNAME=admin"
fi
if [[ -z "$secretctl_user" ]] && (( AUTO_FIX )); then
  upsert_env_value "NEXUS_SECRETCTL_USERNAME" "admin" "$SIDECAR_ENV_FILE"
  secretctl_user="admin"
  log "set NEXUS_SECRETCTL_USERNAME=admin"
fi
if [[ -z "$secretctl_password" && -n "$dashboard_password" ]] && (( AUTO_FIX )); then
  upsert_env_value "NEXUS_SECRETCTL_PASSWORD" "$dashboard_password" "$SIDECAR_ENV_FILE"
  secretctl_password="$dashboard_password"
  log "set NEXUS_SECRETCTL_PASSWORD from NEXUS_DASHBOARD_PASSWORD"
fi

if (( REQUIRE_HTTP_API_KEY )); then
  [[ -n "$http_api_key" ]] || fail "NEXUS_HTTP_API_KEY is required"
fi
[[ -n "$dashboard_password" ]] || fail "NEXUS_DASHBOARD_PASSWORD is required"
[[ -n "$secretctl_password" ]] || fail "NEXUS_SECRETCTL_PASSWORD is required"

if [[ -n "$http_api_key" ]]; then
  if [[ -z "$ha_api_key" ]]; then
    if (( AUTO_FIX )); then
      upsert_env_value "NEXUS_HA_API_KEY" "$http_api_key" "$WATCHDOG_ENV_FILE"
      ha_api_key="$http_api_key"
      log "set NEXUS_HA_API_KEY to match NEXUS_HTTP_API_KEY"
    else
      fail "NEXUS_HA_API_KEY is missing; set it to match NEXUS_HTTP_API_KEY"
    fi
  elif [[ "$ha_api_key" != "$http_api_key" ]]; then
    if (( AUTO_FIX )); then
      upsert_env_value "NEXUS_HA_API_KEY" "$http_api_key" "$WATCHDOG_ENV_FILE"
      ha_api_key="$http_api_key"
      log "aligned NEXUS_HA_API_KEY with NEXUS_HTTP_API_KEY"
    else
      fail "NEXUS_HA_API_KEY must match NEXUS_HTTP_API_KEY"
    fi
  fi
fi

credentials_key="$(read_env_file_value "NEXUS_CREDENTIALS_KEY" "$SIDECAR_ENV_FILE")"
if [[ -z "$credentials_key" ]]; then
  if (( AUTO_GENERATE_CREDENTIALS_KEY )); then
    if [[ -s "$STORE_PATH" ]]; then
      fail "credential store exists at ${STORE_PATH} but NEXUS_CREDENTIALS_KEY is missing; refusing auto-generation"
    fi
    require_cmd openssl
    credentials_key="$(openssl rand -hex 32)"
    upsert_env_value "NEXUS_CREDENTIALS_KEY" "$credentials_key" "$SIDECAR_ENV_FILE"
    log "generated NEXUS_CREDENTIALS_KEY"
  else
    fail "NEXUS_CREDENTIALS_KEY is required"
  fi
fi

if [[ ${#credentials_key} -lt 32 ]]; then
  fail "NEXUS_CREDENTIALS_KEY appears too short (len=${#credentials_key}); expected >= 32 chars"
fi

log "ok http_api_key=$(mask_len "$http_api_key") ha_api_key=$(mask_len "$ha_api_key") dashboard_password=$(mask_len "$dashboard_password") secretctl_password=$(mask_len "$secretctl_password") credentials_key_len=${#credentials_key} gateway_env=${GATEWAY_ENV_FILE} sidecar_env=${SIDECAR_ENV_FILE} watchdog_env=${WATCHDOG_ENV_FILE} store_path=${STORE_PATH}"
