import fs from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

export type NexusDatabase = {
  db: Database.Database;
  close: () => void;
};

export async function openDatabase(dbPath: string): Promise<NexusDatabase> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 10000");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      channel_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      history_anchor_message_id INTEGER,
      history_anchor_updated_at INTEGER,
      UNIQUE(channel, channel_key, agent_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      name TEXT,
      tool_call_id TEXT,
      tool_calls_json TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_id_id ON messages(session_id, id);

    CREATE TABLE IF NOT EXISTS paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      instrument TEXT NOT NULL,
      side TEXT NOT NULL,
      size REAL NOT NULL,
      entry_price REAL,
      exit_price REAL,
      status TEXT NOT NULL,
      reasoning TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS telegram_allowlist (
      user_id INTEGER PRIMARY KEY,
      added_at INTEGER NOT NULL,
      added_by INTEGER,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS pairing_codes (
      code TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pairing_requests (
      code TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      sender_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pairing_requests_channel_sender ON pairing_requests(channel, sender_key);

    CREATE TABLE IF NOT EXISTS human_actions (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      channel TEXT,
      channel_key TEXT,
      agent_id TEXT,
      kind TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      responded_at INTEGER,
      responded_by_channel TEXT,
      responded_by_key TEXT,
      response_text TEXT,
      metadata_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_human_actions_status_created ON human_actions(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_human_actions_session ON human_actions(session_id, status, created_at);

    -- ───────────────────────────────────────────────────────────────────────
    -- Internal scheduler / jobs
    -- ───────────────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      owner_agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cron TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      enabled INTEGER NOT NULL DEFAULT 1,
      spec_json TEXT NOT NULL DEFAULT '{}',
      next_run_at INTEGER,
      last_run_at INTEGER,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_failure_at INTEGER,
      last_notified_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_agent_id, enabled);
    CREATE INDEX IF NOT EXISTS idx_jobs_next_run ON jobs(enabled, next_run_at);

    CREATE TABLE IF NOT EXISTS job_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      owner_agent_id TEXT NOT NULL,
      scheduled_for INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      status TEXT NOT NULL,
      error TEXT,
      output TEXT,
      tool_calls_used INTEGER,
      iterations_used INTEGER,
      FOREIGN KEY(job_id) REFERENCES jobs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_job_runs_owner ON job_runs(owner_agent_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS job_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      run_id TEXT,
      owner_agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      handled_at INTEGER,
      FOREIGN KEY(job_id) REFERENCES jobs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_job_events_owner ON job_events(owner_agent_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS job_leases (
      job_id TEXT PRIMARY KEY,
      lease_id TEXT NOT NULL,
      leased_until INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- ───────────────────────────────────────────────────────────────────────
    -- Gateway active lease (HA mode)
    -- ───────────────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS gateway_leases (
      key TEXT PRIMARY KEY,
      holder_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      renewed_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_gateway_leases_expires ON gateway_leases(expires_at);

    -- ───────────────────────────────────────────────────────────────────────
    -- Database backups (tracking)
    -- ───────────────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS db_backups (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      backup_type TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_db_backups_created ON db_backups(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_db_backups_status ON db_backups(status, created_at DESC);

    -- ───────────────────────────────────────────────────────────────────────
    -- HA events (failover/failback tracking)
    -- ───────────────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS ha_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      source TEXT NOT NULL,
      from_instance TEXT,
      to_instance TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ha_events_created ON ha_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ha_events_type ON ha_events(event_type, created_at DESC);

    -- ───────────────────────────────────────────────────────────────────────
    -- Agent memory store
    -- ───────────────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL DEFAULT 'main',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'observation',
      tags_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(agent_id, key)
    );

    CREATE INDEX IF NOT EXISTS idx_memories_agent_category ON memories(agent_id, category);
    CREATE INDEX IF NOT EXISTS idx_memories_agent_key ON memories(agent_id, key);

    -- ───────────────────────────────────────────────────────────────────────
    -- Data intake (normalized cache)
    -- ───────────────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS data_items (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      tags_json TEXT NOT NULL DEFAULT '[]',
      subject TEXT NOT NULL,
      value_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      collected_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS data_item_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      collected_at INTEGER NOT NULL,
      value_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_data_item_events_source_subject ON data_item_events(source_id, subject, collected_at DESC);

    CREATE INDEX IF NOT EXISTS idx_data_items_source_subject ON data_items(source_id, subject, collected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_data_items_tags ON data_items(tags_json, collected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_data_items_expires ON data_items(expires_at);

    CREATE TABLE IF NOT EXISTS data_intake_sources (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      label TEXT,
      params_json TEXT NOT NULL DEFAULT '{}',
      interval_ms INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_run_at INTEGER,
      last_error TEXT,
      job_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_data_intake_sources_enabled ON data_intake_sources(enabled, source_id);

    -- ───────────────────────────────────────────────────────────────────────
    -- Blackboard (shared agent communication store)
    -- ───────────────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS blackboard (
      id TEXT PRIMARY KEY,
      session_scope TEXT NOT NULL,
      type TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_preset TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER,
      expires_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_blackboard_scope ON blackboard(session_scope, created_at DESC);

    -- ───────────────────────────────────────────────────────────────────────
    -- Agent run graph (hierarchical swarm tracking)
    -- ───────────────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY,
      parent_run_id TEXT,
      session_id TEXT,
      agent_id TEXT NOT NULL,
      preset TEXT NOT NULL,
      channel TEXT,
      channel_key TEXT,
      task TEXT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      tool_calls_used INTEGER,
      iterations_used INTEGER,
      output_preview TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_agent_runs_parent ON agent_runs(parent_run_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON agent_runs(started_at DESC);

    -- ───────────────────────────────────────────────────────────────────────
    -- Database maintenance / cleanup tracking
    -- ───────────────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS cleanup_summaries (
      id TEXT PRIMARY KEY,
      table_name TEXT NOT NULL,
      operation TEXT NOT NULL,
      rows_affected INTEGER NOT NULL,
      date_range_start INTEGER,
      date_range_end INTEGER,
      summary_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cleanup_summaries_table ON cleanup_summaries(table_name, created_at DESC);

    -- ───────────────────────────────────────────────────────────────────────
    -- MCP servers/profiles (dynamic tooling control plane)
    -- ───────────────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'stdio',
      command TEXT,
      args_json TEXT NOT NULL DEFAULT '[]',
      env_json TEXT NOT NULL DEFAULT '{}',
      url TEXT,
      headers_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 0,
      trust_level TEXT NOT NULL DEFAULT 'read_only',
      capability_tags_json TEXT NOT NULL DEFAULT '[]',
      timeout_ms INTEGER NOT NULL DEFAULT 45000,
      max_concurrency INTEGER NOT NULL DEFAULT 2,
      idle_ttl_ms INTEGER NOT NULL DEFAULT 600000,
      last_discovered_tools_json TEXT NOT NULL DEFAULT '[]',
      last_error TEXT,
      last_error_at INTEGER,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled, active, updated_at DESC);

    CREATE TABLE IF NOT EXISTS mcp_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      server_id TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tool_names_json TEXT NOT NULL DEFAULT '[]',
      hidden INTEGER NOT NULL DEFAULT 1,
      ephemeral INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      llm_primary_provider TEXT,
      llm_primary_model TEXT,
      llm_fallback_provider TEXT,
      llm_fallback_model TEXT,
      llm_disable_fallback INTEGER NOT NULL DEFAULT 0,
      budget_max_tool_calls INTEGER,
      budget_max_iterations INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER,
      FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_profiles_server ON mcp_profiles(server_id, enabled, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mcp_profiles_name ON mcp_profiles(name);

    CREATE TABLE IF NOT EXISTS mcp_events (
      id TEXT PRIMARY KEY,
      server_id TEXT,
      profile_id TEXT,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_events_created ON mcp_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mcp_events_server ON mcp_events(server_id, created_at DESC);
  `);

  try {
    db.exec("ALTER TABLE messages ADD COLUMN tool_calls_json TEXT;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE sessions ADD COLUMN history_anchor_message_id INTEGER;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE sessions ADD COLUMN history_anchor_updated_at INTEGER;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE blackboard ADD COLUMN last_accessed_at INTEGER;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE blackboard ADD COLUMN expires_at INTEGER;");
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_blackboard_expires ON blackboard(expires_at);");
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_data_items_expires ON data_items(expires_at);");
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_data_item_events_source_subject ON data_item_events(source_id, subject, collected_at DESC);");
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_data_intake_sources_enabled ON data_intake_sources(enabled, source_id);");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE agent_runs ADD COLUMN parent_run_id TEXT;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE agent_runs ADD COLUMN session_id TEXT;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE agent_runs ADD COLUMN agent_id TEXT;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE agent_runs ADD COLUMN preset TEXT;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE agent_runs ADD COLUMN channel TEXT;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE agent_runs ADD COLUMN channel_key TEXT;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE agent_runs ADD COLUMN task TEXT;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE agent_runs ADD COLUMN status TEXT;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE agent_runs ADD COLUMN started_at INTEGER;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE agent_runs ADD COLUMN ended_at INTEGER;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE agent_runs ADD COLUMN tool_calls_used INTEGER;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE agent_runs ADD COLUMN iterations_used INTEGER;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE agent_runs ADD COLUMN output_preview TEXT;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE data_intake_sources ADD COLUMN job_id TEXT;");
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled, active, updated_at DESC);");
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_mcp_profiles_server ON mcp_profiles(server_id, enabled, updated_at DESC);");
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_mcp_profiles_name ON mcp_profiles(name);");
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_mcp_events_created ON mcp_events(created_at DESC);");
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_mcp_events_server ON mcp_events(server_id, created_at DESC);");
  } catch {
    // already exists
  }

  return {
    db,
    close: () => db.close(),
  };
}
