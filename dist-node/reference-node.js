#!/usr/bin/env tsx
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/mcp/stdio-client.ts
var stdio_client_exports = {};
__export(stdio_client_exports, {
  McpStdioClient: () => McpStdioClient
});
import { spawn } from "node:child_process";
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var McpStdioClient;
var init_stdio_client = __esm({
  "src/mcp/stdio-client.ts"() {
    "use strict";
    McpStdioClient = class {
      constructor(config) {
        this.config = config;
      }
      child = null;
      nextId = 1;
      pending = /* @__PURE__ */ new Map();
      stdoutBuffer = "";
      initialized = false;
      async initialize() {
        await this.ensureStarted();
        const result = await this.request("initialize", {
          protocolVersion: "2025-11-05",
          capabilities: {},
          clientInfo: { name: "nexus", version: "0.0.1" }
        });
        await this.notify("notifications/initialized", {});
        this.initialized = true;
        return result;
      }
      async listTools() {
        if (!this.initialized) {
          await this.initialize();
        }
        const tools = [];
        let cursor;
        for (let i = 0; i < 50; i += 1) {
          const params = cursor ? { cursor } : {};
          const result = await this.request("tools/list", params);
          if (Array.isArray(result.tools)) {
            for (const tool of result.tools) {
              if (!tool || typeof tool !== "object" || typeof tool.name !== "string") continue;
              tools.push({
                name: tool.name,
                description: typeof tool.description === "string" ? tool.description : void 0,
                inputSchema: isJsonObject(tool.inputSchema) ? tool.inputSchema : void 0
              });
            }
          }
          if (!result.nextCursor) break;
          cursor = result.nextCursor;
        }
        return tools;
      }
      async callTool(name, args) {
        if (!this.initialized) {
          await this.initialize();
        }
        const result = await this.request("tools/call", {
          name,
          arguments: args ?? {}
        });
        return result ?? {};
      }
      async listResources(cursor) {
        if (!this.initialized) {
          await this.initialize();
        }
        const params = cursor ? { cursor } : {};
        const result = await this.request("resources/list", params);
        const resources = Array.isArray(result.resources) ? result.resources.filter((item) => {
          return !!item && typeof item === "object" && typeof item.uri === "string";
        }) : [];
        return {
          resources,
          ...typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}
        };
      }
      async readResource(uri) {
        if (!this.initialized) {
          await this.initialize();
        }
        const result = await this.request("resources/read", { uri });
        return result ?? {};
      }
      async close() {
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`MCP process closed before response id=${id}`));
          this.pending.delete(id);
        }
        this.initialized = false;
        const child = this.child;
        this.child = null;
        if (!child) return;
        child.stdout.removeAllListeners();
        child.stderr.removeAllListeners();
        child.removeAllListeners();
        if (!child.killed) {
          child.kill("SIGTERM");
        }
      }
      async ensureStarted() {
        if (this.child) return;
        const child = spawn(this.config.command, this.config.args ?? [], {
          env: { ...process.env, ...this.config.env ?? {} },
          stdio: "pipe"
        });
        this.child = child;
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => this.handleStdoutChunk(chunk));
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          var _a, _b;
          const line = chunk.trim();
          if (line) (_b = (_a = this.config).log) == null ? void 0 : _b.call(_a, `mcp stderr: ${line}`);
        });
        child.on("exit", (code, signal) => {
          var _a, _b;
          const reason = `MCP process exited code=${code ?? "null"} signal=${signal ?? "null"}`;
          (_b = (_a = this.config).log) == null ? void 0 : _b.call(_a, reason);
          for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error(reason));
          }
          this.pending.clear();
          this.child = null;
          this.initialized = false;
        });
        child.on("error", (err) => {
          var _a, _b;
          (_b = (_a = this.config).log) == null ? void 0 : _b.call(_a, `mcp process error: ${err.message}`);
        });
      }
      async notify(method, params) {
        const child = this.child;
        if (!child) throw new Error("MCP process not started");
        const payload = JSON.stringify({
          jsonrpc: "2.0",
          method,
          params
        });
        await this.writeLine(`${payload}
`);
      }
      async request(method, params) {
        const child = this.child;
        if (!child) throw new Error("MCP process not started");
        const id = this.nextId++;
        const payload = {
          jsonrpc: "2.0",
          id,
          method,
          params
        };
        const timeoutMs = this.config.timeoutMs;
        const responsePromise = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`MCP request timed out method=${method} after ${timeoutMs}ms`));
          }, timeoutMs);
          this.pending.set(id, { resolve, reject, timer });
        });
        await this.writeLine(`${JSON.stringify(payload)}
`);
        return responsePromise;
      }
      async writeLine(line) {
        const child = this.child;
        if (!child) throw new Error("MCP process not started");
        await new Promise((resolve, reject) => {
          child.stdin.write(line, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
      handleStdoutChunk(chunk) {
        this.stdoutBuffer += chunk;
        for (; ; ) {
          const newline = this.stdoutBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = this.stdoutBuffer.slice(0, newline).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
          if (!line) continue;
          this.handleLine(line);
        }
      }
      handleLine(line) {
        var _a, _b;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          (_b = (_a = this.config).log) == null ? void 0 : _b.call(_a, `mcp stdout(non-json): ${line}`);
          return;
        }
        if (!parsed || typeof parsed !== "object") return;
        const msg = parsed;
        if (typeof msg.id !== "number") {
          return;
        }
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || `MCP request failed id=${msg.id}`));
          return;
        }
        pending.resolve(msg.result);
      }
    };
  }
});

// examples/nexus-node/state-store-json.ts
var state_store_json_exports = {};
__export(state_store_json_exports, {
  ReferenceNodeJsonStateStore: () => ReferenceNodeJsonStateStore
});
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}
function readJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  const payload = `${JSON.stringify(value, null, 2)}
`;
  let fd = null;
  try {
    fd = fs.openSync(tempPath, "w", 384);
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
  fs.renameSync(tempPath, filePath);
}
function listJsonFiles(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => path.join(dirPath, entry.name));
  } catch {
    return [];
  }
}
var ReferenceNodeJsonStateStore;
var init_state_store_json = __esm({
  "examples/nexus-node/state-store-json.ts"() {
    "use strict";
    ReferenceNodeJsonStateStore = class _ReferenceNodeJsonStateStore {
      constructor(rootDir) {
        this.rootDir = rootDir;
        this.statePath = rootDir;
      }
      backend = "json";
      statePath;
      static async open(stateDir) {
        const rootDir = path.join(stateDir, "state-json");
        for (const child of ["processes", "outbox", "firewall-sessions", "audit-events", "references"]) {
          fs.mkdirSync(path.join(rootDir, child), { recursive: true });
        }
        return new _ReferenceNodeJsonStateStore(rootDir);
      }
      close() {
      }
      upsertProcess(process3, nowMs) {
        const filePath = this.processPath(process3.processId);
        writeJsonAtomic(filePath, {
          ...process3,
          routing: process3.routing ?? null,
          updatedAt: nowMs
        });
      }
      removeProcess(processId) {
        try {
          fs.rmSync(this.processPath(processId), { force: true });
        } catch {
        }
        for (const outboxPath of listJsonFiles(this.outboxDir())) {
          const entry = readJsonFile(outboxPath);
          if (!entry || entry.processId !== processId) continue;
          try {
            fs.rmSync(outboxPath, { force: true });
          } catch {
          }
        }
      }
      updateProcessLogs(processId, logs, nowMs) {
        const filePath = this.processPath(processId);
        const current = readJsonFile(filePath);
        if (!current) return;
        writeJsonAtomic(filePath, {
          ...current,
          logs,
          updatedAt: nowMs
        });
      }
      loadProcesses(limit) {
        const processes = listJsonFiles(this.processesDir()).map((filePath) => readJsonFile(filePath)).filter((row) => Boolean(row == null ? void 0 : row.processId)).sort((a, b) => b.startedAt - a.startedAt).slice(0, Math.max(1, Math.floor(limit)));
        return processes.map((row) => ({
          processId: row.processId,
          status: this.parseStatus(row.status),
          command: row.command,
          cwd: row.cwd ?? null,
          startedAt: row.startedAt,
          endedAt: row.endedAt ?? null,
          exitCode: row.exitCode ?? null,
          signal: row.signal ?? null,
          cancelRequested: Boolean(row.cancelRequested),
          timeoutMs: row.timeoutMs ?? null,
          logs: typeof row.logs === "string" ? row.logs : "",
          routing: row.routing ? asObject(row.routing) : null
        }));
      }
      enqueueOutbox(params) {
        const filePath = this.outboxPath(params.deliveryId);
        if (fs.existsSync(filePath)) return;
        writeJsonAtomic(filePath, {
          deliveryId: params.deliveryId,
          processId: params.processId,
          payload: params.payload,
          createdAt: params.createdAt,
          delivered: false,
          deliveredAt: null
        });
      }
      listUndelivered(limit) {
        return listJsonFiles(this.outboxDir()).map((filePath) => readJsonFile(filePath)).filter((row) => Boolean(row == null ? void 0 : row.deliveryId)).filter((row) => !row.delivered).sort((a, b) => a.createdAt - b.createdAt).slice(0, Math.max(1, Math.floor(limit))).map((row) => ({
          deliveryId: row.deliveryId,
          processId: row.processId,
          payload: asObject(row.payload),
          createdAt: row.createdAt,
          delivered: Boolean(row.delivered),
          deliveredAt: row.deliveredAt ?? null
        }));
      }
      countUndelivered() {
        let count = 0;
        for (const outboxPath of listJsonFiles(this.outboxDir())) {
          const row = readJsonFile(outboxPath);
          if (!row || row.delivered) continue;
          count += 1;
        }
        return count;
      }
      createFirewallSession(params) {
        const expiresAt = params.nowMs + Math.max(1e3, params.ttlMs);
        const record = {
          sessionId: params.sessionId,
          quarantineState: params.quarantineState,
          createdAt: params.nowMs,
          lastUsedAt: params.nowMs,
          expiresAt,
          metadata: params.metadata ?? null
        };
        writeJsonAtomic(this.firewallSessionPath(params.sessionId), record);
        return record;
      }
      getFirewallSession(sessionId, nowMs) {
        const filePath = this.firewallSessionPath(sessionId);
        const record = readJsonFile(filePath);
        if (!(record == null ? void 0 : record.sessionId)) return null;
        if (record.expiresAt <= nowMs) {
          try {
            fs.rmSync(filePath, { force: true });
          } catch {
          }
          return null;
        }
        return {
          sessionId: record.sessionId,
          quarantineState: this.parseQuarantineState(record.quarantineState),
          createdAt: record.createdAt,
          lastUsedAt: record.lastUsedAt,
          expiresAt: record.expiresAt,
          metadata: record.metadata ? asObject(record.metadata) : null
        };
      }
      touchFirewallSession(sessionId, nowMs, ttlMs) {
        const current = this.getFirewallSession(sessionId, nowMs);
        if (!current) return null;
        const updated = {
          ...current,
          lastUsedAt: nowMs,
          expiresAt: nowMs + Math.max(1e3, ttlMs)
        };
        writeJsonAtomic(this.firewallSessionPath(sessionId), updated);
        return updated;
      }
      pruneExpiredFirewallSessions(nowMs) {
        let removed = 0;
        for (const filePath of listJsonFiles(this.firewallSessionsDir())) {
          const record = readJsonFile(filePath);
          if (!record || record.expiresAt > nowMs) continue;
          try {
            fs.rmSync(filePath, { force: true });
            removed += 1;
          } catch {
          }
        }
        return removed;
      }
      appendAuditEvent(params) {
        var _a;
        const eventId = ((_a = params.eventId) == null ? void 0 : _a.trim()) || `aud_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
        const record = {
          eventId,
          createdAt: params.createdAt,
          type: params.type.trim(),
          processId: params.processId ?? null,
          firewallSession: params.firewallSession ?? null,
          actor: params.actor ?? null,
          toolName: params.toolName ?? null,
          details: params.details ?? null
        };
        writeJsonAtomic(this.auditEventPath(eventId), record);
        return record;
      }
      queryAuditEvents(params) {
        var _a;
        const limit = Math.max(1, Math.min(500, Math.floor(params.limit)));
        const cursorCreatedAt = typeof params.cursorCreatedAt === "number" && Number.isFinite(params.cursorCreatedAt) ? Math.floor(params.cursorCreatedAt) : null;
        const events = listJsonFiles(this.auditEventsDir()).map((filePath) => readJsonFile(filePath)).filter((row) => Boolean(row == null ? void 0 : row.eventId)).filter((row) => {
          var _a2, _b, _c, _d;
          if (cursorCreatedAt !== null && row.createdAt >= cursorCreatedAt) return false;
          if (((_a2 = params.type) == null ? void 0 : _a2.trim()) && row.type !== params.type.trim()) return false;
          if (((_b = params.processId) == null ? void 0 : _b.trim()) && row.processId !== params.processId.trim()) return false;
          if (((_c = params.firewallSession) == null ? void 0 : _c.trim()) && row.firewallSession !== params.firewallSession.trim()) return false;
          if (((_d = params.actor) == null ? void 0 : _d.trim()) && row.actor !== params.actor.trim()) return false;
          return true;
        }).sort((a, b) => {
          if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
          return b.eventId.localeCompare(a.eventId);
        });
        const hasMore = events.length > limit;
        const trimmed = hasMore ? events.slice(0, limit) : events;
        return {
          events: trimmed,
          nextCursorCreatedAt: hasMore ? ((_a = trimmed[trimmed.length - 1]) == null ? void 0 : _a.createdAt) ?? null : null
        };
      }
      createReference(params) {
        var _a;
        const refId = ((_a = params.refId) == null ? void 0 : _a.trim()) || `ref_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
        const record = {
          refId,
          sourceType: params.sourceType.trim(),
          processId: params.processId ?? null,
          toolName: params.toolName ?? null,
          title: params.title ?? null,
          safeSummary: params.safeSummary,
          metadata: params.metadata ?? null,
          createdAt: params.nowMs,
          updatedAt: params.nowMs
        };
        writeJsonAtomic(this.referencePath(refId), record);
        return record;
      }
      listReferencesByProcessId(processId, limit) {
        return listJsonFiles(this.referencesDir()).map((filePath) => readJsonFile(filePath)).filter((row) => Boolean(row == null ? void 0 : row.refId)).filter((row) => row.processId === processId).sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(1, Math.min(200, Math.floor(limit))));
      }
      markOutboxDelivered(deliveryId, nowMs) {
        const filePath = this.outboxPath(deliveryId);
        const current = readJsonFile(filePath);
        if (!current) return false;
        if (current.delivered) return true;
        writeJsonAtomic(filePath, {
          ...current,
          delivered: true,
          deliveredAt: nowMs
        });
        return true;
      }
      pruneDeliveredOlderThan(cutoffMs) {
        let removed = 0;
        for (const filePath of listJsonFiles(this.outboxDir())) {
          const row = readJsonFile(filePath);
          if (!row || !row.delivered || row.deliveredAt === null || row.deliveredAt >= cutoffMs) continue;
          try {
            fs.rmSync(filePath, { force: true });
            removed += 1;
          } catch {
          }
        }
        return removed;
      }
      processPath(processId) {
        return path.join(this.processesDir(), `${processId}.json`);
      }
      outboxPath(deliveryId) {
        return path.join(this.outboxDir(), `${deliveryId}.json`);
      }
      firewallSessionPath(sessionId) {
        return path.join(this.firewallSessionsDir(), `${sessionId}.json`);
      }
      auditEventPath(eventId) {
        return path.join(this.auditEventsDir(), `${eventId}.json`);
      }
      referencePath(refId) {
        return path.join(this.referencesDir(), `${refId}.json`);
      }
      processesDir() {
        return path.join(this.rootDir, "processes");
      }
      outboxDir() {
        return path.join(this.rootDir, "outbox");
      }
      firewallSessionsDir() {
        return path.join(this.rootDir, "firewall-sessions");
      }
      auditEventsDir() {
        return path.join(this.rootDir, "audit-events");
      }
      referencesDir() {
        return path.join(this.rootDir, "references");
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
  }
});

// examples/nexus-node/state-store.ts
var state_store_exports = {};
__export(state_store_exports, {
  ReferenceNodeStateStore: () => ReferenceNodeStateStore
});
import fs2 from "node:fs/promises";
import path2 from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
function asObject2(value) {
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
    return asObject2(JSON.parse(raw));
  } catch {
    return null;
  }
}
var ReferenceNodeStateStore;
var init_state_store = __esm({
  "examples/nexus-node/state-store.ts"() {
    "use strict";
    ReferenceNodeStateStore = class _ReferenceNodeStateStore {
      constructor(db, dbPath) {
        this.db = db;
        this.dbPath = dbPath;
        this.statePath = dbPath;
      }
      backend = "sqlite";
      dbPath;
      statePath;
      static async open(stateDir) {
        const dbDir = path2.join(stateDir, "state");
        const dbPath = path2.join(dbDir, "reference-node.db");
        await fs2.mkdir(dbDir, { recursive: true });
        const sqliteModule = await import("better-sqlite3");
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
      upsertProcess(process3, nowMs) {
        const routing = process3.routing ?? {};
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
          process_id: process3.processId,
          status: process3.status,
          tool_name: "system.run",
          command: process3.command,
          cwd: process3.cwd,
          args_json: JSON.stringify({
            command: process3.command,
            cwd: process3.cwd,
            timeoutMs: process3.timeoutMs
          }),
          run_id: runId,
          parent_run_id: parentRunId,
          session_id: sessionId,
          channel,
          channel_key: channelKey,
          firewall_session: firewallSession,
          started_at: process3.startedAt,
          completed_at: process3.endedAt,
          exit_code: process3.exitCode,
          signal: process3.signal,
          cancel_requested: process3.cancelRequested ? 1 : 0,
          timeout_ms: process3.timeoutMs,
          logs_text: process3.logs,
          summary_json: null,
          routing_json: process3.routing ? JSON.stringify(process3.routing) : null,
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
            payload = asObject2(JSON.parse(row.payload_json));
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
        const eventId = ((_a = params.eventId) == null ? void 0 : _a.trim()) || `aud_${randomUUID2().replace(/-/g, "").slice(0, 20)}`;
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
        const refId = ((_a = params.refId) == null ? void 0 : _a.trim()) || `ref_${randomUUID2().replace(/-/g, "").slice(0, 20)}`;
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
  }
});

// examples/nexus-node/reference-node.ts
import { exec, execFile, spawn as spawnChild } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID as randomUUID3,
  sign,
  verify
} from "node:crypto";
import fs3 from "node:fs/promises";
import fsSync from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path3 from "node:path";
import process2 from "node:process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
var ED25519_SPKI_RAW_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
var MAX_OUTPUT_CHARS = 6e4;
var MAX_PROCESS_LOG_CHARS = 12e4;
var DELIVERED_OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var FIREWALL_SESSION_TTL_MS = 24 * 60 * 60 * 1e3;
var MCP_BRIDGE_CONFIG_FILE = "mcp-bridge.json";
var POLICYCTL_COMMAND = "nexus-policyctl";
var SHELLCTL_COMMAND = "nexus-shellctl";
var FILE_PULL_COMMAND = "file_pull";
var FILE_PUSH_COMMAND = "file_push";
var POLICY_PRESET_DIRNAME = "policy-presets";
var SHELLCTL_ROOT_DIRNAME = "interactive-shell";
var SHELLCTL_SESSION_DIRNAME = "sessions";
var SHELLCTL_LOG_DIRNAME = "logs";
var SHELLCTL_POLL_INTERVAL_MS = 60;
var SHELLCTL_MAX_WAIT_MS = 5e3;
var SHELLCTL_MAX_IDLE_MS = 1e3;
var SHELLCTL_MAX_CHARS = 12e3;
var SHELLCTL_MAX_READ_BYTES = 128e3;
var SHELLCTL_SESSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
var POLICY_ALLOWED_FIELDS = /* @__PURE__ */ new Set(["version", "label", "defaultQuarantine", "firewallMode", "denyCommands", "updatedAt"]);
var DEFAULT_FILE_TRANSFER_MAX_BYTES = 5 * 1024 * 1024;
var DEFAULT_CAPABILITIES = [
  "system.run",
  "system.which",
  "process.start",
  "process.status",
  "process.logs",
  "process.cancel",
  "symbols.list",
  "audit.query"
];
var DEFAULT_ALLOW_COMMANDS = ["echo", "uname", "whoami", "pwd", "date"];
var DEFAULT_POLICY_DOC = {
  version: 1,
  defaultQuarantine: "none",
  firewallMode: "transparent",
  denyCommands: []
};
var SYMBOL_TOKEN_PATTERN = /\{\{([a-z]+):([a-zA-Z0-9._-]+)(?::([a-zA-Z0-9._-]+))?\}\}/g;
var SYMBOL_KINDS = ["contact", "account", "secret", "user"];
var NodeToolError = class extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.name = "NodeToolError";
  }
};
async function runReferenceNode(argv = process2.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }
  const envFilePath = args.values["env-file"] ?? process2.env.NEXUS_NODE_ENV_FILE;
  if (envFilePath) {
    await loadEnvFileIntoProcessEnv(path3.resolve(envFilePath));
  }
  const config = buildConfig(args.values, options);
  const logger = await ReferenceNodeLogger.create(config);
  if (isTruthyFlag(args.values.init)) {
    await initializeNodeBootstrap(config, logger);
    if (!isTruthyFlag(args.values["run-after-init"])) {
      logger.info("init complete; exiting (use --run-after-init to continue startup)");
      return;
    }
  }
  if (isTruthyFlag(args.values.doctor)) {
    const doctor = await runDoctorChecks(config, logger);
    if (!doctor.ok) {
      throw new Error("Doctor checks failed. Resolve the reported errors before starting the node.");
    }
    if (!isTruthyFlag(args.values["doctor-continue"])) {
      logger.info("doctor checks passed; exiting (use --doctor-continue to continue startup)");
      return;
    }
  }
  const identity = await loadOrCreateIdentity(config.stateDir);
  const stateStore = await openStateStore(config.stateDir, config.stateBackend);
  const client = new ReferenceNodeClient(config, identity, stateStore, logger);
  logger.info(`id=${config.nodeId} fingerprint=${identity.fingerprint} gateway=${config.gatewayUrl}`);
  logger.info(`capabilities=${config.capabilities.join(",")} allow_commands=${[...config.allowCommands].join(",")}`);
  logger.info(`state_backend=${stateStore.backend} state_path=${stateStore.statePath}`);
  logger.info(`mcp_bridge=${config.mcpBridgeEnabled ? "enabled" : "disabled"} mcp_config=${config.mcpBridgeConfigPath}`);
  logger.info(
    `local_webhook=${config.webhookEnabled ? `enabled http://${config.webhookHost}:${config.webhookPort}${config.webhookPath}` : "disabled"} auth=${config.webhookToken ? "token" : "none"}`
  );
  const fileTransferOps = [];
  if (isAllowedCommand(FILE_PULL_COMMAND, config.allowCommands)) fileTransferOps.push("pull");
  if (isAllowedCommand(FILE_PUSH_COMMAND, config.allowCommands)) fileTransferOps.push("push");
  logger.info(
    `file_transfer=${fileTransferOps.join(",") || "disabled"} roots=${config.fileTransferRoots.join(",")} max_bytes=${config.fileTransferMaxBytes}`
  );
  const shutdown = () => {
    client.stop("shutdown");
  };
  process2.on("SIGINT", shutdown);
  process2.on("SIGTERM", shutdown);
  await client.start();
}
var ReferenceNodeClient = class {
  constructor(config, identity, stateStore, logger) {
    this.config = config;
    this.identity = identity;
    this.stateStore = stateStore;
    this.logger = logger;
    this.policyPath = path3.join(this.config.stateDir, "hermes-policy.json");
    this.policyPresetDir = path3.join(this.config.stateDir, POLICY_PRESET_DIRNAME);
    this.symbolStoreDir = path3.join(this.config.stateDir, "hermes-stores");
    this.mcpBridgeConfigPath = this.config.mcpBridgeConfigPath;
  }
  ws = null;
  webhookServer = null;
  stopped = false;
  reconnectTimer = null;
  reconnectAttempt = 0;
  processes = /* @__PURE__ */ new Map();
  drainingOutbox = false;
  gatewayPublicKey = null;
  gatewayFingerprint = null;
  nodeNonce = null;
  gatewayNonce = null;
  sessionId = null;
  ready = false;
  policy = { ...DEFAULT_POLICY_DOC };
  policyLoadedAtMs = null;
  policyDigest = null;
  policyPath;
  policyPresetDir;
  symbolStoreDir;
  mcpBridgeConfigPath;
  mcpBridgeServers = /* @__PURE__ */ new Map();
  mcpBridgeClients = /* @__PURE__ */ new Map();
  mcpBridgeClientCtorPromise = null;
  async start() {
    await this.loadPolicyFromDisk();
    await this.loadMcpBridgeConfig();
    this.bootstrapPersistedState();
    await this.startWebhookServer();
    this.connect();
  }
  stop(reason) {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.close(1e3, truncateOutput(reason, 120));
      } catch {
      }
    }
    void this.stopWebhookServer().catch(() => void 0);
    this.terminateAllProcesses(reason);
    void this.closeMcpBridgeClients().catch(() => void 0);
    this.stateStore.close();
  }
  async startWebhookServer() {
    if (!this.config.webhookEnabled || this.webhookServer) return;
    const server = createServer((req, res) => {
      void this.handleWebhookHttpRequest(req, res).catch((err) => {
        this.log(`local webhook handler error=${err instanceof Error ? err.message : String(err)}`);
        this.sendWebhookJson(res, 500, { error: "internal server error" });
      });
    });
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.config.webhookPort, this.config.webhookHost);
    });
    server.on("error", (err) => {
      this.log(`local webhook server error=${err instanceof Error ? err.message : String(err)}`);
    });
    this.webhookServer = server;
    this.log(
      `local webhook listening host=${this.config.webhookHost} port=${this.config.webhookPort} path=${this.config.webhookPath}`
    );
  }
  async stopWebhookServer() {
    const server = this.webhookServer;
    if (!server) return;
    this.webhookServer = null;
    await new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
  async handleWebhookHttpRequest(req, res) {
    let pathname = "/";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      this.sendWebhookJson(res, 400, { error: "invalid request url" });
      return;
    }
    if (pathname !== this.config.webhookPath) {
      this.sendWebhookJson(res, 404, { error: "not found" });
      return;
    }
    if ((req.method ?? "GET").toUpperCase() !== "POST") {
      this.sendWebhookJson(res, 405, { error: "method not allowed" });
      return;
    }
    if (this.config.webhookToken) {
      const suppliedToken = this.readWebhookAuthToken(req);
      if (suppliedToken !== this.config.webhookToken) {
        this.sendWebhookJson(res, 401, { error: "invalid webhook token" });
        return;
      }
    }
    const body = await this.readRequestBodyTextLimited(req, this.config.webhookMaxBodyBytes);
    if (!body.ok) {
      this.sendWebhookJson(res, body.status, { error: body.error });
      return;
    }
    let parsed = {};
    if (body.text.trim().length > 0) {
      try {
        parsed = asObject3(JSON.parse(body.text));
      } catch {
        this.sendWebhookJson(res, 400, { error: "invalid JSON body" });
        return;
      }
    }
    const destination = asObject3(parsed.destination);
    const endpointId = asString(destination.endpointId) ?? asString(parsed.endpointId);
    if (!endpointId) {
      this.sendWebhookJson(res, 400, { error: "endpointId or destination.endpointId is required" });
      return;
    }
    const eventId = asString(parsed.eventId) ?? randomUUID3();
    const traceId = asString(parsed.traceId) ?? eventId;
    const kind = asString(parsed.kind) ?? asString(parsed.eventType) ?? "node.webhook.received";
    const ts = asNumber(parsed.ts) ?? Date.now();
    const idempotencyKey = asString(parsed.idempotencyKey) ?? eventId;
    const sensitivity = asString(parsed.sensitivity) ?? "internal";
    const payload = asObject3(parsed.payload);
    const meta = asObject3(parsed.meta);
    if (!this.ready || !this.requireOpenSocket()) {
      this.sendWebhookJson(res, 503, { error: "gateway websocket is not connected" });
      return;
    }
    const sent = this.sendSignedEnvelope({
      type: "event",
      event: "webhook.deliver",
      payload: {
        schemaVersion: "1.0",
        eventId,
        traceId,
        kind,
        destination: {
          endpointId,
          peerId: asString(destination.peerId) ?? null
        },
        ts,
        idempotencyKey,
        sensitivity,
        payload,
        meta: {
          attempt: 1,
          maxAttempts: 1,
          orderingKey: asString(meta.orderingKey) ?? `node:${this.config.nodeId}:${kind}`
        }
      }
    });
    if (!sent) {
      this.sendWebhookJson(res, 503, { error: "failed to publish webhook event to gateway" });
      return;
    }
    this.sendWebhookJson(res, 202, {
      ok: true,
      eventId,
      traceId,
      kind,
      endpointId,
      queuedAt: Date.now()
    });
  }
  readWebhookAuthToken(req) {
    const header = req.headers.authorization;
    if (typeof header === "string") {
      const match = header.match(/^Bearer\s+(.+)$/i);
      if (match == null ? void 0 : match[1]) {
        const token = match[1].trim();
        if (token) return token;
      }
    }
    const tokenHeader = req.headers["x-nexus-node-webhook-token"];
    if (typeof tokenHeader === "string") {
      const token = tokenHeader.trim();
      if (token) return token;
    }
    if (Array.isArray(tokenHeader)) {
      for (const value of tokenHeader) {
        const token = String(value ?? "").trim();
        if (token) return token;
      }
    }
    return null;
  }
  async readRequestBodyTextLimited(req, maxBytes) {
    const contentLengthRaw = req.headers["content-length"];
    const contentLengthHeader = Array.isArray(contentLengthRaw) ? contentLengthRaw[0] : contentLengthRaw;
    if (contentLengthHeader) {
      const declaredBytes = Number(contentLengthHeader);
      if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
        return {
          ok: false,
          status: 413,
          error: `request body exceeds max size (${maxBytes} bytes)`
        };
      }
    }
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
        total += buffer.byteLength;
        if (total > maxBytes) {
          return {
            ok: false,
            status: 413,
            error: `request body exceeds max size (${maxBytes} bytes)`
          };
        }
        chunks.push(buffer);
      }
    } catch {
      return {
        ok: false,
        status: 400,
        error: "failed to read request body"
      };
    }
    const text = chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "";
    return { ok: true, text };
  }
  sendWebhookJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("content-length", Buffer.byteLength(body));
    try {
      res.end(body);
    } catch {
      try {
        res.end();
      } catch {
      }
    }
  }
  connect() {
    if (this.stopped) return;
    const needsTlsPin = Boolean(this.config.gatewayTlsFingerprint);
    let tlsPinVerified = !needsTlsPin;
    const ws = needsTlsPin ? new WebSocket(this.config.gatewayUrl, { rejectUnauthorized: false }) : new WebSocket(this.config.gatewayUrl);
    this.ws = ws;
    this.ready = false;
    this.nodeNonce = null;
    this.gatewayNonce = null;
    this.sessionId = null;
    this.gatewayPublicKey = null;
    this.gatewayFingerprint = null;
    ws.on("upgrade", (response) => {
      var _a;
      if (!this.config.gatewayTlsFingerprint) return;
      const socket = response.socket;
      const certificate = (_a = socket.getPeerCertificate) == null ? void 0 : _a.call(socket, true);
      const actual = normalizeFingerprint256((certificate == null ? void 0 : certificate.fingerprint256) ?? (certificate == null ? void 0 : certificate.fingerprint) ?? "");
      if (!actual || actual !== this.config.gatewayTlsFingerprint) {
        this.log(
          `gateway TLS fingerprint mismatch expected=${this.config.gatewayTlsFingerprint} actual=${actual ?? "unknown"}`
        );
        this.closeSocket(4001, "gateway tls fingerprint mismatch");
        return;
      }
      tlsPinVerified = true;
    });
    ws.on("open", () => {
      this.reconnectAttempt = 0;
      if (needsTlsPin && !tlsPinVerified) {
        this.log("gateway TLS fingerprint was not validated before websocket open");
        this.closeSocket(4001, "gateway tls fingerprint missing");
        return;
      }
      this.sendConnectHello();
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.log("received binary frame; closing");
        this.closeSocket(4001, "binary frames unsupported");
        return;
      }
      const text = typeof data === "string" ? data : data.toString("utf8");
      this.handleMessage(text).catch((err) => {
        this.log(`message handling error=${err instanceof Error ? err.message : String(err)}`);
        this.closeSocket(4001, "message handling failed");
      });
    });
    ws.on("error", (err) => {
      this.log(`socket error=${err instanceof Error ? err.message : String(err)}`);
    });
    ws.on("close", (code, reasonRaw) => {
      const reason = String(reasonRaw || "");
      this.log(`socket closed code=${code} reason=${reason || "<none>"}`);
      this.ready = false;
      if (this.stopped) return;
      this.scheduleReconnect();
    });
  }
  scheduleReconnect() {
    if (this.stopped) return;
    this.reconnectAttempt += 1;
    const base = this.config.reconnectMinMs;
    const delay = Math.min(
      this.config.reconnectMaxMs,
      Math.max(this.config.reconnectMinMs, base * Math.pow(2, Math.min(8, this.reconnectAttempt - 1)))
    );
    this.log(`reconnect attempt=${this.reconnectAttempt} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
  bootstrapPersistedState() {
    this.stateStore.pruneDeliveredOlderThan(Date.now() - DELIVERED_OUTBOX_TTL_MS);
    const prunedFirewallSessions = this.stateStore.pruneExpiredFirewallSessions(Date.now());
    const persisted = this.stateStore.loadProcesses(1e3);
    const nowMs = Date.now();
    for (const record of persisted) {
      const entry = {
        processId: record.processId,
        command: record.command,
        cwd: record.cwd,
        status: record.status,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        exitCode: record.exitCode,
        signal: record.signal,
        cancelRequested: record.cancelRequested,
        timeoutMs: record.timeoutMs,
        logs: record.logs,
        child: null,
        timeoutTimer: null,
        killTimer: null,
        firewallMode: this.readProcessFirewallMode(record.routing),
        hermesReferences: this.readProcessHermesReferences(record.routing),
        routing: record.routing
      };
      this.processes.set(entry.processId, entry);
      if (entry.status === "queued" || entry.status === "running") {
        entry.status = "failed";
        entry.cancelRequested = true;
        entry.endedAt = nowMs;
        entry.exitCode = entry.exitCode ?? 1;
        entry.signal = entry.signal ?? "NODE_RESTART";
        entry.logs = truncateOutput(`${entry.logs}
process recovered after node restart before completion
`, MAX_PROCESS_LOG_CHARS);
        if (entry.firewallMode !== "transparent") {
          const recoveredReference = this.createHermesReference({
            sourceType: "process.output",
            processId: entry.processId,
            toolName: "system.run",
            title: "process recovered after restart",
            safeSummary: this.buildSafeSummary(entry.logs),
            metadata: {
              mode: entry.firewallMode,
              status: entry.status,
              exitCode: entry.exitCode,
              signal: entry.signal
            }
          });
          entry.hermesReferences = [recoveredReference];
          const routing = asObject3(entry.routing ?? {});
          entry.routing = {
            ...routing,
            firewallMode: entry.firewallMode,
            hermesReferences: entry.hermesReferences
          };
        }
        this.persistProcess(entry);
        this.queueTerminalProcessUpdate(entry, "recovered_after_restart");
      }
    }
    const pendingOutbox = this.stateStore.countUndelivered();
    this.log(
      `restored processes=${persisted.length} outbox_pending=${pendingOutbox} firewall_sessions_pruned=${prunedFirewallSessions}`
    );
  }
  async loadPolicyFromDisk() {
    const nowMs = Date.now();
    try {
      const raw = await fs3.readFile(this.policyPath, "utf8");
      const parsed = asObject3(JSON.parse(raw));
      this.policy = this.normalizePolicyDocument(parsed, nowMs);
      const stat = await fs3.stat(this.policyPath);
      this.policyLoadedAtMs = stat.mtimeMs;
      this.policyDigest = this.policyDocDigest(this.policy);
      this.log(
        `loaded hermes policy path=${this.policyPath} firewall_mode=${this.currentPolicyFirewallMode()} default_quarantine=${this.currentPolicyDefaultQuarantine()}`
      );
      return;
    } catch (err) {
      const code = err == null ? void 0 : err.code;
      const missing = code === "ENOENT";
      if (!missing && this.config.policyRequired) {
        throw new Error(
          `Failed to load required Hermes policy at ${this.policyPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (!missing) {
        this.log(
          `policy load failed path=${this.policyPath} error=${err instanceof Error ? err.message : String(err)}; using default policy`
        );
      } else if (this.config.policyRequired) {
        throw new Error(`Required Hermes policy missing at ${this.policyPath}`);
      } else {
        this.log(`policy file missing path=${this.policyPath}; creating default policy`);
      }
    }
    this.policy = this.normalizePolicyDocument({}, nowMs);
    await this.persistPolicyToDisk(this.policy);
  }
  async loadMcpBridgeConfig() {
    this.mcpBridgeServers.clear();
    if (!this.config.mcpBridgeEnabled) return;
    const resolved = path3.resolve(this.mcpBridgeConfigPath);
    await fs3.mkdir(path3.dirname(resolved), { recursive: true });
    let rawText = "";
    try {
      rawText = await fs3.readFile(resolved, "utf8");
    } catch (err) {
      const code = err == null ? void 0 : err.code;
      if (code !== "ENOENT") {
        throw new Error(
          `Failed to read MCP bridge config at ${resolved}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      const bootstrap = {
        enabled: true,
        servers: []
      };
      await fs3.writeFile(resolved, `${JSON.stringify(bootstrap, null, 2)}
`, "utf8");
      this.log(`mcp bridge config created path=${resolved} (empty server list)`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      throw new Error(
        `Invalid MCP bridge config JSON at ${resolved}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const root = asObject3(parsed);
    const serversRaw = Array.isArray(root.servers) ? root.servers : [];
    for (const item of serversRaw) {
      const itemObj = asObject3(item);
      if (asBoolean(itemObj.enabled) === false) continue;
      const server = this.parseMcpBridgeServerConfig(item, resolved);
      if (this.mcpBridgeServers.has(server.id)) {
        throw new Error(`Duplicate MCP bridge server id '${server.id}' in ${resolved}`);
      }
      this.mcpBridgeServers.set(server.id, server);
    }
    this.log(`mcp bridge loaded servers=${this.mcpBridgeServers.size} path=${resolved}`);
  }
  parseMcpBridgeServerConfig(value, sourcePath) {
    const obj = asObject3(value);
    const id = asString(obj.id);
    const command = asString(obj.command);
    if (!id) {
      throw new Error(`MCP bridge server missing 'id' in ${sourcePath}`);
    }
    if (!command) {
      throw new Error(`MCP bridge server '${id}' missing 'command' in ${sourcePath}`);
    }
    const args = Array.isArray(obj.args) ? obj.args.filter((entry) => typeof entry === "string") : [];
    const env = asStringMap(obj.env);
    const timeoutMs = clampInt(obj.timeoutMs, 2e3, 3e5) ?? this.config.mcpBridgeTimeoutMs;
    const allowTools = normalizeMcpAllowPatterns(obj.allowTools);
    const allowResources = normalizeMcpAllowPatterns(obj.allowResources);
    return {
      id,
      label: asString(obj.label) ?? id,
      command,
      args,
      env,
      timeoutMs,
      allowTools,
      allowResources
    };
  }
  assertMcpBridgeEnabled(method) {
    if (this.config.mcpBridgeEnabled) return;
    throw new NodeToolError(
      "CAPABILITY_UNAVAILABLE",
      `Method ${method} is unavailable because MCP bridge is disabled on this node.`,
      false
    );
  }
  selectMcpBridgeServers(serverId) {
    if (serverId) {
      return [this.requireMcpBridgeServer(serverId)];
    }
    return [...this.mcpBridgeServers.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  requireMcpBridgeServer(serverId) {
    const server = this.mcpBridgeServers.get(serverId);
    if (!server) {
      throw new NodeToolError("INVALID_REQUEST", `Unknown MCP bridge server '${serverId}'.`, false);
    }
    return server;
  }
  async getMcpBridgeClient(server) {
    const existing = this.mcpBridgeClients.get(server.id);
    if (existing) return existing;
    const McpStdioClientCtor = await this.loadMcpBridgeClientCtor();
    const client = new McpStdioClientCtor({
      command: server.command,
      args: server.args,
      env: server.env,
      timeoutMs: server.timeoutMs,
      log: (line) => this.log(`mcp[${server.id}] ${line}`)
    });
    try {
      await client.initialize();
      this.mcpBridgeClients.set(server.id, client);
      return client;
    } catch (err) {
      await client.close().catch(() => void 0);
      throw err;
    }
  }
  async loadMcpBridgeClientCtor() {
    if (!this.mcpBridgeClientCtorPromise) {
      this.mcpBridgeClientCtorPromise = Promise.resolve().then(() => (init_stdio_client(), stdio_client_exports)).then((mod) => {
        if (typeof mod.McpStdioClient !== "function") {
          throw new Error("McpStdioClient export missing");
        }
        return mod.McpStdioClient;
      }).catch((err) => {
        this.mcpBridgeClientCtorPromise = null;
        throw new NodeToolError(
          "CAPABILITY_UNAVAILABLE",
          `MCP bridge runtime unavailable: ${err instanceof Error ? err.message : String(err)}`,
          false
        );
      });
    }
    return this.mcpBridgeClientCtorPromise;
  }
  allowlistedMcpName(name, allowPatterns) {
    if (!allowPatterns.length) return false;
    return allowPatterns.some((pattern) => mcpPatternMatches(name, pattern));
  }
  async closeMcpBridgeClients() {
    for (const [serverId, client] of this.mcpBridgeClients.entries()) {
      await client.close().catch((err) => {
        this.log(`mcp[${serverId}] close failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    this.mcpBridgeClients.clear();
  }
  normalizePolicyDocument(value, nowMs) {
    const defaultQuarantine = parseQuarantineState(value.defaultQuarantine, "none");
    const firewallMode = parseFirewallMode(asString(value.firewallMode), "transparent");
    const denyCommands = parsePolicyDenyCommands(value.denyCommands) ?? [];
    const updatedAt = asNumber(value.updatedAt) ?? nowMs;
    const normalized = {
      version: asNumber(value.version) ?? 1,
      defaultQuarantine,
      firewallMode,
      denyCommands,
      updatedAt
    };
    const label = asString(value.label);
    if (label) normalized.label = label;
    return normalized;
  }
  policyDocDigest(policyDoc) {
    return createHash("sha256").update(JSON.stringify(policyDoc)).digest("hex");
  }
  async refreshPolicyFromDiskIfChanged(source) {
    try {
      const stat = await fs3.stat(this.policyPath);
      if (this.policyLoadedAtMs !== null && stat.mtimeMs <= this.policyLoadedAtMs) return;
      const raw = await fs3.readFile(this.policyPath, "utf8");
      const parsed = asObject3(JSON.parse(raw));
      const nextPolicy = this.normalizePolicyDocument(parsed, Date.now());
      const nextDigest = this.policyDocDigest(nextPolicy);
      if (nextDigest === this.policyDigest) {
        this.policyLoadedAtMs = stat.mtimeMs;
        return;
      }
      const previousMode = this.currentPolicyFirewallMode();
      this.policy = nextPolicy;
      this.policyDigest = nextDigest;
      this.policyLoadedAtMs = stat.mtimeMs;
      this.log(
        `policy reload source=${source} path=${this.policyPath} firewall_mode=${this.currentPolicyFirewallMode()} default_quarantine=${this.currentPolicyDefaultQuarantine()}`
      );
      this.writeAuditEvent({
        type: "policy.reload",
        details: {
          source,
          firewallMode: this.currentPolicyFirewallMode(),
          defaultQuarantine: this.currentPolicyDefaultQuarantine(),
          denyCommands: this.currentPolicyDenyCommands(),
          policyPath: this.policyPath
        }
      });
      if (previousMode !== this.currentPolicyFirewallMode()) this.sendCapsAdvertise();
    } catch (err) {
      const code = err == null ? void 0 : err.code;
      if (code === "ENOENT" && !this.config.policyRequired) return;
      throw new NodeToolError(
        "NODE_POLICY_RELOAD_FAILED",
        `Failed to refresh Hermes policy from disk: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  currentPolicyDefaultQuarantine() {
    return parseQuarantineState(this.policy.defaultQuarantine, "none");
  }
  currentPolicyFirewallMode() {
    return parseFirewallMode(asString(this.policy.firewallMode), "transparent");
  }
  currentPolicyDenyCommands() {
    return parsePolicyDenyCommands(this.policy.denyCommands) ?? [];
  }
  advertisedCapabilities() {
    const mode = this.currentPolicyFirewallMode();
    const out = new Set(this.config.capabilities);
    if (isAllowedCommand(FILE_PULL_COMMAND, this.config.allowCommands)) out.add("file.pull");
    if (isAllowedCommand(FILE_PUSH_COMMAND, this.config.allowCommands)) out.add("file.push");
    if (this.config.mcpBridgeEnabled) {
      out.add("mcp.bridge");
      out.add("mcp.list");
      out.add("mcp.call");
      out.add("mcp.resources");
    }
    out.add("backend.nexus");
    out.add(`hermes.mode.${mode}`);
    if (mode !== "transparent") out.add("hermes.enabled");
    return [...out.values()].sort((a, b) => a.localeCompare(b));
  }
  async persistPolicyToDisk(policyDoc) {
    const dirPath = path3.dirname(this.policyPath);
    await fs3.mkdir(dirPath, { recursive: true });
    const tempPath = `${this.policyPath}.tmp-${process2.pid}-${randomUUID3().slice(0, 8)}`;
    const payload = `${JSON.stringify(policyDoc, null, 2)}
`;
    try {
      const fileHandle = await fs3.open(tempPath, "w", 384);
      try {
        await fileHandle.writeFile(payload, "utf8");
        await fileHandle.sync();
      } finally {
        await fileHandle.close();
      }
      await fs3.rename(tempPath, this.policyPath);
      try {
        const dirHandle = await fs3.open(dirPath, "r");
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
      } catch {
      }
      const stat = await fs3.stat(this.policyPath);
      this.policyLoadedAtMs = stat.mtimeMs;
      this.policyDigest = this.policyDocDigest(policyDoc);
    } catch (err) {
      await fs3.rm(tempPath, { force: true }).catch(() => void 0);
      throw err;
    }
  }
  sendConnectHello() {
    const ws = this.requireOpenSocket();
    if (!ws) return;
    this.nodeNonce = randomBytes(32).toString("base64url");
    const firewallMode = this.currentPolicyFirewallMode();
    const advertisedCapabilities = this.advertisedCapabilities();
    this.sendSignedEnvelope({
      type: "req",
      id: randomUUID3(),
      method: "connect.hello",
      params: {
        role: "node",
        displayName: this.config.displayName,
        version: "0.1.0",
        nodeId: this.config.nodeId,
        backend: "nexus",
        trustLevel: "standard",
        firewallMode,
        nodeNonce: this.nodeNonce,
        caps: advertisedCapabilities,
        capabilities: advertisedCapabilities,
        device: {
          id: this.identity.fingerprint,
          fingerprint: this.identity.fingerprint,
          publicKey: this.identity.publicKeyRaw,
          signedAt: Date.now()
        }
      }
    });
    this.log("sent connect.hello");
  }
  async handleMessage(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log("received invalid JSON");
      return;
    }
    const envelope = asObject3(parsed);
    const msg = parseEnvelope(envelope);
    if (!msg) {
      this.log("received invalid envelope");
      return;
    }
    if (!this.verifyGatewayEnvelope(msg, envelope)) {
      this.log("gateway envelope verification failed");
      this.closeSocket(4001, "invalid gateway signature");
      return;
    }
    if (msg.type === "event") {
      await this.handleEvent(msg);
      return;
    }
    if (msg.type === "req") {
      await this.handleRequest(msg);
      return;
    }
    await this.handleResponse(msg);
  }
  verifyGatewayEnvelope(msg, envelope) {
    if (!msg.sender.startsWith("gateway:")) return false;
    const skew = Math.abs(Date.now() - msg.ts);
    if (skew > this.config.maxClockSkewMs) {
      this.log(`rejecting message with timestamp skew=${skew}ms`);
      return false;
    }
    const challengeTrusted = this.trustGatewayIdentityFromChallenge(msg, envelope);
    if (!this.gatewayPublicKey) {
      return challengeTrusted;
    }
    if (verifyEnvelopeSignature(envelope, this.gatewayPublicKey)) {
      return true;
    }
    if (challengeTrusted) {
      this.log(`gateway signing key rotated to fingerprint=${this.gatewayFingerprint ?? "unknown"}`);
      return true;
    }
    return false;
  }
  trustGatewayIdentityFromChallenge(msg, envelope) {
    if (msg.type !== "event" || msg.event !== "connect.challenge") return false;
    const payload = asObject3(msg.payload);
    const gatewayKeyRaw = asString(payload.gatewayPublicKey);
    if (!gatewayKeyRaw) return false;
    const parsed = parsePublicKey(gatewayKeyRaw);
    if (!parsed) return false;
    const claimedFingerprintRaw = asString(payload.gatewayFingerprint);
    const claimedFingerprint = claimedFingerprintRaw ? normalizeFingerprint256(claimedFingerprintRaw) : null;
    if (claimedFingerprintRaw && !claimedFingerprint) {
      this.log("connect.challenge carries invalid gatewayFingerprint format");
      return false;
    }
    const parsedFingerprint = normalizeFingerprint256(parsed.fingerprint);
    if (claimedFingerprint && parsedFingerprint && claimedFingerprint !== parsedFingerprint) {
      this.log(
        `connect.challenge gateway fingerprint mismatch claimed=${claimedFingerprint} parsed=${parsedFingerprint}`
      );
      return false;
    }
    const envelopeOk = verifyEnvelopeSignature(envelope, parsed.key);
    if (!envelopeOk) return false;
    this.gatewayPublicKey = parsed.key;
    this.gatewayFingerprint = parsed.fingerprint;
    return true;
  }
  async handleEvent(msg) {
    switch (msg.event) {
      case "connect.challenge":
        await this.handleConnectChallenge(msg);
        return;
      case "connect.accept":
        this.ready = true;
        this.log("received connect.accept; session ready");
        this.sendCapsAdvertise();
        this.drainOutbox("connect.accept");
        return;
      default:
        this.log(`event=${msg.event}`);
    }
  }
  async handleConnectChallenge(msg) {
    if (!this.nodeNonce || !this.gatewayPublicKey) {
      this.log("challenge received before hello state was initialized");
      return;
    }
    const payload = asObject3(msg.payload);
    const gatewayNonce = asString(payload.gatewayNonce);
    const gatewayProofSig = asString(payload.gatewayProofSig);
    const sessionId = asString(payload.sessionId);
    if (!gatewayNonce || !gatewayProofSig || !sessionId) {
      this.log("challenge payload is missing required fields");
      return;
    }
    const transcript = buildHandshakeTranscript({
      nodeId: this.config.nodeId,
      sessionId,
      nodeNonce: this.nodeNonce,
      gatewayNonce
    });
    if (!this.config.insecureSkipGatewayProof) {
      const proofOk = verifyDetachedPayload(transcript, gatewayProofSig, this.gatewayPublicKey);
      if (!proofOk) {
        this.log("gateway proof signature validation failed");
        this.closeSocket(4001, "invalid gateway proof");
        return;
      }
    }
    this.sessionId = sessionId;
    this.gatewayNonce = gatewayNonce;
    const nodeProofSig = signDetachedPayload(transcript, this.identity.privateKey);
    this.sendSignedEnvelope({
      type: "req",
      id: randomUUID3(),
      method: "connect.prove",
      params: {
        nodeProofSig,
        permissions: {
          "system.run": true,
          "system.which": true,
          "process.start": true,
          "process.status": true,
          "process.logs": true,
          "process.cancel": true
        },
        nodeNonce: this.nodeNonce,
        gatewayNonce
      }
    });
    this.log(
      `sent connect.prove session=${sessionId} gateway_fingerprint=${this.gatewayFingerprint ?? "unknown"}`
    );
  }
  async handleResponse(msg) {
    if (msg.ok) {
      const payload = asObject3(msg.payload);
      const status = asString(payload.status);
      if (status === "ready") {
        this.ready = true;
        this.log("gateway response status=ready");
        this.sendCapsAdvertise();
        this.drainOutbox("response.ready");
      }
      return;
    }
    const code = asString(asObject3(msg.error).code) ?? "ERROR";
    const message = asString(asObject3(msg.error).message) ?? "unknown error";
    this.log(`response error code=${code} message=${message}`);
    if (code === "PAIRING_PENDING" || code === "PAIRING_REQUIRED" || code === "AUTH_INVALID") {
      this.scheduleReconnect();
    }
  }
  async handleRequest(msg) {
    switch (msg.method) {
      case "ping":
        this.sendSignedEnvelope({
          type: "res",
          id: msg.id,
          ok: true,
          payload: { pong: true, ts: Date.now() }
        });
        return;
      case "tool.execute":
        await this.handleToolExecute(msg);
        return;
      case "process.start":
        await this.handleProcessStart(msg);
        return;
      case "process.status":
        await this.handleProcessStatus(msg);
        return;
      case "process.logs":
        await this.handleProcessLogs(msg);
        return;
      case "process.cancel":
        await this.handleProcessCancel(msg);
        return;
      case "process.ack":
        await this.handleProcessAck(msg);
        return;
      case "symbols.list":
        await this.handleSymbolsList(msg);
        return;
      case "audit.query":
        await this.handleAuditQuery(msg);
        return;
      case "mcp.list":
        await this.handleMcpList(msg);
        return;
      case "mcp.call":
        await this.handleMcpCall(msg);
        return;
      case "mcp.resources":
        await this.handleMcpResources(msg);
        return;
      case "file.pull":
        await this.handleFilePull(msg);
        return;
      case "file.push":
        await this.handleFilePush(msg);
        return;
      default:
        this.sendRequestError(msg.id, "METHOD_NOT_IMPLEMENTED", `Method ${msg.method} is not implemented by reference node.`, false);
    }
  }
  async handleToolExecute(msg) {
    const params = asObject3(msg.params);
    const tool = asString(params.tool);
    const args = asObject3(params.args);
    const routing = asObject3(params.routing);
    if (!tool) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "tool.execute requires a tool name", false);
      return;
    }
    try {
      await this.refreshPolicyFromDiskIfChanged("tool.execute");
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
      return;
    }
    try {
      let output = "";
      if (tool === "system.which") {
        output = await this.execSystemWhich(args);
      } else if (tool === "system.run") {
        output = await this.execSystemRun({
          ...args,
          ...Object.keys(routing).length > 0 ? { routing } : {}
        });
      } else {
        throw new NodeToolError("CAPABILITY_UNAVAILABLE", `Tool ${tool} is not supported by this reference node.`);
      }
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          output
        }
      });
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
    }
  }
  async handleProcessStart(msg) {
    var _a, _b, _c, _d;
    const params = asObject3(msg.params);
    const tool = asString(params.tool) ?? "system.run";
    if (tool !== "system.run") {
      this.sendRequestError(msg.id, "CAPABILITY_UNAVAILABLE", `process.start only supports system.run (got ${tool}).`, false);
      return;
    }
    const runArgs = asObject3(params.args);
    const command = asString(runArgs.command);
    if (!command) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "process.start requires args.command.", false);
      return;
    }
    const commandValidation = validateAllowlistedCommand(command, this.config.allowCommands);
    if (!commandValidation.ok) {
      this.sendRequestError(msg.id, "PERMISSION_DENIED", commandValidation.message, false);
      return;
    }
    const commandName = commandValidation.commandName;
    try {
      await this.refreshPolicyFromDiskIfChanged("process.start");
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
      return;
    }
    const cwd = asString(runArgs.cwd) ?? null;
    const env = asStringMap(runArgs.env);
    const timeoutMs = clampInt(runArgs.timeoutMs ?? runArgs.timeout, 1e3, this.config.runTimeoutMs) ?? null;
    const firewallMode = this.currentPolicyFirewallMode();
    let executionCommand = command;
    let executionCwd = cwd;
    let executionEnv = env;
    let resolvedSymbols = [];
    if (firewallMode !== "transparent") {
      let resolvedInvocation;
      try {
        resolvedInvocation = await this.resolveSystemRunInvocation({
          command,
          cwd,
          env
        });
      } catch (err) {
        this.writeAuditEvent({
          type: "symbol.resolve.failed",
          toolName: "process.start",
          details: {
            code: err instanceof NodeToolError ? err.code : "NODE_EXECUTION_FAILED",
            message: err instanceof Error ? err.message : String(err)
          }
        });
        this.sendToolExecutionError(msg.id, err);
        return;
      }
      executionCommand = resolvedInvocation.command;
      executionCwd = resolvedInvocation.cwd;
      executionEnv = resolvedInvocation.env;
      resolvedSymbols = resolvedInvocation.symbols;
    }
    const routingObj = asObject3(params.routing);
    const routing = {
      ...routingObj,
      firewallMode
    };
    if (firewallMode === "transparent") {
      delete routing.firewallSession;
      delete routing.firewallQuarantine;
    }
    const resolvedFirewallSession = firewallMode === "transparent" ? null : this.resolveFirewallSession(routingObj);
    if (resolvedFirewallSession) {
      routing.firewallSession = resolvedFirewallSession.sessionId;
      routing.firewallQuarantine = resolvedFirewallSession.quarantineState;
    }
    const processId = `proc_${randomUUID3().slice(0, 12)}`;
    try {
      this.enforceHermesCommandPolicy({
        toolName: "process.start",
        commandName,
        firewallMode,
        processId,
        firewallSession: (resolvedFirewallSession == null ? void 0 : resolvedFirewallSession.sessionId) ?? null
      });
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
      return;
    }
    const entry = {
      processId,
      command,
      cwd,
      status: "queued",
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      signal: null,
      cancelRequested: false,
      timeoutMs,
      logs: "",
      child: null,
      timeoutTimer: null,
      killTimer: null,
      firewallMode,
      hermesReferences: [],
      routing: Object.keys(routing).length > 0 ? routing : null
    };
    this.processes.set(processId, entry);
    this.persistProcess(entry);
    this.writeAuditEvent({
      type: "process.start.requested",
      processId,
      firewallSession: (resolvedFirewallSession == null ? void 0 : resolvedFirewallSession.sessionId) ?? null,
      toolName: "system.run",
      details: {
        commandName,
        symbolCount: resolvedSymbols.length,
        symbols: resolvedSymbols,
        firewallMode
      }
    });
    if (commandName === POLICYCTL_COMMAND) {
      try {
        entry.status = "running";
        entry.startedAt = Date.now();
        this.persistProcess(entry);
        this.emitProcessUpdate(entry, "running");
        const output = await this.execPolicyCtlCommand({
          command: executionCommand,
          routing,
          toolName: "process.start",
          processId,
          firewallSession: (resolvedFirewallSession == null ? void 0 : resolvedFirewallSession.sessionId) ?? null,
          firewallMode
        });
        if (output) this.appendProcessLog(entry, `${output}
`, "stdout");
        this.finishProcess(entry, 0, null);
        this.sendSignedEnvelope({
          type: "res",
          id: msg.id,
          ok: true,
          payload: {
            processId,
            status: entry.status,
            startedAt: entry.startedAt,
            command,
            firewallMode,
            ...resolvedFirewallSession ? {
              firewallSession: resolvedFirewallSession.sessionId,
              firewallSessionReused: resolvedFirewallSession.reused,
              firewallQuarantine: resolvedFirewallSession.quarantineState
            } : {},
            ...firewallMode !== "transparent" ? {
              hermes: {
                mode: firewallMode,
                sanitized: true,
                references: []
              }
            } : {}
          }
        });
      } catch (err) {
        this.processes.delete(processId);
        this.stateStore.removeProcess(processId);
        this.sendToolExecutionError(msg.id, err);
      }
      return;
    }
    try {
      const child = spawnChild(executionCommand, {
        shell: true,
        cwd: executionCwd ?? void 0,
        env: Object.keys(executionEnv).length > 0 ? { ...process2.env, ...executionEnv } : process2.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      entry.child = child;
      entry.status = "running";
      entry.startedAt = Date.now();
      this.persistProcess(entry);
      this.emitProcessUpdate(entry, "running");
      (_a = child.stdout) == null ? void 0 : _a.on("data", (chunk) => {
        this.appendProcessLog(entry, String(chunk), "stdout");
      });
      (_b = child.stderr) == null ? void 0 : _b.on("data", (chunk) => {
        this.appendProcessLog(entry, String(chunk), "stderr");
      });
      child.on("error", (err) => {
        this.appendProcessLog(entry, `process error: ${err instanceof Error ? err.message : String(err)}
`, "stderr");
      });
      child.on("close", (code, signal) => {
        this.finishProcess(entry, code, signal);
      });
      if (timeoutMs && timeoutMs > 0) {
        entry.timeoutTimer = setTimeout(() => {
          if (entry.status !== "running") return;
          this.appendProcessLog(entry, `process timeout exceeded (${timeoutMs}ms); terminating
`, "stderr");
          this.cancelProcess(entry, {
            signal: "SIGTERM",
            reason: "timeout",
            killAfterMs: 5e3
          });
        }, timeoutMs);
        (_d = (_c = entry.timeoutTimer).unref) == null ? void 0 : _d.call(_c);
      }
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          processId,
          status: entry.status,
          startedAt: entry.startedAt,
          command,
          firewallMode,
          ...resolvedFirewallSession ? {
            firewallSession: resolvedFirewallSession.sessionId,
            firewallSessionReused: resolvedFirewallSession.reused,
            firewallQuarantine: resolvedFirewallSession.quarantineState
          } : {},
          ...firewallMode !== "transparent" ? {
            hermes: {
              mode: firewallMode,
              sanitized: true,
              references: []
            }
          } : {}
        }
      });
    } catch (err) {
      this.processes.delete(processId);
      this.stateStore.removeProcess(processId);
      this.sendToolExecutionError(msg.id, err);
    }
  }
  async handleProcessStatus(msg) {
    const params = asObject3(msg.params);
    const processId = asString(params.processId) ?? asString(params.id);
    if (!processId) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "process.status requires processId.", false);
      return;
    }
    const entry = this.processes.get(processId);
    if (!entry) {
      this.sendRequestError(msg.id, "PROCESS_NOT_FOUND", `Process ${processId} was not found.`, false);
      return;
    }
    this.sendSignedEnvelope({
      type: "res",
      id: msg.id,
      ok: true,
      payload: this.serializeProcess(entry, false)
    });
  }
  async handleProcessLogs(msg) {
    const params = asObject3(msg.params);
    const processId = asString(params.processId) ?? asString(params.id);
    if (!processId) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "process.logs requires processId.", false);
      return;
    }
    const entry = this.processes.get(processId);
    if (!entry) {
      this.sendRequestError(msg.id, "PROCESS_NOT_FOUND", `Process ${processId} was not found.`, false);
      return;
    }
    const maxChars = clampInt(params.maxChars, 200, MAX_OUTPUT_CHARS) ?? 8e3;
    const logs = entry.logs.length > maxChars ? entry.logs.slice(-maxChars) : entry.logs;
    if (entry.firewallMode !== "transparent") {
      const references = this.resolveProcessHermesReferences(entry);
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          processId,
          status: entry.status,
          logs: this.buildSafeSummary(logs),
          totalChars: entry.logs.length,
          truncated: entry.logs.length > maxChars,
          firewallMode: entry.firewallMode,
          firewallSession: asString(asObject3(entry.routing ?? {}).firewallSession),
          hermes: {
            mode: entry.firewallMode,
            sanitized: true,
            references
          }
        }
      });
      return;
    }
    this.sendSignedEnvelope({
      type: "res",
      id: msg.id,
      ok: true,
      payload: {
        processId,
        status: entry.status,
        logs,
        totalChars: entry.logs.length,
        truncated: entry.logs.length > maxChars
      }
    });
  }
  async handleProcessCancel(msg) {
    const params = asObject3(msg.params);
    const processId = asString(params.processId) ?? asString(params.id);
    if (!processId) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "process.cancel requires processId.", false);
      return;
    }
    const entry = this.processes.get(processId);
    if (!entry) {
      this.sendRequestError(msg.id, "PROCESS_NOT_FOUND", `Process ${processId} was not found.`, false);
      return;
    }
    const signal = normalizeSignal(asString(params.signal)) ?? "SIGTERM";
    const reason = asString(params.reason) ?? "gateway_cancel";
    const killAfterMs = clampInt(params.killAfterMs, 0, 6e4) ?? 5e3;
    this.cancelProcess(entry, { signal, reason, killAfterMs });
    this.sendSignedEnvelope({
      type: "res",
      id: msg.id,
      ok: true,
      payload: {
        processId,
        status: entry.status === "running" ? "cancelling" : entry.status,
        signal,
        reason
      }
    });
  }
  async handleProcessAck(msg) {
    const params = asObject3(msg.params);
    const deliveryId = asString(params.deliveryId);
    if (!deliveryId) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "process.ack requires deliveryId.", false);
      return;
    }
    const processId = asString(params.processId) ?? void 0;
    const nowMs = Date.now();
    const acknowledged = this.stateStore.markOutboxDelivered(deliveryId, nowMs);
    this.stateStore.pruneDeliveredOlderThan(nowMs - DELIVERED_OUTBOX_TTL_MS);
    this.sendSignedEnvelope({
      type: "res",
      id: msg.id,
      ok: true,
      payload: {
        deliveryId,
        processId: processId ?? null,
        acknowledged
      }
    });
  }
  async execPolicyCtlCommand(params) {
    const parsed = parsePolicyCtlCommand(params.command);
    const provenance = {
      runId: asString(params.routing.runId),
      parentRunId: asString(params.routing.parentRunId),
      sessionId: asString(params.routing.sessionId),
      channel: asString(params.routing.channel),
      channelKey: asString(params.routing.channelKey)
    };
    if (parsed.action === "show") {
      this.writeAuditEvent({
        type: "policy.command.show",
        processId: params.processId ?? null,
        firewallSession: params.firewallSession ?? null,
        actor: this.formatPolicyMutationActor(provenance),
        toolName: params.toolName,
        details: {
          command: params.command,
          firewallMode: params.firewallMode,
          policyPath: this.policyPath,
          policyDigest: `sha256:${this.policyDocDigest(this.policy)}`,
          provenance
        }
      });
      return JSON.stringify(
        {
          ok: true,
          action: "show",
          policyPath: this.policyPath,
          policyPresetDir: this.policyPresetDir,
          policyDigest: `sha256:${this.policyDocDigest(this.policy)}`,
          policy: this.policy
        },
        null,
        2
      );
    }
    const mutationSource = parsed.action === "apply-preset" ? "policyctl.apply-preset" : "policyctl.patch";
    let patch = {};
    if (parsed.action === "apply-preset") {
      const presetPath = resolvePolicyPresetPath(this.policyPresetDir, parsed.presetName);
      let raw = "";
      try {
        raw = await fs3.readFile(presetPath, "utf8");
      } catch (err) {
        throw new NodeToolError(
          "POLICY_PRESET_NOT_FOUND",
          `Policy preset "${parsed.presetName}" was not found at ${presetPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      try {
        patch = asObject3(JSON.parse(raw));
      } catch (err) {
        throw new NodeToolError(
          "POLICY_PRESET_INVALID",
          `Policy preset "${parsed.presetName}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } else if (parsed.action === "set-mode") {
      patch = { firewallMode: parsed.mode };
    } else if (parsed.action === "deny-add") {
      patch = {
        denyCommands: [.../* @__PURE__ */ new Set([...this.currentPolicyDenyCommands(), parsed.commandName])].sort(
          (a, b) => a.localeCompare(b)
        )
      };
    } else {
      patch = {
        denyCommands: this.currentPolicyDenyCommands().filter((entry) => entry !== parsed.commandName).sort((a, b) => a.localeCompare(b))
      };
    }
    const applied = await this.applyPolicyPatch({
      patch,
      source: mutationSource,
      command: params.command,
      breakGlass: parsed.breakGlass,
      toolName: params.toolName,
      processId: params.processId ?? null,
      firewallSession: params.firewallSession ?? null,
      provenance
    });
    return JSON.stringify(
      {
        ok: true,
        action: parsed.action,
        changed: applied.changed,
        breakGlass: parsed.breakGlass,
        source: mutationSource,
        changedFields: applied.changedFields,
        policyPath: this.policyPath,
        policyDigestBefore: `sha256:${applied.digestBefore}`,
        policyDigestAfter: `sha256:${applied.digestAfter}`,
        defaultQuarantine: this.currentPolicyDefaultQuarantine(),
        firewallMode: this.currentPolicyFirewallMode(),
        denyCommands: this.currentPolicyDenyCommands()
      },
      null,
      2
    );
  }
  async applyPolicyPatch(params) {
    this.assertPolicyPatchShape(params.patch);
    const nowMs = Date.now();
    const current = this.normalizePolicyDocument(this.policy, nowMs);
    const next = this.normalizePolicyDocument(
      {
        ...current,
        ...params.patch
      },
      nowMs
    );
    const changedFields = this.policyChangedFields(current, next);
    const digestBefore = this.policyDocDigest(current);
    const digestAfter = this.policyDocDigest(next);
    if (changedFields.length === 0) {
      return {
        changed: false,
        changedFields: [],
        digestBefore,
        digestAfter
      };
    }
    const previousMode = parseFirewallMode(asString(current.firewallMode), "transparent");
    const nextMode = parseFirewallMode(asString(next.firewallMode), "transparent");
    if (firewallModeStrength(nextMode) < firewallModeStrength(previousMode) && !params.breakGlass) {
      throw new NodeToolError(
        "POLICY_MUTATION_DENIED",
        `Policy downgrade ${previousMode} -> ${nextMode} requires --break-glass.`
      );
    }
    const currentDeny = parsePolicyDenyCommands(current.denyCommands) ?? [];
    const nextDeny = parsePolicyDenyCommands(next.denyCommands) ?? [];
    if (nextDeny.length > 128) {
      throw new NodeToolError("INVALID_REQUEST", "denyCommands cannot exceed 128 entries.");
    }
    if (currentDeny.length > 0 && nextDeny.length === 0 && !params.breakGlass) {
      throw new NodeToolError(
        "POLICY_MUTATION_DENIED",
        "Clearing denyCommands requires --break-glass when denyCommands is currently non-empty."
      );
    }
    await this.persistPolicyToDisk(next);
    this.policy = next;
    this.log(
      `policy command applied source=${params.source} firewall_mode=${this.currentPolicyFirewallMode()} default_quarantine=${this.currentPolicyDefaultQuarantine()} deny_commands=${this.currentPolicyDenyCommands().join(",") || "-"}`
    );
    this.writeAuditEvent({
      type: "policy.command.applied",
      processId: params.processId,
      firewallSession: params.firewallSession,
      actor: this.formatPolicyMutationActor(params.provenance),
      toolName: params.toolName,
      details: {
        source: params.source,
        command: params.command,
        breakGlass: params.breakGlass,
        changedFields,
        previousFirewallMode: previousMode,
        firewallMode: this.currentPolicyFirewallMode(),
        defaultQuarantine: this.currentPolicyDefaultQuarantine(),
        denyCommands: this.currentPolicyDenyCommands(),
        policyPath: this.policyPath,
        digestBefore: `sha256:${digestBefore}`,
        digestAfter: `sha256:${this.policyDocDigest(this.policy)}`,
        provenance: params.provenance
      }
    });
    if (previousMode !== nextMode) this.sendCapsAdvertise();
    return {
      changed: true,
      changedFields,
      digestBefore,
      digestAfter: this.policyDocDigest(this.policy)
    };
  }
  assertPolicyPatchShape(patch) {
    const keys = Object.keys(patch);
    if (keys.length === 0) {
      throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} requires a non-empty policy patch.`);
    }
    for (const key of keys) {
      if (!POLICY_ALLOWED_FIELDS.has(key)) {
        throw new NodeToolError(
          "INVALID_REQUEST",
          `${POLICYCTL_COMMAND} does not allow policy field "${key}". Allowed fields: ${[...POLICY_ALLOWED_FIELDS.values()].join(", ")}.`
        );
      }
    }
    if ("defaultQuarantine" in patch) {
      const value = asString(patch.defaultQuarantine);
      if (!value || value !== "none" && value !== "soft" && value !== "hard") {
        throw new NodeToolError(
          "INVALID_REQUEST",
          `${POLICYCTL_COMMAND} defaultQuarantine must be one of: none, soft, hard.`
        );
      }
    }
    if ("firewallMode" in patch) {
      const value = asString(patch.firewallMode);
      if (!value || value !== "transparent" && value !== "audit-only" && value !== "hermes") {
        throw new NodeToolError(
          "INVALID_REQUEST",
          `${POLICYCTL_COMMAND} firewallMode must be one of: transparent, audit-only, hermes.`
        );
      }
    }
    if ("denyCommands" in patch && parsePolicyDenyCommands(patch.denyCommands) === null) {
      throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} denyCommands must be an array of command names.`);
    }
    if ("version" in patch) {
      const version = asNumber(patch.version);
      if (version === null || !Number.isInteger(version) || version <= 0) {
        throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} version must be a positive integer.`);
      }
    }
    if ("label" in patch) {
      const label = asString(patch.label);
      if (!label || label.length > 120) {
        throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} label must be a non-empty string up to 120 chars.`);
      }
    }
    if ("updatedAt" in patch) {
      const updatedAt = asNumber(patch.updatedAt);
      if (updatedAt === null || !Number.isInteger(updatedAt) || updatedAt < 0) {
        throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} updatedAt must be a non-negative integer.`);
      }
    }
  }
  policyChangedFields(current, next) {
    const fields = ["version", "label", "defaultQuarantine", "firewallMode", "denyCommands"];
    const changed = [];
    for (const field of fields) {
      if (JSON.stringify(current[field] ?? null) !== JSON.stringify(next[field] ?? null)) changed.push(field);
    }
    return changed;
  }
  formatPolicyMutationActor(provenance) {
    const parts = [this.senderId];
    if (provenance.channel) parts.push(`channel=${provenance.channel}`);
    if (provenance.channelKey) parts.push(`channelKey=${provenance.channelKey}`);
    if (provenance.sessionId) parts.push(`session=${provenance.sessionId}`);
    if (provenance.runId) parts.push(`run=${provenance.runId}`);
    return parts.join(" ");
  }
  shellCtlRootDir() {
    return path3.join(this.config.stateDir, SHELLCTL_ROOT_DIRNAME);
  }
  shellCtlMetaDir() {
    return path3.join(this.shellCtlRootDir(), SHELLCTL_SESSION_DIRNAME);
  }
  shellCtlLogDir() {
    return path3.join(this.shellCtlRootDir(), SHELLCTL_LOG_DIRNAME);
  }
  shellCtlMetaPath(sessionId) {
    return path3.join(this.shellCtlMetaDir(), `${sessionId}.json`);
  }
  shellCtlLogPath(sessionId) {
    return path3.join(this.shellCtlLogDir(), `${sessionId}.log`);
  }
  async shellCtlEnsureDirs() {
    await fs3.mkdir(this.shellCtlMetaDir(), { recursive: true });
    await fs3.mkdir(this.shellCtlLogDir(), { recursive: true });
  }
  async shellCtlLoadMeta(sessionId) {
    try {
      const raw = await fs3.readFile(this.shellCtlMetaPath(sessionId), "utf8");
      const parsed = asObject3(JSON.parse(raw));
      const parsedSessionId = asString(parsed.sessionId);
      const tmuxSession = asString(parsed.tmuxSession);
      const cwd = asString(parsed.cwd);
      const logPath = asString(parsed.logPath);
      const createdAt = asNumber(parsed.createdAt);
      const updatedAt = asNumber(parsed.updatedAt);
      if (!parsedSessionId || !tmuxSession || !cwd || !logPath) return null;
      return {
        sessionId: parsedSessionId,
        tmuxSession,
        cwd,
        logPath,
        createdAt: createdAt ?? Date.now(),
        updatedAt: updatedAt ?? Date.now()
      };
    } catch {
      return null;
    }
  }
  async shellCtlSaveMeta(meta) {
    await this.shellCtlEnsureDirs();
    await fs3.writeFile(this.shellCtlMetaPath(meta.sessionId), JSON.stringify(meta, null, 2), { mode: 384 });
  }
  async shellCtlDeleteMeta(sessionId) {
    try {
      await fs3.rm(this.shellCtlMetaPath(sessionId), { force: true });
    } catch {
    }
  }
  async shellCtlFileSize(filePath) {
    try {
      const stat = await fs3.stat(filePath);
      if (!stat.isFile()) return 0;
      return stat.size;
    } catch {
      return 0;
    }
  }
  async shellCtlEnsureTmux() {
    const probe = await runTmuxCommand(["-V"]);
    if (probe.ok) return;
    if (probe.rawCode === "ENOENT") {
      throw new NodeToolError("CAPABILITY_UNAVAILABLE", `${SHELLCTL_COMMAND} requires tmux to be installed on the node.`);
    }
    const detail = [probe.errorMessage, probe.stderr].filter(Boolean).join(" | ");
    throw new NodeToolError("NODE_EXECUTION_FAILED", `tmux probe failed: ${truncateOutput(detail || "unknown error", 500)}`);
  }
  async shellCtlHasSession(tmuxSession) {
    const result = await runTmuxCommand(["has-session", "-t", tmuxSession]);
    return result.ok;
  }
  async shellCtlReadTimedOutput(params) {
    await fs3.mkdir(path3.dirname(params.logPath), { recursive: true });
    try {
      await fs3.access(params.logPath);
    } catch {
      await fs3.writeFile(params.logPath, "", { mode: 384 });
    }
    let startCursor = Math.max(0, Math.floor(params.cursor));
    const initialSize = await this.shellCtlFileSize(params.logPath);
    let resetCursor = false;
    if (startCursor > initialSize) {
      startCursor = 0;
      resetCursor = true;
    }
    const deadline = Date.now() + Math.max(0, params.waitMs);
    let observedSize = await this.shellCtlFileSize(params.logPath);
    let hasNewOutput = observedSize > startCursor;
    while (!hasNewOutput && Date.now() < deadline) {
      await sleepMs(SHELLCTL_POLL_INTERVAL_MS);
      observedSize = await this.shellCtlFileSize(params.logPath);
      hasNewOutput = observedSize > startCursor;
    }
    let finalSize = observedSize;
    if (hasNewOutput && params.idleMs > 0) {
      let quietUntil = Date.now() + params.idleMs;
      while (Date.now() < deadline && Date.now() < quietUntil) {
        await sleepMs(SHELLCTL_POLL_INTERVAL_MS);
        const nextSize = await this.shellCtlFileSize(params.logPath);
        if (nextSize > finalSize) {
          finalSize = nextSize;
          quietUntil = Date.now() + params.idleMs;
        }
      }
    }
    const bytesAvailable = Math.max(0, finalSize - startCursor);
    const maxBytes = Math.max(256, Math.min(SHELLCTL_MAX_READ_BYTES, params.maxChars * 4));
    const bytesToRead = Math.min(bytesAvailable, maxBytes);
    const nextCursor = startCursor + bytesToRead;
    let output = "";
    if (bytesToRead > 0) {
      const handle = await fs3.open(params.logPath, "r");
      try {
        const buf = Buffer.alloc(bytesToRead);
        const { bytesRead } = await handle.read(buf, 0, bytesToRead, startCursor);
        output = buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    }
    return {
      output,
      nextCursor,
      totalBytes: finalSize,
      truncated: nextCursor < finalSize,
      resetCursor
    };
  }
  async execShellCtlCommand(params) {
    const parsed = parseShellCtlCommand(params.command);
    if (parsed.action === "list") {
      await this.shellCtlEnsureDirs();
      const files = await fs3.readdir(this.shellCtlMetaDir());
      const sessions = [];
      for (const entry of files.sort((a, b) => a.localeCompare(b))) {
        if (!entry.endsWith(".json")) continue;
        const sessionId = entry.slice(0, -5);
        const meta2 = await this.shellCtlLoadMeta(sessionId);
        if (!meta2) continue;
        sessions.push({
          session: sessionId,
          cwd: meta2.cwd,
          running: await this.shellCtlHasSession(meta2.tmuxSession),
          logBytes: await this.shellCtlFileSize(meta2.logPath),
          createdAt: meta2.createdAt,
          updatedAt: meta2.updatedAt
        });
      }
      return JSON.stringify(
        {
          ok: true,
          action: "list",
          count: sessions.length,
          sessions
        },
        null,
        2
      );
    }
    if (parsed.action === "open") {
      await this.shellCtlEnsureTmux();
      await this.shellCtlEnsureDirs();
      const existingMeta = await this.shellCtlLoadMeta(parsed.sessionId);
      if (existingMeta && await this.shellCtlHasSession(existingMeta.tmuxSession)) {
        return JSON.stringify(
          {
            ok: true,
            action: "open",
            session: parsed.sessionId,
            existed: true,
            cwd: existingMeta.cwd,
            cursor: await this.shellCtlFileSize(existingMeta.logPath)
          },
          null,
          2
        );
      }
      if (existingMeta) {
        await this.shellCtlDeleteMeta(parsed.sessionId);
      }
      const cwd = parsed.cwd ? path3.resolve(path3.isAbsolute(parsed.cwd) ? parsed.cwd : path3.join(this.config.stateDir, parsed.cwd)) : this.config.stateDir;
      let cwdStat;
      try {
        cwdStat = await fs3.stat(cwd);
      } catch (err) {
        throw new NodeToolError("INVALID_REQUEST", `open cwd does not exist: ${cwd} (${err instanceof Error ? err.message : String(err)})`);
      }
      if (!cwdStat.isDirectory()) {
        throw new NodeToolError("INVALID_REQUEST", `open cwd is not a directory: ${cwd}`);
      }
      const tmuxSession = shellCtlSessionNameFromId(parsed.sessionId);
      const logPath = this.shellCtlLogPath(parsed.sessionId);
      await fs3.writeFile(logPath, "", { mode: 384 });
      const createRes = await runTmuxCommand(["new-session", "-d", "-s", tmuxSession, "-c", cwd]);
      if (!createRes.ok) {
        const detail = [createRes.errorMessage, createRes.stderr].filter(Boolean).join(" | ");
        throw new NodeToolError("NODE_EXECUTION_FAILED", `failed to open tmux session: ${truncateOutput(detail || "unknown error", 500)}`);
      }
      await runTmuxCommand(["set-option", "-t", tmuxSession, "history-limit", "200000"]);
      const pipeCommand = `cat >> ${shellEscape(logPath)}`;
      const pipeRes = await runTmuxCommand(["pipe-pane", "-o", "-t", `${tmuxSession}:0.0`, pipeCommand]);
      if (!pipeRes.ok) {
        await runTmuxCommand(["kill-session", "-t", tmuxSession]);
        const detail = [pipeRes.errorMessage, pipeRes.stderr].filter(Boolean).join(" | ");
        throw new NodeToolError("NODE_EXECUTION_FAILED", `failed to attach tmux output pipe: ${truncateOutput(detail || "unknown error", 500)}`);
      }
      const now = Date.now();
      await this.shellCtlSaveMeta({
        sessionId: parsed.sessionId,
        tmuxSession,
        cwd,
        logPath,
        createdAt: now,
        updatedAt: now
      });
      return JSON.stringify(
        {
          ok: true,
          action: "open",
          session: parsed.sessionId,
          existed: false,
          cwd,
          cursor: 0
        },
        null,
        2
      );
    }
    if (parsed.action === "send") {
      await this.shellCtlEnsureTmux();
      const meta2 = await this.shellCtlLoadMeta(parsed.sessionId);
      if (!meta2) {
        throw new NodeToolError("INVALID_REQUEST", `interactive session not found: ${parsed.sessionId}`);
      }
      if (!await this.shellCtlHasSession(meta2.tmuxSession)) {
        throw new NodeToolError("PROCESS_NOT_FOUND", `interactive session is not running: ${parsed.sessionId}`);
      }
      const target = `${meta2.tmuxSession}:0.0`;
      const sendRes = await runTmuxCommand(["send-keys", "-t", target, "-l", parsed.payload]);
      if (!sendRes.ok) {
        const detail = [sendRes.errorMessage, sendRes.stderr].filter(Boolean).join(" | ");
        throw new NodeToolError("NODE_EXECUTION_FAILED", `failed to send tmux input: ${truncateOutput(detail || "unknown error", 500)}`);
      }
      if (parsed.enter) {
        const enterRes = await runTmuxCommand(["send-keys", "-t", target, "Enter"]);
        if (!enterRes.ok) {
          const detail = [enterRes.errorMessage, enterRes.stderr].filter(Boolean).join(" | ");
          throw new NodeToolError("NODE_EXECUTION_FAILED", `failed to send Enter key: ${truncateOutput(detail || "unknown error", 500)}`);
        }
      }
      meta2.updatedAt = Date.now();
      await this.shellCtlSaveMeta(meta2);
      return JSON.stringify(
        {
          ok: true,
          action: "send",
          session: parsed.sessionId,
          enter: parsed.enter,
          cursor: await this.shellCtlFileSize(meta2.logPath)
        },
        null,
        2
      );
    }
    if (parsed.action === "read") {
      const meta2 = await this.shellCtlLoadMeta(parsed.sessionId);
      if (!meta2) {
        throw new NodeToolError("INVALID_REQUEST", `interactive session not found: ${parsed.sessionId}`);
      }
      const read = await this.shellCtlReadTimedOutput({
        logPath: meta2.logPath,
        cursor: parsed.cursor,
        waitMs: parsed.waitMs,
        idleMs: parsed.idleMs,
        maxChars: parsed.maxChars
      });
      const running2 = await this.shellCtlHasSession(meta2.tmuxSession);
      meta2.updatedAt = Date.now();
      await this.shellCtlSaveMeta(meta2);
      return JSON.stringify(
        {
          ok: true,
          action: "read",
          session: parsed.sessionId,
          output: read.output,
          nextCursor: read.nextCursor,
          totalBytes: read.totalBytes,
          truncated: read.truncated,
          resetCursor: read.resetCursor,
          running: running2
        },
        null,
        2
      );
    }
    if (parsed.action === "interrupt") {
      await this.shellCtlEnsureTmux();
      const meta2 = await this.shellCtlLoadMeta(parsed.sessionId);
      if (!meta2) {
        throw new NodeToolError("INVALID_REQUEST", `interactive session not found: ${parsed.sessionId}`);
      }
      if (!await this.shellCtlHasSession(meta2.tmuxSession)) {
        throw new NodeToolError("PROCESS_NOT_FOUND", `interactive session is not running: ${parsed.sessionId}`);
      }
      const res = await runTmuxCommand(["send-keys", "-t", `${meta2.tmuxSession}:0.0`, "C-c"]);
      if (!res.ok) {
        const detail = [res.errorMessage, res.stderr].filter(Boolean).join(" | ");
        throw new NodeToolError("NODE_EXECUTION_FAILED", `failed to interrupt session: ${truncateOutput(detail || "unknown error", 500)}`);
      }
      meta2.updatedAt = Date.now();
      await this.shellCtlSaveMeta(meta2);
      return JSON.stringify(
        {
          ok: true,
          action: "interrupt",
          session: parsed.sessionId
        },
        null,
        2
      );
    }
    const meta = await this.shellCtlLoadMeta(parsed.sessionId);
    if (!meta) {
      return JSON.stringify(
        {
          ok: true,
          action: "close",
          session: parsed.sessionId,
          alreadyClosed: true
        },
        null,
        2
      );
    }
    const running = await this.shellCtlHasSession(meta.tmuxSession);
    if (running) {
      await runTmuxCommand(["kill-session", "-t", meta.tmuxSession]);
    }
    await this.shellCtlDeleteMeta(parsed.sessionId);
    return JSON.stringify(
      {
        ok: true,
        action: "close",
        session: parsed.sessionId,
        wasRunning: running
      },
      null,
      2
    );
  }
  async handleSymbolsList(msg) {
    const params = asObject3(msg.params);
    const requestedKindRaw = asString(params.kind);
    const requestedKind = parseSymbolKind(requestedKindRaw);
    if (requestedKindRaw && !requestedKind) {
      this.sendRequestError(
        msg.id,
        "INVALID_REQUEST",
        `symbols.list kind must be one of: ${SYMBOL_KINDS.join(", ")} (got ${requestedKindRaw}).`,
        false
      );
      return;
    }
    const includeFields = asBoolean(params.includeFields) ?? true;
    try {
      const catalog = await this.readSymbolCatalog();
      const activeKinds = requestedKind ? [requestedKind] : SYMBOL_KINDS;
      const responseCatalog = {
        contact: [],
        account: [],
        secret: [],
        user: []
      };
      const symbols = [];
      const countsByKind = {
        contact: 0,
        account: 0,
        secret: 0,
        user: 0
      };
      for (const kind of activeKinds) {
        const entries = catalog[kind];
        countsByKind[kind] = entries.length;
        responseCatalog[kind] = entries.map((entry) => {
          const record = { key: entry.key };
          if (includeFields && entry.fields.length > 0 && kind !== "user") {
            record.fields = [...entry.fields];
          }
          return record;
        });
        for (const entry of entries) {
          symbols.push(`{{${kind}:${entry.key}}}`);
          if (includeFields && kind !== "user") {
            for (const field of entry.fields) {
              symbols.push(`{{${kind}:${entry.key}:${field}}}`);
            }
          }
        }
      }
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          kind: requestedKind ?? null,
          includeFields,
          generatedAt: Date.now(),
          storeDir: this.symbolStoreDir,
          catalog: responseCatalog,
          counts: {
            byKind: countsByKind,
            keys: countsByKind.contact + countsByKind.account + countsByKind.secret + countsByKind.user,
            symbols: symbols.length
          },
          symbols
        }
      });
      this.writeAuditEvent({
        type: "symbols.list",
        details: {
          kind: requestedKind ?? null,
          includeFields,
          keys: countsByKind.contact + countsByKind.account + countsByKind.secret + countsByKind.user,
          symbols: symbols.length
        }
      });
    } catch (err) {
      this.sendRequestError(
        msg.id,
        "NODE_SYMBOLS_LIST_FAILED",
        `Failed to build symbols catalog: ${err instanceof Error ? err.message : String(err)}`,
        true
      );
    }
  }
  async handleAuditQuery(msg) {
    const params = asObject3(msg.params);
    const limit = clampInt(params.limit, 1, 500) ?? 100;
    const cursorCreatedAt = asNumber(params.cursorCreatedAt ?? params.cursor) ?? null;
    const type = asString(params.type);
    const processId = asString(params.processId) ?? asString(params.process);
    const firewallSession = asString(params.firewallSession);
    const actor = asString(params.actor);
    const result = this.stateStore.queryAuditEvents({
      limit,
      cursorCreatedAt,
      type,
      processId,
      firewallSession,
      actor
    });
    this.sendSignedEnvelope({
      type: "res",
      id: msg.id,
      ok: true,
      payload: {
        count: result.events.length,
        nextCursorCreatedAt: result.nextCursorCreatedAt,
        events: result.events
      }
    });
  }
  async handleMcpList(msg) {
    const params = asObject3(msg.params);
    const serverId = asString(params.serverId) ?? asString(params.server);
    const includeTools = asBoolean(params.includeTools) ?? true;
    const includeResources = asBoolean(params.includeResources) ?? false;
    try {
      this.assertMcpBridgeEnabled("mcp.list");
      const servers = this.selectMcpBridgeServers(serverId);
      const summaries = [];
      for (const server of servers) {
        const summary = {
          id: server.id,
          label: server.label,
          allowTools: [...server.allowTools],
          allowResources: [...server.allowResources],
          timeoutMs: server.timeoutMs,
          connected: false
        };
        try {
          const client = await this.getMcpBridgeClient(server);
          summary.connected = true;
          if (includeTools) {
            const listedTools = await client.listTools();
            summary.tools = listedTools.filter((tool) => this.allowlistedMcpName(tool.name, server.allowTools)).map((tool) => ({
              name: tool.name,
              ...tool.description ? { description: tool.description } : {},
              ...tool.inputSchema ? { inputSchema: tool.inputSchema } : {}
            }));
          }
          if (includeResources) {
            try {
              const listedResources = await client.listResources();
              const resources = listedResources.resources;
              summary.resources = resources.filter((resource) => this.allowlistedMcpName(resource.uri, server.allowResources)).map((resource) => ({
                uri: resource.uri,
                ...typeof resource.name === "string" ? { name: resource.name } : {},
                ...typeof resource.description === "string" ? { description: resource.description } : {},
                ...typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}
              }));
              if (listedResources.nextCursor) summary.nextCursor = listedResources.nextCursor;
            } catch (err) {
              summary.resourcesError = err instanceof Error ? err.message : String(err);
            }
          }
        } catch (err) {
          summary.error = err instanceof Error ? err.message : String(err);
        }
        summaries.push(summary);
      }
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          bridge: {
            enabled: true,
            configPath: this.mcpBridgeConfigPath
          },
          serverId: serverId ?? null,
          includeTools,
          includeResources,
          count: summaries.length,
          servers: summaries
        }
      });
      this.writeAuditEvent({
        type: "mcp.list",
        details: {
          serverId: serverId ?? null,
          includeTools,
          includeResources,
          count: summaries.length
        }
      });
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
    }
  }
  async handleMcpCall(msg) {
    const params = asObject3(msg.params);
    const serverId = asString(params.serverId) ?? asString(params.server);
    const toolName = asString(params.tool) ?? asString(params.name);
    const toolArgs = asObject3(params.arguments ?? params.args);
    if (!serverId) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "mcp.call requires `serverId`.", false);
      return;
    }
    if (!toolName) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "mcp.call requires `tool`.", false);
      return;
    }
    try {
      this.assertMcpBridgeEnabled("mcp.call");
      const server = this.requireMcpBridgeServer(serverId);
      if (!this.allowlistedMcpName(toolName, server.allowTools)) {
        throw new NodeToolError(
          "PERMISSION_DENIED",
          `MCP tool '${toolName}' is not allowlisted for server '${server.id}'.`
        );
      }
      const client = await this.getMcpBridgeClient(server);
      const result = await client.callTool(toolName, toolArgs);
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          serverId: server.id,
          tool: toolName,
          result
        }
      });
      this.writeAuditEvent({
        type: "mcp.call",
        toolName: "mcp.call",
        details: {
          serverId: server.id,
          tool: toolName
        }
      });
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
    }
  }
  async handleMcpResources(msg) {
    const params = asObject3(msg.params);
    const serverId = asString(params.serverId) ?? asString(params.server);
    if (!serverId) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "mcp.resources requires `serverId`.", false);
      return;
    }
    const uri = asString(params.uri);
    const actionRaw = asString(params.action) ?? (uri ? "read" : "list");
    const action = actionRaw === "read" ? "read" : actionRaw === "list" ? "list" : null;
    if (!action) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "mcp.resources action must be `list` or `read`.", false);
      return;
    }
    try {
      this.assertMcpBridgeEnabled("mcp.resources");
      const server = this.requireMcpBridgeServer(serverId);
      const client = await this.getMcpBridgeClient(server);
      if (action === "read") {
        if (!uri) {
          this.sendRequestError(msg.id, "INVALID_REQUEST", "mcp.resources read requires `uri`.", false);
          return;
        }
        if (!this.allowlistedMcpName(uri, server.allowResources)) {
          throw new NodeToolError(
            "PERMISSION_DENIED",
            `MCP resource '${uri}' is not allowlisted for server '${server.id}'.`
          );
        }
        const result = await client.readResource(uri);
        this.sendSignedEnvelope({
          type: "res",
          id: msg.id,
          ok: true,
          payload: {
            serverId: server.id,
            action,
            uri,
            result
          }
        });
        this.writeAuditEvent({
          type: "mcp.resources.read",
          toolName: "mcp.resources",
          details: {
            serverId: server.id,
            uri
          }
        });
        return;
      }
      const cursor = asString(params.cursor) ?? void 0;
      const limit = clampInt(params.limit, 1, 500) ?? 200;
      const listed = await client.listResources(cursor);
      const filtered = listed.resources.filter(
        (resource) => this.allowlistedMcpName(resource.uri, server.allowResources)
      );
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          serverId: server.id,
          action,
          count: Math.min(filtered.length, limit),
          resources: filtered.slice(0, limit).map((resource) => ({
            uri: resource.uri,
            ...typeof resource.name === "string" ? { name: resource.name } : {},
            ...typeof resource.description === "string" ? { description: resource.description } : {},
            ...typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}
          })),
          nextCursor: listed.nextCursor ?? null
        }
      });
      this.writeAuditEvent({
        type: "mcp.resources.list",
        toolName: "mcp.resources",
        details: {
          serverId: server.id,
          count: Math.min(filtered.length, limit)
        }
      });
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
    }
  }
  async handleFilePull(msg) {
    const params = asObject3(msg.params);
    const requestedPath = asString(params.path) ?? asString(params.remotePath);
    if (!requestedPath) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "file.pull requires `path`.", false);
      return;
    }
    const maxBytes = clampInt(params.maxBytes, 1024, this.config.fileTransferMaxBytes) ?? this.config.fileTransferMaxBytes;
    try {
      this.assertFileTransferAllowed("pull");
      await this.refreshPolicyFromDiskIfChanged("file.pull");
      const firewallMode = this.currentPolicyFirewallMode();
      this.enforceHermesCommandPolicy({
        toolName: "file.pull",
        commandName: FILE_PULL_COMMAND,
        firewallMode
      });
      const resolvedPath = await this.resolveFileTransferPath(requestedPath, "read");
      const stat = await fs3.stat(resolvedPath);
      if (!stat.isFile()) {
        throw new NodeToolError("INVALID_REQUEST", `file.pull path is not a regular file: ${requestedPath}`);
      }
      if (stat.size > maxBytes) {
        throw new NodeToolError(
          "PAYLOAD_TOO_LARGE",
          `file.pull exceeded maxBytes (${stat.size} > ${maxBytes}); increase maxBytes or use a smaller file.`
        );
      }
      const bytes = await fs3.readFile(resolvedPath);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          path: resolvedPath,
          sizeBytes: bytes.length,
          mtimeMs: Math.floor(stat.mtimeMs),
          sha256,
          encoding: "base64",
          contentBase64: bytes.toString("base64")
        }
      });
      this.writeAuditEvent({
        type: "file.pull",
        toolName: "file.pull",
        details: {
          path: resolvedPath,
          sizeBytes: bytes.length,
          maxBytes,
          sha256
        }
      });
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
    }
  }
  async handleFilePush(msg) {
    const params = asObject3(msg.params);
    const requestedPath = asString(params.path) ?? asString(params.remotePath);
    if (!requestedPath) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "file.push requires `path`.", false);
      return;
    }
    const contentBase64 = asString(params.contentBase64) ?? asString(params.base64);
    if (!contentBase64) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "file.push requires base64 payload in `contentBase64`.", false);
      return;
    }
    const overwrite = asBoolean(params.overwrite) ?? false;
    const maxBytes = clampInt(params.maxBytes, 1024, this.config.fileTransferMaxBytes) ?? this.config.fileTransferMaxBytes;
    try {
      this.assertFileTransferAllowed("push");
      await this.refreshPolicyFromDiskIfChanged("file.push");
      const firewallMode = this.currentPolicyFirewallMode();
      this.enforceHermesCommandPolicy({
        toolName: "file.push",
        commandName: FILE_PUSH_COMMAND,
        firewallMode
      });
      const bytes = decodeBase64Loose(contentBase64);
      if (!bytes) {
        throw new NodeToolError("INVALID_REQUEST", "file.push contentBase64 is not valid base64.");
      }
      if (bytes.length > maxBytes) {
        throw new NodeToolError(
          "PAYLOAD_TOO_LARGE",
          `file.push exceeded maxBytes (${bytes.length} > ${maxBytes}); increase maxBytes or upload a smaller file.`
        );
      }
      const resolvedPath = await this.resolveFileTransferPath(requestedPath, "write");
      if (!overwrite) {
        try {
          await fs3.access(resolvedPath);
          throw new NodeToolError(
            "FILE_EXISTS",
            `file.push target already exists: ${resolvedPath} (set overwrite=true to replace).`
          );
        } catch (err) {
          const code = err == null ? void 0 : err.code;
          if (code !== "ENOENT") throw err;
        }
      }
      await fs3.mkdir(path3.dirname(resolvedPath), { recursive: true });
      await fs3.writeFile(resolvedPath, bytes, { mode: 384 });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          path: resolvedPath,
          sizeBytes: bytes.length,
          sha256,
          overwritten: overwrite
        }
      });
      this.writeAuditEvent({
        type: "file.push",
        toolName: "file.push",
        details: {
          path: resolvedPath,
          sizeBytes: bytes.length,
          maxBytes,
          sha256,
          overwrite
        }
      });
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
    }
  }
  assertFileTransferAllowed(direction) {
    const commandName = direction === "pull" ? FILE_PULL_COMMAND : FILE_PUSH_COMMAND;
    if (isAllowedCommand(commandName, this.config.allowCommands)) return;
    throw new NodeToolError(
      "PERMISSION_DENIED",
      `file.${direction} is not allowlisted on this node (add "${commandName}" to NEXUS_NODE_ALLOW_COMMANDS).`
    );
  }
  async resolveFileTransferPath(requestedPath, mode) {
    const trimmed = requestedPath.trim();
    if (!trimmed) throw new NodeToolError("INVALID_REQUEST", "file transfer path cannot be empty.");
    const candidate = path3.resolve(path3.isAbsolute(trimmed) ? trimmed : path3.join(this.config.stateDir, trimmed));
    let resolved = "";
    if (mode === "read") {
      try {
        resolved = await fs3.realpath(candidate);
      } catch (err) {
        const code = err == null ? void 0 : err.code;
        if (code === "ENOENT") throw new NodeToolError("FILE_NOT_FOUND", `File not found: ${requestedPath}`);
        throw err;
      }
    } else {
      resolved = await resolvePathViaExistingParent(candidate);
    }
    const allowed = await this.isFileTransferPathAllowed(resolved);
    if (!allowed) {
      throw new NodeToolError("PERMISSION_DENIED", `Path is outside allowed file-transfer roots: ${requestedPath}`);
    }
    return resolved;
  }
  async isFileTransferPathAllowed(resolvedPath) {
    for (const root of this.config.fileTransferRoots) {
      const normalizedRoot = await resolvePathViaExistingParent(root);
      if (isWithinPath(resolvedPath, normalizedRoot)) return true;
    }
    return false;
  }
  async readSymbolCatalog() {
    const contactsRaw = await this.readJsonUnknown(path3.join(this.symbolStoreDir, "contacts.json"));
    const accountsRaw = await this.readJsonUnknown(path3.join(this.symbolStoreDir, "accounts.json"));
    const secretsRaw = await this.readJsonUnknown(path3.join(this.symbolStoreDir, "secrets.json"));
    const userRaw = await this.readJsonUnknown(path3.join(this.symbolStoreDir, "user.json"));
    return {
      contact: this.parseContactsCatalog(contactsRaw),
      account: this.parseKeyedCatalog(accountsRaw),
      secret: this.parseKeyedCatalog(secretsRaw),
      user: this.parseUserCatalog(userRaw)
    };
  }
  async readJsonUnknown(filePath) {
    try {
      const raw = await fs3.readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      const code = err == null ? void 0 : err.code;
      if (code === "ENOENT") return {};
      this.log(
        `symbols store read failed path=${filePath} error=${err instanceof Error ? err.message : String(err)}; treating as empty`
      );
      return {};
    }
  }
  parseContactsCatalog(raw) {
    const entries = /* @__PURE__ */ new Map();
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const row = asObject3(item);
        const key = asString(row.key);
        if (!key) continue;
        const fields = /* @__PURE__ */ new Set();
        for (const [field, value] of Object.entries(row)) {
          if (field === "key" || value === null || value === void 0) continue;
          fields.add(field);
        }
        entries.set(key, fields);
      }
      return this.normalizeCatalogEntries(entries);
    }
    const map = asObject3(raw);
    for (const [keyRaw, value] of Object.entries(map)) {
      const key = keyRaw.trim();
      if (!key) continue;
      const fields = /* @__PURE__ */ new Set();
      const valueObj = asObject3(value);
      for (const [field, fieldValue] of Object.entries(valueObj)) {
        if (fieldValue === null || fieldValue === void 0) continue;
        fields.add(field);
      }
      entries.set(key, fields);
    }
    return this.normalizeCatalogEntries(entries);
  }
  parseKeyedCatalog(raw) {
    const map = asObject3(raw);
    const entries = /* @__PURE__ */ new Map();
    for (const [keyRaw, value] of Object.entries(map)) {
      const key = keyRaw.trim();
      if (!key) continue;
      const fields = /* @__PURE__ */ new Set();
      const valueObj = asObject3(value);
      for (const [field, fieldValue] of Object.entries(valueObj)) {
        if (fieldValue === null || fieldValue === void 0) continue;
        fields.add(field);
      }
      entries.set(key, fields);
    }
    return this.normalizeCatalogEntries(entries);
  }
  parseUserCatalog(raw) {
    const map = asObject3(raw);
    const entries = /* @__PURE__ */ new Map();
    for (const keyRaw of Object.keys(map)) {
      const key = keyRaw.trim();
      if (!key) continue;
      entries.set(key, /* @__PURE__ */ new Set());
    }
    return this.normalizeCatalogEntries(entries);
  }
  normalizeCatalogEntries(entries) {
    return [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, fields]) => ({
      key,
      fields: [...fields].sort((a, b) => a.localeCompare(b))
    }));
  }
  sendRequestError(id, code, message, retryable) {
    this.sendSignedEnvelope({
      type: "res",
      id,
      ok: false,
      error: {
        code,
        message: truncateOutput(message, 2e3),
        retryable
      }
    });
  }
  sendToolExecutionError(id, err) {
    const code = err instanceof NodeToolError ? err.code : err && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : "NODE_EXECUTION_FAILED";
    const message = err instanceof Error ? err.message : String(err);
    const retryable = err instanceof NodeToolError ? err.retryable : false;
    this.sendRequestError(id, code, message, retryable);
  }
  async execSystemWhich(args) {
    const command = asString(args.command) ?? asString(args.executable) ?? asString(args.name);
    if (!command) {
      throw new NodeToolError("INVALID_REQUEST", "system.which requires `command`.");
    }
    if (command === POLICYCTL_COMMAND) {
      if (!isAllowedCommand(POLICYCTL_COMMAND, this.config.allowCommands)) {
        throw new NodeToolError("COMMAND_NOT_FOUND", `Command not found: ${command}`);
      }
      return `${POLICYCTL_COMMAND} (node-builtin)`;
    }
    if (command === SHELLCTL_COMMAND) {
      if (!isAllowedCommand(SHELLCTL_COMMAND, this.config.allowCommands)) {
        throw new NodeToolError("COMMAND_NOT_FOUND", `Command not found: ${command}`);
      }
      return `${SHELLCTL_COMMAND} (node-builtin)`;
    }
    const safe = shellEscape(command);
    const result = await execShell(`command -v ${safe}`, {
      timeoutMs: Math.min(this.config.runTimeoutMs, 1e4)
    });
    if (result.exitCode !== 0) {
      throw new NodeToolError("COMMAND_NOT_FOUND", `Command not found: ${command}`);
    }
    return truncateOutput(result.stdout.trim() || result.stderr.trim() || "(not found)");
  }
  async execSystemRun(args) {
    const command = asString(args.command);
    if (!command) throw new NodeToolError("INVALID_REQUEST", "system.run requires `command`.");
    const commandValidation = validateAllowlistedCommand(command, this.config.allowCommands);
    if (!commandValidation.ok) throw new NodeToolError("PERMISSION_DENIED", commandValidation.message);
    const commandName = commandValidation.commandName;
    const routing = asObject3(args.routing);
    const firewallMode = this.currentPolicyFirewallMode();
    const timeoutMs = clampInt(args.timeoutMs ?? args.timeout, 1e3, this.config.runTimeoutMs) ?? this.config.runTimeoutMs;
    const cwd = asString(args.cwd) ?? null;
    const env = asStringMap(args.env);
    let executionCommand = command;
    let executionCwd = cwd;
    let executionEnv = env;
    let resolvedSymbols = [];
    if (firewallMode !== "transparent") {
      let resolvedInvocation;
      try {
        resolvedInvocation = await this.resolveSystemRunInvocation({
          command,
          cwd,
          env
        });
      } catch (err) {
        this.writeAuditEvent({
          type: "symbol.resolve.failed",
          toolName: "system.run",
          details: {
            code: err instanceof NodeToolError ? err.code : "NODE_EXECUTION_FAILED",
            message: err instanceof Error ? err.message : String(err)
          }
        });
        throw err;
      }
      executionCommand = resolvedInvocation.command;
      executionCwd = resolvedInvocation.cwd;
      executionEnv = resolvedInvocation.env;
      resolvedSymbols = resolvedInvocation.symbols;
    }
    this.writeAuditEvent({
      type: "tool.execute.requested",
      toolName: "system.run",
      details: {
        commandName,
        symbolCount: resolvedSymbols.length,
        symbols: resolvedSymbols,
        firewallMode
      }
    });
    this.enforceHermesCommandPolicy({
      toolName: "system.run",
      commandName,
      firewallMode
    });
    let combined = "";
    let exitCode = 0;
    let signal = null;
    let timedOut = false;
    if (commandName === POLICYCTL_COMMAND) {
      combined = await this.execPolicyCtlCommand({
        command: executionCommand,
        routing,
        toolName: "system.run",
        firewallMode
      });
    } else if (commandName === SHELLCTL_COMMAND) {
      combined = await this.execShellCtlCommand({
        command: executionCommand
      });
    } else {
      const result = await execShell(executionCommand, {
        cwd: executionCwd ?? void 0,
        timeoutMs,
        env: executionEnv
      });
      combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
      exitCode = result.exitCode;
      signal = result.signal;
      timedOut = result.timedOut;
    }
    if (firewallMode === "transparent") {
      if (timedOut) {
        throw new NodeToolError("EXECUTION_TIMEOUT", `Command timed out after ${timeoutMs}ms.`, true);
      }
      if (exitCode !== 0) {
        const signalPart = signal ? ` signal=${signal}` : "";
        throw new NodeToolError(
          "COMMAND_FAILED",
          truncateOutput(`Command failed (exit=${exitCode}${signalPart}).
${combined}`)
        );
      }
      return truncateOutput(combined || "(no output)");
    }
    const safeSummary = this.buildSafeSummary(combined || "(no output)");
    const reference = this.createHermesReference({
      sourceType: "system.run.output",
      toolName: "system.run",
      title: commandName ? `system.run ${commandName}` : "system.run output",
      safeSummary,
      metadata: {
        mode: firewallMode,
        commandName,
        symbolCount: resolvedSymbols.length,
        symbols: resolvedSymbols,
        exitCode,
        signal,
        timedOut
      }
    });
    if (timedOut) {
      throw new NodeToolError(
        "EXECUTION_TIMEOUT",
        JSON.stringify(
          {
            mode: firewallMode,
            safeSummary,
            references: [reference],
            timedOut: true,
            timeoutMs
          },
          null,
          2
        ),
        true
      );
    }
    if (exitCode !== 0) {
      throw new NodeToolError(
        "COMMAND_FAILED",
        JSON.stringify(
          {
            mode: firewallMode,
            safeSummary,
            references: [reference],
            exitCode,
            signal
          },
          null,
          2
        )
      );
    }
    return JSON.stringify(
      {
        mode: firewallMode,
        safeSummary,
        references: [reference],
        exitCode,
        signal
      },
      null,
      2
    );
  }
  async resolveSystemRunInvocation(params) {
    const storeCache = {};
    const commandResolved = await this.resolveTemplateSymbols(params.command, {
      shellEscapeValues: true,
      storeCache
    });
    const cwdResolved = params.cwd ? await this.resolveTemplateSymbols(params.cwd, {
      shellEscapeValues: false,
      storeCache
    }) : { value: null, symbols: [] };
    const envResolved = {};
    const seenSymbols = /* @__PURE__ */ new Set([...commandResolved.symbols, ...cwdResolved.symbols]);
    for (const [key, value] of Object.entries(params.env)) {
      const resolved = await this.resolveTemplateSymbols(value, {
        shellEscapeValues: false,
        storeCache
      });
      envResolved[key] = resolved.value;
      for (const symbol of resolved.symbols) seenSymbols.add(symbol);
    }
    return {
      command: commandResolved.value,
      cwd: cwdResolved.value,
      env: envResolved,
      symbols: [...seenSymbols.values()]
    };
  }
  async resolveTemplateSymbols(input, opts) {
    const matcher = new RegExp(SYMBOL_TOKEN_PATTERN);
    let cursor = 0;
    let output = "";
    const symbols = [];
    while (true) {
      const match = matcher.exec(input);
      if (!match) break;
      const raw = match[0] ?? "";
      const kindRaw = match[1] ?? "";
      const keyRaw = match[2] ?? "";
      const fieldRaw = match[3] ?? null;
      const kind = parseSymbolKind(kindRaw);
      if (!kind) {
        throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `Unsupported symbol kind in token ${raw}.`);
      }
      const resolved = await this.resolveSymbolToken({
        kind,
        key: keyRaw,
        field: fieldRaw,
        storeCache: opts.storeCache
      });
      output += input.slice(cursor, match.index);
      output += opts.shellEscapeValues ? shellEscape(resolved) : resolved;
      cursor = match.index + raw.length;
      symbols.push(raw);
    }
    if (symbols.length === 0) {
      return {
        value: input,
        symbols: []
      };
    }
    output += input.slice(cursor);
    return {
      value: output,
      symbols
    };
  }
  async resolveSymbolToken(params) {
    const key = params.key.trim();
    if (!key) throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", "Symbol key cannot be empty.");
    if (params.kind === "contact") {
      const contactsRaw = await this.loadSymbolStore("contact", params.storeCache);
      const record = this.lookupContactRecord(contactsRaw, key);
      if (!record) {
        throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `contact symbol "${key}" was not found.`);
      }
      const value = this.pickContactValue(record, params.field);
      if (value === null) {
        const suffix = params.field ? `:${params.field}` : "";
        throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `contact symbol "${key}${suffix}" has no resolvable value.`);
      }
      return value;
    }
    if (params.kind === "user") {
      if (params.field) {
        throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `user symbols do not support field selectors (${params.field}).`);
      }
      const userRaw = await this.loadSymbolStore("user", params.storeCache);
      const userMap = asObject3(userRaw);
      const scalar = this.scalarToString(userMap[key]);
      if (scalar === null) {
        throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `user symbol "${key}" was not found.`);
      }
      return scalar;
    }
    const storeKind = params.kind;
    const storeRaw = await this.loadSymbolStore(storeKind, params.storeCache);
    const storeMap = asObject3(storeRaw);
    if (!(key in storeMap)) {
      throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `${storeKind} symbol "${key}" was not found.`);
    }
    const entry = storeMap[key];
    if (params.field) {
      const entryObj2 = asObject3(entry);
      const value = this.scalarToString(entryObj2[params.field]);
      if (value === null) {
        throw new NodeToolError(
          "SYMBOL_RESOLUTION_FAILED",
          `${storeKind} symbol "${key}:${params.field}" was not found.`
        );
      }
      return value;
    }
    const direct = this.scalarToString(entry);
    if (direct !== null) return direct;
    const entryObj = asObject3(entry);
    const preferred = this.scalarToString(entryObj.value);
    if (preferred !== null) return preferred;
    const scalarEntries = Object.entries(entryObj).flatMap(([field, value]) => {
      const scalar = this.scalarToString(value);
      return scalar === null ? [] : [{ field, value: scalar }];
    });
    if (scalarEntries.length === 1) return scalarEntries[0].value;
    if (scalarEntries.length === 0) {
      throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `${storeKind} symbol "${key}" has no scalar value to resolve.`);
    }
    throw new NodeToolError(
      "SYMBOL_RESOLUTION_FAILED",
      `${storeKind} symbol "${key}" is ambiguous; use an explicit field selector.`
    );
  }
  async loadSymbolStore(kind, cache) {
    if (cache[kind] !== void 0) return cache[kind];
    const fileName = kind === "contact" ? "contacts.json" : kind === "account" ? "accounts.json" : kind === "secret" ? "secrets.json" : "user.json";
    const loaded = await this.readJsonUnknown(path3.join(this.symbolStoreDir, fileName));
    cache[kind] = loaded;
    return loaded;
  }
  lookupContactRecord(raw, key) {
    if (Array.isArray(raw)) {
      const row = raw.find((item) => asString(asObject3(item).key) === key);
      const obj = asObject3(row);
      return Object.keys(obj).length > 0 ? obj : null;
    }
    const map = asObject3(raw);
    if (key in map) {
      const obj = asObject3(map[key]);
      if (Object.keys(obj).length > 0) return obj;
    }
    return null;
  }
  pickContactValue(record, field) {
    if (field) return this.scalarToString(record[field]);
    const preferredFields = ["name", "email", "phone", "firstName", "lastName"];
    for (const candidate of preferredFields) {
      const value = this.scalarToString(record[candidate]);
      if (value !== null) return value;
    }
    for (const [candidate, value] of Object.entries(record)) {
      if (candidate === "key") continue;
      const scalar = this.scalarToString(value);
      if (scalar !== null) return scalar;
    }
    return null;
  }
  scalarToString(value) {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return null;
  }
  appendProcessLog(entry, chunk, stream) {
    if (!chunk) return;
    const line = chunk;
    entry.logs += line;
    if (entry.logs.length > MAX_PROCESS_LOG_CHARS) {
      entry.logs = entry.logs.slice(entry.logs.length - MAX_PROCESS_LOG_CHARS);
    }
    this.stateStore.updateProcessLogs(entry.processId, entry.logs, Date.now());
    this.sendSignedEnvelope({
      type: "event",
      event: "log.append",
      payload: {
        processId: entry.processId,
        stream,
        chunk: truncateOutput(line, 8e3),
        ts: Date.now()
      }
    });
  }
  finishProcess(entry, exitCode, signal) {
    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = null;
    }
    if (entry.killTimer) {
      clearTimeout(entry.killTimer);
      entry.killTimer = null;
    }
    entry.child = null;
    entry.exitCode = exitCode;
    entry.signal = signal ? String(signal) : null;
    entry.endedAt = Date.now();
    if (entry.cancelRequested) {
      entry.status = "cancelled";
    } else if ((exitCode ?? 0) === 0) {
      entry.status = "completed";
    } else {
      entry.status = "failed";
    }
    if (entry.firewallMode !== "transparent") {
      const safeSummary = this.buildSafeSummary(entry.logs);
      const commandName = parseCommandName(entry.command);
      const reference = this.createHermesReference({
        sourceType: "process.output",
        processId: entry.processId,
        toolName: "system.run",
        title: commandName ? `process ${commandName}` : "process output",
        safeSummary,
        metadata: {
          mode: entry.firewallMode,
          status: entry.status,
          exitCode: entry.exitCode,
          signal: entry.signal
        }
      });
      entry.hermesReferences = [reference];
      const routing = asObject3(entry.routing ?? {});
      entry.routing = {
        ...routing,
        firewallMode: entry.firewallMode,
        hermesReferences: entry.hermesReferences
      };
    }
    this.persistProcess(entry);
    this.queueTerminalProcessUpdate(entry, "process_finished");
  }
  persistProcess(entry) {
    const record = {
      processId: entry.processId,
      status: entry.status,
      command: entry.command,
      cwd: entry.cwd,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      exitCode: entry.exitCode,
      signal: entry.signal,
      cancelRequested: entry.cancelRequested,
      timeoutMs: entry.timeoutMs,
      logs: entry.logs,
      routing: entry.routing
    };
    this.stateStore.upsertProcess(record, Date.now());
  }
  resolveFirewallSession(routing) {
    const nowMs = Date.now();
    const requestedSessionId = asString(routing.firewallSession);
    if (requestedSessionId) {
      const existing = this.stateStore.getFirewallSession(requestedSessionId, nowMs);
      if (existing) {
        const touched = this.stateStore.touchFirewallSession(
          requestedSessionId,
          nowMs,
          FIREWALL_SESSION_TTL_MS
        );
        const current = touched ?? existing;
        return {
          sessionId: current.sessionId,
          quarantineState: current.quarantineState,
          reused: true
        };
      }
      this.log(`firewall session missing_or_expired id=${requestedSessionId}; creating replacement`);
    }
    const created = this.createFirewallSession(nowMs);
    return {
      sessionId: created.sessionId,
      quarantineState: created.quarantineState,
      reused: false
    };
  }
  createFirewallSession(nowMs) {
    const sessionId = `fw_${randomUUID3().replace(/-/g, "").slice(0, 20)}`;
    const quarantineState = this.currentPolicyDefaultQuarantine();
    const firewallMode = this.currentPolicyFirewallMode();
    return this.stateStore.createFirewallSession({
      sessionId,
      quarantineState,
      nowMs,
      ttlMs: FIREWALL_SESSION_TTL_MS,
      metadata: {
        source: "policy.defaultQuarantine",
        firewallMode,
        policyUpdatedAt: asNumber(this.policy.updatedAt) ?? nowMs
      }
    });
  }
  mapReferenceSummary(record) {
    return {
      refId: record.refId,
      sourceType: record.sourceType,
      title: record.title ?? null,
      safeSummary: record.safeSummary,
      metadata: record.metadata ?? null
    };
  }
  createHermesReference(params) {
    const nowMs = Date.now();
    const created = this.stateStore.createReference({
      sourceType: params.sourceType,
      processId: params.processId ?? null,
      toolName: params.toolName ?? null,
      title: params.title ?? null,
      safeSummary: params.safeSummary,
      metadata: params.metadata ?? null,
      nowMs
    });
    return this.mapReferenceSummary(created);
  }
  buildSafeSummary(value) {
    const normalized = value.replace(/\r/g, "");
    const charCount = normalized.length;
    if (charCount <= 0) {
      return "Sanitized output withheld by firewall mode (no output).";
    }
    const lineCount = normalized.split("\n").length;
    return `Sanitized output withheld by firewall mode (${lineCount} line(s), ${charCount} char(s)).`;
  }
  enforceHermesCommandPolicy(params) {
    if (params.firewallMode !== "hermes") return;
    const denyCommands = this.currentPolicyDenyCommands();
    if (!denyCommands.includes(params.commandName)) return;
    this.writeAuditEvent({
      type: "policy.deny",
      processId: params.processId ?? null,
      firewallSession: params.firewallSession ?? null,
      toolName: params.toolName,
      details: {
        mode: params.firewallMode,
        reason: "command_denied",
        commandName: params.commandName,
        denyCommands
      }
    });
    throw new NodeToolError(
      "HERMES_POLICY_DENIED",
      JSON.stringify(
        {
          code: "HERMES_POLICY_DENIED",
          mode: params.firewallMode,
          decision: "deny",
          reason: "command_denied",
          commandName: params.commandName,
          denyCommands
        },
        null,
        2
      ),
      false
    );
  }
  readProcessFirewallMode(routing) {
    return parseFirewallMode(asString(asObject3(routing ?? {}).firewallMode), "transparent");
  }
  readProcessHermesReferences(routing) {
    const refsRaw = asObject3(routing ?? {}).hermesReferences;
    if (!Array.isArray(refsRaw)) return [];
    const out = [];
    for (const item of refsRaw) {
      const obj = asObject3(item);
      const refId = asString(obj.refId);
      const sourceType = asString(obj.sourceType);
      const safeSummary = asString(obj.safeSummary);
      if (!refId || !sourceType || !safeSummary) continue;
      const metadataObj = asObject3(obj.metadata);
      out.push({
        refId,
        sourceType,
        title: asString(obj.title) ?? null,
        safeSummary,
        metadata: Object.keys(metadataObj).length > 0 ? metadataObj : null
      });
    }
    return out;
  }
  resolveProcessHermesReferences(entry) {
    if (entry.hermesReferences.length > 0) return entry.hermesReferences;
    const refs = this.stateStore.listReferencesByProcessId(entry.processId, 20).map((row) => this.mapReferenceSummary(row));
    if (refs.length > 0) {
      entry.hermesReferences = refs;
    }
    return entry.hermesReferences;
  }
  writeAuditEvent(params) {
    try {
      this.stateStore.appendAuditEvent({
        createdAt: params.createdAt ?? Date.now(),
        type: params.type,
        processId: params.processId ?? null,
        firewallSession: params.firewallSession ?? null,
        actor: params.actor ?? this.senderId,
        toolName: params.toolName ?? null,
        details: params.details ?? null
      });
    } catch (err) {
      this.log(
        `audit append failed type=${params.type} error=${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  queueTerminalProcessUpdate(entry, reason) {
    const deliveryId = `dlv_${randomUUID3().replace(/-/g, "").slice(0, 20)}`;
    const hermesEnabled = entry.firewallMode !== "transparent";
    const summary = hermesEnabled ? this.buildSafeSummary(entry.logs) : truncateOutput(entry.logs, 6e3);
    const references = hermesEnabled ? this.resolveProcessHermesReferences(entry) : [];
    const payload = {
      processId: entry.processId,
      status: entry.status,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      exitCode: entry.exitCode,
      signal: entry.signal,
      summary,
      deliveryId,
      deliveryReason: reason,
      ts: Date.now(),
      firewallMode: entry.firewallMode,
      ...hermesEnabled ? {
        hermes: {
          mode: entry.firewallMode,
          sanitized: true,
          references
        }
      } : {},
      ...entry.routing ? { routing: entry.routing } : {}
    };
    this.stateStore.enqueueOutbox({
      deliveryId,
      processId: entry.processId,
      payload,
      createdAt: Date.now()
    });
    if (this.ready) this.sendOutboxEntry({ deliveryId, processId: entry.processId, payload, createdAt: Date.now(), delivered: false, deliveredAt: null });
  }
  sendOutboxEntry(entry) {
    return this.sendSignedEnvelope({
      type: "event",
      event: "process.update",
      payload: entry.payload
    });
  }
  drainOutbox(source) {
    if (!this.ready || this.drainingOutbox) return;
    this.drainingOutbox = true;
    try {
      const pending = this.stateStore.listUndelivered(250);
      let sent = 0;
      for (const entry of pending) {
        const ok = this.sendOutboxEntry(entry);
        if (!ok) break;
        sent += 1;
      }
      if (pending.length > 0) {
        this.log(`outbox drain source=${source} pending=${pending.length} sent=${sent}`);
      }
    } finally {
      this.drainingOutbox = false;
    }
  }
  emitProcessUpdate(entry, status) {
    this.sendSignedEnvelope({
      type: "event",
      event: "process.update",
      payload: {
        processId: entry.processId,
        status,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        exitCode: entry.exitCode,
        signal: entry.signal,
        firewallMode: entry.firewallMode,
        ts: Date.now()
      }
    });
  }
  serializeProcess(entry, includeLogs) {
    const hermesReferences = entry.firewallMode !== "transparent" ? this.resolveProcessHermesReferences(entry) : [];
    return {
      processId: entry.processId,
      command: entry.command,
      cwd: entry.cwd,
      status: entry.status,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      exitCode: entry.exitCode,
      signal: entry.signal,
      cancelRequested: entry.cancelRequested,
      timeoutMs: entry.timeoutMs,
      logChars: entry.logs.length,
      firewallMode: entry.firewallMode,
      ...includeLogs ? { logs: entry.logs } : {},
      ...entry.firewallMode !== "transparent" ? {
        hermes: {
          mode: entry.firewallMode,
          sanitized: true,
          references: hermesReferences
        }
      } : {},
      ...entry.routing ? { routing: entry.routing } : {}
    };
  }
  cancelProcess(entry, params) {
    var _a, _b;
    entry.cancelRequested = true;
    this.persistProcess(entry);
    if (!entry.child || entry.status !== "running") return;
    try {
      entry.child.kill(params.signal);
    } catch {
    }
    this.appendProcessLog(entry, `cancel requested (${params.reason}) using ${params.signal}
`, "stderr");
    if (params.signal !== "SIGKILL" && params.killAfterMs > 0) {
      if (entry.killTimer) clearTimeout(entry.killTimer);
      entry.killTimer = setTimeout(() => {
        if (!entry.child || entry.status !== "running") return;
        try {
          entry.child.kill("SIGKILL");
        } catch {
        }
      }, params.killAfterMs);
      (_b = (_a = entry.killTimer).unref) == null ? void 0 : _b.call(_a);
    }
  }
  terminateAllProcesses(reason) {
    for (const entry of this.processes.values()) {
      if (entry.timeoutTimer) {
        clearTimeout(entry.timeoutTimer);
        entry.timeoutTimer = null;
      }
      if (entry.killTimer) {
        clearTimeout(entry.killTimer);
        entry.killTimer = null;
      }
      if (entry.child && entry.status === "running") {
        this.cancelProcess(entry, {
          signal: "SIGTERM",
          reason: `node shutdown: ${reason}`,
          killAfterMs: 2e3
        });
        this.appendProcessLog(entry, `node shutdown requested while process was running
`, "stderr");
        continue;
      }
      if (entry.status === "queued") {
        entry.status = "cancelled";
        entry.cancelRequested = true;
        entry.endedAt = Date.now();
        this.appendProcessLog(entry, `node shutdown before process start: ${reason}
`, "stderr");
        this.persistProcess(entry);
        this.queueTerminalProcessUpdate(entry, "shutdown_queued");
      }
    }
  }
  sendCapsAdvertise() {
    if (!this.ready) return;
    const firewallMode = this.currentPolicyFirewallMode();
    this.sendSignedEnvelope({
      type: "event",
      event: "caps.advertise",
      payload: {
        capabilities: this.advertisedCapabilities(),
        tags: ["reference-node"],
        firewallMode,
        timestamp: Date.now()
      }
    });
  }
  sendSignedEnvelope(envelope) {
    const ws = this.requireOpenSocket();
    if (!ws) return false;
    const withMeta = {
      ...envelope,
      ts: Date.now(),
      sender: this.senderId
    };
    const sig = signEnvelope(withMeta, this.identity.privateKey);
    try {
      ws.send(
        JSON.stringify({
          ...withMeta,
          sig
        })
      );
      return true;
    } catch {
      return false;
    }
  }
  get senderId() {
    return `node:${this.config.nodeId}`;
  }
  requireOpenSocket() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return null;
    return this.ws;
  }
  closeSocket(code, reason) {
    if (!this.ws) return;
    try {
      this.ws.close(code, truncateOutput(reason, 120));
    } catch {
      try {
        this.ws.terminate();
      } catch {
      }
    }
  }
  log(line) {
    this.logger.info(line);
  }
};
function parseArgs(argv) {
  const values = {};
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).trim();
    const next = argv[i + 1];
    if (!key) continue;
    if (!next || next.startsWith("--")) {
      values[key] = "true";
      continue;
    }
    values[key] = next;
    i += 1;
  }
  return { help, values };
}
async function loadEnvFileIntoProcessEnv(filePath) {
  try {
    const raw = await fs3.readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/);
    for (const lineRaw of lines) {
      const line = lineRaw.trim();
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }
      if (!key || process2.env[key] !== void 0) continue;
      process2.env[key] = value;
    }
  } catch (err) {
    const code = err == null ? void 0 : err.code;
    if (code !== "ENOENT") throw err;
  }
}
var ReferenceNodeLogger = class _ReferenceNodeLogger {
  constructor(config) {
    this.config = config;
  }
  writeQueue = Promise.resolve();
  static async create(config) {
    await fs3.mkdir(path3.dirname(config.logFilePath), { recursive: true });
    return new _ReferenceNodeLogger(config);
  }
  info(message, fields = {}) {
    this.write("info", message, fields);
  }
  warn(message, fields = {}) {
    this.write("warn", message, fields);
  }
  error(message, fields = {}) {
    this.write("error", message, fields);
  }
  write(level, message, fields) {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    const line = this.config.logFormat === "json" ? JSON.stringify({ ts, level, component: "reference-node", msg: message, ...fields }) : `[reference-node] ${ts} ${message}`;
    process2.stdout.write(`${line}
`);
    this.writeQueue = this.writeQueue.then(async () => {
      await this.rotateIfNeeded(Buffer.byteLength(`${line}
`, "utf8"));
      await fs3.appendFile(this.config.logFilePath, `${line}
`, "utf8");
    }).catch(() => void 0);
  }
  async rotateIfNeeded(incomingBytes) {
    if (this.config.logMaxBytes <= 0) return;
    let currentSize = 0;
    try {
      const stat = await fs3.stat(this.config.logFilePath);
      currentSize = stat.size;
    } catch {
      currentSize = 0;
    }
    if (currentSize + incomingBytes <= this.config.logMaxBytes) return;
    const maxFiles = Math.max(1, this.config.logMaxFiles);
    for (let i = maxFiles - 1; i >= 1; i -= 1) {
      const src = `${this.config.logFilePath}.${i}`;
      const dest = `${this.config.logFilePath}.${i + 1}`;
      if (!fsSync.existsSync(src)) continue;
      try {
        await fs3.rename(src, dest);
      } catch {
      }
    }
    try {
      await fs3.rename(this.config.logFilePath, `${this.config.logFilePath}.1`);
    } catch {
    }
  }
};
var FORCE_JSON_BUNDLE = typeof __NEXUS_LITE_BUNDLE__ !== "undefined" && __NEXUS_LITE_BUNDLE__;
var openStateStore = FORCE_JSON_BUNDLE ? async (stateDir) => {
  const mod = await Promise.resolve().then(() => (init_state_store_json(), state_store_json_exports));
  return await mod.ReferenceNodeJsonStateStore.open(stateDir);
} : async (stateDir, stateBackend) => {
  if (stateBackend === "json") {
    const mod2 = await Promise.resolve().then(() => (init_state_store_json(), state_store_json_exports));
    return await mod2.ReferenceNodeJsonStateStore.open(stateDir);
  }
  const mod = await Promise.resolve().then(() => (init_state_store(), state_store_exports));
  return await mod.ReferenceNodeStateStore.open(stateDir);
};
async function initializeNodeBootstrap(config, logger) {
  await fs3.mkdir(config.stateDir, { recursive: true });
  await fs3.mkdir(path3.dirname(config.logFilePath), { recursive: true });
  const identity = await loadOrCreateIdentity(config.stateDir);
  const store = await openStateStore(config.stateDir, config.stateBackend);
  store.close();
  const policyPath = path3.join(config.stateDir, "hermes-policy.json");
  try {
    await fs3.access(policyPath);
  } catch {
    await fs3.writeFile(policyPath, `${JSON.stringify({ ...DEFAULT_POLICY_DOC, updatedAt: Date.now() }, null, 2)}
`, {
      mode: 384,
      encoding: "utf8"
    });
  }
  await writeInitEnvFile(config, identity.fingerprint, logger);
  logger.info(`init backend=${config.stateBackend} state_dir=${config.stateDir} env_file=${config.initEnvFilePath}`);
  logger.info("next step: start with --doctor (or --doctor --doctor-continue to run immediately)");
}
async function writeInitEnvFile(config, fingerprint, logger) {
  try {
    await fs3.access(config.initEnvFilePath);
    logger.info(`init env exists path=${config.initEnvFilePath}; leaving unchanged`);
    return;
  } catch {
  }
  await fs3.mkdir(path3.dirname(config.initEnvFilePath), { recursive: true });
  const template = [
    "# Bootstrap environment for Nexus reference node",
    `NEXUS_NODE_GATEWAY_URL=${config.gatewayUrl}`,
    "# Optional for wss:// self-signed gateways",
    "# NEXUS_NODE_GATEWAY_TLS_FINGERPRINT=AB:CD:...",
    `NEXUS_NODE_STATE_DIR=${config.stateDir}`,
    `NEXUS_NODE_STATE_BACKEND=${config.stateBackend}`,
    `NEXUS_NODE_PROFILE=${config.profile}`,
    `NEXUS_NODE_ID=${config.nodeId}`,
    `NEXUS_NODE_NAME=${config.displayName}`,
    `NEXUS_NODE_CAPS=${config.capabilities.join(",")}`,
    `NEXUS_NODE_ALLOW_COMMANDS=${[...config.allowCommands].join(",")}`,
    `NEXUS_NODE_LOG_FORMAT=${config.logFormat}`,
    `NEXUS_NODE_LOG_FILE=${config.logFilePath}`,
    `NEXUS_NODE_LOG_MAX_BYTES=${config.logMaxBytes}`,
    `NEXUS_NODE_LOG_MAX_FILES=${config.logMaxFiles}`,
    `NEXUS_NODE_MCP_BRIDGE=${config.mcpBridgeEnabled ? "1" : "0"}`,
    `NEXUS_NODE_MCP_BRIDGE_CONFIG=${config.mcpBridgeConfigPath}`,
    `NEXUS_NODE_WEBHOOK_HOST=${config.webhookHost}`,
    `NEXUS_NODE_WEBHOOK_PORT=${config.webhookEnabled ? String(config.webhookPort) : "0"}`,
    `NEXUS_NODE_WEBHOOK_PATH=${config.webhookPath}`,
    `NEXUS_NODE_WEBHOOK_MAX_BODY_BYTES=${config.webhookMaxBodyBytes}`,
    "# Optional static bearer token for local webhook ingress",
    "# NEXUS_NODE_WEBHOOK_TOKEN=change-me",
    "",
    `# Generated node fingerprint: ${fingerprint}`,
    ""
  ].join("\n");
  await fs3.writeFile(config.initEnvFilePath, template, { mode: 384, encoding: "utf8" });
  logger.info(`init wrote env template path=${config.initEnvFilePath}`);
}
async function runDoctorChecks(config, logger) {
  const results = [];
  const nodeMajor = Number.parseInt(process2.versions.node.split(".")[0] ?? "0", 10);
  results.push({
    check: "node.version",
    ok: Number.isFinite(nodeMajor) && nodeMajor >= 22,
    detail: `node=${process2.versions.node} required>=22`
  });
  try {
    await fs3.mkdir(config.stateDir, { recursive: true });
    const probePath = path3.join(config.stateDir, `.doctor-write-${process2.pid}-${Date.now()}`);
    await fs3.writeFile(probePath, "ok\n", { mode: 384, encoding: "utf8" });
    await fs3.rm(probePath, { force: true });
    results.push({ check: "state.writable", ok: true, detail: config.stateDir });
  } catch (err) {
    results.push({
      check: "state.writable",
      ok: false,
      detail: err instanceof Error ? err.message : String(err)
    });
  }
  const gatewayProbe = await probeGateway(config.gatewayUrl, 3e3);
  results.push({
    check: "gateway.reachable",
    ok: gatewayProbe.ok,
    detail: gatewayProbe.detail
  });
  try {
    const store = await openStateStore(config.stateDir, config.stateBackend);
    store.close();
    results.push({ check: "state.backend", ok: true, detail: config.stateBackend });
  } catch (err) {
    results.push({
      check: "state.backend",
      ok: false,
      detail: err instanceof Error ? err.message : String(err)
    });
  }
  if (isAllowedCommand(SHELLCTL_COMMAND, config.allowCommands)) {
    const tmuxProbe = await runTmuxCommand(["-V"]);
    const tmuxOk = tmuxProbe.ok;
    const detail = tmuxOk ? truncateOutput(tmuxProbe.stdout || "tmux available", 180) : truncateOutput(tmuxProbe.stderr || tmuxProbe.errorMessage || "tmux not available", 180);
    results.push({ check: "tmux.available", ok: tmuxOk, detail });
  } else {
    results.push({
      check: "tmux.available",
      ok: true,
      detail: `${SHELLCTL_COMMAND} not allowlisted; tmux is optional`
    });
  }
  for (const result of results) {
    if (result.ok) {
      logger.info(`doctor ok check=${result.check} detail=${result.detail}`);
    } else {
      logger.error(`doctor fail check=${result.check} detail=${result.detail}`);
    }
  }
  return {
    ok: results.every((result) => result.ok),
    results
  };
}
async function probeGateway(gatewayUrl, timeoutMs) {
  let parsed;
  try {
    parsed = new URL(gatewayUrl);
  } catch {
    return { ok: false, detail: `invalid gateway URL: ${gatewayUrl}` };
  }
  const host = parsed.hostname;
  const port = Number(parsed.port || (parsed.protocol === "wss:" ? "443" : "80"));
  if (!host || !Number.isFinite(port) || port <= 0) {
    return { ok: false, detail: `invalid host/port host=${host} port=${String(parsed.port || "")}` };
  }
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, detail: `timeout connecting ${host}:${port}` });
    }, Math.max(500, timeoutMs));
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: true, detail: `${host}:${port}` });
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: false, detail: truncateOutput(err.message || String(err), 200) });
    });
  });
}
function isTruthyFlag(value) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
function parseStateBackend(value) {
  switch ((value || "").trim()) {
    case "sqlite":
    case "json":
      return value.trim();
    default:
      throw new Error(`Invalid state backend: ${value}. Expected sqlite or json.`);
  }
}
function parseNodeProfile(value) {
  switch ((value || "").trim()) {
    case "standard":
    case "minimal":
      return value.trim();
    default:
      throw new Error(`Invalid profile: ${value}. Expected standard or minimal.`);
  }
}
function parseLogFormat(value) {
  switch ((value || "").trim()) {
    case "text":
    case "json":
      return value.trim();
    default:
      throw new Error(`Invalid log format: ${value}. Expected text or json.`);
  }
}
function normalizeWebhookPath(value) {
  const raw = (value ?? "").trim();
  if (!raw) return "/node-webhook";
  return raw.startsWith("/") ? raw : `/${raw}`;
}
function buildConfig(values, options = {}) {
  const hostId = os.hostname().replace(/[^a-zA-Z0-9_-]/g, "-");
  const profileRaw = options.forceProfile ?? values.profile ?? process2.env.NEXUS_NODE_PROFILE ?? "standard";
  const profile = parseNodeProfile(profileRaw);
  const nodeId = values["node-id"] ?? process2.env.NEXUS_NODE_ID ?? `reference-${hostId}`;
  const displayName = values.name ?? process2.env.NEXUS_NODE_NAME ?? "Nexus Reference Node";
  const gatewayUrl = values.gateway ?? process2.env.NEXUS_NODE_GATEWAY_URL ?? "ws://127.0.0.1:18789/nx/nodes";
  const gatewayTlsFingerprintRaw = values["gateway-tls-fingerprint"] ?? process2.env.NEXUS_NODE_GATEWAY_TLS_FINGERPRINT ?? "";
  const gatewayTlsFingerprint = normalizeFingerprint256(gatewayTlsFingerprintRaw);
  if (gatewayTlsFingerprintRaw.trim() && !gatewayTlsFingerprint) {
    throw new Error(
      "Invalid gateway TLS fingerprint format. Expected SHA-256 fingerprint with 64 hex chars (with or without ':' separators)."
    );
  }
  const insecureAllowNonLoopbackWs = (values["insecure-allow-nonloopback-ws"] ?? process2.env.NEXUS_NODE_INSECURE_ALLOW_NONLOOPBACK_WS ?? "").trim() === "1";
  validateGatewayTransportPolicy({
    gatewayUrl,
    gatewayTlsFingerprint,
    insecureAllowNonLoopbackWs
  });
  const stateDir = values["state-dir"] ?? process2.env.NEXUS_NODE_STATE_DIR ?? path3.join(os.homedir(), ".nexus-node");
  const resolvedStateDir = path3.resolve(stateDir);
  const stateBackendRaw = options.forceStateBackend ?? values["state-backend"] ?? process2.env.NEXUS_NODE_STATE_BACKEND ?? (profile === "minimal" ? "json" : "sqlite");
  const stateBackend = parseStateBackend(stateBackendRaw);
  const policyRequired = (values["policy-required"] ?? process2.env.NEXUS_NODE_POLICY_REQUIRED ?? "").trim() === "1";
  const capabilities = splitCsv(values.caps ?? process2.env.NEXUS_NODE_CAPS, DEFAULT_CAPABILITIES);
  const allowCommands = new Set(
    splitCsv(values.allow ?? process2.env.NEXUS_NODE_ALLOW_COMMANDS, DEFAULT_ALLOW_COMMANDS)
  );
  const legacyFileTransferSetting = (values["allow-file-transfer"] ?? process2.env.NEXUS_NODE_ALLOW_FILE_TRANSFER ?? "").trim();
  if (legacyFileTransferSetting) {
    throw new Error(
      `NEXUS_NODE_ALLOW_FILE_TRANSFER/--allow-file-transfer is no longer supported. Allowlist ${FILE_PULL_COMMAND},${FILE_PUSH_COMMAND} via NEXUS_NODE_ALLOW_COMMANDS or --allow instead.`
    );
  }
  const runTimeoutMs = clampInt(values["run-timeout-ms"] ?? process2.env.NEXUS_NODE_RUN_TIMEOUT_MS, 1e3, 3e5) ?? 6e4;
  const reconnectMinMs = clampInt(values["reconnect-min-ms"] ?? process2.env.NEXUS_NODE_RECONNECT_MIN_MS, 500, 6e4) ?? 2e3;
  const reconnectMaxMs = clampInt(values["reconnect-max-ms"] ?? process2.env.NEXUS_NODE_RECONNECT_MAX_MS, reconnectMinMs, 3e5) ?? 3e4;
  const maxClockSkewMs = clampInt(values["max-clock-skew-ms"] ?? process2.env.NEXUS_NODE_MAX_CLOCK_SKEW_MS, 5e3, 6e5) ?? 12e4;
  const insecureSkipGatewayProof = (values["insecure-skip-gateway-proof"] ?? process2.env.NEXUS_NODE_INSECURE_SKIP_GATEWAY_PROOF ?? "").trim() === "1";
  const rawMcpBridge = values["mcp-bridge"] ?? process2.env.NEXUS_NODE_MCP_BRIDGE;
  const mcpBridgeEnabled = (rawMcpBridge ?? "").trim() === "1";
  const mcpBridgeConfigPath = path3.resolve(
    values["mcp-bridge-config"] ?? process2.env.NEXUS_NODE_MCP_BRIDGE_CONFIG ?? path3.join(resolvedStateDir, MCP_BRIDGE_CONFIG_FILE)
  );
  const mcpBridgeTimeoutMs = clampInt(values["mcp-bridge-timeout-ms"] ?? process2.env.NEXUS_NODE_MCP_BRIDGE_TIMEOUT_MS, 2e3, 3e5) ?? 3e4;
  const fileTransferRoots = normalizeFileTransferRoots(
    values["file-transfer-roots"] ?? process2.env.NEXUS_NODE_FILE_TRANSFER_ROOTS,
    resolvedStateDir
  );
  const fileTransferMaxBytes = clampInt(values["file-transfer-max-bytes"] ?? process2.env.NEXUS_NODE_FILE_TRANSFER_MAX_BYTES, 1024, 50 * 1024 * 1024) ?? DEFAULT_FILE_TRANSFER_MAX_BYTES;
  const logFormat = parseLogFormat(
    values["log-format"] ?? process2.env.NEXUS_NODE_LOG_FORMAT ?? (profile === "minimal" ? "json" : "text")
  );
  const logFilePath = path3.resolve(
    values["log-file"] ?? process2.env.NEXUS_NODE_LOG_FILE ?? path3.join(resolvedStateDir, "logs", "reference-node.log")
  );
  const logMaxBytes = clampInt(values["log-max-bytes"] ?? process2.env.NEXUS_NODE_LOG_MAX_BYTES, 64 * 1024, 64 * 1024 * 1024) ?? 5 * 1024 * 1024;
  const logMaxFiles = clampInt(values["log-max-files"] ?? process2.env.NEXUS_NODE_LOG_MAX_FILES, 1, 50) ?? 5;
  const initEnvFilePath = path3.resolve(
    values["env-file"] ?? process2.env.NEXUS_NODE_ENV_FILE ?? path3.join(resolvedStateDir, "reference-node.env")
  );
  const webhookHost = (values["webhook-host"] ?? process2.env.NEXUS_NODE_WEBHOOK_HOST ?? "127.0.0.1").trim() || "127.0.0.1";
  const webhookPort = clampInt(values["webhook-port"] ?? process2.env.NEXUS_NODE_WEBHOOK_PORT, 0, 65535) ?? 0;
  const webhookPath = normalizeWebhookPath(values["webhook-path"] ?? process2.env.NEXUS_NODE_WEBHOOK_PATH);
  const webhookTokenRaw = values["webhook-token"] ?? process2.env.NEXUS_NODE_WEBHOOK_TOKEN ?? "";
  const webhookToken = webhookTokenRaw.trim() ? webhookTokenRaw.trim() : null;
  const webhookMaxBodyBytes = clampInt(values["webhook-max-bytes"] ?? process2.env.NEXUS_NODE_WEBHOOK_MAX_BODY_BYTES, 1024, 10 * 1024 * 1024) ?? 256 * 1024;
  return {
    gatewayUrl,
    gatewayTlsFingerprint,
    stateDir: resolvedStateDir,
    stateBackend,
    profile,
    policyRequired,
    nodeId,
    displayName,
    capabilities,
    allowCommands,
    runTimeoutMs,
    reconnectMinMs,
    reconnectMaxMs,
    maxClockSkewMs,
    insecureAllowNonLoopbackWs,
    insecureSkipGatewayProof,
    mcpBridgeEnabled,
    mcpBridgeConfigPath,
    mcpBridgeTimeoutMs,
    fileTransferRoots,
    fileTransferMaxBytes,
    logFormat,
    logFilePath,
    logMaxBytes,
    logMaxFiles,
    initEnvFilePath,
    webhookEnabled: webhookPort > 0,
    webhookHost,
    webhookPort,
    webhookPath,
    webhookToken,
    webhookMaxBodyBytes
  };
}
function validateGatewayTransportPolicy(params) {
  let parsed;
  try {
    parsed = new URL(params.gatewayUrl);
  } catch {
    throw new Error(`Invalid gateway URL: ${params.gatewayUrl}`);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`Gateway URL must use ws:// or wss:// (got ${parsed.protocol}).`);
  }
  const loopback = isLoopbackHost(parsed.hostname);
  if (!loopback && parsed.protocol !== "wss:" && !params.insecureAllowNonLoopbackWs) {
    throw new Error(
      `TLS is required for non-loopback gateway endpoints. Use wss:// for ${parsed.hostname} or set NEXUS_NODE_INSECURE_ALLOW_NONLOOPBACK_WS=1 for debug-only development.`
    );
  }
  if (parsed.protocol === "ws:" && params.gatewayTlsFingerprint) {
    throw new Error("Gateway TLS fingerprint pinning requires a wss:// gateway URL.");
  }
}
function isLoopbackHost(hostname) {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1") return true;
  if (normalized === "host.docker.internal") return true;
  if (normalized.startsWith("127.")) return true;
  return normalized.endsWith(".localhost");
}
function normalizeFingerprint256(value) {
  var _a;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hex = trimmed.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  if (hex.length !== 64) return null;
  return ((_a = hex.match(/.{1,2}/g)) == null ? void 0 : _a.join(":")) ?? null;
}
async function loadOrCreateIdentity(stateDir) {
  const authDir = path3.join(stateDir, "auth");
  const privateKeyPath = path3.join(authDir, "node-ed25519-private.pem");
  const publicKeyPath = path3.join(authDir, "node-ed25519-public.pem");
  await fs3.mkdir(authDir, { recursive: true });
  let privatePem = null;
  let publicPem = null;
  try {
    privatePem = await fs3.readFile(privateKeyPath, "utf8");
    publicPem = await fs3.readFile(publicKeyPath, "utf8");
  } catch {
    const pair = generateKeyPairSync("ed25519");
    privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    publicPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    await fs3.writeFile(privateKeyPath, privatePem, { mode: 384 });
    await fs3.writeFile(publicKeyPath, publicPem, { mode: 420 });
  }
  const privateKey = createPrivateKey(privatePem);
  const publicKey = createPublicKey(publicPem);
  const parsed = parsePublicKey(publicPem);
  if (!parsed) throw new Error("Failed to parse generated node public key.");
  return {
    privateKey,
    publicKey,
    publicKeyRaw: parsed.raw,
    fingerprint: parsed.fingerprint,
    privateKeyPath,
    publicKeyPath
  };
}
function parseEnvelope(value) {
  const type = asString(value.type);
  const ts = asNumber(value.ts);
  const sender = asString(value.sender);
  const sig = asString(value.sig);
  if (!type || !ts || !sender || !sig) return null;
  if (type === "req") {
    const id = asString(value.id);
    const method = asString(value.method);
    if (!id || !method) return null;
    return {
      type: "req",
      id,
      ts,
      sender,
      sig,
      method,
      params: value.params
    };
  }
  if (type === "res") {
    const ok = value.ok;
    if (typeof ok !== "boolean") return null;
    return {
      type: "res",
      id: asString(value.id),
      ts,
      sender,
      sig,
      ok,
      payload: value.payload,
      error: asObject3(value.error)
    };
  }
  if (type === "event") {
    const event = asString(value.event);
    if (!event) return null;
    return {
      type: "event",
      ts,
      sender,
      sig,
      event,
      payload: value.payload
    };
  }
  return null;
}
function verifyEnvelopeSignature(envelope, publicKey) {
  const sig = asString(envelope.sig);
  if (!sig) return false;
  return verifyDetachedPayload(withoutSig(envelope), sig, publicKey);
}
function buildHandshakeTranscript(params) {
  return {
    protocol: "nexus-node-v1",
    kind: "connect-proof",
    nodeId: params.nodeId,
    sessionId: params.sessionId,
    nodeNonce: params.nodeNonce,
    gatewayNonce: params.gatewayNonce
  };
}
async function execShell(paramsCommand, opts) {
  return await new Promise((resolve) => {
    exec(
      paramsCommand,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        env: opts.env ? { ...process2.env, ...opts.env } : process2.env,
        maxBuffer: 10 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({
            stdout,
            stderr,
            exitCode: 0,
            signal: null,
            timedOut: false
          });
          return;
        }
        const anyErr = err;
        const timedOut = Boolean(anyErr.killed) && (String(anyErr.message).toLowerCase().includes("timed out") || String(anyErr.code ?? "").toUpperCase() === "ETIMEDOUT");
        const exitCode = typeof anyErr.code === "number" ? anyErr.code : 1;
        resolve({
          stdout,
          stderr,
          exitCode,
          signal: anyErr.signal ?? null,
          timedOut
        });
      }
    );
  });
}
async function sleepMs(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
async function runTmuxCommand(args) {
  return await new Promise((resolve) => {
    execFile(
      "tmux",
      args,
      {
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({
            ok: true,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            rawCode: 0,
            errorMessage: null
          });
          return;
        }
        const anyErr = err;
        resolve({
          ok: false,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          rawCode: anyErr.code,
          errorMessage: anyErr.message ?? String(err)
        });
      }
    );
  });
}
function isAllowedCommand(commandName, allowCommands) {
  if (allowCommands.has("*")) return true;
  return allowCommands.has(commandName);
}
function hasDisallowedShellSyntax(command) {
  return /(?:&&|\|\||[;&|`$><\n\r])/.test(command);
}
function validateAllowlistedCommand(command, allowCommands) {
  if (hasDisallowedShellSyntax(command)) {
    return {
      ok: false,
      message: "Shell control operators are not allowed. Use a single allowlisted command without chaining, pipes, redirects, or substitutions."
    };
  }
  const commandName = parseCommandName(command);
  if (!commandName) {
    return {
      ok: false,
      message: "Unable to parse command name."
    };
  }
  if (!isAllowedCommand(commandName, allowCommands)) {
    return {
      ok: false,
      message: `Command "${commandName}" is not allowlisted for this node.`
    };
  }
  return {
    ok: true,
    commandName
  };
}
function parseCommandName(command) {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^([^\s]+)/);
  return (match == null ? void 0 : match[1]) ?? null;
}
function normalizeSignal(value) {
  switch (value) {
    case "SIGTERM":
    case "SIGINT":
    case "SIGKILL":
      return value;
    default:
      return null;
  }
}
function parseQuarantineState(value, fallback) {
  if (typeof value !== "string") return fallback;
  switch (value.trim()) {
    case "none":
      return "none";
    case "soft":
      return "soft";
    case "hard":
      return "hard";
    default:
      return fallback;
  }
}
function parseFirewallMode(value, fallback) {
  if (!value) return fallback;
  switch (value.trim()) {
    case "transparent":
      return "transparent";
    case "audit-only":
      return "audit-only";
    case "hermes":
      return "hermes";
    default:
      return fallback;
  }
}
function parsePolicyDenyCommands(value) {
  if (value === void 0 || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const commandName = parseCommandName(trimmed) ?? trimmed;
    if (!commandName) continue;
    out.push(commandName);
  }
  return [...new Set(out.values())].sort((a, b) => a.localeCompare(b));
}
function parsePolicyCtlCommand(command) {
  const tokens = parseCommandTokens(command);
  if (!tokens || tokens.length === 0 || tokens[0] !== POLICYCTL_COMMAND) {
    throw new NodeToolError(
      "INVALID_REQUEST",
      `${POLICYCTL_COMMAND} command is malformed. Expected: ${POLICYCTL_COMMAND} <show|apply-preset|set-mode|deny>.`
    );
  }
  const args = [];
  let breakGlass = false;
  for (const token of tokens.slice(1)) {
    if (token === "--break-glass") {
      breakGlass = true;
      continue;
    }
    args.push(token);
  }
  if (args.length === 0) {
    throw new NodeToolError(
      "INVALID_REQUEST",
      `${POLICYCTL_COMMAND} requires a subcommand: show | apply-preset <name> | set-mode <mode> | deny add|remove <command>.`
    );
  }
  if (args[0] === "show") {
    if (args.length !== 1) {
      throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} show does not accept extra arguments.`);
    }
    return { action: "show", breakGlass };
  }
  if (args[0] === "apply-preset") {
    if (args.length !== 2) {
      throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} apply-preset requires a preset name.`);
    }
    return { action: "apply-preset", presetName: args[1], breakGlass };
  }
  if (args[0] === "set-mode") {
    if (args.length !== 2) {
      throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} set-mode requires one mode argument.`);
    }
    const mode = asString(args[1]);
    if (!mode || mode !== "transparent" && mode !== "audit-only" && mode !== "hermes") {
      throw new NodeToolError(
        "INVALID_REQUEST",
        `${POLICYCTL_COMMAND} set-mode must be one of: transparent, audit-only, hermes.`
      );
    }
    return { action: "set-mode", mode, breakGlass };
  }
  if (args[0] === "deny") {
    if (args.length !== 3) {
      throw new NodeToolError(
        "INVALID_REQUEST",
        `${POLICYCTL_COMMAND} deny requires: deny add <command> | deny remove <command>.`
      );
    }
    const operation = args[1];
    const candidate = asString(args[2]) ?? "";
    const commandName = parseCommandName(candidate);
    if (!commandName || commandName !== candidate || !/^[A-Za-z0-9._-]+$/.test(commandName)) {
      throw new NodeToolError(
        "INVALID_REQUEST",
        `${POLICYCTL_COMMAND} deny command name must be a single token matching [A-Za-z0-9._-]+.`
      );
    }
    if (operation === "add") return { action: "deny-add", commandName, breakGlass };
    if (operation === "remove") return { action: "deny-remove", commandName, breakGlass };
    throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} deny operation must be add or remove.`);
  }
  throw new NodeToolError(
    "INVALID_REQUEST",
    `${POLICYCTL_COMMAND} subcommand ${args[0]} is not supported. Use show|apply-preset|set-mode|deny.`
  );
}
function shellCtlSessionNameFromId(sessionId) {
  const base = sessionId.length <= 44 ? sessionId : `${sessionId.slice(0, 36)}_${shortStableHash(sessionId)}`;
  return `nxsh_${base}`;
}
function parseShellCtlSessionId(value) {
  const trimmed = (value ?? "").trim();
  if (!SHELLCTL_SESSION_PATTERN.test(trimmed)) {
    throw new NodeToolError(
      "INVALID_REQUEST",
      `${SHELLCTL_COMMAND} session must match [A-Za-z0-9._-] and be 1-64 chars.`
    );
  }
  return trimmed;
}
function parseShellCtlInteger(value, flag) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num) || !Number.isInteger(num)) {
    throw new NodeToolError("INVALID_REQUEST", `${SHELLCTL_COMMAND} ${flag} must be an integer.`);
  }
  return num;
}
function parseShellCtlBool(value, flag) {
  const lowered = value.trim().toLowerCase();
  if (lowered === "1" || lowered === "true" || lowered === "yes" || lowered === "on") return true;
  if (lowered === "0" || lowered === "false" || lowered === "no" || lowered === "off") return false;
  throw new NodeToolError("INVALID_REQUEST", `${SHELLCTL_COMMAND} ${flag} must be one of 1/0/true/false.`);
}
function decodeBase64Utf8OrThrow(value, flag) {
  const decoded = decodeBase64Loose(value);
  if (!decoded) {
    throw new NodeToolError("INVALID_REQUEST", `${SHELLCTL_COMMAND} ${flag} must be valid base64.`);
  }
  return decoded.toString("utf8");
}
function parseShellCtlFlags(tokens) {
  const flags = /* @__PURE__ */ new Map();
  for (let i = 0; i < tokens.length; i += 2) {
    const key = tokens[i];
    const value = tokens[i + 1];
    if (!key || !key.startsWith("--")) {
      throw new NodeToolError("INVALID_REQUEST", `${SHELLCTL_COMMAND} expected --flag arguments; got "${key ?? ""}".`);
    }
    if (value === void 0 || value.startsWith("--")) {
      throw new NodeToolError("INVALID_REQUEST", `${SHELLCTL_COMMAND} ${key} requires a value.`);
    }
    if (flags.has(key)) {
      throw new NodeToolError("INVALID_REQUEST", `${SHELLCTL_COMMAND} ${key} cannot be specified more than once.`);
    }
    flags.set(key, value);
  }
  return flags;
}
function ensureOnlyShellCtlFlags(flags, allowed) {
  const allow = new Set(allowed);
  for (const key of flags.keys()) {
    if (!allow.has(key)) {
      throw new NodeToolError(
        "INVALID_REQUEST",
        `${SHELLCTL_COMMAND} does not support flag ${key} for this action.`
      );
    }
  }
}
function parseShellCtlCommand(command) {
  const tokens = parseCommandTokens(command);
  if (!tokens || tokens.length < 2 || tokens[0] !== SHELLCTL_COMMAND) {
    throw new NodeToolError(
      "INVALID_REQUEST",
      `${SHELLCTL_COMMAND} command is malformed. Expected: ${SHELLCTL_COMMAND} <open|send|read|list|close|interrupt>.`
    );
  }
  const action = tokens[1];
  const args = tokens.slice(2);
  if (action === "list") {
    if (args.length > 0) {
      throw new NodeToolError("INVALID_REQUEST", `${SHELLCTL_COMMAND} list does not accept additional arguments.`);
    }
    return { action: "list" };
  }
  const flags = parseShellCtlFlags(args);
  const sessionId = parseShellCtlSessionId(flags.get("--session"));
  if (action === "open") {
    ensureOnlyShellCtlFlags(flags, ["--session", "--cwd-b64"]);
    const cwdB64 = flags.get("--cwd-b64");
    const cwd = cwdB64 ? decodeBase64Utf8OrThrow(cwdB64, "--cwd-b64") : null;
    return { action: "open", sessionId, cwd };
  }
  if (action === "send") {
    ensureOnlyShellCtlFlags(flags, ["--session", "--payload-b64", "--enter"]);
    const payloadB64 = flags.get("--payload-b64");
    if (!payloadB64) {
      throw new NodeToolError("INVALID_REQUEST", `${SHELLCTL_COMMAND} send requires --payload-b64.`);
    }
    const payload = decodeBase64Utf8OrThrow(payloadB64, "--payload-b64");
    const enterRaw = flags.get("--enter");
    const enter = enterRaw ? parseShellCtlBool(enterRaw, "--enter") : true;
    return {
      action: "send",
      sessionId,
      payload,
      enter
    };
  }
  if (action === "read") {
    ensureOnlyShellCtlFlags(flags, ["--session", "--cursor", "--wait-ms", "--idle-ms", "--max-chars"]);
    const cursorRaw = flags.get("--cursor");
    const waitRaw = flags.get("--wait-ms");
    const idleRaw = flags.get("--idle-ms");
    const maxCharsRaw = flags.get("--max-chars");
    const cursor = cursorRaw ? Math.max(0, parseShellCtlInteger(cursorRaw, "--cursor")) : 0;
    const waitMs = waitRaw ? Math.max(0, Math.min(SHELLCTL_MAX_WAIT_MS, parseShellCtlInteger(waitRaw, "--wait-ms"))) : 1500;
    const idleMs = idleRaw ? Math.max(50, Math.min(SHELLCTL_MAX_IDLE_MS, parseShellCtlInteger(idleRaw, "--idle-ms"))) : 200;
    const maxChars = maxCharsRaw ? Math.max(128, Math.min(SHELLCTL_MAX_CHARS, parseShellCtlInteger(maxCharsRaw, "--max-chars"))) : 4e3;
    return {
      action: "read",
      sessionId,
      cursor,
      waitMs,
      idleMs,
      maxChars
    };
  }
  if (action === "close") {
    ensureOnlyShellCtlFlags(flags, ["--session"]);
    return { action: "close", sessionId };
  }
  if (action === "interrupt") {
    ensureOnlyShellCtlFlags(flags, ["--session"]);
    return { action: "interrupt", sessionId };
  }
  throw new NodeToolError(
    "INVALID_REQUEST",
    `${SHELLCTL_COMMAND} action ${action} is not supported. Use open|send|read|list|close|interrupt.`
  );
}
function parseCommandTokens(command) {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  if (tokens.length === 0) return [];
  const out = [];
  for (const token of tokens) {
    if (token.startsWith('"') || token.startsWith("'")) {
      if (token.length < 2 || token[0] !== token[token.length - 1]) return null;
      out.push(token.slice(1, -1));
      continue;
    }
    out.push(token);
  }
  return out;
}
function shortStableHash(input) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}
function resolvePolicyPresetPath(policyPresetDir, presetName) {
  const trimmed = presetName.trim();
  if (!trimmed) {
    throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} apply-preset requires a non-empty preset name.`);
  }
  if (trimmed.length > 128) {
    throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} preset names must be <= 128 characters.`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed) || trimmed.includes("..")) {
    throw new NodeToolError(
      "INVALID_REQUEST",
      `${POLICYCTL_COMMAND} preset names can only include letters, numbers, dot, underscore, and dash.`
    );
  }
  const fileName = trimmed.endsWith(".json") ? trimmed : `${trimmed}.json`;
  const root = path3.resolve(policyPresetDir);
  const resolved = path3.resolve(root, fileName);
  if (!resolved.startsWith(`${root}${path3.sep}`)) {
    throw new NodeToolError("INVALID_REQUEST", `${POLICYCTL_COMMAND} preset path escapes the approved preset directory.`);
  }
  return resolved;
}
function firewallModeStrength(mode) {
  if (mode === "transparent") return 0;
  if (mode === "audit-only") return 1;
  return 2;
}
function shellEscape(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function splitCsv(value, fallback) {
  if (!value || !value.trim()) return [...fallback];
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}
function normalizeFileTransferRoots(value, stateDir) {
  const rawRoots = splitCsv(value, [path3.join(stateDir, "file-transfer")]);
  const out = /* @__PURE__ */ new Set();
  for (const raw of rawRoots) {
    const resolved = path3.resolve(path3.isAbsolute(raw) ? raw : path3.join(stateDir, raw));
    out.add(resolved);
  }
  return [...out.values()].sort((a, b) => a.localeCompare(b));
}
function isWithinPath(candidatePath, rootPath) {
  const relative = path3.relative(rootPath, candidatePath);
  return relative === "" || !relative.startsWith("..") && !path3.isAbsolute(relative);
}
async function resolvePathViaExistingParent(targetPath) {
  let cursor = path3.resolve(targetPath);
  const tail = [];
  while (true) {
    try {
      const base = await fs3.realpath(cursor);
      return tail.length > 0 ? path3.join(base, ...tail) : base;
    } catch (err) {
      const code = err == null ? void 0 : err.code;
      if (code !== "ENOENT") throw err;
      const parent = path3.dirname(cursor);
      if (parent === cursor) {
        return tail.length > 0 ? path3.join(cursor, ...tail) : cursor;
      }
      tail.unshift(path3.basename(cursor));
      cursor = parent;
    }
  }
}
function normalizeMcpAllowPatterns(value) {
  if (!Array.isArray(value)) return [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const pattern = entry.trim();
    if (!pattern) continue;
    seen.add(pattern);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
function mcpPatternMatches(name, pattern) {
  const value = name.trim();
  if (!value) return false;
  const normalized = pattern.trim();
  if (!normalized) return false;
  if (normalized === "*") return true;
  if (normalized.endsWith("*")) {
    const prefix = normalized.slice(0, -1);
    return value.startsWith(prefix);
  }
  return value === normalized;
}
function clampInt(value, min, max) {
  const str = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  if (!str) return null;
  const num = Number(str);
  if (!Number.isFinite(num)) return null;
  return Math.min(max, Math.max(min, Math.floor(num)));
}
function asString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
function asBoolean(value) {
  if (typeof value === "boolean") return value;
  return null;
}
function asNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}
function asObject3(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}
function asStringMap(value) {
  const obj = asObject3(value);
  const out = {};
  for (const [key, v] of Object.entries(obj)) {
    if (typeof v === "string") out[key] = v;
  }
  return out;
}
function parseSymbolKind(value) {
  if (!value) return null;
  switch (value) {
    case "contact":
    case "account":
    case "secret":
    case "user":
      return value;
    default:
      return null;
  }
}
function truncateOutput(text, maxChars = MAX_OUTPUT_CHARS) {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const omitted = text.length - maxChars;
  return `${text.slice(0, half)}

[... truncated ${omitted} chars ...]

${text.slice(-half)}`;
}
function toBase64Url(value) {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function decodeBase64Loose(value) {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized) return null;
  if (/[^A-Za-z0-9+/=]/.test(normalized)) return null;
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  try {
    return Buffer.from(padded, "base64");
  } catch {
    return null;
  }
}
function parsePublicKey(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let key = null;
  if (trimmed.includes("BEGIN PUBLIC KEY")) {
    try {
      key = createPublicKey(trimmed);
    } catch {
      key = null;
    }
  }
  if (!key) {
    const decoded = decodeBase64Loose(trimmed);
    if (decoded) {
      if (decoded.length === 32) {
        try {
          key = createPublicKey({
            key: Buffer.concat([ED25519_SPKI_RAW_PREFIX, decoded]),
            format: "der",
            type: "spki"
          });
        } catch {
          key = null;
        }
      } else {
        try {
          key = createPublicKey({ key: decoded, format: "der", type: "spki" });
        } catch {
          key = null;
        }
      }
    }
  }
  if (!key || key.asymmetricKeyType !== "ed25519") return null;
  const raw = publicKeyRawFromObject(key);
  if (!raw) return null;
  return {
    key,
    raw: toBase64Url(raw),
    fingerprint: createHash("sha256").update(raw).digest("hex")
  };
}
function publicKeyRawFromObject(publicKey) {
  try {
    const der = publicKey.export({ format: "der", type: "spki" });
    if (der.length !== ED25519_SPKI_RAW_PREFIX.length + 32) return null;
    if (!der.subarray(0, ED25519_SPKI_RAW_PREFIX.length).equals(ED25519_SPKI_RAW_PREFIX)) return null;
    return der.subarray(ED25519_SPKI_RAW_PREFIX.length);
  } catch {
    return null;
  }
}
function stableStringify(value) {
  if (value === null || value === void 0) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value;
    const keys = Object.keys(obj).sort();
    const body = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",");
    return `{${body}}`;
  }
  return JSON.stringify(String(value));
}
function withoutSig(value) {
  const { sig: _sig, ...rest } = value;
  return rest;
}
function signDetachedPayload(payload, privateKey) {
  const bytes = Buffer.from(stableStringify(payload), "utf8");
  return toBase64Url(sign(null, bytes, privateKey));
}
function verifyDetachedPayload(payload, signature, publicKey) {
  const sigBytes = decodeBase64Loose(signature);
  if (!sigBytes) return false;
  const bytes = Buffer.from(stableStringify(payload), "utf8");
  try {
    return verify(null, bytes, publicKey, sigBytes);
  } catch {
    return false;
  }
}
function signEnvelope(envelopeWithoutSig, privateKey) {
  return signDetachedPayload(envelopeWithoutSig, privateKey);
}
function printHelp() {
  process2.stdout.write(
    [
      "Reference Nexus node (signed protocol + system.run/system.which + process primitives)",
      "",
      "Usage:",
      "  tsx examples/nexus-node/reference-node.ts [options]",
      "",
      "Options:",
      "  --gateway <url>                 Gateway websocket URL (default ws://127.0.0.1:18789/nx/nodes)",
      "  --gateway-tls-fingerprint <fp>  Pin SHA-256 cert fingerprint for wss:// gateways (self-signed friendly)",
      "  --node-id <id>                  Node ID (sender becomes node:<id>)",
      "  --name <display-name>           Node display name",
      "  --state-dir <dir>               Local state dir for keys (default ~/.nexus-node)",
      "  --state-backend <sqlite|json>   Persistent backend (default sqlite; minimal profile defaults to json)",
      "  --profile <standard|minimal>    Startup profile (default standard)",
      "  --caps <csv>                    Capability list (default system.run,system.which,process.start,process.status,process.logs,process.cancel,symbols.list,audit.query)",
      "  --allow <csv>                   Allowlisted command names for system.run/process.start (include nexus-policyctl,nexus-shellctl,file_pull,file_push to enable control surfaces)",
      "  --policy-required 1             Fail startup when hermes-policy.json is missing/invalid",
      "  --init                          Bootstrap state dir, keys, policy file, and env template then exit",
      "  --run-after-init 1              Continue startup after --init completes",
      "  --env-file <path>               Env file path used by --init (default <stateDir>/reference-node.env)",
      "  --doctor                        Run startup preflight checks then exit",
      "  --doctor-continue 1             Continue startup after --doctor passes",
      "  --run-timeout-ms <ms>           Max system.run timeout (default 60000)",
      "  --file-transfer-roots <csv>     Allowed absolute roots for file transfer paths (default <stateDir>/file-transfer)",
      "  --file-transfer-max-bytes <n>   Max bytes per file.pull/file.push payload (default 5242880)",
      "  --log-format <text|json>        Log format for stdout and rotating log file (default text)",
      "  --log-file <path>               Log file path (default <stateDir>/logs/reference-node.log)",
      "  --log-max-bytes <n>             Rotate log when current file reaches size in bytes (default 5242880)",
      "  --log-max-files <n>             Number of rotated files to keep (default 5)",
      "  --webhook-host <host>           Local webhook bind host (default 127.0.0.1)",
      "  --webhook-port <port>           Enable node-local webhook listener on this port (default 0=disabled)",
      "  --webhook-path <path>           Local webhook path (default /node-webhook)",
      "  --webhook-max-bytes <n>         Max local webhook request size in bytes (default 262144)",
      "  --webhook-token <token>         Optional bearer/x-nexus-node-webhook-token requirement",
      "  --mcp-bridge 1                  Enable MCP bridge methods (mcp.list/mcp.call/mcp.resources)",
      "  --mcp-bridge-config <path>      MCP bridge JSON config path (default <stateDir>/mcp-bridge.json)",
      "  --mcp-bridge-timeout-ms <ms>    MCP bridge request timeout per server (default 30000)",
      "  --reconnect-min-ms <ms>         Minimum reconnect delay (default 2000)",
      "  --reconnect-max-ms <ms>         Maximum reconnect delay (default 30000)",
      "  --max-clock-skew-ms <ms>        Max accepted signed message skew (default 120000)",
      "  --insecure-allow-nonloopback-ws 1 Allow ws:// to non-loopback hosts (debug only; insecure)",
      "  --insecure-skip-gateway-proof 1 Skip challenge proof verification (debug only)",
      "  --help                          Show this help",
      "",
      "Examples:",
      "  tsx examples/nexus-node/reference-node.ts --gateway ws://127.0.0.1:18789/nx/nodes",
      '  tsx examples/nexus-node/reference-node.ts --allow "echo,uname,ls"',
      ""
    ].join("\n")
  );
}
var invokedPath = process2.argv[1] ? path3.resolve(process2.argv[1]) : null;
var currentPath = fileURLToPath(import.meta.url);
if ((process2.env.NEXUS_REFERENCE_NODE_NO_AUTORUN ?? "") !== "1" && invokedPath && invokedPath === currentPath) {
  void runReferenceNode().catch((err) => {
    process2.stderr.write(`[reference-node] fatal: ${err instanceof Error ? err.message : String(err)}
`);
    process2.exitCode = 1;
  });
}
export {
  runReferenceNode
};
//# sourceMappingURL=reference-node.js.map
