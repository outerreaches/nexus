#!/usr/bin/env bash
# Portable launcher for Nexus runtime bundles.

set -euo pipefail

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Options:
  --manifest <path>   Path to portable-manifest.json (default: ./portable-manifest.json)
  --mode <mode>       Override instanceMode from manifest
  --dry-run           Print resolved launch action without executing
  --help              Show this help
USAGE
}

MANIFEST="${MANIFEST:-./portable-manifest.json}"
MODE_OVERRIDE=""
DRY_RUN="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest)
      MANIFEST="$2"
      shift 2
      ;;
    --mode)
      MODE_OVERRIDE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="1"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$MANIFEST" ]]; then
  echo "Manifest not found: $MANIFEST" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for portable launcher" >&2
  exit 1
fi

SCHEMA_VERSION="$(jq -r '.schemaVersion // ""' "$MANIFEST")"
if [[ "$SCHEMA_VERSION" != "portable.v1" ]]; then
  echo "Unsupported manifest schema: $SCHEMA_VERSION" >&2
  exit 1
fi

INSTANCE_MODE="$(jq -r '.instanceMode // "portable"' "$MANIFEST")"
if [[ -n "$MODE_OVERRIDE" ]]; then
  INSTANCE_MODE="$MODE_OVERRIDE"
fi

STATE_MOUNT="$(jq -r '.state.mountPath // "./state.enc"' "$MANIFEST")"
STATE_ENCRYPTED="$(jq -r '.state.encrypted // true' "$MANIFEST")"
ENTRY_CMD="$(jq -r '.entrypoint.command // "nexus"' "$MANIFEST")"
STATE_BUNDLE_FILE=""
STATE_RUNTIME_ROOT=""
CLEANUP_DONE="0"

if [[ "$STATE_ENCRYPTED" == "true" && -z "${PORTABLE_STATE_PASSPHRASE:-}" ]]; then
  echo "PORTABLE_STATE_PASSPHRASE is required for encrypted state" >&2
  exit 1
fi

CACHE_DIR="./.portable-cache"
mkdir -p "$CACHE_DIR"

encrypt_file_with_passphrase() {
  local input_file="$1"
  local output_file="$2"
  node - "$input_file" "$output_file" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");

const [, , inputPath, outputPath] = process.argv;
const passphrase = process.env.PORTABLE_STATE_PASSPHRASE ?? "";
if (!passphrase) throw new Error("PORTABLE_STATE_PASSPHRASE is required");

const magic = Buffer.from("NXENC01", "utf8");
const plaintext = fs.readFileSync(inputPath);
const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const key = crypto.scryptSync(passphrase, salt, 32);
const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const tag = cipher.getAuthTag();

const out = Buffer.concat([magic, salt, iv, tag, ciphertext]);
fs.writeFileSync(outputPath, out, { mode: 0o600 });
NODE
}

decrypt_file_with_passphrase() {
  local input_file="$1"
  local output_file="$2"
  node - "$input_file" "$output_file" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");

const [, , inputPath, outputPath] = process.argv;
const passphrase = process.env.PORTABLE_STATE_PASSPHRASE ?? "";
if (!passphrase) throw new Error("PORTABLE_STATE_PASSPHRASE is required");

const payload = fs.readFileSync(inputPath);
if (payload.length < 7 + 16 + 12 + 16) throw new Error("encrypted state payload is too small");
const magic = payload.subarray(0, 7).toString("utf8");
if (magic !== "NXENC01") throw new Error("encrypted state payload has invalid magic header");
const salt = payload.subarray(7, 23);
const iv = payload.subarray(23, 35);
const tag = payload.subarray(35, 51);
const ciphertext = payload.subarray(51);
const key = crypto.scryptSync(passphrase, salt, 32);

const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
decipher.setAuthTag(tag);
const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
fs.writeFileSync(outputPath, plaintext, { mode: 0o600 });
NODE
}

hydrate_encrypted_state() {
  mkdir -p "$STATE_RUNTIME_ROOT"
  if [[ ! -f "$STATE_BUNDLE_FILE" ]]; then
    mkdir -p "$STATE_RUNTIME_ROOT/state" "$STATE_RUNTIME_ROOT/workspace"
    return
  fi
  local tar_file="$CACHE_DIR/state.decrypt.tar"
  decrypt_file_with_passphrase "$STATE_BUNDLE_FILE" "$tar_file"
  tar -C "$STATE_RUNTIME_ROOT" -xf "$tar_file"
  rm -f "$tar_file"
  mkdir -p "$STATE_RUNTIME_ROOT/state" "$STATE_RUNTIME_ROOT/workspace"
}

persist_encrypted_state() {
  mkdir -p "$STATE_MOUNT"
  local tar_file="$CACHE_DIR/state.encrypt.tar"
  tar -C "$STATE_RUNTIME_ROOT" -cf "$tar_file" .
  encrypt_file_with_passphrase "$tar_file" "$STATE_BUNDLE_FILE"
  rm -f "$tar_file"
}

cleanup() {
  if [[ "$CLEANUP_DONE" == "1" ]]; then
    return
  fi
  CLEANUP_DONE="1"
  if [[ "$STATE_ENCRYPTED" == "true" && -n "$STATE_RUNTIME_ROOT" && -d "$STATE_RUNTIME_ROOT" ]]; then
    persist_encrypted_state
  fi
  rm -rf "$CACHE_DIR"
}
trap cleanup EXIT INT TERM

set_manifest_env() {
  local key value
  while IFS='=' read -r key value; do
    if [[ -z "$key" ]]; then
      continue
    fi
    export "$key"="$value"
  done < <(jq -r '.entrypoint.env // {} | to_entries[] | "\(.key)=\(.value)"' "$MANIFEST")
}

set_manifest_env

if [[ "$STATE_ENCRYPTED" == "true" ]]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "node is required for encrypted portable state" >&2
    exit 1
  fi
  if ! command -v tar >/dev/null 2>&1; then
    echo "tar is required for encrypted portable state" >&2
    exit 1
  fi
  mkdir -p "$STATE_MOUNT"
  chmod 700 "$STATE_MOUNT" 2>/dev/null || true
  STATE_BUNDLE_FILE="$STATE_MOUNT/state.bundle.enc"
  STATE_RUNTIME_ROOT="$CACHE_DIR/state-runtime"
  hydrate_encrypted_state
  export NEXUS_STATE_DIR="$STATE_RUNTIME_ROOT/state"
  export NEXUS_WORKSPACE_DIR="$STATE_RUNTIME_ROOT/workspace"
else
  mkdir -p "$STATE_MOUNT" ./workspace
fi
mkdir -p ./logs

case "$INSTANCE_MODE" in
  execution_node_host)
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    INSTALLER="${SCRIPT_DIR}/install-execution-node-host.sh"
    if [[ ! -x "$INSTALLER" ]]; then
      echo "execution_node_host installer missing: $INSTALLER" >&2
      exit 1
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
      echo "mode=execution_node_host installer=$INSTALLER"
      exit 0
    fi
    "$INSTALLER"
    exit $?
    ;;
  portable)
    ;;
  portable_federated)
    if [[ "${NEXUS_FEDERATION_JOIN_APPROVED:-0}" != "1" ]]; then
      echo "Federated portable launch requires NEXUS_FEDERATION_JOIN_APPROVED=1" >&2
      exit 1
    fi
    export NEXUS_FEDERATION_ENABLED=1
    ;;
  *)
    echo "Unsupported instance mode: $INSTANCE_MODE" >&2
    exit 1
    ;;
esac

ENTRY_ARGS=()
while IFS= read -r arg; do
  ENTRY_ARGS+=("$arg")
done < <(jq -r '.entrypoint.args // [] | .[]' "$MANIFEST")
if [[ "${#ENTRY_ARGS[@]}" -eq 0 ]]; then
  ENTRY_ARGS=("gateway" "--verbose" "--profile" "portable")
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "mode=$INSTANCE_MODE command=$ENTRY_CMD args=${ENTRY_ARGS[*]} encrypted_state=$STATE_ENCRYPTED"
  exit 0
fi

set +e
"$ENTRY_CMD" "${ENTRY_ARGS[@]}"
CMD_STATUS=$?
set -e
exit "$CMD_STATUS"
