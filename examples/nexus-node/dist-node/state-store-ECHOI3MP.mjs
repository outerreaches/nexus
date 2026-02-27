import "./chunk-LZOMFHX3.mjs";

// state-store.ts
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}
function asRoutingString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
function parseJsonObject(raw) {
  if (!raw) return null;
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return null;
  }
}
var ReferenceNodeStateStore = class _ReferenceNodeStateStore {
  constructor(db, dbPath) {
    this.db = db;
    this.dbPath = dbPath;
    this.statePath = dbPath;
  }
  backend = "sqlite";
  dbPath;
  statePath;
  static async open(stateDir) {
    const dbDir = path.join(stateDir, "state");
    const dbPath = path.join(dbDir, "reference-node.db");
    await fs.mkdir(dbDir, { recursive: true });
    const sqliteModule = await import("./lib-F2RZK2F7.mjs");
    const db = new sqliteModule.default(dbPath);
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
    return new _ReferenceNodeStateStore(db, dbPath);
  }
  close() {
    try {
      this.db.close();
    } catch {
    }
  }
  upsertProcess(process, nowMs) {
    const routing = process.routing ?? {};
    const runId = asRoutingString(routing.runId);
    const parentRunId = asRoutingString(routing.parentRunId);
    const sessionId = asRoutingString(routing.sessionId);
    const channel = asRoutingString(routing.channel);
    const channelKey = asRoutingString(routing.channelKey);
    const firewallSession = asRoutingString(routing.firewallSession);
    this.db.prepare(
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
      `
    ).run({
      process_id: process.processId,
      status: process.status,
      tool_name: "system.run",
      command: process.command,
      cwd: process.cwd,
      args_json: JSON.stringify({
        command: process.command,
        cwd: process.cwd,
        timeoutMs: process.timeoutMs
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
      updated_at: nowMs
    });
  }
  removeProcess(processId) {
    this.db.prepare("DELETE FROM node_outbox WHERE process_id = ?").run(processId);
    this.db.prepare("DELETE FROM node_processes WHERE process_id = ?").run(processId);
  }
  updateProcessLogs(processId, logs, nowMs) {
    this.db.prepare("UPDATE node_processes SET logs_text = ?, updated_at = ? WHERE process_id = ?").run(logs, nowMs, processId);
  }
  loadProcesses(limit) {
    const rows = this.db.prepare(
      `
        SELECT process_id, status, command, cwd, started_at, completed_at, exit_code, signal,
               cancel_requested, timeout_ms, logs_text, routing_json
        FROM node_processes
        ORDER BY started_at DESC
        LIMIT ?
      `
    ).all(limit);
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
      routing: parseJsonObject(row.routing_json)
    }));
  }
  enqueueOutbox(params) {
    this.db.prepare(
      `
        INSERT OR IGNORE INTO node_outbox (delivery_id, process_id, payload_json, delivered, created_at, delivered_at)
        VALUES (?, ?, ?, 0, ?, NULL)
      `
    ).run(params.deliveryId, params.processId, JSON.stringify(params.payload), params.createdAt);
  }
  listUndelivered(limit) {
    const rows = this.db.prepare(
      `
        SELECT delivery_id, process_id, payload_json, created_at, delivered, delivered_at
        FROM node_outbox
        WHERE delivered = 0
        ORDER BY created_at ASC
        LIMIT ?
      `
    ).all(limit);
    const out = [];
    for (const row of rows) {
      let payload = null;
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
        deliveredAt: row.delivered_at ?? null
      });
    }
    return out;
  }
  countUndelivered() {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM node_outbox WHERE delivered = 0").get();
    const count = row == null ? void 0 : row.count;
    return typeof count === "number" && Number.isFinite(count) ? count : 0;
  }
  createFirewallSession(params) {
    const expiresAt = params.nowMs + Math.max(1e3, params.ttlMs);
    this.db.prepare(
      `
        INSERT INTO node_firewall_sessions (
          session_id, quarantine_state, created_at, last_used_at, expires_at, metadata_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      params.sessionId,
      params.quarantineState,
      params.nowMs,
      params.nowMs,
      expiresAt,
      params.metadata ? JSON.stringify(params.metadata) : null,
      params.nowMs
    );
    return {
      sessionId: params.sessionId,
      quarantineState: params.quarantineState,
      createdAt: params.nowMs,
      lastUsedAt: params.nowMs,
      expiresAt,
      metadata: params.metadata ?? null
    };
  }
  getFirewallSession(sessionId, nowMs) {
    const row = this.db.prepare(
      `
        SELECT session_id, quarantine_state, created_at, last_used_at, expires_at, metadata_json
        FROM node_firewall_sessions
        WHERE session_id = ?
      `
    ).get(sessionId);
    if (!(row == null ? void 0 : row.session_id)) return null;
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
      metadata: parseJsonObject(row.metadata_json)
    };
  }
  touchFirewallSession(sessionId, nowMs, ttlMs) {
    const expiresAt = nowMs + Math.max(1e3, ttlMs);
    this.db.prepare(
      `
        UPDATE node_firewall_sessions
        SET last_used_at = ?, expires_at = ?, updated_at = ?
        WHERE session_id = ?
      `
    ).run(nowMs, expiresAt, nowMs, sessionId);
    return this.getFirewallSession(sessionId, nowMs);
  }
  pruneExpiredFirewallSessions(nowMs) {
    const result = this.db.prepare("DELETE FROM node_firewall_sessions WHERE expires_at <= ?").run(nowMs);
    return Number(result.changes ?? 0);
  }
  appendAuditEvent(params) {
    var _a;
    const eventId = ((_a = params.eventId) == null ? void 0 : _a.trim()) || `aud_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const type = params.type.trim();
    this.db.prepare(
      `
        INSERT INTO node_audit_events (
          event_id, created_at, type, process_id, firewall_session, actor, tool_name, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      eventId,
      params.createdAt,
      type,
      params.processId ?? null,
      params.firewallSession ?? null,
      params.actor ?? null,
      params.toolName ?? null,
      params.details ? JSON.stringify(params.details) : null
    );
    return {
      eventId,
      createdAt: params.createdAt,
      type,
      processId: params.processId ?? null,
      firewallSession: params.firewallSession ?? null,
      actor: params.actor ?? null,
      toolName: params.toolName ?? null,
      details: params.details ?? null
    };
  }
  queryAuditEvents(params) {
    var _a;
    const limit = Math.max(1, Math.min(500, Math.floor(params.limit)));
    const where = [];
    const bind = [];
    const cursorCreatedAt = typeof params.cursorCreatedAt === "number" && Number.isFinite(params.cursorCreatedAt) ? Math.floor(params.cursorCreatedAt) : null;
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
    const rows = this.db.prepare(sql).all(...bind, limit + 1);
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
      details: parseJsonObject(row.details_json)
    }));
    return {
      events,
      nextCursorCreatedAt: hasMore ? ((_a = events[events.length - 1]) == null ? void 0 : _a.createdAt) ?? null : null
    };
  }
  createReference(params) {
    var _a;
    const sourceType = params.sourceType.trim();
    const refId = ((_a = params.refId) == null ? void 0 : _a.trim()) || `ref_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const safeSummary = params.safeSummary;
    this.db.prepare(
      `
        INSERT INTO node_references (
          ref_id, source_type, process_id, tool_name, title, safe_summary, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      refId,
      sourceType,
      params.processId ?? null,
      params.toolName ?? null,
      params.title ?? null,
      safeSummary,
      params.metadata ? JSON.stringify(params.metadata) : null,
      params.nowMs,
      params.nowMs
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
      updatedAt: params.nowMs
    };
  }
  listReferencesByProcessId(processId, limit) {
    const rows = this.db.prepare(
      `
        SELECT ref_id, source_type, process_id, tool_name, title, safe_summary, metadata_json, created_at, updated_at
        FROM node_references
        WHERE process_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `
    ).all(processId, Math.max(1, Math.min(200, Math.floor(limit))));
    return rows.map((row) => ({
      refId: row.ref_id,
      sourceType: row.source_type,
      processId: row.process_id ?? null,
      toolName: row.tool_name ?? null,
      title: row.title ?? null,
      safeSummary: row.safe_summary,
      metadata: parseJsonObject(row.metadata_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }
  markOutboxDelivered(deliveryId, nowMs) {
    const result = this.db.prepare(
      `
        UPDATE node_outbox
        SET delivered = 1, delivered_at = ?
        WHERE delivery_id = ? AND delivered = 0
      `
    ).run(nowMs, deliveryId);
    if (Number(result.changes ?? 0) > 0) return true;
    const existing = this.db.prepare("SELECT delivery_id FROM node_outbox WHERE delivery_id = ?").get(deliveryId);
    return Boolean(existing == null ? void 0 : existing.delivery_id);
  }
  pruneDeliveredOlderThan(cutoffMs) {
    const result = this.db.prepare("DELETE FROM node_outbox WHERE delivered = 1 AND delivered_at IS NOT NULL AND delivered_at < ?").run(cutoffMs);
    return Number(result.changes ?? 0);
  }
  parseStatus(value) {
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
  parseQuarantineState(value) {
    switch (value) {
      case "none":
      case "soft":
      case "hard":
        return value;
      default:
        return "none";
    }
  }
};
export {
  ReferenceNodeStateStore
};
//# sourceMappingURL=state-store-ECHOI3MP.mjs.map