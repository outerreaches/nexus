#!/usr/bin/env bash
set -euo pipefail

# Aggressive Docker cleanup for Nexus VM.
# Safe to run when only Nexus containers are on the host.
# Running containers are never affected.

log() { printf '[docker-cleanup] %s\n' "$*"; }

log "disk usage BEFORE cleanup:"
df -h / | tail -1

# 1. Remove all stopped containers
log "removing stopped containers..."
docker container prune -f

# 2. Remove all dangling images (untagged layers from old builds)
log "removing dangling images..."
docker image prune -f

# 3. Remove ALL unused images (not just dangling) — safe since only Nexus is on this host
log "removing all unused images..."
docker image prune -af

# 4. Remove unused build cache
log "removing build cache..."
docker builder prune -af

# 5. Remove unused volumes (excludes volumes in use by running containers)
log "removing unused volumes..."
docker volume prune -f

# 6. Remove unused networks
log "removing unused networks..."
docker network prune -f

log "disk usage AFTER cleanup:"
df -h / | tail -1

log "done"
