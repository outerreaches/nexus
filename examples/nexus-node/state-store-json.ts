import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type {
  PersistedAuditEventRecord,
  PersistedFirewallQuarantineState,
  PersistedFirewallSessionRecord,
  PersistedOutboxEntry,
  PersistedProcessRecord,
  PersistedProcessStatus,
  PersistedReferenceRecord,
  ReferenceNodeStateStoreLike,
} from "./state-store-types.js";

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, "w", 0o600);
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
  fs.renameSync(tempPath, filePath);
}

function listJsonFiles(dirPath: string): string[] {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dirPath, entry.name));
  } catch {
    return [];
  }
}

type JsonProcessRecord = PersistedProcessRecord & { updatedAt: number };
type JsonOutboxEntry = PersistedOutboxEntry;
type JsonFirewallSession = PersistedFirewallSessionRecord;
type JsonAuditEvent = PersistedAuditEventRecord;
type JsonReference = PersistedReferenceRecord;

export class ReferenceNodeJsonStateStore implements ReferenceNodeStateStoreLike {
  readonly backend = "json" as const;
  readonly statePath: string;

  private constructor(private readonly rootDir: string) {
    this.statePath = rootDir;
  }

  static async open(stateDir: string): Promise<ReferenceNodeJsonStateStore> {
    const rootDir = path.join(stateDir, "state-json");
    for (const child of ["processes", "outbox", "firewall-sessions", "audit-events", "references"]) {
      fs.mkdirSync(path.join(rootDir, child), { recursive: true });
    }
    return new ReferenceNodeJsonStateStore(rootDir);
  }

  close(): void {
    // no-op
  }

  upsertProcess(process: PersistedProcessRecord, nowMs: number): void {
    const filePath = this.processPath(process.processId);
    writeJsonAtomic(filePath, {
      ...process,
      routing: process.routing ?? null,
      updatedAt: nowMs,
    } satisfies JsonProcessRecord);
  }

  removeProcess(processId: string): void {
    try {
      fs.rmSync(this.processPath(processId), { force: true });
    } catch {
      // ignore
    }
    for (const outboxPath of listJsonFiles(this.outboxDir())) {
      const entry = readJsonFile<JsonOutboxEntry>(outboxPath);
      if (!entry || entry.processId !== processId) continue;
      try {
        fs.rmSync(outboxPath, { force: true });
      } catch {
        // ignore
      }
    }
  }

  updateProcessLogs(processId: string, logs: string, nowMs: number): void {
    const filePath = this.processPath(processId);
    const current = readJsonFile<JsonProcessRecord>(filePath);
    if (!current) return;
    writeJsonAtomic(filePath, {
      ...current,
      logs,
      updatedAt: nowMs,
    } satisfies JsonProcessRecord);
  }

  loadProcesses(limit: number): PersistedProcessRecord[] {
    const processes = listJsonFiles(this.processesDir())
      .map((filePath) => readJsonFile<JsonProcessRecord>(filePath))
      .filter((row): row is JsonProcessRecord => Boolean(row?.processId))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, Math.max(1, Math.floor(limit)));
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
      routing: row.routing ? asObject(row.routing) : null,
    }));
  }

  enqueueOutbox(params: {
    deliveryId: string;
    processId: string;
    payload: Record<string, unknown>;
    createdAt: number;
  }): void {
    const filePath = this.outboxPath(params.deliveryId);
    if (fs.existsSync(filePath)) return;
    writeJsonAtomic(filePath, {
      deliveryId: params.deliveryId,
      processId: params.processId,
      payload: params.payload,
      createdAt: params.createdAt,
      delivered: false,
      deliveredAt: null,
    } satisfies JsonOutboxEntry);
  }

  listUndelivered(limit: number): PersistedOutboxEntry[] {
    return listJsonFiles(this.outboxDir())
      .map((filePath) => readJsonFile<JsonOutboxEntry>(filePath))
      .filter((row): row is JsonOutboxEntry => Boolean(row?.deliveryId))
      .filter((row) => !row.delivered)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, Math.max(1, Math.floor(limit)))
      .map((row) => ({
        deliveryId: row.deliveryId,
        processId: row.processId,
        payload: asObject(row.payload),
        createdAt: row.createdAt,
        delivered: Boolean(row.delivered),
        deliveredAt: row.deliveredAt ?? null,
      }));
  }

  countUndelivered(): number {
    let count = 0;
    for (const outboxPath of listJsonFiles(this.outboxDir())) {
      const row = readJsonFile<JsonOutboxEntry>(outboxPath);
      if (!row || row.delivered) continue;
      count += 1;
    }
    return count;
  }

  createFirewallSession(params: {
    sessionId: string;
    quarantineState: PersistedFirewallQuarantineState;
    metadata?: Record<string, unknown> | null;
    nowMs: number;
    ttlMs: number;
  }): PersistedFirewallSessionRecord {
    const expiresAt = params.nowMs + Math.max(1_000, params.ttlMs);
    const record: JsonFirewallSession = {
      sessionId: params.sessionId,
      quarantineState: params.quarantineState,
      createdAt: params.nowMs,
      lastUsedAt: params.nowMs,
      expiresAt,
      metadata: params.metadata ?? null,
    };
    writeJsonAtomic(this.firewallSessionPath(params.sessionId), record);
    return record;
  }

  getFirewallSession(sessionId: string, nowMs: number): PersistedFirewallSessionRecord | null {
    const filePath = this.firewallSessionPath(sessionId);
    const record = readJsonFile<JsonFirewallSession>(filePath);
    if (!record?.sessionId) return null;
    if (record.expiresAt <= nowMs) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        // ignore
      }
      return null;
    }
    return {
      sessionId: record.sessionId,
      quarantineState: this.parseQuarantineState(record.quarantineState),
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      expiresAt: record.expiresAt,
      metadata: record.metadata ? asObject(record.metadata) : null,
    };
  }

  touchFirewallSession(sessionId: string, nowMs: number, ttlMs: number): PersistedFirewallSessionRecord | null {
    const current = this.getFirewallSession(sessionId, nowMs);
    if (!current) return null;
    const updated: JsonFirewallSession = {
      ...current,
      lastUsedAt: nowMs,
      expiresAt: nowMs + Math.max(1_000, ttlMs),
    };
    writeJsonAtomic(this.firewallSessionPath(sessionId), updated);
    return updated;
  }

  pruneExpiredFirewallSessions(nowMs: number): number {
    let removed = 0;
    for (const filePath of listJsonFiles(this.firewallSessionsDir())) {
      const record = readJsonFile<JsonFirewallSession>(filePath);
      if (!record || record.expiresAt > nowMs) continue;
      try {
        fs.rmSync(filePath, { force: true });
        removed += 1;
      } catch {
        // ignore
      }
    }
    return removed;
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
    const record: JsonAuditEvent = {
      eventId,
      createdAt: params.createdAt,
      type: params.type.trim(),
      processId: params.processId ?? null,
      firewallSession: params.firewallSession ?? null,
      actor: params.actor ?? null,
      toolName: params.toolName ?? null,
      details: params.details ?? null,
    };
    writeJsonAtomic(this.auditEventPath(eventId), record);
    return record;
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
    const cursorCreatedAt =
      typeof params.cursorCreatedAt === "number" && Number.isFinite(params.cursorCreatedAt)
        ? Math.floor(params.cursorCreatedAt)
        : null;
    const events = listJsonFiles(this.auditEventsDir())
      .map((filePath) => readJsonFile<JsonAuditEvent>(filePath))
      .filter((row): row is JsonAuditEvent => Boolean(row?.eventId))
      .filter((row) => {
        if (cursorCreatedAt !== null && row.createdAt >= cursorCreatedAt) return false;
        if (params.type?.trim() && row.type !== params.type.trim()) return false;
        if (params.processId?.trim() && row.processId !== params.processId.trim()) return false;
        if (params.firewallSession?.trim() && row.firewallSession !== params.firewallSession.trim()) return false;
        if (params.actor?.trim() && row.actor !== params.actor.trim()) return false;
        return true;
      })
      .sort((a, b) => {
        if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
        return b.eventId.localeCompare(a.eventId);
      });
    const hasMore = events.length > limit;
    const trimmed = hasMore ? events.slice(0, limit) : events;
    return {
      events: trimmed,
      nextCursorCreatedAt: hasMore ? trimmed[trimmed.length - 1]?.createdAt ?? null : null,
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
    const refId = params.refId?.trim() || `ref_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const record: JsonReference = {
      refId,
      sourceType: params.sourceType.trim(),
      processId: params.processId ?? null,
      toolName: params.toolName ?? null,
      title: params.title ?? null,
      safeSummary: params.safeSummary,
      metadata: params.metadata ?? null,
      createdAt: params.nowMs,
      updatedAt: params.nowMs,
    };
    writeJsonAtomic(this.referencePath(refId), record);
    return record;
  }

  listReferencesByProcessId(processId: string, limit: number): PersistedReferenceRecord[] {
    return listJsonFiles(this.referencesDir())
      .map((filePath) => readJsonFile<JsonReference>(filePath))
      .filter((row): row is JsonReference => Boolean(row?.refId))
      .filter((row) => row.processId === processId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, Math.max(1, Math.min(200, Math.floor(limit))));
  }

  markOutboxDelivered(deliveryId: string, nowMs: number): boolean {
    const filePath = this.outboxPath(deliveryId);
    const current = readJsonFile<JsonOutboxEntry>(filePath);
    if (!current) return false;
    if (current.delivered) return true;
    writeJsonAtomic(filePath, {
      ...current,
      delivered: true,
      deliveredAt: nowMs,
    } satisfies JsonOutboxEntry);
    return true;
  }

  pruneDeliveredOlderThan(cutoffMs: number): number {
    let removed = 0;
    for (const filePath of listJsonFiles(this.outboxDir())) {
      const row = readJsonFile<JsonOutboxEntry>(filePath);
      if (!row || !row.delivered || row.deliveredAt === null || row.deliveredAt >= cutoffMs) continue;
      try {
        fs.rmSync(filePath, { force: true });
        removed += 1;
      } catch {
        // ignore
      }
    }
    return removed;
  }

  private processPath(processId: string): string {
    return path.join(this.processesDir(), `${processId}.json`);
  }

  private outboxPath(deliveryId: string): string {
    return path.join(this.outboxDir(), `${deliveryId}.json`);
  }

  private firewallSessionPath(sessionId: string): string {
    return path.join(this.firewallSessionsDir(), `${sessionId}.json`);
  }

  private auditEventPath(eventId: string): string {
    return path.join(this.auditEventsDir(), `${eventId}.json`);
  }

  private referencePath(refId: string): string {
    return path.join(this.referencesDir(), `${refId}.json`);
  }

  private processesDir(): string {
    return path.join(this.rootDir, "processes");
  }

  private outboxDir(): string {
    return path.join(this.rootDir, "outbox");
  }

  private firewallSessionsDir(): string {
    return path.join(this.rootDir, "firewall-sessions");
  }

  private auditEventsDir(): string {
    return path.join(this.rootDir, "audit-events");
  }

  private referencesDir(): string {
    return path.join(this.rootDir, "references");
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
