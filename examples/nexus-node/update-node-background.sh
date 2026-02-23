#!/usr/bin/env bash
# Update Nexus reference-node code and restart a host-mode background node.

set -euo pipefail

log() { printf '[node-update] %s\n' "$*"; }
warn() { printf '[node-update] WARN: %s\n' "$*" >&2; }
fail() { printf '[node-update] ERROR: %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

print_help() {
  cat <<'EOF'
Usage: update-node-background.sh [options]

Options:
  --ref <git-ref>        Fetch/fast-forward to this ref from origin (default: pull current branch).
  --no-pull              Skip git fetch/pull and only restart.
  --skip-npm-ci          Never run npm ci during update.
  --force-npm-ci         Always run npm ci before restart.
  --allow-dirty          Allow update on dirty git worktree (default: block).
  --code-dir <path>      Override Nexus code directory.
  --env-file <path>      Override node env file used for restart.
  -h, --help             Show this help.

Environment overrides:
  NEXUS_NODE_CODE_DIR
  NEXUS_NODE_ENV_FILE
  NEXUS_NODE_UPDATE_REF
  NEXUS_NODE_UPDATE_SKIP_PULL=1
  NEXUS_NODE_UPDATE_SKIP_NPM_CI=1
  NEXUS_NODE_UPDATE_FORCE_NPM_CI=1
  NEXUS_NODE_UPDATE_ALLOW_DIRTY=1
EOF
}

resolve_code_dir() {
  local candidates=()
  if [ -n "${NEXUS_NODE_CODE_DIR:-}" ]; then
    candidates+=("$NEXUS_NODE_CODE_DIR")
  fi
  candidates+=(
    "$SCRIPT_DIR/../.."
    "$SCRIPT_DIR/code"
    "$PWD"
    "/data/code"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    [ -f "$candidate/examples/nexus-node/reference-node.ts" ] || continue
    (cd "$candidate" && pwd -P)
    return 0
  done
  return 1
}

discover_env_file() {
  local candidates=()
  if [ -n "${NEXUS_NODE_ENV_FILE:-}" ]; then
    candidates+=("$NEXUS_NODE_ENV_FILE")
  fi
  candidates+=(
    "$SCRIPT_DIR/.env"
    "$HOME/nexus-node-host/.env"
    "$HOME/nexus-node-host-deploy/.env"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    [ -f "$candidate" ] || continue
    printf '%s' "$candidate"
    return 0
  done
  return 1
}

UPDATE_REF="${NEXUS_NODE_UPDATE_REF:-}"
SKIP_PULL="${NEXUS_NODE_UPDATE_SKIP_PULL:-0}"
SKIP_NPM_CI="${NEXUS_NODE_UPDATE_SKIP_NPM_CI:-0}"
FORCE_NPM_CI="${NEXUS_NODE_UPDATE_FORCE_NPM_CI:-0}"
ALLOW_DIRTY="${NEXUS_NODE_UPDATE_ALLOW_DIRTY:-0}"
CODE_DIR_OVERRIDE=""
ENV_FILE_OVERRIDE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref)
      UPDATE_REF="${2:-}"
      shift 2
      ;;
    --no-pull)
      SKIP_PULL=1
      shift
      ;;
    --skip-npm-ci)
      SKIP_NPM_CI=1
      shift
      ;;
    --force-npm-ci)
      FORCE_NPM_CI=1
      shift
      ;;
    --allow-dirty)
      ALLOW_DIRTY=1
      shift
      ;;
    --code-dir)
      CODE_DIR_OVERRIDE="${2:-}"
      shift 2
      ;;
    --env-file)
      ENV_FILE_OVERRIDE="${2:-}"
      shift 2
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

if [ -n "$CODE_DIR_OVERRIDE" ]; then
  export NEXUS_NODE_CODE_DIR="$CODE_DIR_OVERRIDE"
fi
if [ -n "$ENV_FILE_OVERRIDE" ]; then
  export NEXUS_NODE_ENV_FILE="$ENV_FILE_OVERRIDE"
fi

CODE_DIR="$(resolve_code_dir)" || fail "unable to find Nexus code dir (set NEXUS_NODE_CODE_DIR)"
ENV_FILE="$(discover_env_file || true)"

if [ -n "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
  log "loaded env file: $ENV_FILE"
else
  warn "no env file found; using current shell environment"
fi

command -v git >/dev/null 2>&1 || fail "git is required"
command -v npm >/dev/null 2>&1 || fail "npm is required"

git -C "$CODE_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "$CODE_DIR is not a git repository"

if [ "$ALLOW_DIRTY" != "1" ]; then
  dirty="$(git -C "$CODE_DIR" status --porcelain --untracked-files=no || true)"
  if [ -n "$dirty" ]; then
    fail "git worktree is dirty; commit/stash changes or rerun with --allow-dirty"
  fi
fi

old_sha="$(git -C "$CODE_DIR" rev-parse HEAD)"
new_sha="$old_sha"

if [ "$SKIP_PULL" != "1" ]; then
  if [ -n "$UPDATE_REF" ]; then
    log "fetching ref from origin: $UPDATE_REF"
    git -C "$CODE_DIR" fetch --prune origin "$UPDATE_REF"
    git -C "$CODE_DIR" merge --ff-only FETCH_HEAD
  else
    log "pulling latest changes (fast-forward only)"
    git -C "$CODE_DIR" pull --ff-only
  fi
  new_sha="$(git -C "$CODE_DIR" rev-parse HEAD)"
else
  log "skipping git pull (--no-pull)"
fi

if [ "$SKIP_NPM_CI" != "1" ]; then
  need_npm_ci=0
  if [ "$FORCE_NPM_CI" = "1" ]; then
    need_npm_ci=1
  elif [ ! -d "$CODE_DIR/node_modules" ]; then
    need_npm_ci=1
  elif [ "$old_sha" != "$new_sha" ] && git -C "$CODE_DIR" diff --name-only "$old_sha" "$new_sha" | grep -Eq '^(package\.json|package-lock\.json)$'; then
    need_npm_ci=1
  fi
  if [ "$need_npm_ci" = "1" ]; then
    log "running npm ci"
    (cd "$CODE_DIR" && npm ci)
  else
    log "npm ci not needed"
  fi
else
  log "skipping npm ci (--skip-npm-ci)"
fi

log "code revision: ${old_sha:0:12} -> ${new_sha:0:12}"

START_SCRIPT="$SCRIPT_DIR/run-node-background.sh"
[ -f "$START_SCRIPT" ] || fail "missing start script: $START_SCRIPT"

log "restarting node"
if [ -n "$ENV_FILE" ]; then
  NEXUS_NODE_CODE_DIR="$CODE_DIR" \
    NEXUS_NODE_ENV_FILE="$ENV_FILE" \
    NEXUS_NODE_REPLACE_RUNNING=1 \
    "$START_SCRIPT"
else
  NEXUS_NODE_CODE_DIR="$CODE_DIR" \
    NEXUS_NODE_REPLACE_RUNNING=1 \
    "$START_SCRIPT"
fi

log "update complete"
