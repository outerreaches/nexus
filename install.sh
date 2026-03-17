#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${NEXUS_HOME:-$HOME/.nexus}"
CODE_DIR=""
REPO_URL="${NEXUS_REPO_URL:-}"
BRANCH="${NEXUS_REPO_BRANCH:-main}"
BIN_PATH="${NEXUS_BIN_PATH:-$HOME/.local/bin/nexus}"
NON_INTERACTIVE=0
YES=0
DRY_RUN=0

usage() {
  cat <<EOF
Usage: install.sh --repo-url <git-url> [options]

Options:
  --repo-url <url>      Git repository URL (required unless NEXUS_REPO_URL is set)
  --branch <name>       Git branch to checkout/update (default: ${BRANCH})
  --root <path>         Nexus home directory (default: ${ROOT_DIR})
  --code-dir <path>     Code checkout directory (default: <root>/code)
  --bin-path <path>     Install nexus launcher at this path (default: ${BIN_PATH})
  --yes                 Accept wizard defaults and confirmations
  --non-interactive     Run setup wizard without prompts
  --dry-run             Print actions without executing deployment commands
  -h, --help            Show this help

Example:
  curl -fsSL <raw-install-url> | bash -s -- --repo-url https://github.com/<org>/<repo>.git
EOF
}

fail() {
  printf '[install] ERROR: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[install] %s\n' "$*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

install_nexus_launcher() {
  local target="$1"
  local launcher_dir launcher_path
  launcher_path="$BIN_PATH"
  launcher_dir="$(dirname "$launcher_path")"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log "dry-run: would install launcher ${launcher_path} -> ${target}"
    return
  fi

  mkdir -p "$launcher_dir"
  cat > "$launcher_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail

LOCAL_ENTRYPOINT="$target"
CONTAINER_ENTRYPOINT="\${NEXUS_CONTAINER_ENTRYPOINT:-/app/dist/index.js}"
COMPOSE_PROJECT="\${COMPOSE_PROJECT:-infra}"
CLI_TARGET="\${NEXUS_CLI_TARGET:-active-container}"
KNOWN_SERVICES=("nexus-primary" "nexus-standby" "nexus")

print_err() {
  printf '[nexus-launcher] ERROR: %s\n' "\$*" >&2
}

first_subcommand() {
  local expect_config=0 arg
  for arg in "\$@"; do
    if [[ "\$expect_config" -eq 1 ]]; then
      expect_config=0
      continue
    fi
    case "\$arg" in
      --config)
        expect_config=1
        ;;
      --config=*|--verbose|-v|--help|-h)
        ;;
      --*)
        ;;
      -*)
        ;;
      *)
        printf '%s' "\$arg"
        return 0
        ;;
    esac
  done
  return 1
}

container_id_for_service() {
  local project="\$1"
  local service="\$2"
  docker ps \
    --filter "label=com.docker.compose.project=\$project" \
    --filter "label=com.docker.compose.service=\$service" \
    --format '{{.ID}}' | head -n1
}

resolve_active_service_for_project() {
  local project="\$1"
  local cid mode_payload service
  for service in "\${KNOWN_SERVICES[@]}"; do
    cid="\$(container_id_for_service "\$project" "\$service")"
    [[ -n "\$cid" ]] || continue
    mode_payload="\$(docker exec "\$cid" sh -lc 'curl -fsS --max-time 2 http://localhost:18789/api/mode' 2>/dev/null || true)"
    if [[ "\$mode_payload" == *'"mode":"active"'* ]]; then
      printf '%s\n%s' "\$project" "\$service"
      return 0
    fi
  done
  for service in "\${KNOWN_SERVICES[@]}"; do
    cid="\$(container_id_for_service "\$project" "\$service")"
    if [[ -n "\$cid" ]]; then
      printf '%s\n%s' "\$project" "\$service"
      return 0
    fi
  done
  return 1
}

candidate_projects() {
  local service
  {
    printf '%s\n' "\$COMPOSE_PROJECT"
    for service in "\${KNOWN_SERVICES[@]}"; do
      docker ps --filter "label=com.docker.compose.service=\$service" --format '{{.Label "com.docker.compose.project"}}'
    done
  } | awk 'NF && !seen[\$0]++'
}

resolve_active_target() {
  local project result
  while IFS= read -r project; do
    [[ -n "\$project" ]] || continue
    result="\$(resolve_active_service_for_project "\$project" || true)"
    [[ -n "\$result" ]] || continue
    printf '%s' "\$result"
    return 0
  done < <(candidate_projects)
  return 1
}

subcommand="\$(first_subcommand "\$@" || true)"
if [[ "\$CLI_TARGET" == "host" ]] || [[ "\$subcommand" == "setup" ]] || [[ "\$subcommand" == "uninstall" ]] || [[ "\$subcommand" == "secrets" ]]; then
  exec node "\$LOCAL_ENTRYPOINT" "\$@"
fi

command -v docker >/dev/null 2>&1 || {
  print_err "docker is required for active-container mode; set NEXUS_CLI_TARGET=host to bypass"
  exit 1
}

target_info="\$(resolve_active_target || true)"
if [[ -z "\$target_info" ]]; then
  print_err "no running gateway containers found (services: nexus-primary, nexus-standby, nexus)"
  exit 1
fi

active_project="\$(printf '%s\n' "\$target_info" | sed -n '1p')"
active_service="\$(printf '%s\n' "\$target_info" | sed -n '2p')"
active_cid="\$(container_id_for_service "\$active_project" "\$active_service")"
if [[ -z "\$active_cid" ]]; then
  print_err "failed to resolve container id for service '\$active_service' (project '\$active_project')"
  exit 1
fi

if [[ -t 0 && -t 1 ]]; then
  exec docker exec -it "\$active_cid" node "\$CONTAINER_ENTRYPOINT" "\$@"
fi
exec docker exec -i "\$active_cid" node "\$CONTAINER_ENTRYPOINT" "\$@"
EOF
  chmod +x "$launcher_path"
  log "installed launcher: ${launcher_path}"

  case ":$PATH:" in
    *":${launcher_dir}:"*) ;;
    *)
      log "NOTE: ${launcher_dir} is not in PATH in this shell."
      log "      Add it to your shell profile to run 'nexus' directly."
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-url)
      REPO_URL="$2"
      shift 2
      ;;
    --branch)
      BRANCH="$2"
      shift 2
      ;;
    --root)
      ROOT_DIR="$2"
      shift 2
      ;;
    --code-dir)
      CODE_DIR="$2"
      shift 2
      ;;
    --bin-path)
      BIN_PATH="$2"
      shift 2
      ;;
    --yes)
      YES=1
      shift
      ;;
    --non-interactive)
      NON_INTERACTIVE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
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

if [[ -z "$REPO_URL" ]]; then
  fail "--repo-url is required (or set NEXUS_REPO_URL)"
fi

if [[ -z "$CODE_DIR" ]]; then
  CODE_DIR="${ROOT_DIR}/code"
fi
if [[ -z "$BIN_PATH" ]]; then
  fail "--bin-path cannot be empty"
fi

require_cmd git
require_cmd node
require_cmd npm

mkdir -p "$ROOT_DIR"

if [[ ! -d "$CODE_DIR/.git" ]]; then
  log "cloning repository into ${CODE_DIR}"
  git clone --branch "$BRANCH" "$REPO_URL" "$CODE_DIR"
else
  log "updating repository in ${CODE_DIR}"
  git -C "$CODE_DIR" fetch origin "$BRANCH"
  git -C "$CODE_DIR" checkout "$BRANCH"
  git -C "$CODE_DIR" merge --ff-only "origin/${BRANCH}"
fi

log "installing dependencies"
if [[ -f "${CODE_DIR}/package-lock.json" ]]; then
  npm --prefix "$CODE_DIR" ci
else
  npm --prefix "$CODE_DIR" install
fi

log "building CLI"
npm --prefix "$CODE_DIR" run build

log "installing nexus launcher"
install_nexus_launcher "$CODE_DIR/dist/index.js"

setup_args=(
  "$CODE_DIR/dist/index.js"
  setup
  --root "$ROOT_DIR"
  --code-dir "$CODE_DIR"
  --repo-url "$REPO_URL"
)

if [[ "$YES" -eq 1 ]]; then
  setup_args+=(--yes)
fi
if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
  setup_args+=(--non-interactive)
fi
if [[ "$DRY_RUN" -eq 1 ]]; then
  setup_args+=(--dry-run)
fi

log "starting setup wizard"
node "${setup_args[@]}"
