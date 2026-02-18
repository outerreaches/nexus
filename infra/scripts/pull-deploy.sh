#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[pull-deploy] %s\n' "$*"
}

fail() {
  printf '[pull-deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

CODE_DIR="${CODE_DIR:-/data/code}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-infra}"
BASE_COMPOSE="${BASE_COMPOSE:-${CODE_DIR}/infra/docker-compose.ha.yml}"
SIDECAR_COMPOSE="${SIDECAR_COMPOSE:-${CODE_DIR}/infra/docker-compose.ha.sidecar.yml}"
TLS_COMPOSE="${TLS_COMPOSE:-${CODE_DIR}/infra/docker-compose.ha.tls.yml}"
TLS_CERT_PEM="${NEXUS_HAPROXY_TLS_CERT_PEM:-${CODE_DIR}/infra/haproxy/certs/nexus.pem}"
ENABLE_SIDECAR="${ENABLE_SIDECAR:-1}"
ENABLE_TLS="${ENABLE_TLS:-1}"
PRUNE_OLD_ARTIFACTS="${PRUNE_OLD_ARTIFACTS:-1}"
PRUNE_UNTIL="${PRUNE_UNTIL:-168h}"

[ -d "$CODE_DIR" ] || fail "missing code dir: ${CODE_DIR}"
[ -f "$BASE_COMPOSE" ] || fail "missing compose file: ${BASE_COMPOSE}"

cd "$CODE_DIR"
old_sha="$(git rev-parse HEAD)"
git fetch origin main
git merge --ff-only origin/main
new_sha="$(git rev-parse HEAD)"
log "updated code: ${old_sha} -> ${new_sha}"

if git diff --name-only "$old_sha" "$new_sha" | grep -Eq '^(infra/scripts/ha-deployer\.sh|infra/systemd/ha-deployer\.service)$'; then
  if command -v systemctl >/dev/null 2>&1; then
    log "ha-deployer changed; reloading unit + restarting service"
    sudo systemctl daemon-reload
    sudo systemctl restart ha-deployer
  fi
fi

declare -a compose_files=("$BASE_COMPOSE")

if [ "$ENABLE_SIDECAR" = "1" ]; then
  if [ -f "$SIDECAR_COMPOSE" ]; then
    compose_files+=("$SIDECAR_COMPOSE")
  else
    log "sidecar overlay not found, continuing without it: ${SIDECAR_COMPOSE}"
  fi
fi

if [ "$ENABLE_TLS" = "1" ]; then
  [ -f "$TLS_COMPOSE" ] || fail "missing TLS compose overlay: ${TLS_COMPOSE}"
  [ -f "$TLS_CERT_PEM" ] || fail "missing TLS cert bundle: ${TLS_CERT_PEM}"
  if [ ! -r "$TLS_CERT_PEM" ]; then
    log "TLS cert is not readable; attempting chmod 644: ${TLS_CERT_PEM}"
    chmod 644 "$TLS_CERT_PEM" 2>/dev/null || sudo chmod 644 "$TLS_CERT_PEM" 2>/dev/null || fail "TLS cert exists but cannot be made readable: ${TLS_CERT_PEM}"
  fi
  compose_files+=("$TLS_COMPOSE")
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

if [ "$ENABLE_TLS" = "1" ] && command -v openssl >/dev/null 2>&1; then
  fingerprint="$(openssl x509 -in "$TLS_CERT_PEM" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//' | tr -d '\r\n')"
  if [ -n "$fingerprint" ]; then
    log "gateway TLS fingerprint: ${fingerprint}"
  fi
fi
