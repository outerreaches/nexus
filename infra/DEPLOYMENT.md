# Nexus Deployment Guide - host

This guide sets up Nexus on a host workstation with:
- Linux VM for isolation (QEMU/KVM)
- Local Git remote on the host host
- Fault-tolerant HA deployment (required)
- Self-editing capability for the agent

For gateway API/dashboard auth rollout, use `infra/internal-doc` before rotating credentials.

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

# NOTE: libvirt can't read files under /home/$USER by default.
# Copy the ISO into /var/lib/libvirt/boot for use with virt-install:
#   sudo cp ~/vm-configs/cloud-init.iso /var/lib/libvirt/boot/nexus-cloud-init.iso
#   sudo chmod 644 /var/lib/libvirt/boot/nexus-cloud-init.iso
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
# Create VM (use cloud-init ISO from /var/lib/libvirt/boot)
sudo virt-install \
  --name nexus-vm \
  --memory 4096 \
  --vcpus 2 \
  --disk /var/lib/libvirt/images/nexus-vm.qcow2 \
  --disk /var/lib/libvirt/boot/nexus-cloud-init.iso,device=cdrom \
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
      # WARNING: enables shell command execution from agent runs
      - NEXUS_ALLOW_SHELL_EXEC=1
      # WARNING: enables direct code writes under root="code"
      - NEXUS_ALLOW_CODE_WRITE=1
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
TZ=America/New_York
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
      "model": "moonshotai/kimi-k2.5"
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
    "enabled": true,
    "contextMode": "delta"
  },
  "proactive": {
    "enabled": true,
    "intervalMs": 3600000,
    "pauseOnActiveTelegram": true,
    "activeTelegramQuietMs": 120000
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
# Install socat for port forwarding
sudo apt install -y socat

# Remove legacy TLS forwarder if present (can conflict on :18790)
sudo systemctl disable --now nexus-forward-18790.service 2>/dev/null || true
sudo rm -f /etc/systemd/system/nexus-forward-18790.service

# Helper: resolve VM IP at connection time
sudo tee /usr/local/bin/nexus-forward-connect.sh << 'EOF'
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

# Create systemd services for persistent port forwarding
sudo tee /etc/systemd/system/nexus-forward.service << 'EOF'
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

sudo tee /etc/systemd/system/nexus-forward-tls.service << 'EOF'
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

# Verify
curl http://localhost:18789/health/live
curl -k https://localhost:18790/health/live
```

This forwarding model resolves the VM IP on each incoming connection, so VM restarts / DHCP lease changes do not require manual systemd edits or forwarder restarts.

### 5.2 Access from laptop

```bash
# On laptop
curl http://host:18789/health/live

# Secure endpoint used by node wss transport
curl -k https://host:18790/health/live

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

### 6.1 Update Nexus Code

**From laptop (manual push):**

```bash
cd ~/Workspace/Nexus
git push host main

# On VM — preferred helper (keeps TLS overlay + preflight checks)
ssh nexus@<vm-ip> "/home/nexus/pull-deploy.sh"

# Equivalent manual form (if helper is unavailable)
cd /data/code
git pull
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml -f /data/code/infra/docker-compose.ha.sidecar.yml -f /data/code/infra/docker-compose.ha.tls.yml up -d --build --force-recreate
```

`/home/nexus/pull-deploy.sh` also prints the active gateway TLS fingerprint after deploy to simplify node pin verification updates.

**From agent (automated):** The coder agent deploys via `ha_deploy` tool. See Section 7.3.2 for the full automated flow. No manual intervention needed.

### 6.2 View Logs

```bash
# HA stack logs (all services)
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml logs -f

# Specific service
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml logs -f nexus-primary
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml logs -f nexus-standby

# ha-deployer daemon logs
sudo journalctl -u ha-deployer -f

# Deploy state
cat /data/nexus/deploy-state.env
```

### 6.3 Rollback Agent Code Changes

If the agent breaks the code:

```bash
# On VM
cd /data/code
infra/scripts/ha-rollout.sh rollback          # Roll back to last-good commit
infra/scripts/ha-rollout.sh rollback <sha>    # Roll back to specific commit

# Or from laptop (nuclear option)
cd ~/Workspace/Nexus
git log --oneline -10  # Find the good commit
git push --force host main
# Then on VM:
cd /data/code && git fetch && git reset --hard host/main
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml -f /data/code/infra/docker-compose.ha.sidecar.yml -f /data/code/infra/docker-compose.ha.tls.yml up -d --build --force-recreate
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

## Phase 7: High Availability Setup (Optional)

This section covers deploying Nexus in a fault-tolerant primary/standby configuration with automatic failover.

### 7.1 HA Architecture Overview

```
                    ┌─────────────┐
                    │   HAProxy   │ :18789 (external)
                    │ Load Balancer│
                    └──────┬──────┘
                           │
           ┌───────────────┴───────────────┐
           │                               │
    ┌──────▼──────┐                ┌───────▼─────┐
    │   Primary   │                │   Standby   │
    │  (active)   │                │  (passive)  │
    │ :18789      │                │ :18789      │
    └──────┬──────┘                └───────┬─────┘
           │                               │
           └───────────┬───────────────────┘
                       │
              ┌────────▼────────┐
              │  Shared Volume  │
              │  /data/nexus    │
              │  (SQLite + WAL) │
              └─────────────────┘
                       │
              ┌────────▼────────┐
              │    Watchdog     │
              │ (monitors both) │
              └─────────────────┘
```

**Key Components:**
- **Primary**: Holds active lease, runs Telegram bot, scheduler, proactive heartbeat
- **Standby**: Health checks only, ready to take over
- **HAProxy**: Routes traffic, automatic health-based failover
- **Watchdog**: Monitors primary, triggers activation of standby on failure
- **Shared Volume**: Both instances share the same SQLite database (WAL mode)

### 7.2 Configuration

**Environment Variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXUS_ACTIVE_LEASE_TTL_MS` | 45000 | Active lease lifetime (ms) |
| `PRIMARY_URL` | http://nexus-primary:18789 | Primary instance URL |
| `STANDBY_URL` | http://nexus-standby:18789 | Standby instance URL |
| `CHECK_INTERVAL` | 5 | Seconds between health checks |
| `FAILURE_THRESHOLD` | 3 | Consecutive failures before failover |
| `RECOVERY_DELAY` | 30 | Seconds to wait after failover |
| `DEACTIVATE_TIMEOUT` | 5 | Seconds to wait for graceful deactivate |
| `ENABLE_FAILBACK` | false | Auto-restore original primary when healthy |
| `FAILBACK_THRESHOLD` | 3 | Consecutive healthy checks before failback |
| `NEXUS_HAPROXY_CONFIG` | `haproxy.cfg` | HAProxy config file (`haproxy.tls.cfg` enables TLS listener) |

### 7.2.1 Required HA Paths and Files

The HA stack in `infra/docker-compose.ha.yml` assumes:
- Code checkout: `/data/code`
- State/DB: `/data/nexus`
- Workspace: `/data/workspace`
- Env files:
  - `/data/nexus-config/gateway/nexus.env` (nexus-primary / nexus-standby)
  - `/data/nexus-config/sidecar/nexus.env` (secret-sidecar)
  - `/data/nexus-config/watchdog/nexus.env` (watchdog)

If your env files are still in `~/nexus-deploy`, create one-time links:

```bash
ln -sf ~/nexus-deploy/.env.gateway /data/nexus-config/gateway/nexus.env
ln -sf ~/nexus-deploy/.env.sidecar /data/nexus-config/sidecar/nexus.env
ln -sf ~/nexus-deploy/.env.watchdog /data/nexus-config/watchdog/nexus.env
```

### 7.3 Deployment

```bash
# On VM - use a fixed compose project name to avoid parallel stacks
cd /data/code
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml -f /data/code/infra/docker-compose.ha.sidecar.yml -f /data/code/infra/docker-compose.ha.tls.yml up -d --build --force-recreate

# Verify services and HA proxy endpoints
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml -f /data/code/infra/docker-compose.ha.sidecar.yml -f /data/code/infra/docker-compose.ha.tls.yml ps
curl -s http://localhost:18789/api/mode
curl -s http://localhost:18789/health/live
curl -s http://localhost:18789/health/traffic
curl -s http://localhost:18789/health/ready
curl -sk https://localhost:18790/health/live

# Check HAProxy stats
curl -s http://localhost:9999/stats | head
```

Notes:
- Always use `-p infra` with the HA compose file. Omitting it can leave an old stack running and cause port conflicts.
- Always include all three compose files (`ha.yml` + `ha.sidecar.yml` + `ha.tls.yml`) for HA gateway lifecycle operations.
- The HA compose file uses bind mounts (`/data/nexus`, `/data/workspace`, `/data/code`) so state survives container recreate/rebuild.
- `/data/code` is mounted writable in containers to allow direct in-agent code edits.
- Deploys should be performed from the VM host using `ha-rollout.sh apply-local` or `/home/nexus/pull-deploy.sh`.
- `ha-rollout.sh` and `pull-deploy.sh` now require sidecar and TLS overlays; sidecar-less or TLS-less deploys are unsupported.
- `ha-rollout.sh` runs `infra/scripts/ha-secrets-preflight.sh` before deploy.
- `pull-deploy.sh` is update-focused and does not run secrets preflight.
- Secrets preflight enforces hardened defaults (sidecar-only resolution, API key + dashboard + secretctl auth, encrypted credentials key).

### 7.3.0a Sidecar Requirements On Existing Instance (No New VM)

The sidecar overlay is mandatory for supported HA deployments.

Overlay file:
- `infra/docker-compose.ha.sidecar.yml`

It adds:
- `secret-sidecar` service (`nexus secret-sidecar`)
- shared unix socket volume (`/run/nexus/secret-sidecar.sock`) mounted into primary + standby
- sidecar healthcheck via unix socket

Deploy with sidecar overlay:

```bash
cd /data/code
export COMPOSE_FILES="/data/code/infra/docker-compose.ha.yml:/data/code/infra/docker-compose.ha.sidecar.yml:/data/code/infra/docker-compose.ha.tls.yml"
export NEXUS_HA_API_KEY="$NEXUS_HA_API_KEY"

infra/scripts/ha-rollout.sh deploy HEAD
infra/scripts/ha-rollout.sh finalize HEAD
infra/scripts/ha-rollout.sh status
```

Provider profile (strict + unix socket):

```bash
curl -s -X POST http://localhost:18789/api/secrets/providers \
  -H "Authorization: Bearer $NEXUS_HTTP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "sidecar-main",
    "kind": "sidecar_http",
    "endpointRef": "unix:///run/nexus/secret-sidecar.sock",
    "authMode": "unix_peer",
    "strictMode": true,
    "enabled": true
  }' | jq .
```

Validation (no secret value in request):

```bash
curl -s -X POST http://localhost:18789/api/secrets/providers/sidecar-main/test \
  -H "Authorization: Bearer $NEXUS_HTTP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"strictMode": true}' | jq .
```

Bootstrap helper (upsert + test + recent audit events):

```bash
cd /data/code
NEXUS_HTTP_API_KEY="$NEXUS_HTTP_API_KEY" \
infra/scripts/ha-sidecar-bootstrap.sh
```

Test-only run (no provider mutation):

```bash
cd /data/code
NEXUS_HTTP_API_KEY="$NEXUS_HTTP_API_KEY" \
infra/scripts/ha-sidecar-bootstrap.sh --test-only
```

Optional overrides for non-default profile wiring:
- `PROVIDER_ID` (default `sidecar-main`)
- `PROVIDER_ENDPOINT` (default `unix:///run/nexus/secret-sidecar.sock`)
- `PROVIDER_AUTH_MODE` (default `unix_peer`)
- `PROVIDER_STRICT_MODE` / `PROVIDER_ENABLED` (`true|false`, `1|0`)

Sidecar-only enforcement is always active.

Behavior:
- `local_file` provider enablement is blocked by the API.
- non-sidecar processes are blocked from direct credential-file access.
- `nexus secret-sidecar` auto-sets `NEXUS_SECRETS_PROCESS_ROLE=sidecar` so sidecar resolution still works.

Phase 2 storage isolation (sidecar-only filesystem access):

```bash
cd /data/code

# 1) Prepare/migrate credential store to dedicated host path
infra/scripts/ha-sidecar-secrets-isolation.sh --prepare
infra/scripts/ha-sidecar-secrets-isolation.sh --migrate
infra/scripts/ha-sidecar-secrets-isolation.sh --status

# 2) Enable isolated store + sidecar-only enforcement
#    (in /data/nexus-config/sidecar/nexus.env)
# NEXUS_CREDENTIALS_STORE_DIR=/data/nexus-secrets

# 3) Recreate stack with sidecar overlay so only secret-sidecar mounts /data/nexus-secrets
docker compose -p infra \
  -f /data/code/infra/docker-compose.ha.yml \
  -f /data/code/infra/docker-compose.ha.sidecar.yml \
  up -d --build --force-recreate nexus-primary nexus-standby secret-sidecar haproxy
```

Validation checks:

```bash
# sidecar health over unix socket
docker compose -p infra \
  -f /data/code/infra/docker-compose.ha.yml \
  -f /data/code/infra/docker-compose.ha.sidecar.yml \
  exec -T nexus-primary sh -lc \
  'curl -fsS --unix-socket /run/nexus/secret-sidecar.sock http://localhost/health'

# sidecar provider still resolves
curl -s -X POST http://localhost:18789/api/secrets/providers/sidecar-main/test \
  -H "Authorization: Bearer $NEXUS_HTTP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"strictMode":true,"traceId":"sidecar-isolation-1","reference":"{{secret:sidecar-main/test.brave.api#password}}"}' | jq .

# local_file enablement remains blocked
curl -s -X POST http://localhost:18789/api/secrets/providers \
  -H "Authorization: Bearer $NEXUS_HTTP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"local-block-test","kind":"local_file","strictMode":true,"enabled":true}' | jq .
```

Notes:
- In strict mode, unix socket + `authMode=unix_peer` is the recommended same-host baseline.
- `ha-rollout.sh` now refreshes `secret-sidecar` automatically when the service exists in selected compose files.
- Keep sidecar socket volume private to the Nexus stack (`secret-sidecar-run`).
- The sidecar overlay mounts `/data/nexus-secrets` only into `secret-sidecar`; primary/standby do not receive that mount.
- For MCP servers, set sensitive env values as secret refs (for example `{{secret:sidecar-main/mcp.github.pat#password}}`) rather than plaintext tokens.

Cutover completion checklist (2026-02-18):

```bash
# 1) Active store path and legacy retirement
test -f /data/nexus-secrets/credentials.json
test ! -e /data/nexus/secrets/credentials.json

# 2) Provider state
curl -s -H "Authorization: Bearer $NEXUS_HTTP_API_KEY" \
  http://localhost:18789/api/secrets/providers | jq .

# expected:
# - sidecar-main enabled=true
# - local-main enabled=false (or removed)

# 3) HA/state health
infra/scripts/ha-rollout.sh status
curl -s http://localhost:18789/health/traffic | jq .
```

Audit interpretation note:
- `access-events` may still show old `local-main` allow entries from pre-cutover traces.
- Treat only post-cutover events as regression signals (for example, any new `local-main` allow event after sidecar-only + isolated-store cutover).

Post-cutover baseline:
- Keep `local-main` disabled.
- Do not reintroduce `/data/nexus/secrets/credentials.json`.
- Use `infra/internal-doc` for day-2 operations (create/rotate/revoke/audit/outage-drill).

### 7.3.0b Fresh Deployment Baseline (Sidecar-First)

Use this path for new installs where there is no legacy credential file to migrate.

```bash
cd /data/code

# 1) Prepare isolated secrets path on host
sudo mkdir -p /data/nexus-secrets
sudo chown root:root /data/nexus-secrets
sudo chmod 700 /data/nexus-secrets

# 2) Configure split env files (minimum secrets settings)
# /data/nexus-config/gateway/nexus.env
#   NEXUS_HTTP_API_KEY=<token>
#   NEXUS_DASHBOARD_PASSWORD=<strong password>
# /data/nexus-config/sidecar/nexus.env
#   NEXUS_CREDENTIALS_KEY=<strong random secret>
#   NEXUS_CREDENTIALS_STORE_DIR=/data/nexus-secrets
#   NEXUS_SECRETCTL_PASSWORD=<strong password>
# /data/nexus-config/watchdog/nexus.env
#   NEXUS_HA_API_KEY=<same token as NEXUS_HTTP_API_KEY>

# 3) Start stack with sidecar overlay (add tls overlay when available)
docker compose -p infra \
  -f /data/code/infra/docker-compose.ha.yml \
  -f /data/code/infra/docker-compose.ha.sidecar.yml \
  up -d --build --force-recreate

# 4) Bootstrap/verify sidecar provider profile
NEXUS_HTTP_API_KEY="$NEXUS_HTTP_API_KEY" \
infra/scripts/ha-sidecar-bootstrap.sh

# 5) Sanity checks
curl -s http://localhost:18789/health/traffic | jq .
curl -s -H "Authorization: Bearer $NEXUS_HTTP_API_KEY" \
  http://localhost:18789/api/secrets/providers | jq .
test ! -e /data/nexus/secrets/credentials.json
test -d /data/nexus-secrets
```

Expected provider state on fresh deployment:
- `sidecar-main` enabled=true
- `local-main` absent or disabled

### 7.3.0 Secure Node Transport (`wss://`)

To use strict node transport security for non-loopback nodes, enable TLS on HAProxy and pin the certificate fingerprint on the node.

```bash
cd /data/code

# 1) Generate or inspect the HAProxy TLS certificate bundle and fingerprint
bash infra/scripts/ha-generate-tls-cert.sh --san <host-ip> --san <hostname>

# 2) Ensure TLS overlay is available
test -f /data/code/infra/docker-compose.ha.tls.yml

# 3) Recreate HAProxy with TLS listener exposed on :18790
docker compose -p infra \
  -f /data/code/infra/docker-compose.ha.yml \
  -f /data/code/infra/docker-compose.ha.tls.yml \
  up -d --force-recreate haproxy

# 4) Validate HTTPS endpoint (self-signed cert; -k expected)
curl -sk https://localhost:18790/health/live
```

If you intentionally run without the TLS overlay file, set `NEXUS_HAPROXY_CONFIG=haproxy.tls.cfg` in the runtime environment instead.

Node `.env` settings (example):

```bash
NEXUS_NODE_GATEWAY_URL=wss://192.0.2.10:18790/nx/nodes
NEXUS_NODE_GATEWAY_TLS_FINGERPRINT=<sha256 fingerprint from ha-generate-tls-cert.sh>
NEXUS_NODE_INSECURE_ALLOW_NONLOOPBACK_WS=0
NEXUS_NODE_TZ=America/New_York
```

Pairing note:

- Node approval is one-time per `nodeId` + node fingerprint.
- Gateway restarts/redeploys should not require re-approval when `/data/nexus` and node identity keys persist.
- Re-approval is expected if node auth keys are regenerated/replaced, node ID changes, or node records are deleted/reset.

### 7.3.1 Rolling Deploy (Manual)

Use the rollout helper directly for manual deploys:

```bash
cd /data/code
git pull

# Show active/inactive slots + rollout state
infra/scripts/ha-rollout.sh status

# Deploy current HEAD (or pass an explicit commit SHA)
infra/scripts/ha-rollout.sh deploy HEAD

# Refresh the inactive slot to match the new version
infra/scripts/ha-rollout.sh finalize HEAD

# Deploy local uncommitted changes safely:
# canary inactive slot -> switch + smoke -> host commit -> refresh standby
infra/scripts/ha-rollout.sh apply-local "Describe change" host main
```

Rollback commands:

```bash
# Roll back to last-good recorded commit
infra/scripts/ha-rollout.sh rollback

# Roll back to a specific commit
infra/scripts/ha-rollout.sh rollback <commit-sha>
```

Notes:
- `deploy` requires a clean git working tree in `/data/code`.
- On failure after switchover, the script re-activates the previous slot and checks out `last_good_sha`.
- Rollout state is persisted in `/data/nexus/deploy-state.env`.
- If both slots are accidentally in standby mode, the script attempts bootstrap activation before failing.

### 7.3.2 Self-Modification Deploy Flow (Automated)

The coder agent deploys autonomously via `ha_deploy` tool + host-side `ha-deployer` daemon.

**Components:**
- `src/tools/ha-deploy.ts` — In-container tool: writes trigger file, polls for result
- `infra/scripts/ha-deployer.sh` — Host-side daemon: watches for triggers, runs ha-rollout.sh
- `infra/systemd/ha-deployer.service` — Systemd unit for ha-deployer daemon
- `src/core/agent-service.ts` — Writes deploy-ack after orchestrator finishes
- `src/core/isolated-worker.ts` — Auto-triggers deploy if coder skips it

**Deploy sequence:**

```
1. Coder agent: edit → typecheck → build → ha_deploy action='apply'
2. ha_deploy writes /data/nexus/deploy-trigger.json
3. ha-deployer daemon (host) picks up trigger, runs:
     ha-rollout.sh apply-local "<commit message>" host main
4. apply-local: build standby with new code → health check → commit+push → switch traffic
5. ha_deploy polls deploy-state.env, sees success, returns OK to coder
6. Coder writes results to blackboard, returns to orchestrator
7. Orchestrator finishes full request cycle (including Telegram reply)
8. agent-service writes /data/nexus/deploy-ack
9. ha-deployer validates ack context, then runs finalize at the exact deployed SHA to rebuild old primary
10. Both containers now running latest code
```

**Safeguards:**
- **Auto-deploy**: If the coder edits code + builds but skips `ha_deploy`, the isolated worker auto-triggers it after the agent run completes.
- **Finalize ack protocol**: ha-deployer writes `finalize-pending` and waits for `deploy-ack` before rebuilding the old primary. This ensures the orchestrator's full request cycle (including Telegram reply) completes before the container is killed.
- **Ack correlation**: `finalize-pending` includes trigger/run context, and `deploy-ack` is matched against that context to avoid unrelated runs unblocking finalize.
- **Pinned finalize target**: after `apply-local`, ha-deployer finalizes the exact `LAST_DEPLOY_SHA` from deploy state (not floating `HEAD`).
- **Ack timeout**: If deploy-ack doesn't arrive within 10 minutes, ha-deployer proceeds with finalize anyway (safety net for crashed agents).
- **Git blocking**: Mutating git commands (`add`, `commit`, `push`, `reset`, etc.) are blocked in the coder's `shell_exec` for the code repo. The host daemon handles all git operations.

**ha-deployer systemd service setup:**

```bash
# On VM host
sudo cp /data/code/infra/systemd/ha-deployer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ha-deployer

# Check status/logs
sudo systemctl status ha-deployer
sudo journalctl -u ha-deployer -f
```

**Operational behavior:**
- Only the active slot handles Telegram/scheduler/proactive jobs.
- Standby slot intentionally does not process channel traffic.
- The old primary stays alive (with old code) until the orchestrator acks.
- If both slots report standby, rollout attempts bootstrap activation before failing slot detection.
- Deploy lock (`/data/nexus/ha-rollout.lock`) prevents the watchdog from triggering failover during a deploy.

### 7.3.2a Post-Deploy Validation + Failure Ladder

Run validation in a fresh request cycle after deploy success:

```bash
curl -s http://localhost:18789/health/live
curl -s http://localhost:18789/health/traffic
curl -s http://localhost:18789/api/mode
curl -s -H "Authorization: Bearer $NEXUS_HTTP_API_KEY" \
  http://localhost:18789/api/secrets/providers
```

If deploy fails or a slot does not come up:

```bash
infra/scripts/ha-rollout.sh status

# inspect failing slot logs
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml -f /data/code/infra/docker-compose.ha.sidecar.yml -f /data/code/infra/docker-compose.ha.tls.yml logs nexus-primary --tail=200
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml -f /data/code/infra/docker-compose.ha.sidecar.yml -f /data/code/infra/docker-compose.ha.tls.yml logs nexus-standby --tail=200

# recover
infra/scripts/ha-rollout.sh rollback
# or: infra/scripts/ha-rollout.sh rollback <known-good-sha>
infra/scripts/ha-rollout.sh finalize HEAD
```

### 7.3.3 CODEGUIDE Migration Semantics

`CODEGUIDE.md` has two sources:
- Repo template: `/data/code/CODEGUIDE.md` (operator-maintained reference for migration).
- Live prompt file: `/data/nexus/CODEGUIDE.md` (loaded by coder at runtime).

Important behavior:
- New instances get the generated default from `src/state/personalization.ts` during `init`.
- Existing instances keep their current `/data/nexus/CODEGUIDE.md`; deploy scripts do not overwrite it.

Recommended migration flow after CODEGUIDE updates:

```bash
# on VM
cp -a /data/nexus/CODEGUIDE.md /data/nexus/CODEGUIDE.md.bak.$(date +%F-%H%M%S)
diff -u /data/nexus/CODEGUIDE.md /data/code/CODEGUIDE.md || true
# then merge/apply the desired changes into /data/nexus/CODEGUIDE.md
```

### 7.4 Testing Failover

```bash
# 1. Verify primary is active
curl http://localhost:18789/api/mode
# Expected: {"mode":"active"}

# 2. Check lease holder
curl http://localhost:18789/status | jq '.activeLease'

# 3. Stop primary container to trigger failover
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml stop nexus-primary

# 4. Watch watchdog logs
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml logs -f watchdog

# 5. After ~15-20 seconds, verify standby activated
curl http://localhost:18789/api/mode
# Expected: {"mode":"active"} (now served by standby)

# 6. Restart original primary
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml start nexus-primary

# 7. Original primary enters standby mode
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml logs --tail=100 nexus-primary | grep standby
# Expected: "standby: active lease held by ..."
```

### 7.5 Manual Failover

```bash
# Gracefully deactivate current primary
curl -X POST http://localhost:18789/api/deactivate
# Expected: {"ok":true,"message":"deactivated"}

# Activate standby instance
curl -X POST http://standby-host:18789/api/activate
# Expected: {"ok":true,"message":"activated"}
```

### 7.6 Monitoring

**Dashboard:** Visit `/dashboard` to see:
- Mode indicator (ACTIVE/STANDBY)
- Lease status (holder, expiration)
- Recent HA events
- Backup status

**Health Endpoints:**
- `/health/live` - Liveness probe (HTTP server responding)
- `/health/traffic` - Traffic/failover probe (DB reachable, active role, active lease held)
- `/health/ready` - Full operational readiness probe (includes scheduler, backups, proactive, memory, etc.)
- `/status` - Full system status including lease info

**Telegram Notifications:** Configure `channels.telegram.enabled` to receive alerts for:
- Failover events
- Failback events
- Backup failures

### 7.7 Failback (Optional)

When enabled, the watchdog automatically restores the original primary after it recovers:

```bash
# Enable failback in docker-compose.ha.yml
ENABLE_FAILBACK=true
FAILBACK_THRESHOLD=3  # Healthy checks before failback

# Flow:
# 1. Original primary crashes → standby activates
# 2. Original primary restarts → enters standby mode
# 3. Watchdog monitors original primary health
# 4. After 3 consecutive healthy checks → initiates failback
# 5. Current primary deactivated, original primary activated
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
# On VM - check disk space (root partition)
df -h

# Inspect Docker disk usage
docker system df

# Typical root cause: stale layers/images (overlay2)
sudo du -xhd1 /var/lib/docker | sort -h

# Safe cleanup (keeps volumes)
docker container prune -f
docker image prune -f
docker builder prune -f

# Aggressive cleanup (removes unused images + volumes)
# docker system prune -a -f --volumes
```

For recurring cleanup automation (without touching `/data/nexus/backups`), see:
- `infra/scripts/nexus-disk-gc.sh`
- `infra/systemd/nexus-disk-gc.service`
- `infra/systemd/nexus-disk-gc.timer`

Install on the VM:
```bash
sudo install -m 0755 /data/code/infra/scripts/nexus-disk-gc.sh /usr/local/sbin/nexus-disk-gc
sudo cp /data/code/infra/systemd/nexus-disk-gc.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nexus-disk-gc.timer
systemctl list-timers nexus-disk-gc.timer --all
```

### npm install/ci fails on VM (EBADENGINE / EACCES)

Symptoms:
- `npm WARN EBADENGINE` (Node too old; repo requires Node 22+)
- `EACCES: permission denied` under `/data/code/node_modules` (root-owned files from prior runs)

Fix:
```bash
# Upgrade Node to 22+ (example with NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v

# Fix repo ownership and reinstall deps
sudo chown -R "$(id -u)":"$(id -g)" /data/code
rm -rf /data/code/node_modules /data/code/package-lock.json
cd /data/code
npm install
```

### VM disk fills up over time (Docker images/logs)

If `/` trends toward 100% usage, the most common drivers are stale Docker images/layers and unbounded container JSON logs.

Recommended:
- Enable the disk GC timer (see files listed above).
- Set Docker log rotation via `/etc/docker/daemon.json`:
  - `{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}`
  - Restart Docker after changes: `sudo systemctl restart docker`

### Port forward not working

```bash
# On host - check socat service
sudo systemctl status nexus-forward
sudo journalctl -u nexus-forward -f
sudo systemctl status nexus-forward-tls
sudo journalctl -u nexus-forward-tls -f

# Check VM is running and has correct IP
virsh domifaddr nexus-vm

# Verify both forwarded ports locally on host
curl http://localhost:18789/health/live
curl -k https://localhost:18790/health/live
```

### HA: Port 18789 already allocated

Symptom:
- `Bind for 0.0.0.0:18789 failed: port is already allocated`

Cause:
- An older non-HA stack (often project `nexus-deploy`) is still bound to host port `18789`.

Fix:

```bash
docker ps --filter "publish=18789" --format "table {{.ID}}\t{{.Names}}\t{{.Ports}}"

# If legacy stack is running:
cd ~/nexus-deploy
docker compose down

# Start HA stack with explicit project name
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml -f /data/code/infra/docker-compose.ha.sidecar.yml -f /data/code/infra/docker-compose.ha.tls.yml up -d
```

### HA: split env file missing

Symptom:
- `env file /data/nexus-config/gateway/nexus.env not found ...`
- `env file /data/nexus-config/sidecar/nexus.env not found ...`
- `env file /data/nexus-config/watchdog/nexus.env not found ...`

Cause:
- HA overlays now use split env files per service scope.

Fix:

```bash
ln -sf ~/nexus-deploy/.env.gateway /data/nexus-config/gateway/nexus.env
ln -sf ~/nexus-deploy/.env.sidecar /data/nexus-config/sidecar/nexus.env
ln -sf ~/nexus-deploy/.env.watchdog /data/nexus-config/watchdog/nexus.env
# or copy each file directly into /data/nexus-config/{gateway,sidecar,watchdog}/
```

### HA: `ha-rollout` cannot determine active slot

Symptom:
- `ERROR: unable to determine active slot (primary=standby, standby=standby)`

Cause:
- Both slots ended up in standby mode (or both active) after manual operations or interrupted restarts.

Fix:

```bash
cd /data/code
infra/scripts/ha-rollout.sh status

# Re-run deploy/finalize/rollback; script now attempts automatic slot recovery
infra/scripts/ha-rollout.sh deploy HEAD
```

### HA: Dashboard returns 503 (`<NOSRV>`) while containers are up

Symptoms:
- HAProxy logs show `Layer7 wrong status` and backend has no available server.
- `curl` inside Nexus containers fails with `exec: "curl": executable file not found`.

Cause:
- Containers were built from an older image missing runtime tools used by health checks.

Fix:

```bash
cd /data/code
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml -f /data/code/infra/docker-compose.ha.sidecar.yml -f /data/code/infra/docker-compose.ha.tls.yml up -d --build --force-recreate
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml -f /data/code/infra/docker-compose.ha.sidecar.yml -f /data/code/infra/docker-compose.ha.tls.yml ps
```

### HA: State/data appears missing after switching to HA compose

Symptoms:
- Dashboard loads but jobs, intakes, blackboard history look empty.

Cause:
- Stack was started with fresh named volumes instead of bind mounts to `/data/nexus` and `/data/workspace`.

Fix:

```bash
# Confirm expected host paths contain prior state
ls -lah /data/nexus | head
ls -lah /data/workspace | head

# Confirm current HA compose uses host bind mounts (not named volumes)
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml config | grep -E '/data/nexus|/data/workspace|/data/code'
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
| `docker compose -p infra -f /data/code/infra/docker-compose.ha.yml logs -f` | View HA stack logs |
| `docker compose -p infra -f /data/code/infra/docker-compose.ha.yml ps` | Show container status |
| `sudo journalctl -u ha-deployer -f` | View deploy daemon logs |
| `cat /data/nexus/deploy-state.env` | Check deploy state |
| `infra/scripts/ha-rollout.sh status` | Show active/inactive HA slots + rollout state |
| `infra/scripts/ha-rollout.sh deploy HEAD` | Roll out current commit to inactive slot and switch |
| `infra/scripts/ha-rollout.sh apply-local "msg"` | Roll out local working-tree changes, then commit on host |
| `infra/scripts/ha-rollout.sh finalize` | Rebuild standby slot to match active commit |
| `infra/scripts/ha-rollout.sh rollback` | Roll back to recorded last-good commit |

**Deploy trigger files** (in `/data/nexus/`):

| File | Written by | Purpose |
|------|-----------|---------|
| `deploy-trigger.json` | ha_deploy tool (container) | Requests a deploy |
| `deploy-trigger.processing.json` | ha-deployer (host) | Deploy in progress |
| `deploy-state.env` | ha-rollout.sh (host) | Last deploy result |
| `finalize-pending` | ha-deployer (host) | Waiting for orchestrator ack |
| `deploy-ack` | agent-service (container) | Orchestrator finished, safe to rebuild |
| `ha-rollout.lock` | ha-rollout.sh (host) | Deploy lock (prevents watchdog failover) |

---

## Federation Deployment Addendum

### Target Topology (v1)

- `nexus-vm` = primary instance (`runtime.profile=primary`)
- `nexus-monetization-vm` = service instance (`runtime.profile=monetization`)
- Optional: `nexus-standby-vm` or VPS standby (`runtime.profile=standby`)
- Execution-node-host installs remain separate from full gateway instances.

Principles:

- Keep inter-instance traffic private (libvirt/internal network) by default.
- Do not expose monetization VM services publicly unless required.
- Forward host ports only when explicitly needed.

### VM Provisioning (parameterized)

Use `infra/scripts/setup-vm.sh` with explicit resources per VM:

```bash
# Primary VM
bash infra/scripts/setup-vm.sh \
  --vm-name nexus-vm \
  --memory-mb 8192 \
  --cpus 4 \
  --disk-size 80G

# Monetization VM (no host forwarding by default)
bash infra/scripts/setup-vm.sh \
  --vm-name nexus-monetization-vm \
  --memory-mb 12288 \
  --cpus 4 \
  --disk-size 120G

# Optional host forwarding only when needed
bash infra/scripts/setup-vm.sh \
  --vm-name nexus-vm \
  --enable-forwarding \
  --forward-http-port 18789 \
  --forward-https-port 18790
```

### Iterative Provision + Deploy (single script)

For repeated profile testing loops (service/standby/monetization), use:

- `infra/scripts/provision-libvirt-instance.sh`

This script provisions a libvirt VM, waits for SSH, clones/pulls Nexus in-guest, and deploys a selected runtime profile. It also supports optional federation config bootstrap for test environments.

Initialization note:

- On fresh state dirs, the script now runs a headless `nexus init` automatically before gateway deploy (unless `--skip-init` is set).
- You can tune onboarding defaults with `--init-agent-name`, `--init-user-name`, and `--init-timezone`.
- The script runs `ha-secrets-preflight.sh --auto-fix` in-guest before deploy, and auto-generates `NEXUS_CREDENTIALS_KEY` only when missing and no credential store exists.
- Use `--http-api-key` to seed control-plane auth keys and `--require-http-api-key` to enforce presence.
- Guest helper wrappers are installed automatically:
  - `~/sidecar-bootstrap.sh` -> `/data/code/infra/scripts/ha-sidecar-bootstrap.sh`
  - `~/secrets-onboard.sh` -> `/data/code/infra/scripts/ha-secrets-onboard.sh`
  - `~/secretctl.sh` -> `/data/code/infra/scripts/ha-secretctl.sh`

Private repo + SSH readiness note:

- If your key is passphrase-protected, preload it in an agent before provisioning:

```bash
eval "$(ssh-agent -s)"
ssh-add /home/<user>/.ssh/id_ed25519
```

- Prefer cloning from the host bare mirror for private repos:
  - `--repo-url ssh://<host-user>@192.168.122.1/~/git/nexus.git`
- Always pass explicit SSH key paths so cloud-init auth and readiness checks use the same key:
  - `--ssh-public-key-path /home/<user>/.ssh/id_ed25519.pub`
  - `--ssh-private-key-path /home/<user>/.ssh/id_ed25519`

```bash
# Example: non-monetization federated service instance (8GB RAM, 40GB disk)
# (private repo via host bare mirror)
bash infra/scripts/provision-libvirt-instance.sh \
  --vm-name nexus-service-vm \
  --hostname nexus-service-vm \
  --memory-mb 8192 \
  --disk-size 40G \
  --ssh-public-key-path /home/user/.ssh/id_ed25519.pub \
  --ssh-private-key-path /home/user/.ssh/id_ed25519 \
  --repo-url ssh://user@192.168.122.1/~/git/nexus.git \
  --profile service_custom \
  --http-api-key '<strong-random-token>' \
  --require-http-api-key \
  --federation-enable \
  --federation-instance-id service-main \
  --federation-allow-insecure-dev

# Example: standby iteration
bash infra/scripts/provision-libvirt-instance.sh \
  --vm-name nexus-standby-vm \
  --memory-mb 8192 \
  --disk-size 40G \
  --profile standby \
  --federation-enable \
  --federation-instance-id standby-main
```

### Profile-based Runtime Configuration

Single-instance deployment scripts are retired. Use HA deployment only:

```bash
# VM-local pull/deploy helper
/home/nexus/pull-deploy.sh

# Or rollout-based deploy
cd /data/code
infra/scripts/ha-rollout.sh deploy HEAD
infra/scripts/ha-rollout.sh finalize HEAD
```

Set runtime profile and federation settings via `/data/nexus/nexus.json` (or
`infra/scripts/provision-libvirt-instance.sh --profile ...` during provisioning).

Monetization compose overlay (when using shared compose stacks):

- `infra/docker-compose.monetization.yml`

### Security Enforcement Scripts

Network policy between primary and monetization VMs:

```bash
# Dry-run
bash infra/scripts/apply-federation-vm-network-policy.sh \
  --primary-ip 10.10.0.11 \
  --monetization-ip 10.10.0.12 \
  --inference-ip 10.10.0.20

# Apply
bash infra/scripts/apply-federation-vm-network-policy.sh \
  --primary-ip 10.10.0.11 \
  --monetization-ip 10.10.0.12 \
  --inference-ip 10.10.0.20 \
  --apply
```

Secret locality enforcement and checks:

```bash
bash infra/scripts/enforce-monetization-secret-locality.sh \
  --primary-state-dir /data/nexus \
  --monetization-state-dir /data/nexus-monetization \
  --apply-perms
```

### Failover + Rebind Runbook (Primary -> Standby)

1. Promote standby instance:

```bash
curl -X POST http://<standby>:18789/api/activate -H 'content-type: application/json' -d '{}'
```

2. Rebind service peer endpoint to new active primary:

```bash
bash infra/scripts/federation-failover-rebind-smoke.sh \
  --standby-url http://<standby>:18789 \
  --service-url http://<service>:18789 \
  --peer-id primary-peer \
  --new-primary-endpoint https://<standby>:18789 \
  --apply
```

3. Validate webhook continuity/drain:

```bash
bash infra/scripts/federation-webhook-continuity-smoke.sh \
  --service-url http://<service>:18789
```

Expected behavior:

- Service peer record points to new primary endpoint.
- Pending webhook queue drains to zero.
- No duplicate-key group growth for `eventId:endpointId` pairs.

### Existing Standalone Retrofit (No Re-init)

```bash
# Dry-run validation
bash infra/scripts/federation-retrofit-smoke.sh --state-dir /data/nexus

# Apply safe config retrofit
bash infra/scripts/federation-retrofit-smoke.sh --state-dir /data/nexus --apply
```

### Portable Workflow

Build portable bundle:

```bash
bash infra/scripts/build-portable-runtime.sh --instance-mode portable
bash infra/scripts/build-portable-runtime.sh --instance-mode portable_federated
bash infra/scripts/build-portable-runtime.sh --instance-mode execution_node_host
```

Launcher dry-run:

```bash
PORTABLE_STATE_PASSPHRASE=... \
NEXUS_FEDERATION_JOIN_APPROVED=1 \
bash infra/scripts/portable-launcher.sh --manifest infra/portable/dist/portable-manifest.json --dry-run
```

Execution-node-host install path:

```bash
bash infra/scripts/install-execution-node-host.sh --dry-run
```

Portable smoke checks:

```bash
bash infra/scripts/portable-smoke.sh
```

### Infra Smokes

```bash
# host dual-VM presence
bash infra/scripts/host-two-vm-smoke.sh

# Legacy single-instance deploy retirement smoke
bash infra/scripts/profile-bootstrap-smoke.sh
```
