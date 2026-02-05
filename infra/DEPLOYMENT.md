# Nexus Deployment Guide - host

This guide sets up Nexus on a host workstation with:
- Linux VM for isolation (QEMU/KVM)
- Local Git remote on the host host
- Fault-tolerant deployment (optional HA mode)
- Self-editing capability for the agent

## Prerequisites

- host with Ubuntu 24.04 LTS installed
- laptop with Nexus codebase at `~/Workspace/Nexus`
- Both machines on the same network
- SSH access to the host

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           laptop (Development)                              │
│  ~/Workspace/Nexus/ ──── git push ───→ host (bare repo)                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     host (Ubuntu 24.04)                         │
│                                                                              │
│  ~/git/nexus.git (bare repo)                                                │
│       │                                                                      │
│       ▼ (git clone / pull)                                                   │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    Linux VM (4GB RAM, 2 vCPU)                          │  │
│  │  /data/code/      ← git clone from host (SSH)                          │  │
│  │  /data/nexus/      ← state, database                                   │  │
│  │  /data/workspace/  ← agent workspace                                   │  │
│  │                                                                        │  │
│  │  Docker: Nexus container                                               │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Host Setup (host)

### 1.1 Install KVM/QEMU

```bash
# SSH into host
ssh user@host

# Update system
sudo apt update && sudo apt upgrade -y

# Install virtualization packages
sudo apt install -y \
  qemu-kvm \
  libvirt-daemon-system \
  libvirt-clients \
  bridge-utils \
  virtinst \
  virt-manager \
  cloud-image-utils

# Add user to groups
sudo usermod -aG libvirt $USER
sudo usermod -aG kvm $USER

# Verify KVM works
sudo kvm-ok

# Start libvirt
sudo systemctl enable --now libvirtd

# Logout and login again for group changes
exit
```

### 1.2 Set up Local Git Remote (Host)

```bash
ssh user@host

# Create a bare repo to receive pushes
mkdir -p ~/git
git init --bare ~/git/nexus.git
```

---

## Phase 2: laptop Git Setup

### 2.1 Add host Remote and Push

```bash
# On laptop
cd ~/Workspace/Nexus
git remote add host ssh://user@host/~/git/nexus.git
git push host main
```

### 2.2 Pull on host Working Tree

```bash
# On VM (first time clone)
git clone ssh://user@host/~/git/nexus.git /data/code
```

---

## Phase 3: Create the VM

### 3.1 Download Ubuntu Cloud Image

```bash
ssh user@host

cd /var/lib/libvirt/images
sudo wget https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
```

### 3.2 Create Cloud-Init Config

```bash
# Create cloud-init directory
mkdir -p ~/vm-configs
cd ~/vm-configs

# Get your SSH public key
cat ~/.ssh/id_ed25519.pub  # or id_rsa.pub

# Create cloud-init config
cat > cloud-init.yaml << 'EOF'
#cloud-config
hostname: nexus-vm
users:
  - name: nexus
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - YOUR_SSH_PUBLIC_KEY_HERE
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

# Edit to add your actual SSH key
nano cloud-init.yaml
```

### 3.3 Create VM Disk

```bash
# Create VM disk (thin provisioned, grows to 20GB)
sudo qemu-img create -f qcow2 \
  -F qcow2 \
  -b /var/lib/libvirt/images/noble-server-cloudimg-amd64.img \
  /var/lib/libvirt/images/nexus-vm.qcow2 20G

# Create cloud-init ISO
cloud-localds ~/vm-configs/cloud-init.iso ~/vm-configs/cloud-init.yaml
```

### 3.4 Create and Start VM

```bash
# Create VM
sudo virt-install \
  --name nexus-vm \
  --memory 4096 \
  --vcpus 2 \
  --disk /var/lib/libvirt/images/nexus-vm.qcow2 \
  --disk ~/vm-configs/cloud-init.iso,device=cdrom \
  --os-variant ubuntu24.04 \
  --network network=default \
  --graphics none \
  --console pty,target_type=serial \
  --import \
  --noautoconsole

# Wait for VM to boot (about 60 seconds)
sleep 60

# Get VM IP
VM_IP=$(virsh domifaddr nexus-vm | grep -oE '192\.168\.[0-9]+\.[0-9]+')
echo "VM IP: $VM_IP"
```

### 3.5 Configure VM

```bash
# SSH into VM
ssh nexus@$VM_IP

# Create other directories
sudo mkdir -p /data/{nexus,workspace}
sudo chown -R nexus:nexus /data

# Verify Docker works
docker --version
docker compose version

# Clone code from host host
git clone ssh://user@host/~/git/nexus.git /data/code
```

---

## Phase 4: Deploy Nexus

### 4.1 Create Docker Compose File

```bash
# On VM
mkdir -p ~/nexus-deploy
cd ~/nexus-deploy

cat > docker-compose.yml << 'EOF'
version: "3.8"

services:
  nexus:
    build:
      context: /data/code
      dockerfile: Dockerfile
    command: gateway --verbose
    volumes:
      # Code directory (read-write for self-editing)
      - /data/code:/data/code:rw
      # State directory (database, config)
      - /data/nexus:/data/nexus
      # Agent workspace
      - /data/workspace:/data/workspace
    environment:
      - NEXUS_STATE_DIR=/data/nexus
      - NEXUS_CODE_DIR=/data/code
      - NEXUS_WORKSPACE_DIR=/data/workspace
      - NEXUS_BROWSER_HEADLESS=1
      - NEXUS_BROWSER_NO_SANDBOX=1
      - NEXUS_ALLOW_SHELL_EXEC=1
      - NEXUS_ALLOW_CODE_EDIT=1
    env_file:
      - .env
    ports:
      - "18789:18789"
    restart: unless-stopped
    deploy:
      resources:
        limits:
          cpus: '1.5'
          memory: 3G
EOF
```

### 4.2 Create Environment File

```bash
# On VM
cat > ~/nexus-deploy/.env << 'EOF'
# LLM Configuration
OPENROUTER_API_KEY=your_api_key_here

# Telegram (optional)
TELEGRAM_BOT_TOKEN=your_bot_token_here

# Other settings
TZ=America/Los_Angeles
EOF

# Edit with your actual keys
nano ~/nexus-deploy/.env
```

### 4.3 Initialize Nexus Config

```bash
# On VM - create initial config
mkdir -p /data/nexus
cat > /data/nexus/nexus.json << 'EOF'
{
  "port": 18789,
  "llm": {
    "openaiCompat": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "model": "anthropic/claude-sonnet-4"
    }
  },
  "permissions": {
    "allowShellExec": true,
    "allowCodeEdit": true
  },
  "channels": {
    "telegram": {
      "enabled": false
    }
  },
  "scheduler": {
    "enabled": true
  },
  "proactive": {
    "enabled": true,
    "intervalMs": 3600000
  }
}
EOF
```

### 4.4 Build and Start

```bash
cd ~/nexus-deploy

# Build the image
docker compose build

# Start Nexus
docker compose up -d

# Check logs
docker compose logs -f
```

### 4.5 Verify Deployment

```bash
# On VM
curl http://localhost:18789/health/live
# Should return: {"ok":true,"timestamp":...}

curl http://localhost:18789/health/ready
# Should return: {"ok":true,"checks":{"database":{"ok":true},"agents":{"ok":true}},...}

curl http://localhost:18789/status | jq .
```

---

## Phase 5: Network Access

### 5.1 Port Forward from Host to VM

```bash
# On host host
VM_IP=$(virsh domifaddr nexus-vm | grep -oE '192\.168\.[0-9]+\.[0-9]+')

# Install socat for port forwarding
sudo apt install -y socat

# Create systemd service for persistent port forwarding
sudo tee /etc/systemd/system/nexus-forward.service << EOF
[Unit]
Description=Nexus port forward to VM
After=libvirtd.service

[Service]
Type=simple
ExecStart=/usr/bin/socat TCP-LISTEN:18789,fork,reuseaddr TCP:${VM_IP}:18789
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now nexus-forward

# Verify
curl http://localhost:18789/health/live
```

### 5.2 Access from laptop

```bash
# On laptop
curl http://host:18789/health/live

# Or open dashboard in browser
open http://host:18789/dashboard
```

### 5.3 (Optional) Tailscale Setup

```bash
# On host host
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# On laptop
brew install tailscale
tailscale up

# Now access via Tailscale hostname
curl http://host-tailscale-hostname:18789/health/live
```

---

## Phase 6: Maintenance

### 6.1 Update Nexus Code (Git → host)

```bash
# On laptop
cd ~/Workspace/Nexus
git push host main

# On VM
cd /data/code
git pull
cd ~/nexus-deploy
docker compose build
docker compose up -d
```

### 6.2 View Logs

```bash
# On VM
docker compose logs -f nexus

# Or on host via SSH
ssh nexus@$(virsh domifaddr nexus-vm | grep -oE '192\.168\.[0-9]+\.[0-9]+') \
  "cd ~/nexus-deploy && docker compose logs -f"
```

### 6.3 Rollback Agent Code Changes

If the agent breaks the code:

```bash
# On laptop (where git repo is authoritative)
cd ~/Workspace/Nexus
git log --oneline -10  # Find the good commit
git reset --hard HEAD~1  # Or specific commit hash

# Push rollback to host, then rebuild on VM
git push host main
ssh nexus@host-vm "cd /data/code && git pull && cd ~/nexus-deploy && docker compose build && docker compose up -d"
```

### 6.4 VM Snapshots

```bash
# On host host
# Create snapshot before risky operations
virsh snapshot-create-as nexus-vm clean-state "Known good state"

# List snapshots
virsh snapshot-list nexus-vm

# Revert if needed
virsh snapshot-revert nexus-vm clean-state
```

### 6.5 Backup Database

```bash
# On VM
cp /data/nexus/nexus.db /data/nexus/nexus.db.backup.$(date +%Y%m%d)
```

---

## Troubleshooting

### VM won't start

```bash
# Check libvirt logs
sudo journalctl -u libvirtd -f

# Check VM status
virsh list --all
virsh start nexus-vm
virsh console nexus-vm
```

### Docker build fails

```bash
# On VM - check disk space
df -h /data

# Clear Docker cache
docker system prune -a
```

### Port forward not working

```bash
# On host - check socat service
sudo systemctl status nexus-forward
sudo journalctl -u nexus-forward -f

# Check VM is running and has correct IP
virsh domifaddr nexus-vm
```

---

## Quick Reference

| Component | Location | Access |
|-----------|----------|--------|
| Nexus API | VM container | `http://host:18789` |
| Dashboard | VM container | `http://host:18789/dashboard` |
| VM console | host | `virsh console nexus-vm` |
| host bare repo | host | `~/git/nexus.git` |
| VM code dir | VM | `/data/code` |

| Command | Purpose |
|---------|---------|
| `virsh list --all` | List VMs |
| `virsh start nexus-vm` | Start VM |
| `virsh shutdown nexus-vm` | Graceful shutdown |
| `virsh snapshot-create-as nexus-vm NAME` | Create snapshot |
| `docker compose logs -f` | View Nexus logs |
| `docker compose restart` | Restart Nexus |
