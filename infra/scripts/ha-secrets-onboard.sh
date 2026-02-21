#!/usr/bin/env bash
# Interactive initial secrets onboarding for sidecar-backed credential storage.
#
# Baseline secrets covered by default:
#   - llm.openrouter.api
#   - telegram.bot.token
#   - search.brave.api
#   - twitter.auth.auth_token
#   - twitter.auth.ct0
#
# Behavior:
#   - Prompts once for secretctl operator credentials (same auth gate as ha-secretctl.sh).
#   - Can seed values from env/.env when present, or prompt hidden input.
#   - Never prints secret values.
#   - Prints generated secret refs at the end.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CODE_DIR="${CODE_DIR:-$REPO_ROOT}"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-infra}"
COMPOSE_FILES="${COMPOSE_FILES:-${CODE_DIR}/infra/docker-compose.ha.yml:${CODE_DIR}/infra/docker-compose.ha.sidecar.yml}"
SECRET_PROVIDER_ID="${SECRET_PROVIDER_ID:-sidecar-main}"
ENV_FILE="${ENV_FILE:-${CODE_DIR}/.env}"
AUTH_REQUIRED="${AUTH_REQUIRED:-1}"
ADD_CUSTOM="${ADD_CUSTOM:-1}"

declare -a COMPOSE_CMD
COMPOSE_CMD=(docker compose -p "${COMPOSE_PROJECT}")
IFS=':' read -r -a _compose_files <<<"${COMPOSE_FILES}"
for file in "${_compose_files[@]}"; do
  [[ -n "$file" ]] || continue
  COMPOSE_CMD+=(-f "$file")
done

log() {
  printf '[secrets-onboard] %s\n' "$*"
}

die() {
  printf '[secrets-onboard] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
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

load_auth_material() {
  local expected_user expected_pass
  expected_user="${NEXUS_SECRETCTL_USERNAME:-}"
  expected_pass="${NEXUS_SECRETCTL_PASSWORD:-}"

  if [[ -z "$expected_user" ]]; then
    expected_user="$(read_env_file_value "NEXUS_SECRETCTL_USERNAME" "$ENV_FILE")"
  fi
  if [[ -z "$expected_pass" ]]; then
    expected_pass="$(read_env_file_value "NEXUS_SECRETCTL_PASSWORD" "$ENV_FILE")"
  fi

  expected_user="${expected_user:-admin}"
  [[ -n "$expected_pass" ]] || die "NEXUS_SECRETCTL_PASSWORD is required (set env or ${ENV_FILE})"

  EXPECTED_SECRETCTL_USER="$expected_user"
  EXPECTED_SECRETCTL_PASS="$expected_pass"
}

require_http_api_key() {
  local api_key="${NEXUS_HTTP_API_KEY:-}"
  if [[ -z "$api_key" ]]; then
    api_key="$(read_env_file_value "NEXUS_HTTP_API_KEY" "$ENV_FILE")"
  fi
  [[ -n "$api_key" ]] || die "NEXUS_HTTP_API_KEY is required (set env or ${ENV_FILE})"
}

authenticate_operator() {
  if [[ "${AUTH_REQUIRED}" == "0" ]]; then
    log "auth gate disabled (AUTH_REQUIRED=0)"
    return
  fi

  require_http_api_key
  load_auth_material

  local entered_user entered_pass
  read -r -p "Secretctl username [${EXPECTED_SECRETCTL_USER}]: " entered_user
  entered_user="${entered_user:-$EXPECTED_SECRETCTL_USER}"
  read -r -s -p "Secretctl password: " entered_pass
  printf '\n'

  if [[ "$entered_user" != "$EXPECTED_SECRETCTL_USER" || "$entered_pass" != "$EXPECTED_SECRETCTL_PASS" ]]; then
    unset entered_user entered_pass EXPECTED_SECRETCTL_PASS
    die "authentication failed"
  fi

  unset entered_user entered_pass EXPECTED_SECRETCTL_PASS
  log "authentication successful"
}

run_sidecar_tsx() {
  local -a extra_env
  extra_env=()
  while [[ "${1:-}" == "-e" ]]; do
    [[ $# -ge 2 ]] || die "run_sidecar_tsx -e requires NAME=VALUE"
    extra_env+=(-e "$2")
    shift 2
  done
  local -a env_args
  env_args=()
  local var_name
  while IFS= read -r var_name; do
    [[ -n "$var_name" ]] || continue
    env_args+=(-e "$var_name")
  done < <(compgen -v | grep '^ONBOARD_' || true)

  "${COMPOSE_CMD[@]}" exec -T "${extra_env[@]}" "${env_args[@]}" secret-sidecar sh -lc 'cd /app && ./node_modules/.bin/tsx'
}

confirm() {
  local prompt="$1"
  local default="${2:-N}"
  local answer=""
  local hint="[y/N]"
  if [[ "$default" == "Y" ]]; then
    hint="[Y/n]"
  fi
  read -r -p "${prompt} ${hint}: " answer
  answer="${answer:-$default}"
  case "${answer}" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

prompt_secret_value() {
  local prompt="$1"
  local required="$2"
  local value="" confirm_value=""
  while true; do
    read -r -s -p "${prompt}: " value
    printf '\n'
    if [[ -z "$value" ]]; then
      if [[ "$required" == "1" ]]; then
        printf 'Value is required.\n'
        continue
      fi
      printf '%s' ""
      return 0
    fi
    read -r -s -p "Confirm ${prompt}: " confirm_value
    printf '\n'
    if [[ "$value" != "$confirm_value" ]]; then
      printf 'Values do not match. Try again.\n'
      continue
    fi
    printf '%s' "$value"
    return 0
  done
}

find_seed_value() {
  local key_csv="$1"
  FOUND_SEED_VALUE=""
  FOUND_SEED_SOURCE=""
  local key
  IFS=',' read -r -a _keys <<<"$key_csv"
  for key in "${_keys[@]}"; do
    key="$(printf '%s' "$key" | xargs)"
    [[ -n "$key" ]] || continue
    local v="${!key:-}"
    if [[ -z "$v" ]]; then
      v="$(read_env_file_value "$key" "$ENV_FILE")"
    fi
    if [[ -n "$v" ]]; then
      FOUND_SEED_VALUE="$v"
      FOUND_SEED_SOURCE="$key"
      return 0
    fi
  done
  return 1
}

upsert_secret() {
  local cred_id="$1"
  local secret_value="$2"
  local note="$3"
  local b64_val=""
  [[ -n "$cred_id" ]] || die "missing credential id"
  [[ -n "$secret_value" ]] || die "missing secret value for $cred_id"
  b64_val="$(printf '%s' "$secret_value" | base64 | tr -d '\n')"

  ONBOARD_PROVIDER_ID="$SECRET_PROVIDER_ID" \
  ONBOARD_CRED_ID="$cred_id" \
  ONBOARD_CRED_NOTE="$note" \
  run_sidecar_tsx -e "_B64_SECRET=${b64_val}" <<'TS'
import { upsertCredential } from "./src/secrets/credentials.ts";

const stateDir = process.env.NEXUS_STATE_DIR || "/data/nexus";
const providerId = (process.env.ONBOARD_PROVIDER_ID || "sidecar-main").trim();
const id = (process.env.ONBOARD_CRED_ID || "").trim();
const password = Buffer.from(process.env._B64_SECRET || "", "base64").toString("utf8");
const note = (process.env.ONBOARD_CRED_NOTE || "").trim();
if (!id) throw new Error("missing credential id");
if (!password) throw new Error(`missing value for ${id}`);

const res = await upsertCredential({
  stateDir,
  id,
  password,
  note: note || undefined,
  overwrite: true,
});

console.log(JSON.stringify({
  ok: true,
  id: res.credential.id,
  passwordEncrypted: res.passwordEncrypted,
  updatedAt: res.credential.updatedAt,
  updatedAtIso: new Date(res.credential.updatedAt).toISOString(),
  refs: {
    password: `{{secret:${providerId}/${res.credential.id}#password}}`,
    username: `{{secret:${providerId}/${res.credential.id}#username}}`,
  },
}, null, 2));
TS
  unset b64_val
}

configure_secret() {
  local cred_id="$1"
  local label="$2"
  local env_keys="$3"
  local required="$4"

  local note="initial onboarding: ${label}"
  local value=""

  printf '\n== %s (%s) ==\n' "$label" "$cred_id"

  if find_seed_value "$env_keys"; then
    if confirm "Seed from ${FOUND_SEED_SOURCE}?" "Y"; then
      value="$FOUND_SEED_VALUE"
    fi
  fi

  if [[ -z "$value" ]]; then
    if [[ "$required" != "1" ]]; then
      if ! confirm "Set this secret now?" "N"; then
        log "skipped: ${cred_id}"
        return 0
      fi
    fi
    value="$(prompt_secret_value "${label}" "$required")"
    if [[ -z "$value" ]]; then
      log "skipped: ${cred_id}"
      return 0
    fi
  fi

  upsert_secret "$cred_id" "$value" "$note"
  CONFIGURED_IDS+=("$cred_id")
  unset value FOUND_SEED_VALUE
}

print_usage() {
  cat <<EOF
Usage: $(basename "$0")

Interactive wizard for initial sidecar secret onboarding.

Environment:
  CODE_DIR=${CODE_DIR}
  COMPOSE_PROJECT=${COMPOSE_PROJECT}
  COMPOSE_FILES=${COMPOSE_FILES}
  SECRET_PROVIDER_ID=${SECRET_PROVIDER_ID}
  ENV_FILE=${ENV_FILE}
  NEXUS_SECRETCTL_USERNAME/NEXUS_SECRETCTL_PASSWORD required for auth gate
  NEXUS_HTTP_API_KEY required
  AUTH_REQUIRED=1 (set 0 to disable auth gate)
  ADD_CUSTOM=1    (set 0 to skip custom secret prompt loop)

Baseline secrets:
  llm.openrouter.api
  telegram.bot.token
  search.brave.api
  twitter.auth.auth_token
  twitter.auth.ct0
EOF
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    print_usage
    exit 0
  fi

  require_cmd docker
  require_cmd base64

  authenticate_operator

  log "verifying sidecar exec path"
  "${COMPOSE_CMD[@]}" exec -T secret-sidecar sh -lc 'test -x /app/node_modules/.bin/tsx' >/dev/null

  declare -ga CONFIGURED_IDS
  CONFIGURED_IDS=()

  configure_secret "llm.openrouter.api" "OpenRouter API key" "OPENROUTER_API_KEY" "1"
  configure_secret "telegram.bot.token" "Telegram bot token" "TELEGRAM_BOT_TOKEN" "0"
  configure_secret "search.brave.api" "Brave API key" "BRAVE_API_KEY" "0"
  configure_secret "twitter.auth.auth_token" "Twitter auth token" "TWITTER_AUTH_TOKEN,AUTH_TOKEN" "0"
  configure_secret "twitter.auth.ct0" "Twitter ct0 cookie" "TWITTER_CT0,CT0" "0"

  if [[ "${ADD_CUSTOM}" == "1" ]]; then
    while confirm "Add another secret?" "N"; do
      local custom_id="" custom_label="" custom_required="0" custom_value=""
      read -r -p "Credential id (example: mcp.github.pat): " custom_id
      custom_id="$(printf '%s' "$custom_id" | xargs)"
      [[ -n "$custom_id" ]] || {
        log "empty id, skipping"
        continue
      }
      read -r -p "Label/description: " custom_label
      custom_label="$(printf '%s' "$custom_label" | xargs)"
      [[ -n "$custom_label" ]] || custom_label="$custom_id"
      custom_value="$(prompt_secret_value "$custom_label" "$custom_required")"
      [[ -n "$custom_value" ]] || {
        log "skipped: ${custom_id}"
        continue
      }
      upsert_secret "$custom_id" "$custom_value" "initial onboarding: ${custom_label}"
      CONFIGURED_IDS+=("$custom_id")
      unset custom_value
    done
  fi

  printf '\n'
  if [[ ${#CONFIGURED_IDS[@]} -eq 0 ]]; then
    log "no secrets were changed"
    exit 0
  fi

  log "onboarding complete; generated refs:"
  local id
  for id in "${CONFIGURED_IDS[@]}"; do
    printf '  - %s -> {{secret:%s/%s#password}}\n' "$id" "$SECRET_PROVIDER_ID" "$id"
  done
}

main "$@"
