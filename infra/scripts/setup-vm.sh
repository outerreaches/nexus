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

    # Verify
    echo "Mounted directories:"
    ls -la /data/
VMSCRIPT

  # Step 15: Setup port forwarding
  log "Setting up port forwarding (18789 + 18790)..."
  sudo tee /etc/systemd/system/nexus-forward.service > /dev/null << EOF
[Unit]
Description=Nexus port forward to VM
After=libvirtd.service network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/socat TCP-LISTEN:18789,fork,reuseaddr TCP:$VM_IP:18789
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

  sudo tee /etc/systemd/system/nexus-forward-tls.service > /dev/null << EOF
[Unit]
Description=Nexus TLS port forward to VM
After=libvirtd.service network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/socat TCP-LISTEN:18790,fork,reuseaddr TCP:$VM_IP:18790
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable --now nexus-forward
  sudo systemctl enable --now nexus-forward-tls

  log "Port forwarding configured and started for ports 18789 (HTTP) and 18790 (HTTPS/WSS)"
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
echo "   # Then follow deployment guide"
echo ""
echo "3. VM management commands:"
echo "   virsh list --all      # List VMs"
echo "   virsh console $VM_NAME  # VM console"
echo "   virsh shutdown $VM_NAME # Graceful shutdown"
echo ""
