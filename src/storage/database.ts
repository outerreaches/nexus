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

    CREATE TABLE IF NOT EXISTS jobs_archive (
      archive_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      owner_agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cron TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      enabled INTEGER NOT NULL,
      spec_json TEXT NOT NULL DEFAULT '{}',
      next_run_at INTEGER,
      last_run_at INTEGER,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_failure_at INTEGER,
      last_notified_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER NOT NULL,
      archive_reason TEXT NOT NULL,
      archived_by TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_archive_job ON jobs_archive(job_id, archived_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_archive_reason ON jobs_archive(archive_reason, archived_at DESC);

    CREATE TABLE IF NOT EXISTS job_runs_archive (
      archive_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
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
      archived_at INTEGER NOT NULL,
      archive_reason TEXT NOT NULL,
      archived_by TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_job_runs_archive_job ON job_runs_archive(job_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_job_runs_archive_run ON job_runs_archive(run_id);
    CREATE INDEX IF NOT EXISTS idx_job_runs_archive_archived ON job_runs_archive(archived_at DESC);

    CREATE TABLE IF NOT EXISTS job_events_archive (
      archive_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      run_id TEXT,
      owner_agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      handled_at INTEGER,
      archived_at INTEGER NOT NULL,
      archive_reason TEXT NOT NULL,
      archived_by TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_job_events_archive_job ON job_events_archive(job_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_job_events_archive_run ON job_events_archive(run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_job_events_archive_archived ON job_events_archive(archived_at DESC);

    -- ───────────────────────────────────────────────────────────────────────
    -- Ad-hoc process runs (one-off executions)
    -- ───────────────────────────────────────────────────────────────────────

    -- A "process run" is an on-demand execution started by an agent/tool call
    -- (and later, by remote node async execution). It is intentionally
    -- separate from the scheduler's "jobs" concept.
    CREATE TABLE IF NOT EXISTS process_runs (
      id TEXT PRIMARY KEY,
      backend TEXT NOT NULL DEFAULT 'local_child', -- local_child | node_async | ...
      status TEXT NOT NULL,                       -- running | exited | stopped
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      pid INTEGER,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      exit_code INTEGER,
      signal TEXT,
      log_path TEXT NOT NULL,

      -- Optional linkage / provenance
      node_id TEXT,
      node_execution_id TEXT,
      created_by_job_id TEXT,
      created_by_job_run_id TEXT,
      request_channel TEXT,
      request_channel_key TEXT,
      request_agent_id TEXT,
      request_preset TEXT,
      request_session_id TEXT,
      request_run_id TEXT,
      request_parent_run_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',

      -- Optional notification settings (best-effort)
      notify_mode TEXT NOT NULL DEFAULT 'never', -- never | on_failure | on_exit
      notify_chat_id INTEGER,                   -- telegram private-chat id (positive integer)
      notify_preset TEXT,                       -- preset to use when notifying (e.g., "process-manager")
      notify_attempts INTEGER NOT NULL DEFAULT 0,
      notify_last_error TEXT,
      notify_next_attempt_at INTEGER,
      notified_at INTEGER,

      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_process_runs_status_started ON process_runs(status, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_process_runs_started ON process_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_process_runs_job ON process_runs(created_by_job_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_process_runs_node ON process_runs(node_id, started_at DESC);

    -- ───────────────────────────────────────────────────────────────────────
    -- Node registry (gateway-side)
    -- ───────────────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      public_key TEXT UNIQUE NOT NULL,
      fingerprint TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | blocked | offline | online
      endpoint TEXT,
      backend TEXT NOT NULL DEFAULT 'nexus',       -- nexus | openclaw
      trust_level TEXT NOT NULL DEFAULT 'standard',
      firewall_mode TEXT NOT NULL DEFAULT 'transparent',
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      permissions_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      last_seen_at INTEGER,
      connected_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
    CREATE INDEX IF NOT EXISTS idx_nodes_fingerprint ON nodes(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_nodes_last_seen ON nodes(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_nodes_backend_status ON nodes(backend, status);
    CREATE INDEX IF NOT EXISTS idx_nodes_trust_status ON nodes(trust_level, status);

    CREATE TABLE IF NOT EXISTS node_sessions (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      ip_address TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_node_sessions_node_started ON node_sessions(node_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS node_executions (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      args_json TEXT,
      result_status TEXT, -- success | error | timeout
      error_code TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_node_executions_node_started ON node_executions(node_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS node_pairing_requests (
      id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      public_key TEXT NOT NULL,
      display_name TEXT,
      requested_at INTEGER NOT NULL,
      approved_at INTEGER,
      approved_by TEXT,
      rejected_at INTEGER,
      rejected_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_node_pairing_fingerprint ON node_pairing_requests(fingerprint);

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
    CREATE INDEX IF NOT EXISTS idx_blackboard_created_at ON blackboard(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_blackboard_type_created_at ON blackboard(type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_blackboard_agent_preset_created_at ON blackboard(agent_preset, created_at DESC);

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
    -- Context cursor tracking (delta injection checkpoints)
    -- ───────────────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS context_cursors (
      flow_type TEXT NOT NULL,
      flow_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      telegram_session_id TEXT,
      last_message_id INTEGER,
      summary_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(flow_type, flow_key, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_context_cursors_updated ON context_cursors(flow_type, updated_at DESC);

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

    CREATE TABLE IF NOT EXISTS mcp_grants (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      target_preset TEXT NOT NULL,
      tool_names_json TEXT NOT NULL DEFAULT '[]',
      max_calls INTEGER,
      call_count INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      run_id TEXT,
      parent_run_id TEXT,
      issued_by_agent_id TEXT,
      issued_by_run_id TEXT,
      revoke_reason TEXT,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(profile_id) REFERENCES mcp_profiles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mcp_grants_status_expires ON mcp_grants(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_mcp_grants_target ON mcp_grants(target_preset, status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_mcp_grants_run ON mcp_grants(run_id, status, expires_at);

    -- ───────────────────────────────────────────────────────────────────────
    -- Federation / transport / webhook / secrets (P1 scaffolding)
    -- ───────────────────────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS federation_peers (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      signing_key TEXT NOT NULL,
      trust_state TEXT NOT NULL DEFAULT 'pending', -- pending | trusted | revoked | quarantined
      enabled INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_federation_peers_trust_enabled ON federation_peers(trust_state, enabled, updated_at DESC);

    CREATE TABLE IF NOT EXISTS federation_sessions (
      id TEXT PRIMARY KEY,
      peer_id TEXT NOT NULL REFERENCES federation_peers(id) ON DELETE CASCADE,
      session_token_hash TEXT,
      status TEXT NOT NULL, -- active | expired | revoked | failed
      established_at INTEGER NOT NULL,
      expires_at INTEGER,
      last_heartbeat_at INTEGER,
      revoked_at INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_federation_sessions_peer_status ON federation_sessions(peer_id, status, expires_at DESC);

    CREATE TABLE IF NOT EXISTS federation_tasks (
      id TEXT PRIMARY KEY,
      peer_id TEXT NOT NULL REFERENCES federation_peers(id) ON DELETE CASCADE,
      status TEXT NOT NULL, -- pending | running | completed | failed | cancelled
      method TEXT NOT NULL,
      idempotency_key TEXT,
      request_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT,
      error_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_federation_tasks_peer_status ON federation_tasks(peer_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS federation_events (
      id TEXT PRIMARY KEY,
      peer_id TEXT REFERENCES federation_peers(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      direction TEXT NOT NULL, -- inbound | outbound
      envelope_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      trace_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_federation_events_peer_created ON federation_events(peer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_federation_events_trace ON federation_events(trace_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS federation_outbox (
      id TEXT PRIMARY KEY,
      peer_id TEXT REFERENCES federation_peers(id) ON DELETE SET NULL,
      transport_kind TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- pending | sending | sent | acked | failed | dead_letter
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      last_attempt_at INTEGER,
      last_error TEXT,
      trace_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_federation_outbox_status_next ON federation_outbox(status, next_attempt_at, updated_at DESC);

    CREATE TABLE IF NOT EXISTS federation_replay_nonces (
      source_instance TEXT NOT NULL,
      nonce TEXT NOT NULL,
      key_id TEXT,
      envelope_id TEXT,
      trace_id TEXT,
      first_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY(source_instance, nonce)
    );
    CREATE INDEX IF NOT EXISTS idx_federation_replay_nonces_expires ON federation_replay_nonces(expires_at);
    CREATE INDEX IF NOT EXISTS idx_federation_replay_nonces_source_seen ON federation_replay_nonces(source_instance, first_seen_at DESC);

    CREATE TABLE IF NOT EXISTS federation_audit (
      id TEXT PRIMARY KEY,
      peer_id TEXT REFERENCES federation_peers(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      decision TEXT, -- allow | deny | info
      actor TEXT,
      trace_id TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_federation_audit_created ON federation_audit(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_federation_audit_peer ON federation_audit(peer_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS transport_routes (
      route_id TEXT PRIMARY KEY,
      peer_id TEXT REFERENCES federation_peers(id) ON DELETE CASCADE,
      adapter TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      healthy INTEGER NOT NULL DEFAULT 0,
      last_checked_at INTEGER,
      last_error TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(peer_id, adapter, endpoint)
    );
    CREATE INDEX IF NOT EXISTS idx_transport_routes_peer_health ON transport_routes(peer_id, healthy, updated_at DESC);

    CREATE TABLE IF NOT EXISTS webhook_endpoints (
      id TEXT PRIMARY KEY,
      owner_scope TEXT NOT NULL DEFAULT 'local', -- local | federation_peer
      peer_id TEXT REFERENCES federation_peers(id) ON DELETE SET NULL,
      url TEXT NOT NULL,
      event_filter_json TEXT NOT NULL DEFAULT '[]',
      signing_mode TEXT NOT NULL DEFAULT 'hmac', -- hmac | ed25519
      secret_ref TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'active', -- active | paused | revoked
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_enabled_status ON webhook_endpoints(enabled, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS webhook_subscriptions (
      id TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(endpoint_id, event_type)
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_endpoint ON webhook_subscriptions(endpoint_id, enabled);

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
      event_id TEXT,
      status TEXT NOT NULL, -- pending | sent | acked | failed | dead_letter
      attempts INTEGER NOT NULL DEFAULT 0,
      response_code INTEGER,
      response_body TEXT,
      next_attempt_at INTEGER,
      last_attempt_at INTEGER,
      trace_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status_next ON webhook_deliveries(status, next_attempt_at, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint_created ON webhook_deliveries(endpoint_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS webhook_dlq (
      id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
      endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      replayed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_dlq_created ON webhook_dlq(created_at DESC);

    CREATE TABLE IF NOT EXISTS federation_exports (
      id TEXT PRIMARY KEY,
      resource_type TEXT NOT NULL, -- node_pool | data_intake | blackboard | mcp
      resource_selector_json TEXT NOT NULL DEFAULT '{}',
      projection_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_federation_exports_type_enabled ON federation_exports(resource_type, enabled, updated_at DESC);

    CREATE TABLE IF NOT EXISTS federation_grants (
      id TEXT PRIMARY KEY,
      peer_id TEXT NOT NULL REFERENCES federation_peers(id) ON DELETE CASCADE,
      export_id TEXT NOT NULL REFERENCES federation_exports(id) ON DELETE CASCADE,
      permission TEXT NOT NULL DEFAULT 'read',
      sensitivity_ceiling TEXT NOT NULL DEFAULT 'internal',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(peer_id, export_id)
    );
    CREATE INDEX IF NOT EXISTS idx_federation_grants_peer_enabled ON federation_grants(peer_id, enabled, updated_at DESC);

    CREATE TABLE IF NOT EXISTS secret_provider_profiles (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      endpoint_ref TEXT,
      auth_mode TEXT NOT NULL DEFAULT 'none',
      strict_mode INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_secret_provider_profiles_kind_enabled ON secret_provider_profiles(kind, enabled, updated_at DESC);

    CREATE TABLE IF NOT EXISTS secret_access_events (
      id TEXT PRIMARY KEY,
      provider_profile_id TEXT REFERENCES secret_provider_profiles(id) ON DELETE SET NULL,
      trace_id TEXT,
      firewall_session TEXT,
      actor TEXT,
      secret_path_hash TEXT NOT NULL,
      secret_class TEXT,
      decision TEXT NOT NULL, -- allow | deny | error
      reason TEXT,
      lease_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_secret_access_events_created ON secret_access_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_secret_access_events_trace ON secret_access_events(trace_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS secret_leases (
      id TEXT PRIMARY KEY,
      provider_profile_id TEXT REFERENCES secret_provider_profiles(id) ON DELETE SET NULL,
      lease_ref TEXT NOT NULL,
      secret_class TEXT,
      status TEXT NOT NULL, -- active | expired | revoked
      issued_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER,
      trace_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_secret_leases_status_expires ON secret_leases(status, expires_at DESC);

    CREATE TABLE IF NOT EXISTS http_auth_sessions (
      session_hash TEXT PRIMARY KEY,
      csrf_token TEXT NOT NULL,
      user_label TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_http_auth_sessions_expires ON http_auth_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_http_auth_sessions_revoked ON http_auth_sessions(revoked_at, expires_at);

    CREATE TABLE IF NOT EXISTS identity_keyring (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL, -- federation | node
      kid TEXT NOT NULL,
      public_key TEXT NOT NULL,
      private_key_ref TEXT,
      status TEXT NOT NULL DEFAULT 'active', -- active | next | revoked | expired
      not_before INTEGER,
      not_after INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revoked_at INTEGER,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(scope, kid)
    );
    CREATE INDEX IF NOT EXISTS idx_identity_keyring_scope_status ON identity_keyring(scope, status, not_after DESC);
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
    db.exec("CREATE INDEX IF NOT EXISTS idx_blackboard_created_at ON blackboard(created_at DESC);");
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_blackboard_type_created_at ON blackboard(type, created_at DESC);");
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_blackboard_agent_preset_created_at ON blackboard(agent_preset, created_at DESC);");
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
    db.exec("ALTER TABLE process_runs ADD COLUMN notify_mode TEXT NOT NULL DEFAULT 'never';");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE process_runs ADD COLUMN notify_chat_id INTEGER;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE process_runs ADD COLUMN notify_preset TEXT;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE process_runs ADD COLUMN notify_attempts INTEGER NOT NULL DEFAULT 0;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE process_runs ADD COLUMN notify_last_error TEXT;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE process_runs ADD COLUMN notify_next_attempt_at INTEGER;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE process_runs ADD COLUMN notified_at INTEGER;");
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_process_runs_notify_pending ON process_runs(status, notified_at, notify_next_attempt_at);");
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

  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS mcp_grants (" +
      "id TEXT PRIMARY KEY, " +
      "profile_id TEXT NOT NULL, " +
      "server_id TEXT NOT NULL, " +
      "target_preset TEXT NOT NULL, " +
      "tool_names_json TEXT NOT NULL DEFAULT '[]', " +
      "max_calls INTEGER, " +
      "call_count INTEGER NOT NULL DEFAULT 0, " +
      "expires_at INTEGER, " +
      "status TEXT NOT NULL DEFAULT 'active', " +
      "run_id TEXT, " +
      "parent_run_id TEXT, " +
      "issued_by_agent_id TEXT, " +
      "issued_by_run_id TEXT, " +
      "revoke_reason TEXT, " +
      "revoked_at INTEGER, " +
      "created_at INTEGER NOT NULL, " +
      "updated_at INTEGER NOT NULL, " +
      "FOREIGN KEY(profile_id) REFERENCES mcp_profiles(id) ON DELETE CASCADE" +
      ");",
    );
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_mcp_grants_status_expires ON mcp_grants(status, expires_at);");
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_mcp_grants_target ON mcp_grants(target_preset, status, expires_at);");
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_mcp_grants_run ON mcp_grants(run_id, status, expires_at);");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE nodes ADD COLUMN backend TEXT NOT NULL DEFAULT 'nexus';");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE nodes ADD COLUMN trust_level TEXT NOT NULL DEFAULT 'standard';");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE nodes ADD COLUMN firewall_mode TEXT NOT NULL DEFAULT 'transparent';");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE nodes ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE nodes ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '{}';");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE nodes ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE nodes ADD COLUMN last_seen_at INTEGER;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE nodes ADD COLUMN connected_at INTEGER;");
  } catch {
    // already exists
  }

  try {
    db.exec("ALTER TABLE nodes ADD COLUMN updated_at INTEGER;");
  } catch {
    // already exists
  }

  try {
    db.exec("UPDATE nodes SET updated_at = COALESCE(updated_at, created_at, CAST(strftime('%s','now') AS INTEGER) * 1000);");
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);");
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_fingerprint ON nodes(fingerprint);");
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_last_seen ON nodes(last_seen_at);");
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_backend_status ON nodes(backend, status);");
  } catch {
    // already exists
  }

  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_trust_status ON nodes(trust_level, status);");
  } catch {
    // already exists
  }

  return {
    db,
    close: () => db.close(),
  };
}
