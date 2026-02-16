import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

export type PersistedProcessStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type PersistedFirewallQuarantineState = "none" | "soft" | "hard";

export type PersistedProcessRecord = {
  processId: string;
  status: PersistedProcessStatus;
  command: string;
  cwd: string | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  cancelRequested: boolean;
  timeoutMs: number | null;
  logs: string;
  routing: Record<string, unknown> | null;
};

export type PersistedOutboxEntry = {
  deliveryId: string;
  processId: string;
  payload: Record<string, unknown>;
  createdAt: number;
  delivered: boolean;
  deliveredAt: number | null;
};

export type PersistedFirewallSessionRecord = {
  sessionId: string;
  quarantineState: PersistedFirewallQuarantineState;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  metadata: Record<string, unknown> | null;
};

export type PersistedAuditEventRecord = {
  eventId: string;
  createdAt: number;
  type: string;
  processId: string | null;
  firewallSession: string | null;
  actor: string | null;
  toolName: string | null;
  details: Record<string, unknown> | null;
};

export type PersistedReferenceRecord = {
  refId: string;
  sourceType: string;
  processId: string | null;
  toolName: string | null;
  title: string | null;
  safeSummary: string;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
};

type PersistedProcessRow = {
  process_id: string;
  status: string;
  command: string;
  cwd: string | null;
  started_at: number;
  completed_at: number | null;
  exit_code: number | null;
  signal: string | null;
  cancel_requested: number;
  timeout_ms: number | null;
  logs_text: string | null;
  routing_json: string | null;
};

type PersistedOutboxRow = {
  delivery_id: string;
  process_id: string;
  payload_json: string;
  created_at: number;
  delivered: number;
  delivered_at: number | null;
};

type PersistedFirewallSessionRow = {
  session_id: string;
  quarantine_state: string;
  created_at: number;
  last_used_at: number;
  expires_at: number;
  metadata_json: string | null;
};

type PersistedAuditEventRow = {
  event_id: string;
  created_at: number;
  type: string;
  process_id: string | null;
  firewall_session: string | null;
  actor: string | null;
  tool_name: string | null;
  details_json: string | null;
};

type PersistedReferenceRow = {
  ref_id: string;
  source_type: string;
  process_id: string | null;
  tool_name: string | null;
  title: string | null;
  safe_summary: string;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asRoutingString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return null;
  }
}

export class ReferenceNodeStateStore {
  readonly dbPath: string;

  private constructor(
    private readonly db: Database.Database,
    dbPath: string,
  ) {
    this.dbPath = dbPath;
  }

  static async open(stateDir: string): Promise<ReferenceNodeStateStore> {
    const dbDir = path.join(stateDir, "state");
    const dbPath = path.join(dbDir, "reference-node.db");
    await fs.mkdir(dbDir, { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_processes (
        process_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        command TEXT NOT NULL,
        cwd TEXT,
        args_json TEXT,
        run_id TEXT,
        parent_run_id TEXT,
        session_id TEXT,
        channel TEXT,
        channel_key TEXT,
        firewall_session TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        exit_code INTEGER,
        signal TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        timeout_ms INTEGER,
        logs_text TEXT,
        summary_json TEXT,
        routing_json TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_node_processes_status_started
        ON node_processes(status, started_at DESC);

      CREATE TABLE IF NOT EXISTS node_outbox (
        delivery_id TEXT PRIMARY KEY,
        process_id TEXT NOT NULL REFERENCES node_processes(process_id),
        payload_json TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_node_outbox_delivered_created
        ON node_outbox(delivered, created_at ASC);

      CREATE TABLE IF NOT EXISTS node_firewall_sessions (
        session_id TEXT PRIMARY KEY,
        quarantine_state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        metadata_json TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_node_firewall_sessions_expires
        ON node_firewall_sessions(expires_at ASC);

      CREATE TABLE IF NOT EXISTS node_audit_events (
        event_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        type TEXT NOT NULL,
        process_id TEXT,
        firewall_session TEXT,
        actor TEXT,
        tool_name TEXT,
        details_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_node_audit_events_created
        ON node_audit_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_node_audit_events_type_created
        ON node_audit_events(type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_node_audit_events_process_created
        ON node_audit_events(process_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS node_references (
        ref_id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        process_id TEXT,
        tool_name TEXT,
        title TEXT,
        safe_summary TEXT NOT NULL,
        metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_node_references_process_created
        ON node_references(process_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_node_references_tool_created
        ON node_references(tool_name, created_at DESC);
    `);
    return new ReferenceNodeStateStore(db, dbPath);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }

  upsertProcess(process: PersistedProcessRecord, nowMs: number): void {
    const routing = process.routing ?? {};
    const runId = asRoutingString(routing.runId);
    const parentRunId = asRoutingString(routing.parentRunId);
    const sessionId = asRoutingString(routing.sessionId);
    const channel = asRoutingString(routing.channel);
    const channelKey = asRoutingString(routing.channelKey);
    const firewallSession = asRoutingString(routing.firewallSession);
    this.db
      .prepare(
        `
        INSERT INTO node_processes (
          process_id, status, tool_name, command, cwd, args_json,
          run_id, parent_run_id, session_id, channel, channel_key, firewall_session,
          started_at, completed_at, exit_code, signal, cancel_requested, timeout_ms,
          logs_text, summary_json, routing_json, updated_at
        ) VALUES (
          @process_id, @status, @tool_name, @command, @cwd, @args_json,
          @run_id, @parent_run_id, @session_id, @channel, @channel_key, @firewall_session,
          @started_at, @completed_at, @exit_code, @signal, @cancel_requested, @timeout_ms,
          @logs_text, @summary_json, @routing_json, @updated_at
        )
        ON CONFLICT(process_id) DO UPDATE SET
          status=excluded.status,
          command=excluded.command,
          cwd=excluded.cwd,
          args_json=excluded.args_json,
          run_id=excluded.run_id,
          parent_run_id=excluded.parent_run_id,
          session_id=excluded.session_id,
          channel=excluded.channel,
          channel_key=excluded.channel_key,
          firewall_session=excluded.firewall_session,
          completed_at=excluded.completed_at,
          exit_code=excluded.exit_code,
          signal=excluded.signal,
          cancel_requested=excluded.cancel_requested,
          timeout_ms=excluded.timeout_ms,
          logs_text=excluded.logs_text,
          summary_json=excluded.summary_json,
          routing_json=excluded.routing_json,
          updated_at=excluded.updated_at
      `,
      )
      .run({
        process_id: process.processId,
        status: process.status,
        tool_name: "system.run",
        command: process.command,
        cwd: process.cwd,
        args_json: JSON.stringify({
          command: process.command,
          cwd: process.cwd,
          timeoutMs: process.timeoutMs,
        }),
        run_id: runId,
        parent_run_id: parentRunId,
        session_id: sessionId,
        channel,
        channel_key: channelKey,
        firewall_session: firewallSession,
        started_at: process.startedAt,
        completed_at: process.endedAt,
        exit_code: process.exitCode,
        signal: process.signal,
        cancel_requested: process.cancelRequested ? 1 : 0,
        timeout_ms: process.timeoutMs,
        logs_text: process.logs,
        summary_json: null,
        routing_json: process.routing ? JSON.stringify(process.routing) : null,
        updated_at: nowMs,
      });
  }

  removeProcess(processId: string): void {
    this.db.prepare("DELETE FROM node_outbox WHERE process_id = ?").run(processId);
    this.db.prepare("DELETE FROM node_processes WHERE process_id = ?").run(processId);
  }

  updateProcessLogs(processId: string, logs: string, nowMs: number): void {
    this.db.prepare("UPDATE node_processes SET logs_text = ?, updated_at = ? WHERE process_id = ?").run(logs, nowMs, processId);
  }

  loadProcesses(limit: number): PersistedProcessRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT process_id, status, command, cwd, started_at, completed_at, exit_code, signal,
               cancel_requested, timeout_ms, logs_text, routing_json
        FROM node_processes
        ORDER BY started_at DESC
        LIMIT ?
      `,
      )
      .all(limit) as PersistedProcessRow[];
    return rows.map((row) => ({
      processId: row.process_id,
      status: this.parseStatus(row.status),
      command: row.command,
      cwd: row.cwd ?? null,
      startedAt: row.started_at,
      endedAt: row.completed_at ?? null,
      exitCode: row.exit_code ?? null,
      signal: row.signal ?? null,
      cancelRequested: row.cancel_requested === 1,
      timeoutMs: row.timeout_ms ?? null,
      logs: row.logs_text ?? "",
      routing: parseJsonObject(row.routing_json),
    }));
  }

  enqueueOutbox(params: {
    deliveryId: string;
    processId: string;
    payload: Record<string, unknown>;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `
        INSERT OR IGNORE INTO node_outbox (delivery_id, process_id, payload_json, delivered, created_at, delivered_at)
        VALUES (?, ?, ?, 0, ?, NULL)
      `,
      )
      .run(params.deliveryId, params.processId, JSON.stringify(params.payload), params.createdAt);
  }

  listUndelivered(limit: number): PersistedOutboxEntry[] {
    const rows = this.db
      .prepare(
        `
        SELECT delivery_id, process_id, payload_json, created_at, delivered, delivered_at
        FROM node_outbox
        WHERE delivered = 0
        ORDER BY created_at ASC
        LIMIT ?
      `,
      )
      .all(limit) as PersistedOutboxRow[];
    const out: PersistedOutboxEntry[] = [];
    for (const row of rows) {
      let payload: Record<string, unknown> | null = null;
      try {
        payload = asObject(JSON.parse(row.payload_json));
      } catch {
        payload = null;
      }
      if (!payload) continue;
      out.push({
        deliveryId: row.delivery_id,
        processId: row.process_id,
        payload,
        createdAt: row.created_at,
        delivered: row.delivered === 1,
        deliveredAt: row.delivered_at ?? null,
      });
    }
    return out;
  }

  countUndelivered(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM node_outbox WHERE delivered = 0")
      .get() as { count?: number } | undefined;
    const count = row?.count;
    return typeof count === "number" && Number.isFinite(count) ? count : 0;
  }

  createFirewallSession(params: {
    sessionId: string;
    quarantineState: PersistedFirewallQuarantineState;
    metadata?: Record<string, unknown> | null;
    nowMs: number;
    ttlMs: number;
  }): PersistedFirewallSessionRecord {
    const expiresAt = params.nowMs + Math.max(1_000, params.ttlMs);
    this.db
      .prepare(
        `
        INSERT INTO node_firewall_sessions (
          session_id, quarantine_state, created_at, last_used_at, expires_at, metadata_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        params.sessionId,
        params.quarantineState,
        params.nowMs,
        params.nowMs,
        expiresAt,
        params.metadata ? JSON.stringify(params.metadata) : null,
        params.nowMs,
      );
    return {
      sessionId: params.sessionId,
      quarantineState: params.quarantineState,
      createdAt: params.nowMs,
      lastUsedAt: params.nowMs,
      expiresAt,
      metadata: params.metadata ?? null,
    };
  }

  getFirewallSession(sessionId: string, nowMs: number): PersistedFirewallSessionRecord | null {
    const row = this.db
      .prepare(
        `
        SELECT session_id, quarantine_state, created_at, last_used_at, expires_at, metadata_json
        FROM node_firewall_sessions
        WHERE session_id = ?
      `,
      )
      .get(sessionId) as PersistedFirewallSessionRow | undefined;
    if (!row?.session_id) return null;
    if (row.expires_at <= nowMs) {
      this.db.prepare("DELETE FROM node_firewall_sessions WHERE session_id = ?").run(sessionId);
      return null;
    }
    return {
      sessionId: row.session_id,
      quarantineState: this.parseQuarantineState(row.quarantine_state),
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      metadata: parseJsonObject(row.metadata_json),
    };
  }

  touchFirewallSession(sessionId: string, nowMs: number, ttlMs: number): PersistedFirewallSessionRecord | null {
    const expiresAt = nowMs + Math.max(1_000, ttlMs);
    this.db
      .prepare(
        `
        UPDATE node_firewall_sessions
        SET last_used_at = ?, expires_at = ?, updated_at = ?
        WHERE session_id = ?
      `,
      )
      .run(nowMs, expiresAt, nowMs, sessionId);
    return this.getFirewallSession(sessionId, nowMs);
  }

  pruneExpiredFirewallSessions(nowMs: number): number {
    const result = this.db
      .prepare("DELETE FROM node_firewall_sessions WHERE expires_at <= ?")
      .run(nowMs);
    return Number(result.changes ?? 0);
  }

  appendAuditEvent(params: {
    eventId?: string;
    createdAt: number;
    type: string;
    processId?: string | null;
    firewallSession?: string | null;
    actor?: string | null;
    toolName?: string | null;
    details?: Record<string, unknown> | null;
  }): PersistedAuditEventRecord {
    const eventId = params.eventId?.trim() || `aud_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const type = params.type.trim();
    this.db
      .prepare(
        `
        INSERT INTO node_audit_events (
          event_id, created_at, type, process_id, firewall_session, actor, tool_name, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        eventId,
        params.createdAt,
        type,
        params.processId ?? null,
        params.firewallSession ?? null,
        params.actor ?? null,
        params.toolName ?? null,
        params.details ? JSON.stringify(params.details) : null,
      );
    return {
      eventId,
      createdAt: params.createdAt,
      type,
      processId: params.processId ?? null,
      firewallSession: params.firewallSession ?? null,
      actor: params.actor ?? null,
      toolName: params.toolName ?? null,
      details: params.details ?? null,
    };
  }

  queryAuditEvents(params: {
    limit: number;
    cursorCreatedAt?: number | null;
    type?: string | null;
    processId?: string | null;
    firewallSession?: string | null;
    actor?: string | null;
  }): { events: PersistedAuditEventRecord[]; nextCursorCreatedAt: number | null } {
    const limit = Math.max(1, Math.min(500, Math.floor(params.limit)));
    const where: string[] = [];
    const bind: unknown[] = [];

    const cursorCreatedAt =
      typeof params.cursorCreatedAt === "number" && Number.isFinite(params.cursorCreatedAt)
        ? Math.floor(params.cursorCreatedAt)
        : null;
    if (cursorCreatedAt !== null) {
      where.push("created_at < ?");
      bind.push(cursorCreatedAt);
    }
    if (params.type && params.type.trim()) {
      where.push("type = ?");
      bind.push(params.type.trim());
    }
    if (params.processId && params.processId.trim()) {
      where.push("process_id = ?");
      bind.push(params.processId.trim());
    }
    if (params.firewallSession && params.firewallSession.trim()) {
      where.push("firewall_session = ?");
      bind.push(params.firewallSession.trim());
    }
    if (params.actor && params.actor.trim()) {
      where.push("actor = ?");
      bind.push(params.actor.trim());
    }

    const sql = `
      SELECT event_id, created_at, type, process_id, firewall_session, actor, tool_name, details_json
      FROM node_audit_events
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, event_id DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...bind, limit + 1) as PersistedAuditEventRow[];
    const hasMore = rows.length > limit;
    const trimmed = hasMore ? rows.slice(0, limit) : rows;
    const events = trimmed.map((row) => ({
      eventId: row.event_id,
      createdAt: row.created_at,
      type: row.type,
      processId: row.process_id ?? null,
      firewallSession: row.firewall_session ?? null,
      actor: row.actor ?? null,
      toolName: row.tool_name ?? null,
      details: parseJsonObject(row.details_json),
    }));
    return {
      events,
      nextCursorCreatedAt: hasMore ? events[events.length - 1]?.createdAt ?? null : null,
    };
  }

  createReference(params: {
    refId?: string;
    sourceType: string;
    processId?: string | null;
    toolName?: string | null;
    title?: string | null;
    safeSummary: string;
    metadata?: Record<string, unknown> | null;
    nowMs: number;
  }): PersistedReferenceRecord {
    const sourceType = params.sourceType.trim();
    const refId = params.refId?.trim() || `ref_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const safeSummary = params.safeSummary;
    this.db
      .prepare(
        `
        INSERT INTO node_references (
          ref_id, source_type, process_id, tool_name, title, safe_summary, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        refId,
        sourceType,
        params.processId ?? null,
        params.toolName ?? null,
        params.title ?? null,
        safeSummary,
        params.metadata ? JSON.stringify(params.metadata) : null,
        params.nowMs,
        params.nowMs,
      );
    return {
      refId,
      sourceType,
      processId: params.processId ?? null,
      toolName: params.toolName ?? null,
      title: params.title ?? null,
      safeSummary,
      metadata: params.metadata ?? null,
      createdAt: params.nowMs,
      updatedAt: params.nowMs,
    };
  }

  listReferencesByProcessId(processId: string, limit: number): PersistedReferenceRecord[] {
    const rows = this.db
      .prepare(
        `
        SELECT ref_id, source_type, process_id, tool_name, title, safe_summary, metadata_json, created_at, updated_at
        FROM node_references
        WHERE process_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
      )
      .all(processId, Math.max(1, Math.min(200, Math.floor(limit)))) as PersistedReferenceRow[];
    return rows.map((row) => ({
      refId: row.ref_id,
      sourceType: row.source_type,
      processId: row.process_id ?? null,
      toolName: row.tool_name ?? null,
      title: row.title ?? null,
      safeSummary: row.safe_summary,
      metadata: parseJsonObject(row.metadata_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  markOutboxDelivered(deliveryId: string, nowMs: number): boolean {
    const result = this.db
      .prepare(
        `
        UPDATE node_outbox
        SET delivered = 1, delivered_at = ?
        WHERE delivery_id = ? AND delivered = 0
      `,
      )
      .run(nowMs, deliveryId);
    if (Number(result.changes ?? 0) > 0) return true;
    const existing = this.db
      .prepare("SELECT delivery_id FROM node_outbox WHERE delivery_id = ?")
      .get(deliveryId) as { delivery_id?: string } | undefined;
    return Boolean(existing?.delivery_id);
  }

  pruneDeliveredOlderThan(cutoffMs: number): number {
    const result = this.db
      .prepare("DELETE FROM node_outbox WHERE delivered = 1 AND delivered_at IS NOT NULL AND delivered_at < ?")
      .run(cutoffMs);
    return Number(result.changes ?? 0);
  }

  private parseStatus(value: string): PersistedProcessStatus {
    switch (value) {
      case "queued":
      case "running":
      case "completed":
      case "failed":
      case "cancelled":
        return value;
      default:
        return "failed";
    }
  }

  private parseQuarantineState(value: string): PersistedFirewallQuarantineState {
    switch (value) {
      case "none":
      case "soft":
      case "hard":
        return value;
      default:
        return "none";
    }
  }
}
