#!/usr/bin/env bash
set -euo pipefail

REPO_SLUG="${NEXUS_REPO_SLUG:-outerreaches/nexus}"
DEFAULT_REPO_URL="${NEXUS_REPO_URL:-https://github.com/${REPO_SLUG}.git}"
CHANNEL="${NEXUS_INSTALL_CHANNEL:-stable}"
REF="${NEXUS_INSTALL_REF:-}"
HAS_REPO_URL=0
declare -a INSTALL_ARGS=()

usage() {
  cat <<EOF
Usage: get.sh [options] [-- <install.sh args>]

Bootstrap options:
  --channel <stable|beta|main>   Release channel (default: stable)
  --ref <git-ref>                Install from an explicit tag/branch/commit
  --repo-url <git-url>           Repository URL passed through to install.sh
  -h, --help                     Show this help

Examples:
  # Stable channel (latest GitHub release tag)
  curl -fsSL https://raw.githubusercontent.com/${REPO_SLUG}/main/get.sh | bash -s -- --channel stable

  # Main branch
  curl -fsSL https://raw.githubusercontent.com/${REPO_SLUG}/main/get.sh | bash -s -- --channel main

  # Explicit tag
  curl -fsSL https://raw.githubusercontent.com/${REPO_SLUG}/main/get.sh | bash -s -- --ref v0.1.0

All additional arguments are forwarded to install.sh.
EOF
}

log() {
  printf '[get] %s\n' "$*"
}

warn() {
  printf '[get] WARN: %s\n' "$*" >&2
}

fail() {
  printf '[get] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

latest_release_tag() {
  local response tag
  response="$(curl -fsSL "https://api.github.com/repos/${REPO_SLUG}/releases/latest")" || return 1
  tag="$(printf '%s\n' "$response" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  [ -n "$tag" ] || return 1
  printf '%s' "$tag"
}

download_install() {
  local ref="$1"
  local target="$2"
  local url="https://raw.githubusercontent.com/${REPO_SLUG}/${ref}/install.sh"
  curl -fsSL "$url" -o "$target"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel)
      [[ $# -ge 2 ]] || fail "--channel requires a value"
      CHANNEL="$2"
      shift 2
      ;;
    --ref)
      [[ $# -ge 2 ]] || fail "--ref requires a value"
      REF="$2"
      shift 2
      ;;
    --repo-url)
      [[ $# -ge 2 ]] || fail "--repo-url requires a value"
      HAS_REPO_URL=1
      INSTALL_ARGS+=("$1" "$2")
      shift 2
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        INSTALL_ARGS+=("$1")
        shift
      done
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      INSTALL_ARGS+=("$1")
      shift
      ;;
  esac
done

require_cmd curl
require_cmd bash

if [[ -z "$REF" ]]; then
  case "$CHANNEL" in
    stable)
      if REF="$(latest_release_tag)"; then
        log "channel=stable resolved to release tag ${REF}"
      else
        warn "could not resolve latest release tag; falling back to main"
        REF="main"
      fi
      ;;
    beta)
      REF="beta"
      ;;
    main)
      REF="main"
      ;;
    *)
      fail "unknown channel: ${CHANNEL} (expected stable|beta|main)"
      ;;
  esac
fi

tmp_install="$(mktemp)"
cleanup() {
  rm -f "$tmp_install"
}
trap cleanup EXIT

if ! download_install "$REF" "$tmp_install"; then
  if [[ "$CHANNEL" == "beta" && -z "${NEXUS_INSTALL_REF:-}" ]]; then
    warn "beta ref '${REF}' is unavailable; falling back to main"
    REF="main"
    download_install "$REF" "$tmp_install" || fail "unable to download install.sh from ${REPO_SLUG}@${REF}"
  else
    fail "unable to download install.sh from ${REPO_SLUG}@${REF}"
  fi
fi

if [[ "$HAS_REPO_URL" -eq 0 ]]; then
  INSTALL_ARGS=(--repo-url "$DEFAULT_REPO_URL" "${INSTALL_ARGS[@]}")
fi

log "running installer from ${REPO_SLUG}@${REF}"
bash "$tmp_install" "${INSTALL_ARGS[@]}"
