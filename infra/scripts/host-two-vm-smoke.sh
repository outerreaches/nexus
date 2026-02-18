#!/usr/bin/env bash
# Smoke-check expected host dual-VM topology.

set -euo pipefail

PRIMARY_VM="${PRIMARY_VM:-nexus-vm}"
MONETIZATION_VM="${MONETIZATION_VM:-nexus-monetization-vm}"

if ! command -v virsh >/dev/null 2>&1; then
  echo "virsh is required" >&2
  exit 1
fi

vm_ip() {
  local name="$1"
  virsh domifaddr "$name" 2>/dev/null | awk '/ipv4/ {print $4}' | cut -d/ -f1 | head -n1
}

check_vm() {
  local name="$1"
  local state
  state="$(virsh domstate "$name" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ "$state" != "running" ]]; then
    echo "VM not running: $name (state=$state)" >&2
    return 1
  fi
  local ip
  ip="$(vm_ip "$name")"
  if [[ -z "$ip" ]]; then
    echo "VM has no IPv4: $name" >&2
    return 1
  fi
  echo "$name ip=$ip"
}

check_vm "$PRIMARY_VM"
check_vm "$MONETIZATION_VM"

echo "Dual-VM topology smoke passed."
