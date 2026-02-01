import crypto from "node:crypto";
import type { NexusDatabase } from "../storage/database.js";

export type AgentRunStatus = "running" | "complete" | "failed" | "budget_exhausted";

export type AgentRunInfo = {
  runId: string;
  parentRunId?: string | null;
  agentId: string;
  preset: string;
  channel: string;
  channelKey: string;
  sessionId: string;
  task: string;
  status: AgentRunStatus;
  startedAt: number;
  endedAt: number | null;
  toolCallsUsed?: number;
  iterationsUsed?: number;
  outputPreview?: string;
};

export class AgentTracker {
  private readonly active = new Map<string, AgentRunInfo>();
  private readonly recent: AgentRunInfo[] = [];

  constructor(
    private readonly opts: {
      maxRecent?: number;
      retentionMs?: number;
      db?: NexusDatabase;
    } = {},
  ) {}

  startRun(params: {
    parentRunId?: string | null;
    agentId: string;
    preset: string;
    channel: string;
    channelKey: string;
    sessionId: string;
    task: string;
  }): string {
    const runId = crypto.randomUUID();
    const nowMs = Date.now();
    const info: AgentRunInfo = {
      runId,
      parentRunId: params.parentRunId ?? null,
      agentId: params.agentId,
      preset: params.preset,
      channel: params.channel,
      channelKey: params.channelKey,
      sessionId: params.sessionId,
      task: params.task,
      status: "running",
      startedAt: nowMs,
      endedAt: null,
    };
    this.active.set(runId, info);
    this.persistStart(info);
    return runId;
  }

  completeRun(
    runId: string,
    params: {
      status: Exclude<AgentRunStatus, "running">;
      toolCallsUsed?: number;
      iterationsUsed?: number;
      outputPreview?: string;
      endedAt?: number;
    },
  ): void {
    const nowMs = params.endedAt ?? Date.now();
    const existing = this.active.get(runId);
    const info: AgentRunInfo = existing
      ? {
          ...existing,
          status: params.status,
          endedAt: nowMs,
          toolCallsUsed: params.toolCallsUsed,
          iterationsUsed: params.iterationsUsed,
          outputPreview: params.outputPreview,
        }
      : {
          runId,
          parentRunId: null,
          agentId: "unknown",
          preset: "unknown",
          channel: "unknown",
          channelKey: "unknown",
          sessionId: "unknown",
          task: "",
          status: params.status,
          startedAt: nowMs,
          endedAt: nowMs,
          toolCallsUsed: params.toolCallsUsed,
          iterationsUsed: params.iterationsUsed,
          outputPreview: params.outputPreview,
        };

    this.active.delete(runId);
    this.recent.unshift(info);
    this.prune(nowMs);
    this.persistComplete(info);
  }

  listActive(): AgentRunInfo[] {
    return [...this.active.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  listRecent(params: { sinceMs?: number; limit?: number } = {}): AgentRunInfo[] {
    const nowMs = Date.now();
    this.prune(nowMs);
    const sinceMs = params.sinceMs ?? nowMs - this.retentionMs;
    const limit = params.limit ?? this.maxRecent;
    return this.recent.filter((r) => (r.endedAt ?? 0) >= sinceMs).slice(0, limit);
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.retentionMs;
    while (this.recent.length > 0 && (this.recent[this.recent.length - 1]?.endedAt ?? 0) < cutoff) {
      this.recent.pop();
    }
    if (this.recent.length > this.maxRecent) {
      this.recent.length = this.maxRecent;
    }
    this.pruneDatabase(cutoff);
  }

  private get maxRecent(): number {
    return typeof this.opts.maxRecent === "number" && Number.isFinite(this.opts.maxRecent) ? Math.max(20, this.opts.maxRecent) : 200;
  }

  private get retentionMs(): number {
    return typeof this.opts.retentionMs === "number" && Number.isFinite(this.opts.retentionMs)
      ? Math.max(60_000, this.opts.retentionMs)
      : 6 * 60 * 60_000;
  }

  private persistStart(info: AgentRunInfo): void {
    const db = this.opts.db;
    if (!db) return;
    db.db
      .prepare(
        `INSERT INTO agent_runs
          (run_id, parent_run_id, session_id, agent_id, preset, channel, channel_key, task, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           parent_run_id=excluded.parent_run_id,
           session_id=excluded.session_id,
           agent_id=excluded.agent_id,
           preset=excluded.preset,
           channel=excluded.channel,
           channel_key=excluded.channel_key,
           task=excluded.task,
           status=excluded.status,
           started_at=excluded.started_at`,
      )
      .run(
        info.runId,
        info.parentRunId ?? null,
        info.sessionId || null,
        info.agentId,
        info.preset,
        info.channel || null,
        info.channelKey || null,
        info.task || null,
        info.status,
        info.startedAt,
      );
  }

  private persistComplete(info: AgentRunInfo): void {
    const db = this.opts.db;
    if (!db) return;
    db.db
      .prepare(
        `UPDATE agent_runs
          SET status = ?, ended_at = ?, tool_calls_used = ?, iterations_used = ?, output_preview = ?
          WHERE run_id = ?`,
      )
      .run(
        info.status,
        info.endedAt ?? null,
        info.toolCallsUsed ?? null,
        info.iterationsUsed ?? null,
        info.outputPreview ?? null,
        info.runId,
      );
  }

  private pruneDatabase(cutoffMs: number): void {
    const db = this.opts.db;
    if (!db) return;
    db.db.prepare("DELETE FROM agent_runs WHERE ended_at IS NOT NULL AND ended_at < ?").run(cutoffMs);
  }
}
