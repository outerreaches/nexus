#!/usr/bin/env bash
# Provision a Nexus VM on a libvirt host and optionally deploy Nexus HA
# (primary + standby + sidecar + TLS).
# Designed for iterative topology testing (service_custom, standby, monetization, etc.).

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
fail() { echo -e "${RED}[!]${NC} $*" >&2; exit 1; }

usage() {
  cat <<USAGE
Usage: $(basename "$0") --vm-name <name> [options]

Required:
  --vm-name <name>                 VM/domain name (example: nexus-service-vm)

VM options:
  --hostname <name>                Guest hostname (default: <vm-name>)
  --memory-mb <mb>                 RAM in MB (default: 8192)
  --cpus <count>                   vCPU count (default: 4)
  --disk-size <size>               Disk size for cloned qcow2 (default: 40G)
  --network <name>                 libvirt network (default: default)
  --libvirt-uri <uri>              libvirt URI (default: qemu:///system)
  --image-pool <name>              libvirt storage pool for VM disks (default: images)
  --boot-pool <name>               libvirt storage pool for cloud-init ISO (default: boot)
  --base-image-volume <name>       Base cloud image volume in image pool
                                   (default: noble-server-cloudimg-amd64.img)
  --vm-user <user>                 Guest SSH user created by cloud-init (default: nexus)
  --ssh-public-key-path <path>     Public key path for guest SSH auth
                                   (default: ~/.ssh/id_ed25519.pub or ~/.ssh/id_rsa.pub)
  --ssh-private-key-path <path>    Private key used for SSH readiness/deploy checks
                                   (default: derive from --ssh-public-key-path by stripping .pub)
                                   (if passphrase-protected, preload in ssh-agent)
  --force-recreate                 Destroy existing VM and recreate disk/ISO volumes

Deployment options (enabled by default):
  --no-deploy                      Only provision VM, skip git clone/HA deploy
  --profile <profile>              standard|primary|standby|monetization|service_custom|portable
                                   (default: service_custom)
  --repo-url <url>                 Git repo URL (default: https://github.com/outerreaches/nexus.git)
  --repo-branch <name>             Git branch (default: main)
  --code-dir <path>                Guest code dir (default: /data/code)
  --config-root <path>             Guest config root for split env files (default: /data/nexus-config)
  --state-dir <path>               Guest state dir (default: /data/nexus)
  --workspace-dir <path>           Guest workspace dir (default: /data/workspace)
  --deploy-dir <path>              Legacy path (unused by HA deploy; default: ~/nexus-deploy)
  --port <port>                    Host port mapped by guest compose (default: 18789)
  --compose-project <name>         Compose project name (default: infra)
  --http-api-key <token>           Seed NEXUS_HTTP_API_KEY (gateway) + NEXUS_HA_API_KEY (watchdog)
  --credentials-key <value>        Seed NEXUS_CREDENTIALS_KEY into sidecar env file
  --no-generate-credentials-key    Disable automatic credential-key generation when missing
  --require-http-api-key           Require NEXUS_HTTP_API_KEY in preflight checks
  --wait-ssh-seconds <seconds>     Max wait for guest SSH (default: 360)
  --skip-init                      Skip headless nexus init (default: auto-init if missing files)
  --init-agent-name <name>         Headless init agent identity name (default: Nexus)
  --init-user-name <name>          Headless init user profile name (default: Ops)
  --init-timezone <tz>             Headless init timezone (default: UTC)

Federation config options (applied only when deploy is enabled and --federation-enable is set):
  --federation-enable              Set federation.enabled=true in guest config
  --federation-instance-id <id>    federation.localInstanceId (default: <vm-name>)
  --federation-outbox-enabled      Set federation.outbox.enabled=true (default when federation enabled)
  --federation-outbox-disabled     Set federation.outbox.enabled=false
  --federation-allow-insecure-dev  For lab/private networks:
                                   requireMtls=false + allowInsecureSignedOnlyDev=true

Safety:
  --dry-run                        Print actions without executing mutations
  --help                           Show this help

Example (your requested test VM):
  $(basename "$0") \
    --vm-name nexus-service-vm \
    --hostname nexus-service-vm \
    --memory-mb 8192 \
    --disk-size 40G \
    --profile service_custom \
    --federation-enable \
    --federation-instance-id service-main \
    --federation-allow-insecure-dev
USAGE
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

run() {
  if (( DRY_RUN )); then
    printf '[dry-run] %s\n' "$*"
  else
    eval "$@"
  fi
}

LIBVIRT_URI="${LIBVIRT_URI:-qemu:///system}"
VM_NAME=""
VM_HOSTNAME=""
VM_MEMORY_MB="8192"
VM_CPUS="4"
VM_DISK_SIZE="40G"
VM_NETWORK="default"
IMAGE_POOL="images"
BOOT_POOL="boot"
BASE_IMAGE_VOL="noble-server-cloudimg-amd64.img"
VM_USER="nexus"
SSH_PUBLIC_KEY_PATH=""
SSH_PRIVATE_KEY_PATH=""
FORCE_RECREATE=0

DO_DEPLOY=1
PROFILE="service_custom"
REPO_URL="https://github.com/outerreaches/nexus.git"
REPO_BRANCH="main"
CODE_DIR="/data/code"
CONFIG_ROOT="/data/nexus-config"
STATE_DIR="/data/nexus"
WORKSPACE_DIR="/data/workspace"
DEPLOY_DIR='~/nexus-deploy'
PORT="18789"
COMPOSE_PROJECT="infra"
HTTP_API_KEY=""
CREDENTIALS_KEY=""
GENERATE_CREDENTIALS_KEY=1
REQUIRE_HTTP_API_KEY=0
WAIT_SSH_SECONDS="360"
SKIP_INIT=0
INIT_AGENT_NAME="Nexus"
INIT_USER_NAME="Ops"
INIT_TIMEZONE="UTC"

FEDERATION_ENABLE=0
FEDERATION_INSTANCE_ID=""
FEDERATION_OUTBOX_ENABLED=1
FEDERATION_ALLOW_INSECURE_DEV=0

DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vm-name)
      VM_NAME="$2"
      shift 2
      ;;
    --hostname)
      VM_HOSTNAME="$2"
      shift 2
      ;;
    --memory-mb)
      VM_MEMORY_MB="$2"
      shift 2
      ;;
    --cpus)
      VM_CPUS="$2"
      shift 2
      ;;
    --disk-size)
      VM_DISK_SIZE="$2"
      shift 2
      ;;
    --network)
      VM_NETWORK="$2"
      shift 2
      ;;
    --libvirt-uri)
      LIBVIRT_URI="$2"
      shift 2
      ;;
    --image-pool)
      IMAGE_POOL="$2"
      shift 2
      ;;
    --boot-pool)
      BOOT_POOL="$2"
      shift 2
      ;;
    --base-image-volume)
      BASE_IMAGE_VOL="$2"
      shift 2
      ;;
    --vm-user)
      VM_USER="$2"
      shift 2
      ;;
    --ssh-public-key-path)
      SSH_PUBLIC_KEY_PATH="$2"
      shift 2
      ;;
    --ssh-private-key-path)
      SSH_PRIVATE_KEY_PATH="$2"
      shift 2
      ;;
    --force-recreate)
      FORCE_RECREATE=1
      shift
      ;;
    --no-deploy)
      DO_DEPLOY=0
      shift
      ;;
    --profile)
      PROFILE="$2"
      shift 2
      ;;
    --repo-url)
      REPO_URL="$2"
      shift 2
      ;;
    --repo-branch)
      REPO_BRANCH="$2"
      shift 2
      ;;
    --code-dir)
      CODE_DIR="$2"
      shift 2
      ;;
    --config-root)
      CONFIG_ROOT="$2"
      shift 2
      ;;
    --state-dir)
      STATE_DIR="$2"
      shift 2
      ;;
    --workspace-dir)
      WORKSPACE_DIR="$2"
      shift 2
      ;;
    --deploy-dir)
      DEPLOY_DIR="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --compose-project)
      COMPOSE_PROJECT="$2"
      shift 2
      ;;
    --http-api-key)
      HTTP_API_KEY="$2"
      shift 2
      ;;
    --credentials-key)
      CREDENTIALS_KEY="$2"
      shift 2
      ;;
    --no-generate-credentials-key)
      GENERATE_CREDENTIALS_KEY=0
      shift
      ;;
    --require-http-api-key)
      REQUIRE_HTTP_API_KEY=1
      shift
      ;;
    --wait-ssh-seconds)
      WAIT_SSH_SECONDS="$2"
      shift 2
      ;;
    --skip-init)
      SKIP_INIT=1
      shift
      ;;
    --init-agent-name)
      INIT_AGENT_NAME="$2"
      shift 2
      ;;
    --init-user-name)
      INIT_USER_NAME="$2"
      shift 2
      ;;
    --init-timezone)
      INIT_TIMEZONE="$2"
      shift 2
      ;;
    --federation-enable)
      FEDERATION_ENABLE=1
      shift
      ;;
    --federation-instance-id)
      FEDERATION_INSTANCE_ID="$2"
      shift 2
      ;;
    --federation-outbox-enabled)
      FEDERATION_OUTBOX_ENABLED=1
      shift
      ;;
    --federation-outbox-disabled)
      FEDERATION_OUTBOX_ENABLED=0
      shift
      ;;
    --federation-allow-insecure-dev)
      FEDERATION_ALLOW_INSECURE_DEV=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[[ -n "$VM_NAME" ]] || { usage; fail "--vm-name is required"; }
[[ -n "$VM_HOSTNAME" ]] || VM_HOSTNAME="$VM_NAME"
[[ -n "$FEDERATION_INSTANCE_ID" ]] || FEDERATION_INSTANCE_ID="$VM_NAME"

case "$PROFILE" in
  standard|primary|standby|monetization|service_custom|portable)
    ;;
  *)
    fail "unsupported --profile: $PROFILE"
    ;;
esac

require_cmd virsh
require_cmd virt-install
require_cmd cloud-localds
require_cmd ssh
require_cmd git

# Validate libvirt connectivity and resources.
virsh -c "$LIBVIRT_URI" uri >/dev/null 2>&1 || fail "cannot connect to libvirt URI: $LIBVIRT_URI"
virsh -c "$LIBVIRT_URI" pool-info "$IMAGE_POOL" >/dev/null 2>&1 || fail "missing image pool: $IMAGE_POOL"
virsh -c "$LIBVIRT_URI" pool-info "$BOOT_POOL" >/dev/null 2>&1 || fail "missing boot pool: $BOOT_POOL"
virsh -c "$LIBVIRT_URI" vol-info --pool "$IMAGE_POOL" "$BASE_IMAGE_VOL" >/dev/null 2>&1 || fail "missing base image volume '$BASE_IMAGE_VOL' in pool '$IMAGE_POOL'"

if [[ -z "$SSH_PUBLIC_KEY_PATH" ]]; then
  if [[ -f "$HOME/.ssh/id_ed25519.pub" ]]; then
    SSH_PUBLIC_KEY_PATH="$HOME/.ssh/id_ed25519.pub"
  elif [[ -f "$HOME/.ssh/id_rsa.pub" ]]; then
    SSH_PUBLIC_KEY_PATH="$HOME/.ssh/id_rsa.pub"
  else
    fail "no SSH public key found; use --ssh-public-key-path"
  fi
fi
[[ -f "$SSH_PUBLIC_KEY_PATH" ]] || fail "SSH public key not found: $SSH_PUBLIC_KEY_PATH"
SSH_PUBLIC_KEY="$(cat "$SSH_PUBLIC_KEY_PATH")"

if [[ -z "$SSH_PRIVATE_KEY_PATH" ]]; then
  if [[ "$SSH_PUBLIC_KEY_PATH" == *.pub ]]; then
    SSH_PRIVATE_KEY_PATH="${SSH_PUBLIC_KEY_PATH%.pub}"
  fi
fi
[[ -n "$SSH_PRIVATE_KEY_PATH" ]] || fail "unable to derive SSH private key path from: $SSH_PUBLIC_KEY_PATH (set --ssh-private-key-path)"
[[ -f "$SSH_PRIVATE_KEY_PATH" ]] || fail "SSH private key not found: $SSH_PRIVATE_KEY_PATH"

key_fingerprint="$(ssh-keygen -lf "$SSH_PUBLIC_KEY_PATH" 2>/dev/null | awk '{print $2}' || true)"
agent_has_key=0
if [[ -n "${SSH_AUTH_SOCK:-}" ]] && command -v ssh-add >/dev/null 2>&1 && [[ -n "$key_fingerprint" ]]; then
  if ssh-add -l 2>/dev/null | awk '{print $2}' | grep -Fqx "$key_fingerprint"; then
    agent_has_key=1
  fi
fi
if ! ssh-keygen -yf "$SSH_PRIVATE_KEY_PATH" -P "" >/dev/null 2>&1; then
  if (( agent_has_key )); then
    warn "SSH private key appears passphrase-protected; matching key is loaded in ssh-agent, continuing"
  else
    fail "SSH private key appears passphrase-protected and is not loaded in ssh-agent. Run: eval \"\$(ssh-agent -s)\" && ssh-add \"$SSH_PRIVATE_KEY_PATH\""
  fi
fi

DISK_VOL="${VM_NAME}.qcow2"
ISO_VOL="${VM_NAME}-cloud-init.iso"

vm_exists=0
if virsh -c "$LIBVIRT_URI" dominfo "$VM_NAME" >/dev/null 2>&1; then
  vm_exists=1
fi

if (( vm_exists )) && (( FORCE_RECREATE == 0 )); then
  fail "VM already exists: $VM_NAME (use --force-recreate to replace)"
fi

if (( vm_exists )) && (( FORCE_RECREATE == 1 )); then
  warn "Force-recreate enabled: destroying and undefining VM '$VM_NAME'"
  run "virsh -c '$LIBVIRT_URI' destroy '$VM_NAME' >/dev/null 2>&1 || true"
  run "virsh -c '$LIBVIRT_URI' undefine '$VM_NAME' --nvram >/dev/null 2>&1 || virsh -c '$LIBVIRT_URI' undefine '$VM_NAME' >/dev/null 2>&1 || true"
fi

if virsh -c "$LIBVIRT_URI" vol-info --pool "$IMAGE_POOL" "$DISK_VOL" >/dev/null 2>&1; then
  if (( FORCE_RECREATE )); then
    warn "Deleting existing disk volume: ${IMAGE_POOL}/${DISK_VOL}"
    run "virsh -c '$LIBVIRT_URI' vol-delete --pool '$IMAGE_POOL' '$DISK_VOL' >/dev/null"
  else
    fail "disk volume already exists: ${IMAGE_POOL}/${DISK_VOL}"
  fi
fi

if virsh -c "$LIBVIRT_URI" vol-info --pool "$BOOT_POOL" "$ISO_VOL" >/dev/null 2>&1; then
  if (( FORCE_RECREATE )); then
    warn "Deleting existing cloud-init ISO volume: ${BOOT_POOL}/${ISO_VOL}"
    run "virsh -c '$LIBVIRT_URI' vol-delete --pool '$BOOT_POOL' '$ISO_VOL' >/dev/null"
  else
    fail "cloud-init ISO volume already exists: ${BOOT_POOL}/${ISO_VOL}"
  fi
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

USER_DATA="$TMP_DIR/user-data"
META_DATA="$TMP_DIR/meta-data"
ISO_LOCAL="$TMP_DIR/${ISO_VOL}"

log "Building cloud-init seed"
cat > "$USER_DATA" <<CLOUD
#cloud-config
hostname: ${VM_HOSTNAME}
users:
  - name: ${VM_USER}
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    groups: [docker]
    ssh_authorized_keys:
      - ${SSH_PUBLIC_KEY}
package_update: true
packages:
  - docker.io
  - docker-compose-v2
  - git
  - curl
  - jq
runcmd:
  - systemctl enable docker
  - systemctl start docker
  - usermod -aG docker ${VM_USER}
  - mkdir -p /data/{code,nexus,workspace}
  - chown -R ${VM_USER}:${VM_USER} /data
CLOUD

cat > "$META_DATA" <<META
instance-id: ${VM_NAME}
local-hostname: ${VM_HOSTNAME}
META

run "cloud-localds '$ISO_LOCAL' '$USER_DATA' '$META_DATA'"

# Create VM disk from base cloud image and resize to requested capacity.
log "Creating disk volume ${IMAGE_POOL}/${DISK_VOL} from base ${BASE_IMAGE_VOL}"
run "virsh -c '$LIBVIRT_URI' vol-clone --pool '$IMAGE_POOL' '$BASE_IMAGE_VOL' '$DISK_VOL' >/dev/null"
run "virsh -c '$LIBVIRT_URI' vol-resize --pool '$IMAGE_POOL' '$DISK_VOL' '$VM_DISK_SIZE' >/dev/null"

# Upload cloud-init ISO into boot pool.
iso_size="$(wc -c < "$ISO_LOCAL" | tr -d '[:space:]')"
iso_capacity="$((iso_size + 1048576))"
log "Uploading cloud-init ISO volume ${BOOT_POOL}/${ISO_VOL}"
run "virsh -c '$LIBVIRT_URI' vol-create-as '$BOOT_POOL' '$ISO_VOL' '$iso_capacity' --format raw >/dev/null"
run "virsh -c '$LIBVIRT_URI' vol-upload --pool '$BOOT_POOL' '$ISO_VOL' '$ISO_LOCAL' >/dev/null"

DISK_PATH="$(virsh -c "$LIBVIRT_URI" vol-path --pool "$IMAGE_POOL" "$DISK_VOL")"
ISO_PATH="$(virsh -c "$LIBVIRT_URI" vol-path --pool "$BOOT_POOL" "$ISO_VOL")"

log "Creating VM '${VM_NAME}' (${VM_MEMORY_MB}MB RAM, ${VM_CPUS} vCPU, ${VM_DISK_SIZE} disk)"
run "virt-install --connect '$LIBVIRT_URI' \
  --name '$VM_NAME' \
  --memory '$VM_MEMORY_MB' \
  --vcpus '$VM_CPUS' \
  --disk '$DISK_PATH,format=qcow2,bus=virtio' \
  --disk '$ISO_PATH,device=cdrom' \
  --os-variant ubuntu24.04 \
  --network network='$VM_NETWORK' \
  --graphics none \
  --console pty,target_type=serial \
  --import \
  --noautoconsole"

if (( DRY_RUN )); then
  log "Dry-run complete. No VM/deploy actions were executed."
  exit 0
fi

vm_ip() {
  virsh -c "$LIBVIRT_URI" domifaddr "$VM_NAME" 2>/dev/null | awk '/ipv4/ {print $4}' | cut -d/ -f1 | head -n1
}

log "Waiting for VM IP..."
VM_IP=""
for _ in $(seq 1 120); do
  VM_IP="$(vm_ip || true)"
  if [[ -n "$VM_IP" ]]; then
    break
  fi
  sleep 2
done
[[ -n "$VM_IP" ]] || fail "unable to determine VM IP for $VM_NAME"

log "VM IP resolved: $VM_IP"

# If this VM IP was reused after a recreate, stale host keys can cause
# "REMOTE HOST IDENTIFICATION HAS CHANGED" and make readiness checks loop.
ssh-keygen -R "$VM_IP" >/dev/null 2>&1 || true
ssh-keygen -R "[$VM_IP]:22" >/dev/null 2>&1 || true

SSH_OPTS=(
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=3
  -i "$SSH_PRIVATE_KEY_PATH"
)

log "Waiting for SSH readiness (${WAIT_SSH_SECONDS}s timeout)"
ssh_ready=0
last_ssh_error=""
for _ in $(seq 1 "$WAIT_SSH_SECONDS"); do
  ssh_output="$(ssh "${SSH_OPTS[@]}" "${VM_USER}@${VM_IP}" "echo ok" 2>&1 || true)"
  if [[ "$ssh_output" == "ok" ]]; then
    ssh_ready=1
    break
  fi
  last_ssh_error="$ssh_output"
  if (( _ % 15 == 0 )); then
    warn "still waiting for SSH (${_}/${WAIT_SSH_SECONDS}) for ${VM_USER}@${VM_IP}; last error: $(printf '%s' "$last_ssh_error" | tr '\n' ' ' | tr -s ' ')"
  fi
  sleep 1
done
(( ssh_ready == 1 )) || fail "SSH did not become ready for ${VM_USER}@${VM_IP}; last error: $(printf '%s' "$last_ssh_error" | tr '\n' ' ' | tr -s ' ')"

log "Waiting for cloud-init completion (best effort)"
ssh "${SSH_OPTS[@]}" "${VM_USER}@${VM_IP}" \
  'if command -v cloud-init >/dev/null 2>&1; then sudo cloud-init status --wait >/dev/null 2>&1 || true; fi' || true

if (( DO_DEPLOY == 0 )); then
  log "VM provisioned. Deployment skipped (--no-deploy)."
  echo "vm_name=${VM_NAME}"
  echo "vm_ip=${VM_IP}"
  echo "next_step=ssh ${VM_USER}@${VM_IP}"
  exit 0
fi

log "Bootstrapping guest repo + HA deploy (runtime.profile=${PROFILE})"
ssh "${SSH_OPTS[@]}" "${VM_USER}@${VM_IP}" \
  REPO_URL="$(printf '%q' "$REPO_URL")" \
  REPO_BRANCH="$(printf '%q' "$REPO_BRANCH")" \
  CODE_DIR="$(printf '%q' "$CODE_DIR")" \
  CONFIG_ROOT="$(printf '%q' "$CONFIG_ROOT")" \
  STATE_DIR="$(printf '%q' "$STATE_DIR")" \
  WORKSPACE_DIR="$(printf '%q' "$WORKSPACE_DIR")" \
  DEPLOY_DIR="$(printf '%q' "$DEPLOY_DIR")" \
  PROFILE="$(printf '%q' "$PROFILE")" \
  PORT="$(printf '%q' "$PORT")" \
  COMPOSE_PROJECT="$(printf '%q' "$COMPOSE_PROJECT")" \
  HTTP_API_KEY="$(printf '%q' "$HTTP_API_KEY")" \
  CREDENTIALS_KEY="$(printf '%q' "$CREDENTIALS_KEY")" \
  GENERATE_CREDENTIALS_KEY="$(printf '%q' "$GENERATE_CREDENTIALS_KEY")" \
  REQUIRE_HTTP_API_KEY="$(printf '%q' "$REQUIRE_HTTP_API_KEY")" \
  SKIP_INIT="$(printf '%q' "$SKIP_INIT")" \
  INIT_AGENT_NAME="$(printf '%q' "$INIT_AGENT_NAME")" \
  INIT_USER_NAME="$(printf '%q' "$INIT_USER_NAME")" \
  INIT_TIMEZONE="$(printf '%q' "$INIT_TIMEZONE")" \
  FEDERATION_ENABLE="$(printf '%q' "$FEDERATION_ENABLE")" \
  FEDERATION_INSTANCE_ID="$(printf '%q' "$FEDERATION_INSTANCE_ID")" \
  FEDERATION_OUTBOX_ENABLED="$(printf '%q' "$FEDERATION_OUTBOX_ENABLED")" \
  FEDERATION_ALLOW_INSECURE_DEV="$(printf '%q' "$FEDERATION_ALLOW_INSECURE_DEV")" \
  'bash -s' <<'REMOTE'
set -euo pipefail

# shellcheck disable=SC2153
REPO_URL="${REPO_URL}"
REPO_BRANCH="${REPO_BRANCH}"
CODE_DIR="${CODE_DIR}"
CONFIG_ROOT="${CONFIG_ROOT}"
STATE_DIR="${STATE_DIR}"
WORKSPACE_DIR="${WORKSPACE_DIR}"
DEPLOY_DIR="${DEPLOY_DIR}"
PROFILE="${PROFILE}"
PORT="${PORT}"
COMPOSE_PROJECT="${COMPOSE_PROJECT}"
HTTP_API_KEY="${HTTP_API_KEY}"
CREDENTIALS_KEY="${CREDENTIALS_KEY}"
GENERATE_CREDENTIALS_KEY="${GENERATE_CREDENTIALS_KEY}"
REQUIRE_HTTP_API_KEY="${REQUIRE_HTTP_API_KEY}"
SKIP_INIT="${SKIP_INIT}"
INIT_AGENT_NAME="${INIT_AGENT_NAME}"
INIT_USER_NAME="${INIT_USER_NAME}"
INIT_TIMEZONE="${INIT_TIMEZONE}"
FEDERATION_ENABLE="${FEDERATION_ENABLE}"
FEDERATION_INSTANCE_ID="${FEDERATION_INSTANCE_ID}"
FEDERATION_OUTBOX_ENABLED="${FEDERATION_OUTBOX_ENABLED}"
FEDERATION_ALLOW_INSECURE_DEV="${FEDERATION_ALLOW_INSECURE_DEV}"

if [[ "$REPO_URL" == ssh://* ]]; then
  export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o StrictHostKeyChecking=accept-new}"
fi

ensure_writable_dir() {
  local path="$1"
  if mkdir -p "$path" >/dev/null 2>&1; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo mkdir -p "$path"
    sudo chown -R "$(id -un):$(id -gn)" "$path"
    return 0
  fi
  return 1
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

GATEWAY_ENV_PATH="${CONFIG_ROOT}/gateway/nexus.env"
SIDECAR_ENV_PATH="${CONFIG_ROOT}/sidecar/nexus.env"
WATCHDOG_ENV_PATH="${CONFIG_ROOT}/watchdog/nexus.env"

for dir in "$CODE_DIR" "$STATE_DIR" "$WORKSPACE_DIR" "$DEPLOY_DIR" "$CONFIG_ROOT" "${CONFIG_ROOT}/gateway" "${CONFIG_ROOT}/sidecar" "${CONFIG_ROOT}/watchdog"; do
  ensure_writable_dir "$dir" || {
    echo "failed to prepare writable directory: $dir" >&2
    exit 1
  }
done

if [[ -d "$CODE_DIR/.git" ]]; then
  cd "$CODE_DIR"
  git fetch origin "$REPO_BRANCH"
  git checkout "$REPO_BRANCH"
  git reset --hard "origin/$REPO_BRANCH"
else
  rm -rf "$CODE_DIR"
  if ! git clone --branch "$REPO_BRANCH" --single-branch "$REPO_URL" "$CODE_DIR"; then
    if [[ "$REPO_URL" == https://github.com/* ]]; then
      echo "git clone failed for ${REPO_URL}. If this repo is private, use --repo-url ssh://<host-user>@192.168.122.1/~/git/nexus.git" >&2
      echo "and ensure the VM's SSH public key is authorized in the host user's ~/.ssh/authorized_keys." >&2
    fi
    exit 1
  fi
fi

PULL_DEPLOY_SCRIPT="$CODE_DIR/infra/scripts/pull-deploy.sh"
TLS_SCRIPT="$CODE_DIR/infra/scripts/ha-generate-tls-cert.sh"
SECRETS_PREFLIGHT_SCRIPT="$CODE_DIR/infra/scripts/ha-secrets-preflight.sh"
SIDECAR_BOOTSTRAP_SCRIPT="$CODE_DIR/infra/scripts/ha-sidecar-bootstrap.sh"
BASE_COMPOSE="$CODE_DIR/infra/docker-compose.ha.yml"
SIDECAR_COMPOSE="$CODE_DIR/infra/docker-compose.ha.sidecar.yml"
TLS_COMPOSE="$CODE_DIR/infra/docker-compose.ha.tls.yml"
TLS_CERT_PEM="$CODE_DIR/infra/haproxy/certs/nexus.pem"

for required in "$PULL_DEPLOY_SCRIPT" "$TLS_SCRIPT" "$SECRETS_PREFLIGHT_SCRIPT" "$SIDECAR_BOOTSTRAP_SCRIPT" "$BASE_COMPOSE" "$SIDECAR_COMPOSE" "$TLS_COMPOSE"; do
  [[ -f "$required" ]] || {
    echo "missing required HA deploy asset: $required" >&2
    exit 1
  }
done
chmod +x "$PULL_DEPLOY_SCRIPT" "$TLS_SCRIPT" "$SECRETS_PREFLIGHT_SCRIPT" "$SIDECAR_BOOTSTRAP_SCRIPT"

if [[ ! -f "$GATEWAY_ENV_PATH" ]]; then
  if [[ -f "$CODE_DIR/.env.gateway.example" ]]; then
    cp "$CODE_DIR/.env.gateway.example" "$GATEWAY_ENV_PATH"
    echo "created $GATEWAY_ENV_PATH from .env.gateway.example (fill secrets before production use)"
  else
    : > "$GATEWAY_ENV_PATH"
    echo "created empty $GATEWAY_ENV_PATH (fill required secrets before production use)"
  fi
fi

if [[ ! -f "$SIDECAR_ENV_PATH" ]]; then
  if [[ -f "$CODE_DIR/.env.sidecar.example" ]]; then
    cp "$CODE_DIR/.env.sidecar.example" "$SIDECAR_ENV_PATH"
    echo "created $SIDECAR_ENV_PATH from .env.sidecar.example (fill secrets before production use)"
  else
    : > "$SIDECAR_ENV_PATH"
    echo "created empty $SIDECAR_ENV_PATH (fill required secrets before production use)"
  fi
fi

if [[ ! -f "$WATCHDOG_ENV_PATH" ]]; then
  if [[ -f "$CODE_DIR/.env.watchdog.example" ]]; then
    cp "$CODE_DIR/.env.watchdog.example" "$WATCHDOG_ENV_PATH"
    echo "created $WATCHDOG_ENV_PATH from .env.watchdog.example (fill secrets before production use)"
  else
    : > "$WATCHDOG_ENV_PATH"
    echo "created empty $WATCHDOG_ENV_PATH (fill required secrets before production use)"
  fi
fi

if [[ -n "$HTTP_API_KEY" ]]; then
  upsert_env_value "NEXUS_HTTP_API_KEY" "$HTTP_API_KEY" "$GATEWAY_ENV_PATH"
  upsert_env_value "NEXUS_HA_API_KEY" "$HTTP_API_KEY" "$WATCHDOG_ENV_PATH"
fi

if [[ -n "$CREDENTIALS_KEY" ]]; then
  upsert_env_value "NEXUS_CREDENTIALS_KEY" "$CREDENTIALS_KEY" "$SIDECAR_ENV_PATH"
fi

pref_cmd=(
  "$SECRETS_PREFLIGHT_SCRIPT"
  --code-dir "$CODE_DIR"
  --gateway-env-file "$GATEWAY_ENV_PATH"
  --sidecar-env-file "$SIDECAR_ENV_PATH"
  --watchdog-env-file "$WATCHDOG_ENV_PATH"
  --state-dir "$STATE_DIR"
  --store-dir "/data/nexus-secrets"
  --auto-fix
)
if [[ "$GENERATE_CREDENTIALS_KEY" == "1" ]]; then
  pref_cmd+=(--auto-generate-credentials-key)
fi
if [[ "$REQUIRE_HTTP_API_KEY" == "1" ]]; then
  pref_cmd+=(--require-http-api-key)
fi
"${pref_cmd[@]}"

if [[ ! -s "$TLS_CERT_PEM" ]]; then
  "$TLS_SCRIPT" --san "$(hostname -f)" --san "$(hostname)"
fi
chmod 644 "$TLS_CERT_PEM" 2>/dev/null || sudo chmod 644 "$TLS_CERT_PEM" 2>/dev/null || true

CONFIG_FILE="$STATE_DIR/nexus.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
  printf '{}\n' > "$CONFIG_FILE"
fi

if [[ "$FEDERATION_ENABLE" == "1" ]]; then
  TMP_FILE="$(mktemp)"
  jq \
    --arg profile "$PROFILE" \
    --arg instance "$FEDERATION_INSTANCE_ID" \
    --argjson outbox "$FEDERATION_OUTBOX_ENABLED" \
    --argjson insecure "$FEDERATION_ALLOW_INSECURE_DEV" \
    '
      .runtime = (.runtime // {})
      | .runtime.profile = $profile
      | .federation = (.federation // {})
      | .federation.enabled = true
      | .federation.localInstanceId = $instance
      | .federation.transport = (.federation.transport // {})
      | .federation.transport.adapter = (.federation.transport.adapter // "federation_http")
      | .federation.transport.webhookFirst = (.federation.transport.webhookFirst // true)
      | .federation.transport.pollingFallbackEnabled = (.federation.transport.pollingFallbackEnabled // true)
      | .federation.transport.allowInsecureSignedOnlyDev = $insecure
      | .federation.transport.requireMtls = (if $insecure then false else true end)
      | .federation.webhooks = (.federation.webhooks // {})
      | .federation.webhooks.federatedOnly = (.federation.webhooks.federatedOnly // true)
      | .federation.webhooks.externalEnabled = (.federation.webhooks.externalEnabled // false)
      | .federation.outbox = (.federation.outbox // {})
      | .federation.outbox.enabled = $outbox
      | .federation.outbox.intervalMs = (.federation.outbox.intervalMs // 5000)
      | .federation.outbox.maxBatch = (.federation.outbox.maxBatch // 20)
      | .federation.outbox.requestTimeoutMs = (.federation.outbox.requestTimeoutMs // 10000)
    ' "$CONFIG_FILE" > "$TMP_FILE"
  mv "$TMP_FILE" "$CONFIG_FILE"
else
  TMP_FILE="$(mktemp)"
  jq \
    --arg profile "$PROFILE" \
    '
      .runtime = (.runtime // {})
      | .runtime.profile = $profile
    ' "$CONFIG_FILE" > "$TMP_FILE"
  mv "$TMP_FILE" "$CONFIG_FILE"
fi

# Initialize personalization files if needed (gateway startup is blocked until initialized).
if [[ "$SKIP_INIT" != "1" ]]; then
  NEEDS_INIT=0
  for f in SOUL.md AGENTS.md USER.md CODEGUIDE.md HEARTBEAT.md NOTES.md; do
    if [[ ! -s "$STATE_DIR/$f" ]]; then
      NEEDS_INIT=1
      break
    fi
  done
  if [[ "$NEEDS_INIT" == "1" ]]; then
    INIT_JSON="$STATE_DIR/.init-onboarding.json"
    jq -n \
      --arg agent "$INIT_AGENT_NAME" \
      --arg user "$INIT_USER_NAME" \
      --arg tz "$INIT_TIMEZONE" \
      '{
        identity: {
          name: $agent
        },
        userProfile: {
          name: $user,
          gender: true,
          timezone: $tz
        },
        telegram: {
          enabled: false,
          allowFrom: [],
          pairing: {
            enabled: false,
            codeTtlMs: 3600000,
            maxPending: 3
          }
        }
      }' > "$INIT_JSON"

    NEXUS_GATEWAY_ENV_FILE="$GATEWAY_ENV_PATH" \
    NEXUS_SIDECAR_ENV_FILE="$SIDECAR_ENV_PATH" \
    NEXUS_WATCHDOG_ENV_FILE="$WATCHDOG_ENV_PATH" \
    docker compose -p "$COMPOSE_PROJECT" \
      -f "$BASE_COMPOSE" \
      -f "$SIDECAR_COMPOSE" \
      -f "$TLS_COMPOSE" \
      run --rm --no-deps nexus-primary init --onboarding-json "$INIT_JSON"
    rm -f "$INIT_JSON"
  fi
fi

# Install convenience wrappers in guest home so operators have stable entrypoints
# for secrets onboarding and day-2 credential ops.
cat > "$HOME/secrets-onboard.sh" <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail
cd /data/code
exec infra/scripts/ha-secrets-onboard.sh "$@"
WRAP
chmod +x "$HOME/secrets-onboard.sh"

cat > "$HOME/secretctl.sh" <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail
cd /data/code
exec infra/scripts/ha-secretctl.sh "$@"
WRAP
chmod +x "$HOME/secretctl.sh"

cat > "$HOME/sidecar-bootstrap.sh" <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail
cd /data/code
exec infra/scripts/ha-sidecar-bootstrap.sh "$@"
WRAP
chmod +x "$HOME/sidecar-bootstrap.sh"

# Real deployment run (HA + sidecar + TLS only).
CODE_DIR="$CODE_DIR" CONFIG_ROOT="$CONFIG_ROOT" COMPOSE_PROJECT="$COMPOSE_PROJECT" "$PULL_DEPLOY_SCRIPT"

# Ensure sidecar provider profile is present and reachable.
bootstrap_http_api_key="$(read_env_file_value "NEXUS_HTTP_API_KEY" "$GATEWAY_ENV_PATH")"
if [[ -n "$bootstrap_http_api_key" ]]; then
  NEXUS_HTTP_API_KEY="$bootstrap_http_api_key" "$SIDECAR_BOOTSTRAP_SCRIPT"
else
  "$SIDECAR_BOOTSTRAP_SCRIPT"
fi
REMOTE

log "Provision + deploy complete"
echo "vm_name=${VM_NAME}"
echo "vm_ip=${VM_IP}"
echo "profile=${PROFILE}"
echo "endpoint=http://${VM_IP}:${PORT}"
echo "sidecar_bootstrap_cmd=ssh ${VM_USER}@${VM_IP} ~/sidecar-bootstrap.sh"
echo "secrets_onboard_cmd=ssh ${VM_USER}@${VM_IP} ~/secrets-onboard.sh"
echo "secretctl_cmd=ssh ${VM_USER}@${VM_IP} ~/secretctl.sh list"
if (( FEDERATION_ENABLE )); then
  echo "federation_enabled=1"
  echo "federation_instance_id=${FEDERATION_INSTANCE_ID}"
fi
