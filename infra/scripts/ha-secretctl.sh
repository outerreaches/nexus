#!/usr/bin/env bash
# Sidecar credential manager (metadata only; never prints secret values).
#
# Commands:
#   list
#   info <credential-id>
#   refs <credential-id>
#   set <credential-id> [--username <value>] [--note <text>] [--no-password]
#   delete <credential-id> [--yes]
#
# Auth gate:
#   Prompts for secretctl operator credentials and validates against
#   NEXUS_SECRETCTL_USERNAME / NEXUS_SECRETCTL_PASSWORD.
#   Values are read from environment first, then split env files if present.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOST_OS="${NEXUS_HOST_OS:-$(uname -s 2>/dev/null || echo unknown)}"
IS_DARWIN=0
if [ "$HOST_OS" = "Darwin" ]; then
  IS_DARWIN=1
fi

if [ -n "${NEXUS_HOME:-}" ]; then
  DEFAULT_NEXUS_HOME="$NEXUS_HOME"
elif [ -d "/data/code" ] || [ -d "/data/nexus-config" ] || [ -d "/data/nexus" ]; then
  DEFAULT_NEXUS_HOME=""
else
  DEFAULT_NEXUS_HOME="${HOME}/.nexus"
fi

if [ -n "$DEFAULT_NEXUS_HOME" ]; then
  DEFAULT_CODE_DIR="${DEFAULT_NEXUS_HOME}/code"
  DEFAULT_CONFIG_ROOT="${DEFAULT_NEXUS_HOME}/config"
  DEFAULT_STATE_DIR="${DEFAULT_NEXUS_HOME}/state"
  DEFAULT_STORE_DIR="${DEFAULT_NEXUS_HOME}/secrets"
else
  DEFAULT_CODE_DIR="${REPO_ROOT}"
  DEFAULT_CONFIG_ROOT="/data/nexus-config"
  DEFAULT_STATE_DIR="/data/nexus"
  DEFAULT_STORE_DIR="/data/nexus-secrets"
fi

CODE_DIR="${CODE_DIR:-${NEXUS_CODE_DIR:-${DEFAULT_CODE_DIR}}}"
CONFIG_ROOT="${CONFIG_ROOT:-${DEFAULT_CONFIG_ROOT}}"
STATE_DIR="${STATE_DIR:-${NEXUS_STATE_DIR:-${DEFAULT_STATE_DIR}}}"
STORE_DIR="${STORE_DIR:-${NEXUS_STORE_DIR:-${DEFAULT_STORE_DIR}}}"
HOST_CODE_DIR="${NEXUS_HOST_CODE_DIR:-${CODE_DIR}}"
HOST_STATE_DIR="${NEXUS_HOST_STATE_DIR:-${STATE_DIR}}"
HOST_SECRETS_DIR="${NEXUS_HOST_SECRETS_DIR:-${STORE_DIR}}"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-infra}"
DEFAULT_MACOS_COMPOSE="${CODE_DIR}/infra/docker-compose.ha.macos.yml"
DEFAULT_COMPOSE_FILES="${CODE_DIR}/infra/docker-compose.ha.yml:${CODE_DIR}/infra/docker-compose.ha.sidecar.yml"
if [ "$IS_DARWIN" -eq 1 ] && [ -f "$DEFAULT_MACOS_COMPOSE" ]; then
  DEFAULT_COMPOSE_FILES="${DEFAULT_COMPOSE_FILES}:${DEFAULT_MACOS_COMPOSE}"
fi
COMPOSE_FILES="${COMPOSE_FILES:-${DEFAULT_COMPOSE_FILES}}"
SECRET_PROVIDER_ID="${SECRET_PROVIDER_ID:-sidecar-main}"
GATEWAY_ENV_FILE="${GATEWAY_ENV_FILE:-${CONFIG_ROOT}/gateway/nexus.env}"
SIDECAR_ENV_FILE="${SIDECAR_ENV_FILE:-${CONFIG_ROOT}/sidecar/nexus.env}"

AUTH_REQUIRED="${AUTH_REQUIRED:-1}"

export NEXUS_GATEWAY_ENV_FILE="${GATEWAY_ENV_FILE}"
export NEXUS_SIDECAR_ENV_FILE="${SIDECAR_ENV_FILE}"
export NEXUS_HOST_CODE_DIR="${HOST_CODE_DIR}"
export NEXUS_HOST_STATE_DIR="${HOST_STATE_DIR}"
export NEXUS_HOST_SECRETS_DIR="${HOST_SECRETS_DIR}"
if [ "$IS_DARWIN" -eq 1 ]; then
  export NEXUS_GATEWAY_UID="${NEXUS_GATEWAY_UID:-$(id -u)}"
  export NEXUS_GATEWAY_GID="${NEXUS_GATEWAY_GID:-$(id -g)}"
fi

declare -a COMPOSE_CMD
COMPOSE_CMD=(docker compose -p "${COMPOSE_PROJECT}")
IFS=':' read -r -a _compose_files <<<"${COMPOSE_FILES}"
for file in "${_compose_files[@]}"; do
  [[ -n "$file" ]] || continue
  COMPOSE_CMD+=(-f "$file")
done

log() {
  printf '[secretctl] %s\n' "$*"
}

die() {
  printf '[secretctl] ERROR: %s\n' "$*" >&2
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
    expected_user="$(read_env_file_value "NEXUS_SECRETCTL_USERNAME" "$SIDECAR_ENV_FILE")"
  fi
  if [[ -z "$expected_pass" ]]; then
    expected_pass="$(read_env_file_value "NEXUS_SECRETCTL_PASSWORD" "$SIDECAR_ENV_FILE")"
  fi

  expected_user="${expected_user:-admin}"
  [[ -n "$expected_pass" ]] || die "NEXUS_SECRETCTL_PASSWORD is required (set env or ${SIDECAR_ENV_FILE})"

  EXPECTED_SECRETCTL_USER="$expected_user"
  EXPECTED_SECRETCTL_PASS="$expected_pass"
}

require_http_api_key() {
  local api_key="${NEXUS_HTTP_API_KEY:-}"
  if [[ -z "$api_key" ]]; then
    api_key="$(read_env_file_value "NEXUS_HTTP_API_KEY" "$GATEWAY_ENV_FILE")"
  fi
  [[ -n "$api_key" ]] || die "NEXUS_HTTP_API_KEY is required (set env or ${GATEWAY_ENV_FILE})"
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
  done < <(compgen -v | grep '^SECRETCTL_' || true)

  local -a cmd
  cmd=("${COMPOSE_CMD[@]}" exec -T)
  if [[ ${#extra_env[@]} -gt 0 ]]; then
    cmd+=("${extra_env[@]}")
  fi
  if [[ ${#env_args[@]} -gt 0 ]]; then
    cmd+=("${env_args[@]}")
  fi
  cmd+=(secret-sidecar sh -lc 'cd /app && ./node_modules/.bin/tsx')
  "${cmd[@]}"
}

print_usage() {
  cat <<EOF
Usage: $(basename "$0") <command> [args]

Commands:
  list
      List credential metadata and reference strings.

  info <credential-id>
      Show metadata for one credential (no secret values).

  refs <credential-id>
      Print secret references for one credential.

  set <credential-id> [--username <value>] [--note <text>] [--no-password]
      Add or update credential metadata/password.
      Prompts for password unless --no-password is used.

  delete <credential-id> [--yes]
      Delete credential by id.

Environment:
  CODE_DIR=${CODE_DIR}
  STATE_DIR=${STATE_DIR}
  STORE_DIR=${STORE_DIR}
  COMPOSE_PROJECT=${COMPOSE_PROJECT}
  COMPOSE_FILES=${COMPOSE_FILES}
  SECRET_PROVIDER_ID=${SECRET_PROVIDER_ID}
  GATEWAY_ENV_FILE=${GATEWAY_ENV_FILE}
  SIDECAR_ENV_FILE=${SIDECAR_ENV_FILE}
  NEXUS_SECRETCTL_USERNAME/NEXUS_SECRETCTL_PASSWORD required for auth gate
  NEXUS_HTTP_API_KEY required
  AUTH_REQUIRED=1 (default; set 0 to disable local auth gate)
EOF
}

cmd_list() {
  SECRETCTL_PROVIDER_ID="$SECRET_PROVIDER_ID" run_sidecar_tsx <<'TS'
import { listCredentials } from "./src/secrets/credentials.ts";

const stateDir = process.env.NEXUS_STATE_DIR || "/data/nexus";
const providerId = (process.env.SECRETCTL_PROVIDER_ID || "sidecar-main").trim();

const items = await listCredentials(stateDir);
const rows = items
  .slice()
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((item) => ({
    id: item.id,
    hasUsername: item.hasUsername,
    hasPassword: item.hasPassword,
    updatedAt: item.updatedAt,
    updatedAtIso: new Date(item.updatedAt).toISOString(),
    note: item.note ?? null,
    refs: {
      password: `{{secret:${providerId}/${item.id}#password}}`,
      username: `{{secret:${providerId}/${item.id}#username}}`,
    },
  }));

console.log(JSON.stringify({
  ok: true,
  providerId,
  total: rows.length,
  credentials: rows,
}, null, 2));
TS
}

cmd_info() {
  local cred_id="$1"
  [[ -n "$cred_id" ]] || die "info requires <credential-id>"
  SECRETCTL_PROVIDER_ID="$SECRET_PROVIDER_ID" SECRETCTL_CRED_ID="$cred_id" run_sidecar_tsx <<'TS'
import { listCredentials } from "./src/secrets/credentials.ts";

const stateDir = process.env.NEXUS_STATE_DIR || "/data/nexus";
const providerId = (process.env.SECRETCTL_PROVIDER_ID || "sidecar-main").trim();
const credId = (process.env.SECRETCTL_CRED_ID || "").trim();
if (!credId) throw new Error("missing credential id");

const items = await listCredentials(stateDir);
const item = items.find((row) => row.id === credId);
if (!item) {
  console.log(JSON.stringify({ ok: false, error: `credential_not_found:${credId}` }, null, 2));
  process.exit(2);
}

console.log(JSON.stringify({
  ok: true,
  providerId,
  credential: {
    id: item.id,
    hasUsername: item.hasUsername,
    hasPassword: item.hasPassword,
    updatedAt: item.updatedAt,
    updatedAtIso: new Date(item.updatedAt).toISOString(),
    note: item.note ?? null,
    refs: {
      password: `{{secret:${providerId}/${item.id}#password}}`,
      username: `{{secret:${providerId}/${item.id}#username}}`,
    },
  },
}, null, 2));
TS
}

cmd_refs() {
  local cred_id="$1"
  [[ -n "$cred_id" ]] || die "refs requires <credential-id>"
  printf 'password_ref={{secret:%s/%s#password}}\n' "$SECRET_PROVIDER_ID" "$cred_id"
  printf 'username_ref={{secret:%s/%s#username}}\n' "$SECRET_PROVIDER_ID" "$cred_id"
}

cmd_set() {
  local cred_id="$1"
  shift || true
  [[ -n "$cred_id" ]] || die "set requires <credential-id>"

  local username=""
  local note=""
  local set_password=1
  local has_username=0
  local has_note=0
  local has_password=0
  local password=""
  local b64_pw=""
  local b64_un=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --username)
        [[ $# -ge 2 ]] || die "--username requires a value"
        username="$2"
        has_username=1
        shift 2
        ;;
      --note)
        [[ $# -ge 2 ]] || die "--note requires a value"
        note="$2"
        has_note=1
        shift 2
        ;;
      --no-password)
        set_password=0
        shift
        ;;
      -h|--help)
        cat <<EOF
Usage: $(basename "$0") set <credential-id> [--username <value>] [--note <text>] [--no-password]
EOF
        exit 0
        ;;
      *)
        die "unknown set option: $1"
        ;;
    esac
  done

  if (( set_password )); then
    local confirm=""
    read -r -s -p "Password for ${cred_id} (leave empty to keep existing): " password
    printf '\n'
    if [[ -n "$password" ]]; then
      read -r -s -p "Confirm password: " confirm
      printf '\n'
      [[ "$password" == "$confirm" ]] || die "password confirmation mismatch"
      has_password=1
    fi
  fi

  if (( has_username == 0 && has_note == 0 && has_password == 0 )); then
    die "nothing to update (set --username/--note and/or enter password)"
  fi

  if (( has_password )); then
    b64_pw="$(printf '%s' "$password" | base64 | tr -d '\n')"
  fi
  if (( has_username )); then
    b64_un="$(printf '%s' "$username" | base64 | tr -d '\n')"
  fi

  SECRETCTL_PROVIDER_ID="$SECRET_PROVIDER_ID" \
  SECRETCTL_CRED_ID="$cred_id" \
  SECRETCTL_CRED_NOTE="$note" \
  SECRETCTL_HAS_USERNAME="$has_username" \
  SECRETCTL_HAS_NOTE="$has_note" \
  SECRETCTL_HAS_PASSWORD="$has_password" \
  run_sidecar_tsx \
  -e "_B64_PW=${b64_pw}" \
  -e "_B64_UN=${b64_un}" <<'TS'
import { upsertCredential } from "./src/secrets/credentials.ts";

const stateDir = process.env.NEXUS_STATE_DIR || "/data/nexus";
const providerId = (process.env.SECRETCTL_PROVIDER_ID || "sidecar-main").trim();
const id = (process.env.SECRETCTL_CRED_ID || "").trim();
if (!id) throw new Error("missing credential id");

const hasUsername = process.env.SECRETCTL_HAS_USERNAME === "1";
const hasNote = process.env.SECRETCTL_HAS_NOTE === "1";
const hasPassword = process.env.SECRETCTL_HAS_PASSWORD === "1";

const params: {
  stateDir: string;
  id: string;
  username?: string;
  note?: string;
  password?: string;
  overwrite?: boolean;
} = {
  stateDir,
  id,
  overwrite: false,
};
if (hasUsername) params.username = Buffer.from(process.env._B64_UN || "", "base64").toString("utf8");
if (hasNote) params.note = process.env.SECRETCTL_CRED_NOTE ?? "";
if (hasPassword) params.password = Buffer.from(process.env._B64_PW || "", "base64").toString("utf8");

const res = await upsertCredential(params);
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
  unset b64_pw b64_un password
}

cmd_delete() {
  local cred_id="$1"
  shift || true
  [[ -n "$cred_id" ]] || die "delete requires <credential-id>"

  local confirm=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --yes) confirm=1; shift ;;
      -h|--help)
        cat <<EOF
Usage: $(basename "$0") delete <credential-id> [--yes]
EOF
        exit 0
        ;;
      *)
        die "unknown delete option: $1"
        ;;
    esac
  done

  if (( confirm == 0 )); then
    local reply=""
    read -r -p "Delete credential '${cred_id}'? [y/N]: " reply
    [[ "$reply" == "y" || "$reply" == "Y" ]] || die "aborted"
  fi

  SECRETCTL_CRED_ID="$cred_id" run_sidecar_tsx <<'TS'
import { deleteCredential } from "./src/secrets/credentials.ts";

const stateDir = process.env.NEXUS_STATE_DIR || "/data/nexus";
const id = (process.env.SECRETCTL_CRED_ID || "").trim();
if (!id) throw new Error("missing credential id");

const deleted = await deleteCredential({ stateDir, id });
console.log(JSON.stringify({ ok: true, id, deleted }, null, 2));
if (!deleted) process.exit(3);
TS
}

main() {
  require_cmd docker
  require_cmd base64

  local cmd="${1:-}"
  [[ -n "$cmd" ]] || {
    print_usage
    exit 1
  }
  shift || true

  if [[ "$cmd" != "-h" && "$cmd" != "--help" ]]; then
    authenticate_operator
  fi

  case "$cmd" in
    list)
      cmd_list
      ;;
    info)
      [[ $# -ge 1 ]] || die "info requires <credential-id>"
      cmd_info "$1"
      ;;
    refs)
      [[ $# -ge 1 ]] || die "refs requires <credential-id>"
      cmd_refs "$1"
      ;;
    set)
      [[ $# -ge 1 ]] || die "set requires <credential-id>"
      cmd_set "$@"
      ;;
    delete)
      [[ $# -ge 1 ]] || die "delete requires <credential-id>"
      cmd_delete "$@"
      ;;
    -h|--help)
      print_usage
      ;;
    *)
      die "unknown command: $cmd"
      ;;
  esac
}

main "$@"
