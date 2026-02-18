#!/usr/bin/env bash
# Validate standalone -> federation-capable retrofit without re-init/data loss.

set -euo pipefail

usage() {
  cat <<USAGE
Usage: $(basename "$0") --state-dir <path> [--apply]

Required:
  --state-dir <path>   Existing Nexus state directory containing nexus.json + nexus.db

Options:
  --apply              Persist retrofit config changes (default: dry-run)
  --help               Show help
USAGE
}

STATE_DIR=""
APPLY="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-dir)
      STATE_DIR="$2"
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

if [[ -z "$STATE_DIR" ]]; then
  usage
  echo "--state-dir is required" >&2
  exit 1
fi

CONFIG_PATH="$STATE_DIR/nexus.json"
DB_PATH="$STATE_DIR/nexus.db"

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "missing config: $CONFIG_PATH" >&2
  exit 1
fi
if [[ ! -f "$DB_PATH" ]]; then
  echo "missing database: $DB_PATH" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi

echo "[snapshot] DB row counts before retrofit"
node - <<NODE
const Database = require('better-sqlite3');
const db = new Database('$DB_PATH', { readonly: true });
const tables = ['sessions','llm_messages','jobs','job_runs','blackboard_items'];
for (const t of tables) {
  try {
    const row = db.prepare(`SELECT COUNT(*) as n FROM ${t}`).get();
    console.log(`${t}=${row.n}`);
  } catch {
    console.log(`${t}=n/a`);
  }
}
db.close();
NODE

if [[ "$APPLY" != "1" ]]; then
  echo "Dry-run complete. No config changes were written."
  exit 0
fi

TMP_CONFIG="$(mktemp)"
node - <<'NODE' "$CONFIG_PATH" "$TMP_CONFIG"
const fs = require('fs');
const [configPath, outPath] = process.argv.slice(2);
const raw = fs.readFileSync(configPath, 'utf8');
const cfg = JSON.parse(raw);
cfg.runtime = cfg.runtime || {};
if (!cfg.runtime.profile) cfg.runtime.profile = 'standard';
cfg.federation = cfg.federation || {};
if (cfg.federation.enabled === undefined) cfg.federation.enabled = false;
if (!cfg.federation.localInstanceId) cfg.federation.localInstanceId = 'local';
if (!cfg.federation.transport) cfg.federation.transport = { adapter: 'federation_http', webhookFirst: true, pollingFallbackEnabled: true, requireMtls: true, allowInsecureSignedOnlyDev: false };
if (!cfg.federation.webhooks) cfg.federation.webhooks = { federatedOnly: true, externalEnabled: false };
if (!cfg.federation.outbox) cfg.federation.outbox = { enabled: false, intervalMs: 5000, maxBatch: 20, requestTimeoutMs: 10000 };
if (!Array.isArray(cfg.federation.peers)) cfg.federation.peers = [];
fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2) + '\n');
NODE

cp "$CONFIG_PATH" "$CONFIG_PATH.bak.$(date +%s)"
mv "$TMP_CONFIG" "$CONFIG_PATH"

echo "Retrofit config applied to $CONFIG_PATH"
