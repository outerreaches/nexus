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
