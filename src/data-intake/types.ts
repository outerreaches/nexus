import type { z } from "zod";

import type { NexusDatabase } from "../storage/database.js";

export type NormalizedRecord = {
  subject: string;
  value: unknown;
  collectedAtMs?: number;
  ttlMs?: number;
  metadata?: Record<string, unknown>;
};

export type DataIntakeContext = {
  db?: NexusDatabase;
  nowMs: () => number;
  log: (msg: string) => void;
  request?: {
    channel?: string;
    channelKey?: string;
    agentId?: string;
    sessionId?: string;
  };
};

export type DataSource = {
  id: string;
  name: string;
  description: string;
  usageNote?: string;
  tags: string[];
  schemaVersion: number;
  defaultTtlMs: number;
  paramsSchema?: z.ZodTypeAny;
  fetch: (params: unknown, ctx: DataIntakeContext) => Promise<unknown>;
  normalize: (raw: unknown, params: unknown, ctx: DataIntakeContext) => Promise<NormalizedRecord[]> | NormalizedRecord[];
  /** Generate a concise, context-relevant preview from normalized records (for ad-hoc runs) */
  summarize?: (records: NormalizedRecord[], ctx: DataIntakeContext) => unknown;
};

export type DataRunResult = {
  sourceId: string;
  sourceName: string;
  stored: number;
  skipped: number;
  errors: string[];
  collectedAtMs: number;
  /** Optional preview of the most relevant data (populated if source has summarize function) */
  preview?: unknown;
};
