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
      "model": "moonshot/kimi-k2.5"
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

### 6.1 Update Nexus Code

**From laptop (manual push):**

```bash
cd ~/Workspace/Nexus
git push host main

# On VM — pull and rebuild both containers
cd /data/code && git pull
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml up -d --build --force-recreate
```

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
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml up -d --build --force-recreate
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

### 7.2.1 Required HA Paths and Files

The HA stack in `infra/docker-compose.ha.yml` assumes:
- Code checkout: `/data/code`
- State/DB: `/data/nexus`
- Workspace: `/data/workspace`
- Env file: `/data/code/.env` (because `env_file: ../.env` is resolved from `/data/code/infra`)

If your env file is still in `~/nexus-deploy/.env`, create a one-time link:

```bash
ln -sf ~/nexus-deploy/.env /data/code/.env
```

### 7.3 Deployment

```bash
# On VM - use a fixed compose project name to avoid parallel stacks
cd /data/code
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml up -d --build --force-recreate

# Verify services and HA proxy endpoints
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml ps
curl -s http://localhost:18789/api/mode
curl -s http://localhost:18789/health/live
curl -s http://localhost:18789/health/ready

# Check HAProxy stats
curl -s http://localhost:9999/stats | head
```

Notes:
- Always use `-p infra` with the HA compose file. Omitting it can leave an old stack running and cause port conflicts.
- The HA compose file uses bind mounts (`/data/nexus`, `/data/workspace`, `/data/code`) so state survives container recreate/rebuild.
- `/data/code` is mounted writable in containers to allow direct in-agent code edits.
- Deploys should still be performed from the VM host using `ha-rollout.sh apply-local`.

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
- `/health/ready` - Readiness probe (database, scheduler, backups healthy)
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
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml up -d
```

### HA: env file `/data/code/.env` not found

Symptom:
- `env file /data/code/.env not found: stat /data/code/.env: no such file or directory`

Cause:
- `infra/docker-compose.ha.yml` uses `env_file: ../.env`, so Compose resolves it to `/data/code/.env`.

Fix:

```bash
ln -sf ~/nexus-deploy/.env /data/code/.env
# or:
cp ~/nexus-deploy/.env /data/code/.env
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
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml up -d --build --force-recreate
docker compose -p infra -f /data/code/infra/docker-compose.ha.yml ps
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
