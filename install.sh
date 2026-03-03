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
exec node "$target" "\$@"
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
