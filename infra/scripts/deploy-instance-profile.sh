#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'MSG'
ERROR: single-instance deployment is retired in this repository.
Supported deployment path is HA + sidecar (+ TLS overlay):
  - /home/nexus/pull-deploy.sh
  - infra/scripts/ha-rollout.sh deploy HEAD

If provisioning a fresh VM, use: infra/scripts/provision-libvirt-instance.sh
MSG
exit 1
