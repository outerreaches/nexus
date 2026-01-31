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

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      channel_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
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
  `);

  try {
    db.exec("ALTER TABLE messages ADD COLUMN tool_calls_json TEXT;");
  } catch {
    // already exists
  }

  return {
    db,
    close: () => db.close(),
  };
}
