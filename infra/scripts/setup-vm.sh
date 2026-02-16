#!/bin/bash
# Nexus VM Setup Script for host
# Run this on the host host after installing Ubuntu 24.04

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[!]${NC} $1"; exit 1; }

# Check if running as root
if [ "$EUID" -eq 0 ]; then
  error "Don't run this script as root. Run as your regular user."
fi

# Configuration
VM_NAME="nexus-vm"
VM_MEMORY="4096"  # 4GB
VM_CPUS="2"
VM_DISK_SIZE="20G"
VM_CONFIG_DIR="/var/lib/libvirt/boot"  # Use libvirt-accessible directory
CLOUD_IMAGE_URL="https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img"

log "Starting Nexus VM setup..."

# Step 1: Install packages
log "Installing required packages..."
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

# Step 2: Configure user groups
log "Configuring user groups..."
sudo usermod -aG libvirt $USER
sudo usermod -aG kvm $USER

# Step 3: Start services
log "Starting services..."
sudo systemctl enable --now libvirtd

# Step 4: Create directories
log "Creating directories..."
sudo mkdir -p "$VM_CONFIG_DIR"
sudo chown $USER:$USER "$VM_CONFIG_DIR"

# Step 5: Download cloud image
log "Downloading Ubuntu cloud image..."
if [ ! -f /var/lib/libvirt/images/noble-server-cloudimg-amd64.img ]; then
  sudo wget -O /var/lib/libvirt/images/noble-server-cloudimg-amd64.img "$CLOUD_IMAGE_URL"
else
  log "Cloud image already exists, skipping download"
fi

# Step 6: Get SSH key
if [ -f ~/.ssh/id_ed25519.pub ]; then
  SSH_KEY=$(cat ~/.ssh/id_ed25519.pub)
elif [ -f ~/.ssh/id_rsa.pub ]; then
  SSH_KEY=$(cat ~/.ssh/id_rsa.pub)
else
  warn "No SSH key found. Generating one..."
  ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
  SSH_KEY=$(cat ~/.ssh/id_ed25519.pub)
fi

# Step 7: Create cloud-init config
log "Creating cloud-init configuration..."
cat > "$VM_CONFIG_DIR/cloud-init.yaml" << EOF
#cloud-config
hostname: nexus-vm
users:
  - name: nexus
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $SSH_KEY
package_update: true
packages:
  - docker.io
  - docker-compose-v2
  - git
  - curl
runcmd:
  - systemctl enable docker
  - usermod -aG docker nexus
  - mkdir -p /data/{code,nexus,workspace}
  - chown -R nexus:nexus /data
EOF

# Step 8: Create cloud-init ISO
log "Creating cloud-init ISO..."
cloud-localds "$VM_CONFIG_DIR/cloud-init.iso" "$VM_CONFIG_DIR/cloud-init.yaml"

# Step 9: Create VM disk
log "Creating VM disk..."
if [ -f /var/lib/libvirt/images/nexus-vm.qcow2 ]; then
  warn "VM disk already exists. Skipping creation."
else
  sudo qemu-img create -f qcow2 \
    -F qcow2 \
    -b /var/lib/libvirt/images/noble-server-cloudimg-amd64.img \
    /var/lib/libvirt/images/nexus-vm.qcow2 "$VM_DISK_SIZE"
fi

# Step 10: Check if VM already exists
if virsh list --all | grep -q "$VM_NAME"; then
  warn "VM '$VM_NAME' already exists."
  read -p "Delete and recreate? (y/N) " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    virsh destroy "$VM_NAME" 2>/dev/null || true
    virsh undefine "$VM_NAME" --remove-all-storage 2>/dev/null || true
    sudo qemu-img create -f qcow2 \
      -F qcow2 \
      -b /var/lib/libvirt/images/noble-server-cloudimg-amd64.img \
      /var/lib/libvirt/images/nexus-vm.qcow2 "$VM_DISK_SIZE"
  else
    log "Keeping existing VM."
    exit 0
  fi
fi

# Step 11: Create VM
log "Creating VM..."
sudo virt-install \
  --name "$VM_NAME" \
  --memory "$VM_MEMORY" \
  --vcpus "$VM_CPUS" \
  --disk /var/lib/libvirt/images/nexus-vm.qcow2 \
  --disk "$VM_CONFIG_DIR/cloud-init.iso,device=cdrom" \
  --os-variant ubuntu24.04 \
  --network network=default \
  --graphics none \
  --console pty,target_type=serial \
  --import \
  --noautoconsole

log "Waiting for VM to boot (60 seconds)..."
sleep 60

# Step 12: Get VM IP
VM_IP=$(virsh domifaddr "$VM_NAME" 2>/dev/null | grep -oE '192\.168\.[0-9]+\.[0-9]+' || echo "")

if [ -z "$VM_IP" ]; then
  warn "Could not get VM IP. VM might still be booting."
  log "Try running: virsh domifaddr $VM_NAME"
else
  log "VM IP: $VM_IP"

  # Step 13: Wait for SSH
  log "Waiting for SSH to be available..."
  for i in {1..30}; do
    if ssh -o ConnectTimeout=2 -o StrictHostKeyChecking=no "nexus@$VM_IP" "echo ok" 2>/dev/null; then
      break
    fi
    sleep 2
  done

  # Step 14: Configure VM
  log "Configuring VM..."
  ssh -o StrictHostKeyChecking=no "nexus@$VM_IP" << 'VMSCRIPT'
    # Ensure mount points exist
    sudo mkdir -p /data/code /data/nexus /data/workspace
    sudo chown -R nexus:nexus /data

    # Install a robust pull+deploy helper that always includes TLS overlay.
    cat > /home/nexus/pull-deploy.sh << 'PULLDEPLOY'
#!/usr/bin/env bash
set -euo pipefail

CODE_DIR="${CODE_DIR:-/data/code}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-infra}"
BASE_COMPOSE="${BASE_COMPOSE:-${CODE_DIR}/infra/docker-compose.ha.yml}"
TLS_COMPOSE="${TLS_COMPOSE:-${CODE_DIR}/infra/docker-compose.ha.tls.yml}"
TLS_CERT_PEM="${NEXUS_HAPROXY_TLS_CERT_PEM:-${CODE_DIR}/infra/haproxy/certs/nexus.pem}"

if [ ! -d "$CODE_DIR" ]; then
  echo "[pull-deploy] missing code dir: $CODE_DIR" >&2
  exit 1
fi

cd "$CODE_DIR"
git fetch origin main
git merge --ff-only origin/main

if [ ! -f "$BASE_COMPOSE" ]; then
  echo "[pull-deploy] missing compose file: $BASE_COMPOSE" >&2
  exit 1
fi
if [ ! -f "$TLS_COMPOSE" ]; then
  echo "[pull-deploy] missing TLS compose overlay: $TLS_COMPOSE" >&2
  exit 1
fi
if [ ! -f "$TLS_CERT_PEM" ]; then
  echo "[pull-deploy] missing TLS cert bundle: $TLS_CERT_PEM" >&2
  echo "[pull-deploy] run: bash infra/scripts/ha-generate-tls-cert.sh --san <gateway-host-or-ip>" >&2
  exit 1
fi

docker compose -p "$COMPOSE_PROJECT" -f "$BASE_COMPOSE" -f "$TLS_COMPOSE" up -d --build --force-recreate
docker compose -p "$COMPOSE_PROJECT" -f "$BASE_COMPOSE" -f "$TLS_COMPOSE" ps

if command -v openssl >/dev/null 2>&1; then
  FP="$(openssl x509 -in "$TLS_CERT_PEM" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//' || true)"
  if [ -n "$FP" ]; then
    echo "[pull-deploy] gateway TLS fingerprint: $FP"
    echo "[pull-deploy] node setting: NEXUS_NODE_GATEWAY_TLS_FINGERPRINT=$FP"
  fi
fi
PULLDEPLOY
    chmod +x /home/nexus/pull-deploy.sh

    # Verify
    echo "Mounted directories:"
    ls -la /data/
VMSCRIPT

  # Step 15: Setup port forwarding
  log "Setting up port forwarding (18789 + 18790)..."

  # Some older installs created a separate legacy TLS unit that can conflict with
  # nexus-forward-tls.service by binding :18790 first.
  if [ -f /etc/systemd/system/nexus-forward-18790.service ]; then
    warn "Found legacy unit nexus-forward-18790.service; disabling to avoid :18790 bind conflicts."
    sudo systemctl disable --now nexus-forward-18790.service || true
    sudo rm -f /etc/systemd/system/nexus-forward-18790.service
  fi

  # Resolve VM IP per accepted connection. This keeps forwarding working if the
  # VM gets a new DHCP lease after restart.
  sudo tee /usr/local/bin/nexus-forward-connect.sh > /dev/null << 'EOF'
#!/usr/bin/env bash
set -euo pipefail

VM_NAME="${NEXUS_FORWARD_VM_NAME:-nexus-vm}"
PORT="${NEXUS_FORWARD_PORT:-}"

if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "nexus-forward-connect: invalid NEXUS_FORWARD_PORT='${PORT}'" >&2
  exit 64
fi

lookup_vm_ip() {
  virsh domifaddr "$VM_NAME" 2>/dev/null | awk '/ipv4/ {print $4}' | cut -d/ -f1 | head -n1
}

for _ in {1..20}; do
  VM_IP="$(lookup_vm_ip || true)"
  if [ -n "$VM_IP" ]; then
    exec /usr/bin/socat STDIO "TCP:${VM_IP}:${PORT}"
  fi
  sleep 1
done

echo "nexus-forward-connect: unable to resolve IPv4 for VM '${VM_NAME}'" >&2
exit 1
EOF
  sudo chmod 0755 /usr/local/bin/nexus-forward-connect.sh

  sudo tee /etc/systemd/system/nexus-forward.service > /dev/null << 'EOF'
[Unit]
Description=Nexus port forward to VM
After=libvirtd.service network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=NEXUS_FORWARD_VM_NAME=nexus-vm
Environment=NEXUS_FORWARD_PORT=18789
ExecStart=/usr/bin/socat TCP-LISTEN:18789,fork,reuseaddr EXEC:/usr/local/bin/nexus-forward-connect.sh,nofork
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

  sudo tee /etc/systemd/system/nexus-forward-tls.service > /dev/null << 'EOF'
[Unit]
Description=Nexus TLS port forward to VM
After=libvirtd.service network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=NEXUS_FORWARD_VM_NAME=nexus-vm
Environment=NEXUS_FORWARD_PORT=18790
ExecStart=/usr/bin/socat TCP-LISTEN:18790,fork,reuseaddr EXEC:/usr/local/bin/nexus-forward-connect.sh,nofork
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable --now nexus-forward
  sudo systemctl enable --now nexus-forward-tls

  log "Port forwarding configured with dynamic VM IP resolution for 18789 (HTTP) and 18790 (HTTPS/WSS)"
fi

echo ""
echo "======================================"
log "VM setup complete!"
echo "======================================"
echo ""
echo "Next steps:"
echo "1. Push code to the host bare repo from your laptop"
echo "   git remote add host ssh://user@host/~/git/nexus.git"
echo "   git push host main"
echo ""
echo "2. After code is pushed, SSH into VM and clone the repo:"
echo "   ssh nexus@$VM_IP"
echo "   git clone ssh://user@host/~/git/nexus.git /data/code"
echo "   /home/nexus/pull-deploy.sh   # Pull + rebuild using TLS-safe compose files"
echo ""
echo "3. VM management commands:"
echo "   virsh list --all      # List VMs"
echo "   virsh console $VM_NAME  # VM console"
echo "   virsh shutdown $VM_NAME # Graceful shutdown"
echo ""
