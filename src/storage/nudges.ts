import type { NexusDatabase } from "./database.js";

export type SessionNudgeState = {
  sessionId: string;
  userTurnCount: number;
  lastMemoryActionTurn: number;
  lastMemoryNudgeTurn: number;
  skillIterationsSinceAction: number;
  updatedAt: number;
};

type NudgeRow = {
  session_id: string;
  user_turn_count: number;
  last_memory_action_turn: number;
  last_memory_nudge_turn: number;
  skill_iterations_since_action: number;
  updated_at: number;
};

function toInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function mapRow(row: NudgeRow): SessionNudgeState {
  return {
    sessionId: String(row.session_id),
    userTurnCount: toInt(row.user_turn_count),
    lastMemoryActionTurn: toInt(row.last_memory_action_turn),
    lastMemoryNudgeTurn: toInt(row.last_memory_nudge_turn),
    skillIterationsSinceAction: toInt(row.skill_iterations_since_action),
    updatedAt: toInt(row.updated_at),
  };
}

function ensureRow(db: NexusDatabase, sessionId: string, nowMs: number): void {
  db.db
    .prepare(
      `INSERT INTO session_nudges (
         session_id, user_turn_count, last_memory_action_turn, last_memory_nudge_turn, skill_iterations_since_action, updated_at
       ) VALUES (?, 0, 0, 0, 0, ?)
       ON CONFLICT(session_id) DO NOTHING`,
    )
    .run(sessionId, nowMs);
}

function loadRow(db: NexusDatabase, sessionId: string): NudgeRow | null {
  const row = db.db
    .prepare(
      `SELECT
         session_id, user_turn_count, last_memory_action_turn, last_memory_nudge_turn, skill_iterations_since_action, updated_at
       FROM session_nudges
       WHERE session_id = ?
       LIMIT 1`,
    )
    .get(sessionId) as NudgeRow | undefined;
  return row ?? null;
}

export function beginSessionTurnNudges(params: {
  db: NexusDatabase;
  sessionId: string;
  nowMs: number;
  memoryTurnInterval: number;
  skillIterationInterval: number;
}): {
  state: SessionNudgeState;
  memoryNudgeDue: boolean;
  skillNudgeDue: boolean;
} {
  const memoryInterval = Math.max(0, Math.floor(params.memoryTurnInterval));
  const skillInterval = Math.max(0, Math.floor(params.skillIterationInterval));

  ensureRow(params.db, params.sessionId, params.nowMs);

  params.db.db
    .prepare("UPDATE session_nudges SET user_turn_count = user_turn_count + 1, updated_at = ? WHERE session_id = ?")
    .run(params.nowMs, params.sessionId);

  const current = loadRow(params.db, params.sessionId);
  if (!current) {
    return {
      state: {
        sessionId: params.sessionId,
        userTurnCount: 1,
        lastMemoryActionTurn: 0,
        lastMemoryNudgeTurn: 0,
        skillIterationsSinceAction: 0,
        updatedAt: params.nowMs,
      },
      memoryNudgeDue: false,
      skillNudgeDue: false,
    };
  }

  let memoryNudgeDue = false;
  if (memoryInterval > 0) {
    const lastSignalTurn = Math.max(toInt(current.last_memory_action_turn), toInt(current.last_memory_nudge_turn));
    memoryNudgeDue = toInt(current.user_turn_count) - lastSignalTurn >= memoryInterval;
  }

  const skillNudgeDue = skillInterval > 0
    ? toInt(current.skill_iterations_since_action) >= skillInterval
    : false;

  if (memoryNudgeDue || skillNudgeDue) {
    params.db.db
      .prepare(
        `UPDATE session_nudges
         SET last_memory_nudge_turn = CASE WHEN ? = 1 THEN user_turn_count ELSE last_memory_nudge_turn END,
             skill_iterations_since_action = CASE WHEN ? = 1 THEN 0 ELSE skill_iterations_since_action END,
             updated_at = ?
         WHERE session_id = ?`,
      )
      .run(memoryNudgeDue ? 1 : 0, skillNudgeDue ? 1 : 0, params.nowMs, params.sessionId);
  }

  const finalRow = loadRow(params.db, params.sessionId) ?? current;
  return {
    state: mapRow(finalRow),
    memoryNudgeDue,
    skillNudgeDue,
  };
}

export function completeSessionTurnNudges(params: {
  db: NexusDatabase;
  sessionId: string;
  nowMs: number;
  userTurnCount: number;
  iterationsUsed: number;
  memoryActionUsed: boolean;
  skillActionUsed: boolean;
}): SessionNudgeState {
  ensureRow(params.db, params.sessionId, params.nowMs);
  const current = loadRow(params.db, params.sessionId);
  if (!current) {
    return {
      sessionId: params.sessionId,
      userTurnCount: Math.max(0, Math.floor(params.userTurnCount)),
      lastMemoryActionTurn: params.memoryActionUsed ? Math.max(0, Math.floor(params.userTurnCount)) : 0,
      lastMemoryNudgeTurn: 0,
      skillIterationsSinceAction: params.skillActionUsed ? 0 : Math.max(0, Math.floor(params.iterationsUsed)),
      updatedAt: params.nowMs,
    };
  }

  const iterationsUsed = Math.max(0, Math.floor(params.iterationsUsed));
  const userTurnCount = Math.max(0, Math.floor(params.userTurnCount));
  const priorSkillIterations = toInt(current.skill_iterations_since_action);
  const nextSkillIterations = params.skillActionUsed ? 0 : priorSkillIterations + iterationsUsed;
  const nextLastMemoryActionTurn = params.memoryActionUsed
    ? Math.max(toInt(current.last_memory_action_turn), userTurnCount)
    : toInt(current.last_memory_action_turn);

  params.db.db
    .prepare(
      `UPDATE session_nudges
       SET last_memory_action_turn = ?,
           skill_iterations_since_action = ?,
           updated_at = ?
       WHERE session_id = ?`,
    )
    .run(nextLastMemoryActionTurn, nextSkillIterations, params.nowMs, params.sessionId);

  const finalRow = loadRow(params.db, params.sessionId) ?? current;
  return mapRow(finalRow);
}

