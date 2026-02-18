#!/usr/bin/env bash
# Enforce minimal federation network policy between primary and monetization instances.

set -euo pipefail

usage() {
  cat <<USAGE
Usage: $(basename "$0") --primary-ip <ip> --monetization-ip <ip> [options]

Required:
  --primary-ip <ip>          Primary instance VM IP
  --monetization-ip <ip>     Monetization instance VM IP

Options:
  --federation-port <port>   Federation API port (default: 18789)
  --inference-ip <ip>        Optional shared inference endpoint IP
  --inference-port <port>    Inference port (default: 11434)
  --apply                    Apply rules (default: dry-run)
  --help                     Show this help
USAGE
}

PRIMARY_IP=""
MONETIZATION_IP=""
FEDERATION_PORT="18789"
INFERENCE_IP=""
INFERENCE_PORT="11434"
APPLY="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --primary-ip)
      PRIMARY_IP="$2"
      shift 2
      ;;
    --monetization-ip)
      MONETIZATION_IP="$2"
      shift 2
      ;;
    --federation-port)
      FEDERATION_PORT="$2"
      shift 2
      ;;
    --inference-ip)
      INFERENCE_IP="$2"
      shift 2
      ;;
    --inference-port)
      INFERENCE_PORT="$2"
      shift 2
      ;;
    --apply)
      APPLY="1"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$PRIMARY_IP" || -z "$MONETIZATION_IP" ]]; then
  usage
  echo "--primary-ip and --monetization-ip are required" >&2
  exit 1
fi

RULES=(
  "iptables -N NEXUS_FEDERATION_POLICY 2>/dev/null || true"
  "iptables -F NEXUS_FEDERATION_POLICY"
  "iptables -A NEXUS_FEDERATION_POLICY -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"
  "iptables -A NEXUS_FEDERATION_POLICY -s ${PRIMARY_IP} -d ${MONETIZATION_IP} -p tcp --dport ${FEDERATION_PORT} -j ACCEPT"
  "iptables -A NEXUS_FEDERATION_POLICY -s ${MONETIZATION_IP} -d ${PRIMARY_IP} -p tcp --dport ${FEDERATION_PORT} -j ACCEPT"
)

if [[ -n "$INFERENCE_IP" ]]; then
  RULES+=("iptables -A NEXUS_FEDERATION_POLICY -s ${PRIMARY_IP} -d ${INFERENCE_IP} -p tcp --dport ${INFERENCE_PORT} -j ACCEPT")
  RULES+=("iptables -A NEXUS_FEDERATION_POLICY -s ${MONETIZATION_IP} -d ${INFERENCE_IP} -p tcp --dport ${INFERENCE_PORT} -j ACCEPT")
fi

RULES+=("iptables -A NEXUS_FEDERATION_POLICY -s ${PRIMARY_IP} -d ${MONETIZATION_IP} -j DROP")
RULES+=("iptables -A NEXUS_FEDERATION_POLICY -s ${MONETIZATION_IP} -d ${PRIMARY_IP} -j DROP")
RULES+=("iptables -C FORWARD -j NEXUS_FEDERATION_POLICY 2>/dev/null || iptables -I FORWARD 1 -j NEXUS_FEDERATION_POLICY")

if [[ "$APPLY" != "1" ]]; then
  echo "Dry-run mode. Proposed commands:"
  printf '  %s\n' "${RULES[@]}"
  exit 0
fi

for cmd in "${RULES[@]}"; do
  echo "+ $cmd"
  sudo bash -lc "$cmd"
done

echo "Network policy applied."
