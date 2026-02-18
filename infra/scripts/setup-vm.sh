#!/usr/bin/env bash
# Nexus VM Setup Script for libvirt hosts

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[!]${NC} $1"; exit 1; }

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Options:
  --vm-name <name>             VM name (default: nexus-vm)
  --hostname <name>            Guest hostname (default: <vm-name>)
  --memory-mb <mb>             VM memory in MB (default: 4096)
  --cpus <count>               VM vCPU count (default: 2)
  --disk-size <size>           VM disk size (default: 20G)
  --network <name>             libvirt network name (default: default)
  --enable-forwarding          Configure host systemd TCP forwarders to guest ports
  --forward-http-port <port>   Host TCP listen port for HTTP (default: 18789)
  --forward-https-port <port>  Host TCP listen port for HTTPS/WSS (default: 18790)
  --skip-packages              Skip apt package install/updates
  --help                       Show this help message

Environment overrides:
  VM_NAME, VM_MEMORY_MB, VM_CPUS, VM_DISK_SIZE, VM_NETWORK
  ENABLE_FORWARDING, FORWARD_HTTP_PORT, FORWARD_HTTPS_PORT
USAGE
}

if [[ "${EUID}" -eq 0 ]]; then
  error "Do not run this script as root. Run as a regular user with sudo access."
fi

VM_NAME="${VM_NAME:-nexus-vm}"
VM_HOSTNAME="${VM_HOSTNAME:-}"
VM_MEMORY_MB="${VM_MEMORY_MB:-4096}"
VM_CPUS="${VM_CPUS:-2}"
VM_DISK_SIZE="${VM_DISK_SIZE:-20G}"
VM_NETWORK="${VM_NETWORK:-default}"
ENABLE_FORWARDING="${ENABLE_FORWARDING:-0}"
FORWARD_HTTP_PORT="${FORWARD_HTTP_PORT:-18789}"
FORWARD_HTTPS_PORT="${FORWARD_HTTPS_PORT:-18790}"
SKIP_PACKAGES="0"

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
    --enable-forwarding)
      ENABLE_FORWARDING="1"
      shift
      ;;
    --forward-http-port)
      FORWARD_HTTP_PORT="$2"
      shift 2
      ;;
    --forward-https-port)
      FORWARD_HTTPS_PORT="$2"
      shift 2
      ;;
    --skip-packages)
      SKIP_PACKAGES="1"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      error "Unknown option: $1"
      ;;
  esac
done

if [[ -z "${VM_HOSTNAME}" ]]; then
  VM_HOSTNAME="${VM_NAME}"
fi

VM_CONFIG_DIR="/var/lib/libvirt/boot"
CLOUD_IMAGE_URL="https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img"
CLOUD_IMAGE_PATH="/var/lib/libvirt/images/noble-server-cloudimg-amd64.img"
VM_DISK_PATH="/var/lib/libvirt/images/${VM_NAME}.qcow2"
CLOUD_INIT_YAML="${VM_CONFIG_DIR}/${VM_NAME}-cloud-init.yaml"
CLOUD_INIT_ISO="${VM_CONFIG_DIR}/${VM_NAME}-cloud-init.iso"
VM_USER="nexus"

safe_vm_name() {
  echo "$1" | tr -c 'a-zA-Z0-9_.-' '-'
}

get_vm_ip() {
  virsh domifaddr "${VM_NAME}" 2>/dev/null | awk '/ipv4/ {print $4}' | cut -d/ -f1 | head -n1
}

log "Starting VM setup for ${VM_NAME}"

if [[ "${SKIP_PACKAGES}" != "1" ]]; then
  log "Installing required packages"
  sudo apt update
  sudo apt install -y \
    qemu-kvm \
    libvirt-daemon-system \
    libvirt-clients \
    bridge-utils \
    virtinst \
    cloud-image-utils \
    socat \
    curl \
    jq
else
  warn "Skipping package installation (--skip-packages set)"
fi

log "Ensuring host groups/services are configured"
sudo usermod -aG libvirt "$USER"
sudo usermod -aG kvm "$USER"
sudo systemctl enable --now libvirtd

log "Preparing libvirt boot directory"
sudo mkdir -p "${VM_CONFIG_DIR}"
sudo chown "$USER:$USER" "${VM_CONFIG_DIR}"

log "Ensuring Ubuntu cloud image is present"
if [[ ! -f "${CLOUD_IMAGE_PATH}" ]]; then
  sudo wget -O "${CLOUD_IMAGE_PATH}" "${CLOUD_IMAGE_URL}"
else
  log "Cloud image already present at ${CLOUD_IMAGE_PATH}"
fi

if [[ -f ~/.ssh/id_ed25519.pub ]]; then
  SSH_KEY="$(cat ~/.ssh/id_ed25519.pub)"
elif [[ -f ~/.ssh/id_rsa.pub ]]; then
  SSH_KEY="$(cat ~/.ssh/id_rsa.pub)"
else
  warn "No SSH key found; generating ~/.ssh/id_ed25519"
  ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
  SSH_KEY="$(cat ~/.ssh/id_ed25519.pub)"
fi

log "Writing cloud-init config ${CLOUD_INIT_YAML}"
cat > "${CLOUD_INIT_YAML}" <<CLOUDINIT
#cloud-config
hostname: ${VM_HOSTNAME}
users:
  - name: ${VM_USER}
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - ${SSH_KEY}
package_update: true
packages:
  - docker.io
  - docker-compose-v2
  - git
  - curl
runcmd:
  - systemctl enable docker
  - usermod -aG docker ${VM_USER}
  - mkdir -p /data/{code,nexus,workspace}
  - chown -R ${VM_USER}:${VM_USER} /data
CLOUDINIT

log "Creating cloud-init ISO ${CLOUD_INIT_ISO}"
cloud-localds "${CLOUD_INIT_ISO}" "${CLOUD_INIT_YAML}"

if [[ -f "${VM_DISK_PATH}" ]]; then
  warn "VM disk already exists: ${VM_DISK_PATH}"
else
  log "Creating VM disk ${VM_DISK_PATH} (${VM_DISK_SIZE})"
  sudo qemu-img create -f qcow2 -F qcow2 -b "${CLOUD_IMAGE_PATH}" "${VM_DISK_PATH}" "${VM_DISK_SIZE}"
fi

if virsh list --all | grep -qE "^\s*[-0-9]+\s+${VM_NAME}\s+"; then
  warn "VM '${VM_NAME}' already exists"
  read -r -p "Delete and recreate? (y/N) " reply
  if [[ "${reply}" =~ ^[Yy]$ ]]; then
    virsh destroy "${VM_NAME}" 2>/dev/null || true
    virsh undefine "${VM_NAME}" --remove-all-storage 2>/dev/null || true
    sudo qemu-img create -f qcow2 -F qcow2 -b "${CLOUD_IMAGE_PATH}" "${VM_DISK_PATH}" "${VM_DISK_SIZE}"
  else
    log "Keeping existing VM"
    exit 0
  fi
fi

log "Creating VM ${VM_NAME}"
sudo virt-install \
  --name "${VM_NAME}" \
  --memory "${VM_MEMORY_MB}" \
  --vcpus "${VM_CPUS}" \
  --disk "${VM_DISK_PATH}" \
  --disk "${CLOUD_INIT_ISO},device=cdrom" \
  --os-variant ubuntu24.04 \
  --network "network=${VM_NETWORK}" \
  --graphics none \
  --console pty,target_type=serial \
  --import \
  --noautoconsole

log "Waiting for VM boot"
sleep 60

VM_IP="$(get_vm_ip || true)"
if [[ -z "${VM_IP}" ]]; then
  warn "Unable to resolve ${VM_NAME} IP via virsh domifaddr"
  warn "Run manually: virsh domifaddr ${VM_NAME}"
else
  log "VM IP: ${VM_IP}"
  log "Waiting for SSH readiness"
  for _ in {1..30}; do
    if ssh -o ConnectTimeout=2 -o StrictHostKeyChecking=no "${VM_USER}@${VM_IP}" "echo ok" >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done

  log "Configuring guest filesystem helper script"
  ssh -o StrictHostKeyChecking=no "${VM_USER}@${VM_IP}" "bash -s" <<'VMSCRIPT'
set -euo pipefail
sudo mkdir -p /data/code /data/nexus /data/workspace
sudo chown -R nexus:nexus /data
VMSCRIPT

  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PULL_DEPLOY_SCRIPT="${SCRIPT_DIR}/pull-deploy.sh"
  if [[ ! -f "${PULL_DEPLOY_SCRIPT}" ]]; then
    error "Missing helper script in repo: ${PULL_DEPLOY_SCRIPT}"
  fi

  scp -o StrictHostKeyChecking=no "${PULL_DEPLOY_SCRIPT}" "${VM_USER}@${VM_IP}:/home/nexus/pull-deploy.sh"
  ssh -o StrictHostKeyChecking=no "${VM_USER}@${VM_IP}" "chmod +x /home/nexus/pull-deploy.sh"
fi

if [[ "${ENABLE_FORWARDING}" == "1" ]]; then
  SAFE_VM_NAME="$(safe_vm_name "${VM_NAME}")"
  CONNECT_HELPER="/usr/local/bin/nexus-forward-connect-${SAFE_VM_NAME}.sh"
  HTTP_SERVICE="nexus-forward-${SAFE_VM_NAME}-http.service"
  HTTPS_SERVICE="nexus-forward-${SAFE_VM_NAME}-https.service"

  log "Configuring optional host forwarding (${FORWARD_HTTP_PORT}, ${FORWARD_HTTPS_PORT})"

  sudo tee "${CONNECT_HELPER}" >/dev/null <<EOF_CONNECT
#!/usr/bin/env bash
set -euo pipefail
VM_NAME="${VM_NAME}"
PORT="\${NEXUS_FORWARD_PORT:-}"
if ! [[ "\${PORT}" =~ ^[0-9]+$ ]]; then
  echo "invalid NEXUS_FORWARD_PORT='\${PORT}'" >&2
  exit 64
fi
lookup_vm_ip() {
  virsh domifaddr "\${VM_NAME}" 2>/dev/null | awk '/ipv4/ {print \$4}' | cut -d/ -f1 | head -n1
}
for _ in {1..20}; do
  VM_IP="\$(lookup_vm_ip || true)"
  if [ -n "\${VM_IP}" ]; then
    exec /usr/bin/socat STDIO "TCP:\${VM_IP}:\${PORT}"
  fi
  sleep 1
done
echo "unable to resolve IPv4 for VM '\${VM_NAME}'" >&2
exit 1
EOF_CONNECT
  sudo chmod 0755 "${CONNECT_HELPER}"

  sudo tee "/etc/systemd/system/${HTTP_SERVICE}" >/dev/null <<EOF_HTTP
[Unit]
Description=Nexus forward ${VM_NAME} HTTP
After=libvirtd.service network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=NEXUS_FORWARD_PORT=${FORWARD_HTTP_PORT}
ExecStart=/usr/bin/socat TCP-LISTEN:${FORWARD_HTTP_PORT},fork,reuseaddr EXEC:${CONNECT_HELPER},nofork
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF_HTTP

  sudo tee "/etc/systemd/system/${HTTPS_SERVICE}" >/dev/null <<EOF_HTTPS
[Unit]
Description=Nexus forward ${VM_NAME} HTTPS/WSS
After=libvirtd.service network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=NEXUS_FORWARD_PORT=${FORWARD_HTTPS_PORT}
ExecStart=/usr/bin/socat TCP-LISTEN:${FORWARD_HTTPS_PORT},fork,reuseaddr EXEC:${CONNECT_HELPER},nofork
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF_HTTPS

  sudo systemctl daemon-reload
  sudo systemctl enable --now "${HTTP_SERVICE%.service}"
  sudo systemctl enable --now "${HTTPS_SERVICE%.service}"
  log "Forwarding services enabled: ${HTTP_SERVICE}, ${HTTPS_SERVICE}"
else
  log "Forwarding not configured (default). Use --enable-forwarding if needed."
fi

echo
echo "======================================"
log "VM setup complete"
echo "======================================"
echo "VM name: ${VM_NAME}"
echo "VM hostname: ${VM_HOSTNAME}"
echo "VM disk: ${VM_DISK_PATH}"
if [[ -n "${VM_IP:-}" ]]; then
  echo "VM IP: ${VM_IP}"
fi
