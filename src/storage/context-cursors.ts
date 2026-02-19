import type { NexusDatabase } from "./database.js";

export type ContextFlowType = "job" | "heartbeat";

export type ContextCursor = {
  flowType: ContextFlowType;
  flowKey: string;
  agentId: string;
  telegramSessionId: string | null;
  lastMessageId: number | null;
  summaryJson: string;
  updatedAt: number;
};

export function getContextCursor(
  db: NexusDatabase,
  params: { flowType: ContextFlowType; flowKey: string; agentId: string },
): ContextCursor | null {
  const row = db.db
    .prepare(
      `SELECT flow_type, flow_key, agent_id, telegram_session_id, last_message_id, summary_json, updated_at
       FROM context_cursors
       WHERE flow_type = ? AND flow_key = ? AND agent_id = ?
       LIMIT 1`,
    )
    .get(params.flowType, params.flowKey, params.agentId) as
    | {
        flow_type: string;
        flow_key: string;
        agent_id: string;
        telegram_session_id: string | null;
        last_message_id: number | null;
        summary_json: string | null;
        updated_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    flowType: row.flow_type as ContextFlowType,
    flowKey: row.flow_key,
    agentId: row.agent_id,
    telegramSessionId: row.telegram_session_id ? String(row.telegram_session_id) : null,
    lastMessageId: typeof row.last_message_id === "number" && Number.isFinite(row.last_message_id)
      ? Math.max(0, Math.floor(row.last_message_id))
      : null,
    summaryJson: typeof row.summary_json === "string" ? row.summary_json : "{}",
    updatedAt: Math.max(0, Math.floor(Number(row.updated_at ?? 0))),
  };
}

export function upsertContextCursor(
  db: NexusDatabase,
  params: {
    flowType: ContextFlowType;
    flowKey: string;
    agentId: string;
    telegramSessionId: string | null;
    lastMessageId: number | null;
    updatedAt: number;
    summaryJson?: string;
  },
): void {
  const normalizedLastMessageId = typeof params.lastMessageId === "number" && Number.isFinite(params.lastMessageId)
    ? Math.max(0, Math.floor(params.lastMessageId))
    : null;
  const summaryJson = typeof params.summaryJson === "string" && params.summaryJson.trim().length > 0
    ? params.summaryJson
    : "{}";
  db.db
    .prepare(
      `INSERT INTO context_cursors (
         flow_type, flow_key, agent_id, telegram_session_id, last_message_id, summary_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(flow_type, flow_key, agent_id) DO UPDATE SET
         telegram_session_id = excluded.telegram_session_id,
         last_message_id = excluded.last_message_id,
         summary_json = excluded.summary_json,
         updated_at = excluded.updated_at`,
    )
    .run(
      params.flowType,
      params.flowKey,
      params.agentId,
      params.telegramSessionId ?? null,
      normalizedLastMessageId,
      summaryJson,
      Math.max(0, Math.floor(params.updatedAt)),
    );
}

export function deleteContextCursorsByFlow(
  db: NexusDatabase,
  params: { flowType: ContextFlowType; flowKey: string; agentId?: string },
): number {
  if (params.agentId) {
    const res = db.db
      .prepare("DELETE FROM context_cursors WHERE flow_type = ? AND flow_key = ? AND agent_id = ?")
      .run(params.flowType, params.flowKey, params.agentId);
    return res.changes;
  }
  const res = db.db
    .prepare("DELETE FROM context_cursors WHERE flow_type = ? AND flow_key = ?")
    .run(params.flowType, params.flowKey);
  return res.changes;
}
