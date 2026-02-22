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

export interface ReferenceNodeStateStoreLike {
  readonly backend: "sqlite" | "json";
  readonly statePath: string;

  close(): void;

  upsertProcess(process: PersistedProcessRecord, nowMs: number): void;
  removeProcess(processId: string): void;
  updateProcessLogs(processId: string, logs: string, nowMs: number): void;
  loadProcesses(limit: number): PersistedProcessRecord[];

  enqueueOutbox(params: {
    deliveryId: string;
    processId: string;
    payload: Record<string, unknown>;
    createdAt: number;
  }): void;
  listUndelivered(limit: number): PersistedOutboxEntry[];
  countUndelivered(): number;
  markOutboxDelivered(deliveryId: string, nowMs: number): boolean;
  pruneDeliveredOlderThan(cutoffMs: number): number;

  createFirewallSession(params: {
    sessionId: string;
    quarantineState: PersistedFirewallQuarantineState;
    metadata?: Record<string, unknown> | null;
    nowMs: number;
    ttlMs: number;
  }): PersistedFirewallSessionRecord;
  getFirewallSession(sessionId: string, nowMs: number): PersistedFirewallSessionRecord | null;
  touchFirewallSession(sessionId: string, nowMs: number, ttlMs: number): PersistedFirewallSessionRecord | null;
  pruneExpiredFirewallSessions(nowMs: number): number;

  appendAuditEvent(params: {
    eventId?: string;
    createdAt: number;
    type: string;
    processId?: string | null;
    firewallSession?: string | null;
    actor?: string | null;
    toolName?: string | null;
    details?: Record<string, unknown> | null;
  }): PersistedAuditEventRecord;
  queryAuditEvents(params: {
    limit: number;
    cursorCreatedAt?: number | null;
    type?: string | null;
    processId?: string | null;
    firewallSession?: string | null;
    actor?: string | null;
  }): { events: PersistedAuditEventRecord[]; nextCursorCreatedAt: number | null };

  createReference(params: {
    refId?: string;
    sourceType: string;
    processId?: string | null;
    toolName?: string | null;
    title?: string | null;
    safeSummary: string;
    metadata?: Record<string, unknown> | null;
    nowMs: number;
  }): PersistedReferenceRecord;
  listReferencesByProcessId(processId: string, limit: number): PersistedReferenceRecord[];
}
