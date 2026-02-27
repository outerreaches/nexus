// examples/nexus-node/state-store-json.ts
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
var ReferenceNodeJsonStateStore = class _ReferenceNodeJsonStateStore {
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
  upsertProcess(process2, nowMs) {
    const filePath = this.processPath(process2.processId);
    writeJsonAtomic(filePath, {
      ...process2,
      routing: process2.routing ?? null,
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
export {
  ReferenceNodeJsonStateStore
};
//# sourceMappingURL=state-store-json.js.map
