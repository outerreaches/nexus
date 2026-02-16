#!/usr/bin/env bash
# Generate a local TLS certificate bundle for HAProxy and print pinning values.
#
# Output:
#   - Combined key+cert PEM at infra/haproxy/certs/nexus.pem (default)
#   - SHA-256 fingerprint for node-side pinning
#
# Examples:
#   infra/scripts/ha-generate-tls-cert.sh --san <host-ip> --san <hostname>
#   infra/scripts/ha-generate-tls-cert.sh --force --days 365 --san gateway.example.com

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODE_DIR="${CODE_DIR:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"

CERT_PEM="${NEXUS_HAPROXY_TLS_CERT_PEM:-${CODE_DIR}/infra/haproxy/certs/nexus.pem}"
DAYS="${NEXUS_HAPROXY_TLS_DAYS:-825}"
FORCE=0
declare -a EXTRA_SANS=()

usage() {
  cat <<'EOF'
Usage:
  ha-generate-tls-cert.sh [--force] [--days <num>] [--san <dns-or-ip>]...

Options:
  --san <dns-or-ip>  Add Subject Alternative Name (repeatable).
  --days <num>       Certificate validity in days (default 825).
  --force            Overwrite existing certificate.
  -h, --help         Show this help message.

Environment overrides:
  CODE_DIR
  NEXUS_HAPROXY_TLS_CERT_PEM
  NEXUS_HAPROXY_TLS_DAYS
EOF
}

fail() {
  echo "[ha-tls] ERROR: $*" >&2
  exit 1
}

log() {
  echo "[ha-tls] $*"
}

is_ip_literal() {
  local value="$1"
  # IPv4 (simple form) or any literal containing ':' (IPv6 forms)
  if [[ "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    return 0
  fi
  if [[ "$value" == *:* ]]; then
    return 0
  fi
  return 1
}

format_san_entry() {
  local value="$1"
  if is_ip_literal "$value"; then
    printf 'IP:%s' "$value"
  else
    printf 'DNS:%s' "$value"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --san)
      [ "$#" -ge 2 ] || fail "--san requires a value"
      EXTRA_SANS+=("$2")
      shift 2
      ;;
    --days)
      [ "$#" -ge 2 ] || fail "--days requires a value"
      DAYS="$2"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

command -v openssl >/dev/null 2>&1 || fail "missing required command: openssl"

if ! [[ "$DAYS" =~ ^[0-9]+$ ]] || [ "$DAYS" -lt 1 ]; then
  fail "--days must be a positive integer"
fi

CERT_DIR="$(dirname "$CERT_PEM")"
mkdir -p "$CERT_DIR"

if [ -f "$CERT_PEM" ] && [ "$FORCE" -ne 1 ]; then
  fp_existing="$(openssl x509 -in "$CERT_PEM" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//' | tr -d '\r\n')"
  if [ -n "$fp_existing" ]; then
    log "certificate already exists: $CERT_PEM"
    log "fingerprint: $fp_existing"
    echo ""
    echo "Node settings:"
    echo "  NEXUS_NODE_GATEWAY_URL=wss://<gateway-host-or-ip>:18790/nx/nodes"
    echo "  NEXUS_NODE_GATEWAY_TLS_FINGERPRINT=$fp_existing"
    echo ""
    echo "Use --force to replace the existing certificate."
    exit 0
  fi
  fail "existing file is not a readable certificate: $CERT_PEM (use --force to overwrite)"
fi

declare -a SAN_ENTRIES=(
  "DNS:localhost"
  "IP:127.0.0.1"
)

for raw in "${EXTRA_SANS[@]}"; do
  value="$(printf '%s' "$raw" | tr -d '\r\n[:space:]')"
  [ -n "$value" ] || continue
  SAN_ENTRIES+=("$(format_san_entry "$value")")
done

# De-duplicate SAN entries while preserving order.
declare -a UNIQUE_SANS=()
for item in "${SAN_ENTRIES[@]}"; do
  seen=0
  for existing in "${UNIQUE_SANS[@]-}"; do
    if [ "$existing" = "$item" ]; then
      seen=1
      break
    fi
  done
  if [ "$seen" -eq 0 ]; then
    UNIQUE_SANS+=("$item")
  fi
done

SAN_CSV="$(IFS=,; printf '%s' "${UNIQUE_SANS[*]}")"
CN_VALUE="localhost"
if [ "${#EXTRA_SANS[@]}" -gt 0 ]; then
  CN_VALUE="${EXTRA_SANS[0]}"
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

OPENSSL_CFG="${TMP_DIR}/openssl.cnf"
KEY_PEM="${TMP_DIR}/key.pem"
CERT_ONLY_PEM="${TMP_DIR}/cert.pem"

cat >"$OPENSSL_CFG" <<EOF
[req]
default_bits = 4096
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = ${CN_VALUE}

[v3_req]
subjectAltName = ${SAN_CSV}
extendedKeyUsage = serverAuth
keyUsage = digitalSignature, keyEncipherment
EOF

openssl req \
  -x509 \
  -newkey rsa:4096 \
  -sha256 \
  -days "$DAYS" \
  -nodes \
  -config "$OPENSSL_CFG" \
  -keyout "$KEY_PEM" \
  -out "$CERT_ONLY_PEM" >/dev/null 2>&1

cat "$KEY_PEM" "$CERT_ONLY_PEM" >"$CERT_PEM"
chmod 600 "$CERT_PEM"

FINGERPRINT="$(openssl x509 -in "$CERT_ONLY_PEM" -noout -fingerprint -sha256 | sed 's/^.*=//' | tr -d '\r\n')"

log "wrote TLS cert bundle: $CERT_PEM"
log "validity: ${DAYS} day(s)"
log "subjectAltName: ${SAN_CSV}"
log "fingerprint: ${FINGERPRINT}"
echo ""
echo "Node settings:"
echo "  NEXUS_NODE_GATEWAY_URL=wss://<gateway-host-or-ip>:18790/nx/nodes"
echo "  NEXUS_NODE_GATEWAY_TLS_FINGERPRINT=${FINGERPRINT}"
