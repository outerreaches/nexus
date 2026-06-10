import crypto from "node:crypto";

import type { NexusDatabase } from "./database.js";
import type { GateVerdict } from "../core/tool-gate.js";

export type ToolGateEventRecord = {
  id: string;
  toolName: string;
  decision: string;
  source: string;
  ruleId: string;
  reason: string | null;
  enforced: boolean;
  argsHash: string;
  argsPreview: string | null;
  agentId: string | null;
  sessionId: string | null;
  runId: string | null;
  channel: string | null;
  approvalId: string | null;
  createdAt: number;
};

const ARGS_PREVIEW_MAX_CHARS = 600;

export function hashToolGateArgs(args: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(args) ?? "null";
  } catch {
    serialized = String(args);
  }
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

export function appendToolGateEvent(db: NexusDatabase, params: {
  verdict: GateVerdict;
  toolName: string;
  enforced: boolean;
  argsHash: string;
  /** Pre-redacted preview (caller is responsible for redaction). */
  argsPreview?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  channel?: string | null;
  approvalId?: string | null;
  nowMs: number;
}): ToolGateEventRecord {
  const id = `TG${crypto.randomBytes(10).toString("hex").toUpperCase()}`;
  const preview = params.argsPreview
    ? params.argsPreview.slice(0, ARGS_PREVIEW_MAX_CHARS)
    : null;
  db.db
    .prepare(
      `INSERT INTO tool_gate_events (
         id, tool_name, decision, source, rule_id, reason, enforced,
         args_hash, args_preview, agent_id, session_id, run_id, channel,
         approval_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      params.toolName,
      params.verdict.decision,
      params.verdict.source,
      params.verdict.ruleId,
      params.verdict.reason || null,
      params.enforced ? 1 : 0,
      params.argsHash,
      preview,
      params.agentId ?? null,
      params.sessionId ?? null,
      params.runId ?? null,
      params.channel ?? null,
      params.approvalId ?? null,
      params.nowMs,
    );
  return {
    id,
    toolName: params.toolName,
    decision: params.verdict.decision,
    source: params.verdict.source,
    ruleId: params.verdict.ruleId,
    reason: params.verdict.reason || null,
    enforced: params.enforced,
    argsHash: params.argsHash,
    argsPreview: preview,
    agentId: params.agentId ?? null,
    sessionId: params.sessionId ?? null,
    runId: params.runId ?? null,
    channel: params.channel ?? null,
    approvalId: params.approvalId ?? null,
    createdAt: params.nowMs,
  };
}

/** Delete gate events older than the cutoff. Returns rows removed. */
export function pruneToolGateEvents(db: NexusDatabase, params: {
  nowMs: number;
  retentionMs: number;
}): number {
  const cutoff = params.nowMs - Math.max(0, params.retentionMs);
  const result = db.db
    .prepare("DELETE FROM tool_gate_events WHERE created_at <= ?")
    .run(cutoff);
  return result.changes;
}
