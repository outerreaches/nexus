#!/usr/bin/env bash
# Validate HA + sidecar secrets prerequisites.
#
# Checks:
# - NEXUS_SECRETS_STRICT=1
# - NEXUS_SECRETS_SIDECAR_ONLY=1
# - NEXUS_CREDENTIALS_KEY is set
# - If HTTP auth is enabled (or --require-http-api-key), NEXUS_HTTP_API_KEY is set
# - If NEXUS_HTTP_API_KEY is set, NEXUS_HA_API_KEY is set and matches
#
# Optional autofix:
# - --auto-fix: set strict/sidecar-only to 1 and align HA/API key values
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
REQUIRE_HTTP_API_KEY=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --code-dir <path>                      Code directory (default: ${CODE_DIR})
  --env-file <path>                      Env file path (default: ${ENV_FILE})
  --state-dir <path>                     State directory (default: ${STATE_DIR})
  --store-dir <path>                     Credential store directory (default: ${STORE_DIR})
  --store-path <path>                    Credential store file path (default: ${STORE_PATH})
  --auto-fix                             Apply safe env fixes (strict/sidecar-only/HA key alignment)
  --auto-generate-credentials-key        Generate NEXUS_CREDENTIALS_KEY when missing and store is absent
  --require-http-api-key                 Require NEXUS_HTTP_API_KEY even when auth flag is unset
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

normalize_bool() {
  local raw
  raw="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | xargs)"
  case "$raw" in
    1|true|yes|on) printf '1' ;;
    0|false|no|off|'') printf '0' ;;
    *)
      fail "invalid boolean value: $1"
      ;;
  esac
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

strict_raw="$(read_env_file_value "NEXUS_SECRETS_STRICT" "$ENV_FILE")"
strict_bool="$(normalize_bool "${strict_raw:-0}")"
if [[ "$strict_bool" != "1" ]]; then
  if (( AUTO_FIX )); then
    upsert_env_value "NEXUS_SECRETS_STRICT" "1" "$ENV_FILE"
    strict_bool="1"
    log "set NEXUS_SECRETS_STRICT=1"
  else
    fail "NEXUS_SECRETS_STRICT must be enabled (set to 1)"
  fi
fi

sidecar_only_raw="$(read_env_file_value "NEXUS_SECRETS_SIDECAR_ONLY" "$ENV_FILE")"
sidecar_only_bool="$(normalize_bool "${sidecar_only_raw:-0}")"
if [[ "$sidecar_only_bool" != "1" ]]; then
  if (( AUTO_FIX )); then
    upsert_env_value "NEXUS_SECRETS_SIDECAR_ONLY" "1" "$ENV_FILE"
    sidecar_only_bool="1"
    log "set NEXUS_SECRETS_SIDECAR_ONLY=1"
  else
    fail "NEXUS_SECRETS_SIDECAR_ONLY must be enabled (set to 1)"
  fi
fi

auth_enabled_raw="$(read_env_file_value "NEXUS_HTTP_AUTH_ENABLED" "$ENV_FILE")"
auth_enabled_bool="$(normalize_bool "${auth_enabled_raw:-0}")"
http_api_key="$(read_env_file_value "NEXUS_HTTP_API_KEY" "$ENV_FILE")"
ha_api_key="$(read_env_file_value "NEXUS_HA_API_KEY" "$ENV_FILE")"
shared_auth_token="$(read_env_file_value "NEXUS_HTTP_AUTH_TOKEN" "$ENV_FILE")"

if [[ -z "$http_api_key" && -n "$ha_api_key" ]]; then
  if (( AUTO_FIX )); then
    upsert_env_value "NEXUS_HTTP_API_KEY" "$ha_api_key" "$ENV_FILE"
    http_api_key="$ha_api_key"
    log "set NEXUS_HTTP_API_KEY from NEXUS_HA_API_KEY"
  fi
fi

if [[ -z "$http_api_key" && -n "$shared_auth_token" && ( "$auth_enabled_bool" == "1" || "$REQUIRE_HTTP_API_KEY" == "1" ) ]]; then
  if (( AUTO_FIX )); then
    upsert_env_value "NEXUS_HTTP_API_KEY" "$shared_auth_token" "$ENV_FILE"
    http_api_key="$shared_auth_token"
    log "set NEXUS_HTTP_API_KEY from NEXUS_HTTP_AUTH_TOKEN"
  fi
fi

if [[ "$auth_enabled_bool" == "1" || "$REQUIRE_HTTP_API_KEY" == "1" ]]; then
  [[ -n "$http_api_key" ]] || fail "NEXUS_HTTP_API_KEY is required"
fi

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

log "ok strict=1 sidecar_only=1 http_api_key=$(mask_len "$http_api_key") ha_api_key=$(mask_len "$ha_api_key") credentials_key_len=${#credentials_key} env_file=${ENV_FILE} store_path=${STORE_PATH}"
