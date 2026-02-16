import type { NexusDatabase } from "../storage/database.js";
import {
  createNodeSession,
  deleteNodeById,
  endNodeSession,
  getNodeById,
  listNodes,
  setNodeMetadata,
  setNodeStatus,
  touchNodeLastSeen,
  upsertNode,
  type NodeRecord,
  type NodeStatus,
  type UpsertNodeParams,
} from "../storage/nodes.js";

export class NodeRegistry {
  private readonly inMemory = new Map<string, NodeRecord>();

  constructor(
    private readonly deps: {
      db?: NexusDatabase;
      log: (line: string) => void;
    },
  ) {}

  list(limit: number = 200): NodeRecord[] {
    if (this.deps.db) return listNodes(this.deps.db, limit);
    return [...this.inMemory.values()]
      .sort((a, b) => {
        const aSeen = a.lastSeenAt ?? 0;
        const bSeen = b.lastSeenAt ?? 0;
        return bSeen - aSeen;
      })
      .slice(0, limit);
  }

  get(id: string): NodeRecord | null {
    if (this.deps.db) return getNodeById(this.deps.db, id);
    return this.inMemory.get(id) ?? null;
  }

  registerOrUpdate(params: UpsertNodeParams): NodeRecord {
    const nowMs = params.nowMs ?? Date.now();
    if (this.deps.db) {
      upsertNode(this.deps.db, { ...params, nowMs });
      const row = getNodeById(this.deps.db, params.id);
      if (row) return row;
      this.deps.log(`nodes: upsert completed but row missing for id=${params.id}`);
    }
    const next = this.mergeInMemoryRecord(this.inMemory.get(params.id) ?? null, params, nowMs);
    this.inMemory.set(next.id, next);
    return next;
  }

  markHeartbeat(params: {
    id: string;
    nowMs?: number;
    endpoint?: string | null;
    capabilities?: string[];
    tags?: string[];
  }): NodeRecord | null {
    const nowMs = params.nowMs ?? Date.now();
    if (this.deps.db) {
      touchNodeLastSeen(this.deps.db, {
        id: params.id,
        lastSeenAt: nowMs,
        endpoint: params.endpoint,
        capabilities: params.capabilities,
        tags: params.tags,
      });
      return getNodeById(this.deps.db, params.id);
    }

    const existing = this.inMemory.get(params.id);
    if (!existing) return null;
    const next: NodeRecord = {
      ...existing,
      endpoint: params.endpoint === undefined ? existing.endpoint : params.endpoint,
      capabilities: params.capabilities ?? existing.capabilities,
      tags: params.tags ?? existing.tags,
      lastSeenAt: nowMs,
      updatedAt: nowMs,
    };
    this.inMemory.set(params.id, next);
    return next;
  }

  setStatus(params: { id: string; status: NodeStatus; connectedAt?: number | null; nowMs?: number }): NodeRecord | null {
    const nowMs = params.nowMs ?? Date.now();
    if (this.deps.db) {
      setNodeStatus(this.deps.db, {
        id: params.id,
        status: params.status,
        connectedAt: params.connectedAt,
        nowMs,
      });
      return getNodeById(this.deps.db, params.id);
    }

    const existing = this.inMemory.get(params.id);
    if (!existing) return null;
    const next: NodeRecord = {
      ...existing,
      status: params.status,
      connectedAt: params.connectedAt === undefined ? existing.connectedAt : params.connectedAt,
      updatedAt: nowMs,
    };
    this.inMemory.set(params.id, next);
    return next;
  }

  setMetadata(params: { id: string; metadata: Record<string, unknown>; nowMs?: number }): NodeRecord | null {
    const nowMs = params.nowMs ?? Date.now();
    if (this.deps.db) {
      setNodeMetadata(this.deps.db, {
        id: params.id,
        metadata: params.metadata,
        nowMs,
      });
      return getNodeById(this.deps.db, params.id);
    }

    const existing = this.inMemory.get(params.id);
    if (!existing) return null;
    const next: NodeRecord = {
      ...existing,
      metadata: params.metadata,
      updatedAt: nowMs,
    };
    this.inMemory.set(params.id, next);
    return next;
  }

  remove(id: string): boolean {
    if (this.deps.db) return deleteNodeById(this.deps.db, id);
    return this.inMemory.delete(id);
  }

  beginSession(params: {
    id: string;
    nodeId: string;
    startedAt: number;
    ipAddress?: string | null;
    capabilities?: string[];
  }): void {
    if (!this.deps.db) return;
    createNodeSession(this.deps.db, params);
  }

  endSession(params: { id: string; endedAt: number }): void {
    if (!this.deps.db) return;
    endNodeSession(this.deps.db, params);
  }

  private mergeInMemoryRecord(existing: NodeRecord | null, params: UpsertNodeParams, nowMs: number): NodeRecord {
    return {
      id: params.id,
      label: params.label,
      publicKey: params.publicKey,
      fingerprint: params.fingerprint,
      status: params.status ?? existing?.status ?? "pending",
      endpoint: params.endpoint ?? existing?.endpoint ?? null,
      backend: params.backend ?? existing?.backend ?? "nexus",
      trustLevel: params.trustLevel ?? existing?.trustLevel ?? "standard",
      firewallMode: params.firewallMode ?? existing?.firewallMode ?? "transparent",
      capabilities: params.capabilities ?? existing?.capabilities ?? [],
      tags: params.tags ?? existing?.tags ?? [],
      permissions: params.permissions ?? existing?.permissions ?? {},
      metadata: params.metadata ?? existing?.metadata ?? {},
      lastSeenAt: params.lastSeenAt ?? existing?.lastSeenAt ?? null,
      connectedAt: params.connectedAt ?? existing?.connectedAt ?? null,
      createdAt: existing?.createdAt ?? nowMs,
      updatedAt: nowMs,
    };
  }
}
