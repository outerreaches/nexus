#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[pull-deploy] %s\n' "$*"
}

fail() {
  printf '[pull-deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOST_OS="${NEXUS_HOST_OS:-$(uname -s 2>/dev/null || echo unknown)}"
IS_DARWIN=0
if [ "$HOST_OS" = "Darwin" ]; then
  IS_DARWIN=1
fi

if [ -n "${NEXUS_HOME:-}" ]; then
  DEFAULT_NEXUS_HOME="$NEXUS_HOME"
elif [ -d "/data/code" ] || [ -d "/data/nexus-config" ]; then
  DEFAULT_NEXUS_HOME=""
else
  DEFAULT_NEXUS_HOME="${HOME}/.nexus"
fi

if [ -n "$DEFAULT_NEXUS_HOME" ]; then
  DEFAULT_CONFIG_ROOT="${DEFAULT_NEXUS_HOME}/config"
  DEFAULT_STATE_DIR="${DEFAULT_NEXUS_HOME}/state"
  DEFAULT_WORKSPACE_DIR="${DEFAULT_NEXUS_HOME}/workspace"
  DEFAULT_STORE_DIR="${DEFAULT_NEXUS_HOME}/secrets"
else
  DEFAULT_CONFIG_ROOT="/data/nexus-config"
  DEFAULT_STATE_DIR="/data/nexus"
  DEFAULT_WORKSPACE_DIR="/data/workspace"
  DEFAULT_STORE_DIR="/data/nexus-secrets"
fi

CODE_DIR="${CODE_DIR:-${NEXUS_CODE_DIR:-${REPO_ROOT}}}"
CONFIG_ROOT="${CONFIG_ROOT:-${DEFAULT_CONFIG_ROOT}}"
STATE_DIR="${STATE_DIR:-${NEXUS_STATE_DIR:-${DEFAULT_STATE_DIR}}}"
WORKSPACE_DIR="${WORKSPACE_DIR:-${NEXUS_WORKSPACE_DIR:-${DEFAULT_WORKSPACE_DIR}}}"
STORE_DIR="${STORE_DIR:-${DEFAULT_STORE_DIR}}"
HOST_CODE_DIR="${NEXUS_HOST_CODE_DIR:-${CODE_DIR}}"
HOST_STATE_DIR="${NEXUS_HOST_STATE_DIR:-${STATE_DIR}}"
HOST_WORKSPACE_DIR="${NEXUS_HOST_WORKSPACE_DIR:-${WORKSPACE_DIR}}"
HOST_SECRETS_DIR="${NEXUS_HOST_SECRETS_DIR:-${STORE_DIR}}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-infra}"
BASE_COMPOSE="${BASE_COMPOSE:-${CODE_DIR}/infra/docker-compose.ha.yml}"
SIDECAR_COMPOSE="${SIDECAR_COMPOSE:-${CODE_DIR}/infra/docker-compose.ha.sidecar.yml}"
TLS_COMPOSE="${TLS_COMPOSE:-${CODE_DIR}/infra/docker-compose.ha.tls.yml}"
MACOS_COMPOSE="${MACOS_COMPOSE:-${CODE_DIR}/infra/docker-compose.ha.macos.yml}"
TLS_CERT_PEM="${NEXUS_HAPROXY_TLS_CERT_PEM:-${CODE_DIR}/infra/haproxy/certs/nexus.pem}"
GATEWAY_ENV_FILE="${GATEWAY_ENV_FILE:-${CONFIG_ROOT}/gateway/nexus.env}"
SIDECAR_ENV_FILE="${SIDECAR_ENV_FILE:-${CONFIG_ROOT}/sidecar/nexus.env}"
WATCHDOG_ENV_FILE="${WATCHDOG_ENV_FILE:-${CONFIG_ROOT}/watchdog/nexus.env}"
PRUNE_OLD_ARTIFACTS="${PRUNE_OLD_ARTIFACTS:-1}"
PRUNE_UNTIL="${PRUNE_UNTIL:-168h}"

[ -d "$CODE_DIR" ] || fail "missing code dir: ${CODE_DIR}"
[ -f "$BASE_COMPOSE" ] || fail "missing compose file: ${BASE_COMPOSE}"
[ -f "$SIDECAR_COMPOSE" ] || fail "missing compose overlay: ${SIDECAR_COMPOSE}"
[ -f "$TLS_COMPOSE" ] || fail "missing compose overlay: ${TLS_COMPOSE}"
[ -f "$TLS_CERT_PEM" ] || fail "missing TLS cert bundle: ${TLS_CERT_PEM}"
[ -f "$GATEWAY_ENV_FILE" ] || fail "missing gateway env file: ${GATEWAY_ENV_FILE}"
[ -f "$SIDECAR_ENV_FILE" ] || fail "missing sidecar env file: ${SIDECAR_ENV_FILE}"
[ -f "$WATCHDOG_ENV_FILE" ] || fail "missing watchdog env file: ${WATCHDOG_ENV_FILE}"

export NEXUS_GATEWAY_ENV_FILE="${GATEWAY_ENV_FILE}"
export NEXUS_SIDECAR_ENV_FILE="${SIDECAR_ENV_FILE}"
export NEXUS_WATCHDOG_ENV_FILE="${WATCHDOG_ENV_FILE}"
export NEXUS_HOST_CODE_DIR="${HOST_CODE_DIR}"
export NEXUS_HOST_STATE_DIR="${HOST_STATE_DIR}"
export NEXUS_HOST_WORKSPACE_DIR="${HOST_WORKSPACE_DIR}"
export NEXUS_HOST_SECRETS_DIR="${HOST_SECRETS_DIR}"

RUNTIME_UID="${NEXUS_GATEWAY_UID:-$(id -u)}"
RUNTIME_GID="${NEXUS_GATEWAY_GID:-$(id -g)}"
export NEXUS_GATEWAY_UID="${RUNTIME_UID}"
export NEXUS_GATEWAY_GID="${RUNTIME_GID}"

restart_ha_deployer() {
  local service_label plist_path uid domain
  if command -v systemctl >/dev/null 2>&1; then
    log "ha-deployer changed; reloading unit + restarting service"
    sudo systemctl daemon-reload
    sudo systemctl restart ha-deployer
    return 0
  fi

  if [ "$IS_DARWIN" -eq 1 ] && command -v launchctl >/dev/null 2>&1; then
    service_label="${NEXUS_HA_DEPLOYER_LABEL:-io.outerreaches.nexus.ha-deployer}"
    plist_path="${NEXUS_HA_DEPLOYER_PLIST:-${HOME}/Library/LaunchAgents/${service_label}.plist}"
    if [ ! -f "$plist_path" ]; then
      log "ha-deployer changed; launchd plist not found at ${plist_path}, skipping restart"
      return 0
    fi
    uid="$(id -u)"
    for domain in "gui/${uid}" "user/${uid}"; do
      if launchctl kickstart -k "${domain}/${service_label}" >/dev/null 2>&1; then
        log "ha-deployer changed; restarted launchd job ${domain}/${service_label}"
        return 0
      fi
    done
    log "ha-deployer changed; launchd restart failed for ${service_label}"
  fi
}

ensure_runtime_dir() {
  local dir="$1"
  [ -n "$dir" ] || return 0
  mkdir -p "$dir" 2>/dev/null || sudo mkdir -p "$dir"
  if ! chown "${RUNTIME_UID}:${RUNTIME_GID}" "$dir" 2>/dev/null; then
    sudo chown "${RUNTIME_UID}:${RUNTIME_GID}" "$dir"
  fi
}

ensure_runtime_dir "${HOST_STATE_DIR}"
ensure_runtime_dir "${HOST_STATE_DIR}/candidates"
ensure_runtime_dir "${HOST_STATE_DIR}/interactive-shell"
ensure_runtime_dir "${HOST_WORKSPACE_DIR}"

cd "$CODE_DIR"
git fetch origin main
target_sha="$(git rev-parse origin/main)"
current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_branch" != "main" ]; then
  log "switching branch: ${current_branch} -> main"
  if git show-ref --verify --quiet refs/heads/main; then
    git switch main >/dev/null 2>&1 || git checkout main >/dev/null
  else
    git switch -c main --track origin/main >/dev/null 2>&1 || git checkout -b main --track origin/main >/dev/null
  fi
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  fail "working tree has local tracked changes; commit/stash before deploy sync"
fi

old_sha="$(git rev-parse HEAD)"
if [ "$old_sha" != "$target_sha" ] && ! git merge-base --is-ancestor "$old_sha" "$target_sha"; then
  backup_branch="backup/pull-deploy-$(date +%Y%m%d-%H%M%S)"
  git branch "$backup_branch" "$old_sha"
  log "non-fast-forward update detected; backup branch created: ${backup_branch} @ ${old_sha}"
fi

git reset --hard "$target_sha" >/dev/null
new_sha="$(git rev-parse HEAD)"
log "synced code to origin/main: ${old_sha} -> ${new_sha}"

if git diff --name-only "$old_sha" "$new_sha" | grep -Eq '^(infra/scripts/ha-deployer\.sh|infra/systemd/ha-deployer\.service)$'; then
  restart_ha_deployer
fi

declare -a compose_files=(
  "$BASE_COMPOSE"
  "$SIDECAR_COMPOSE"
  "$TLS_COMPOSE"
)
if [ "$IS_DARWIN" -eq 1 ]; then
  [ -f "$MACOS_COMPOSE" ] || fail "missing macOS compose overlay: ${MACOS_COMPOSE}"
  compose_files+=("$MACOS_COMPOSE")
fi

if [ ! -r "$TLS_CERT_PEM" ]; then
  log "TLS cert is not readable; attempting chmod 644: ${TLS_CERT_PEM}"
  chmod 644 "$TLS_CERT_PEM" 2>/dev/null || sudo chmod 644 "$TLS_CERT_PEM" 2>/dev/null || fail "TLS cert exists but cannot be made readable: ${TLS_CERT_PEM}"
fi

compose_cmd=(docker compose -p "$COMPOSE_PROJECT")
for file in "${compose_files[@]}"; do
  compose_cmd+=(-f "$file")
done

log "bringing stack up with compose files:"
for file in "${compose_files[@]}"; do
  log "  - ${file}"
done
"${compose_cmd[@]}" up -d --build --force-recreate --remove-orphans
"${compose_cmd[@]}" ps

if [ "$PRUNE_OLD_ARTIFACTS" = "1" ]; then
  log "pruning stopped project containers and old images/build cache (until=${PRUNE_UNTIL})"
  docker container prune -f --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" >/dev/null || true
  docker image prune -f --filter "until=${PRUNE_UNTIL}" >/dev/null || true
  docker builder prune -f --filter "until=${PRUNE_UNTIL}" >/dev/null || true
fi

if command -v openssl >/dev/null 2>&1; then
  fingerprint="$(openssl x509 -in "$TLS_CERT_PEM" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//' | tr -d '\r\n')"
  if [ -n "$fingerprint" ]; then
    log "gateway TLS fingerprint: ${fingerprint}"
  fi
fi
