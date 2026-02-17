#!/bin/bash
# Nexus Deployment Script
# Run this inside the VM after code has synced

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[!]${NC} $1"; exit 1; }

# Configuration
DEPLOY_DIR="$HOME/nexus-deploy"
CODE_DIR="/data/code"
STATE_DIR="/data/nexus"
WORKSPACE_DIR="/data/workspace"

# Check prerequisites
log "Checking prerequisites..."

if [ ! -d "$CODE_DIR" ]; then
  error "Code directory not found at $CODE_DIR. Is virtiofs mounted?"
fi

if [ ! -f "$CODE_DIR/Dockerfile" ]; then
  error "Dockerfile not found. Has the code synced yet?"
fi

if ! command -v docker &> /dev/null; then
  error "Docker not installed"
fi

if ! docker ps &> /dev/null; then
  error "Cannot connect to Docker. Are you in the docker group? Try: newgrp docker"
fi

# Create deployment directory
log "Creating deployment directory..."
mkdir -p "$DEPLOY_DIR"
cd "$DEPLOY_DIR"

# Create docker-compose.yml
log "Creating docker-compose.yml..."
cat > docker-compose.yml << EOF
version: "3.8"

services:
  nexus:
    build:
      context: $CODE_DIR
      dockerfile: Dockerfile
    command: gateway --verbose
    volumes:
      - $CODE_DIR:/data/code:rw
      - $STATE_DIR:/data/nexus
      - $WORKSPACE_DIR:/data/workspace
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

# Check for .env file
if [ ! -f .env ]; then
  log "Creating .env template..."
  cat > .env << 'EOF'
# LLM Configuration (required)
# Get key from https://openrouter.ai/
OPENROUTER_API_KEY=your_api_key_here

# Telegram Bot (optional)
# Create bot via @BotFather
TELEGRAM_BOT_TOKEN=

# Timezone
TZ=UTC
EOF
  warn "Please edit $DEPLOY_DIR/.env with your API keys"
  warn "Then run this script again"
  exit 0
fi

# Check if API key is configured
if grep -q "your_api_key_here" .env; then
  error "Please edit $DEPLOY_DIR/.env and add your OPENROUTER_API_KEY"
fi

# Create initial Nexus config if it doesn't exist
if [ ! -f "$STATE_DIR/nexus.json" ]; then
  log "Creating initial Nexus configuration..."
  mkdir -p "$STATE_DIR"
  cat > "$STATE_DIR/nexus.json" << 'EOF'
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
  "limits": {
    "maxToolCallsPerRun": 50,
    "maxIterationsPerRun": 30,
    "maxConcurrentAgents": 4,
    "maxContextTokens": 100000
  },
  "channels": {
    "telegram": {
      "enabled": false,
      "mode": "allowlist",
      "allowFrom": [],
      "pairing": {
        "enabled": false
      }
    }
  },
  "scheduler": {
    "enabled": true,
    "tickIntervalMs": 60000,
    "maxRunsPerTick": 3,
    "leaseTtlMs": 300000,
    "maxConsecutiveFailures": 5,
    "notifyAgentOnFailure": true,
    "notifyCooldownMs": 3600000
  },
  "proactive": {
    "enabled": true,
    "intervalMs": 3600000
  }
}
EOF
fi

# Build and start
log "Building Nexus Docker image..."
docker compose build

log "Starting Nexus..."
docker compose up -d

# Wait for startup
log "Waiting for Nexus to start..."
for i in {1..30}; do
  if curl -sf http://localhost:18789/health/live > /dev/null 2>&1; then
    break
  fi
  sleep 2
done

# Verify
log "Verifying deployment..."
if curl -sf http://localhost:18789/health/live > /dev/null; then
  echo ""
  echo "======================================"
  log "Nexus deployed successfully!"
  echo "======================================"
  echo ""
  echo "Health check:"
  curl -s http://localhost:18789/health/ready | jq .
  echo ""
  echo "Status:"
  curl -s http://localhost:18789/status | jq '{name, port, mode, stateDir, codeDir}'
  echo ""
  echo "Access:"
  echo "  API: http://localhost:18789"
  echo "  Dashboard: http://localhost:18789/dashboard"
  echo ""
  echo "Logs: docker compose logs -f"
else
  error "Nexus failed to start. Check logs: docker compose logs"
fi
