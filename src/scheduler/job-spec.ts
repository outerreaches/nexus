import type { NexusDatabase } from "../storage/database.js";

export const ONE_SHOT_CRON = "@once";

export type AgentTaskDeliveryMode = "session_resume" | "report_only";
export type AgentTaskContextMode = "full" | "delta" | "none";
export type JobOriginRecoveredFrom = "direct_request" | "request_session" | "telegram_ancestor" | "migration" | "none";

export type AgentTaskOrigin = {
  channel: string;
  channelKey: string;
  sessionId: string | null;
  agentId: string;
  runId: string | null;
  preset: string | null;
  telegramChatId: number | null;
  recoveredFrom: JobOriginRecoveredFrom;
};

export function parsePositiveTelegramChatId(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

export function parseJobSpec(specJson: string | Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!specJson) return {};
  if (typeof specJson === "object" && !Array.isArray(specJson)) {
    return { ...specJson };
  }
  if (typeof specJson !== "string" || !specJson.trim()) return {};
  try {
    const parsed = JSON.parse(specJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed specs
  }
  return {};
}

export function isOneShotCron(cron: string): boolean {
  return cron.trim() === ONE_SHOT_CRON;
}

export function getOneShotAtMs(spec: Record<string, unknown>): number | null {
  return readFiniteNumber(spec.oneShotAtMs);
}

export function isOneShotSpec(spec: Record<string, unknown>): boolean {
  if (spec.scheduleKind === "one_shot") return true;
  return getOneShotAtMs(spec) !== null;
}

export function hasResumableOrigin(spec: Record<string, unknown>): boolean {
  const channel = readTrimmedString(spec.originChannel);
  const channelKey = readTrimmedString(spec.originChannelKey);
  const agentId = readTrimmedString(spec.originAgentId);
  if (!channel || !channelKey || !agentId) return false;
  if (channel === "telegram") {
    return parsePositiveTelegramChatId(channelKey) !== null;
  }
  return true;
}

export function readDeliveryMode(spec: Record<string, unknown>): AgentTaskDeliveryMode | null {
  const raw = readTrimmedString(spec.deliveryMode);
  if (raw === "session_resume" || raw === "report_only") return raw;
  return null;
}

export function resolveDeliveryMode(params: {
  cron: string;
  spec: Record<string, unknown>;
}): AgentTaskDeliveryMode {
  const explicit = readDeliveryMode(params.spec);
  if (explicit === "report_only") return explicit;
  if (explicit === "session_resume" && isOneShotCron(params.cron) && hasResumableOrigin(params.spec)) {
    return explicit;
  }
  if (isOneShotCron(params.cron) && hasResumableOrigin(params.spec)) {
    return "session_resume";
  }
  return "report_only";
}

export function readOrigin(spec: Record<string, unknown>): AgentTaskOrigin | null {
  if (!hasResumableOrigin(spec)) return null;
  const channel = readTrimmedString(spec.originChannel);
  const channelKey = readTrimmedString(spec.originChannelKey);
  const agentId = readTrimmedString(spec.originAgentId);
  if (!channel || !channelKey || !agentId) return null;
  const runId = readTrimmedString(spec.originRunId);
  const sessionId = readTrimmedString(spec.originSessionId);
  const preset = readTrimmedString(spec.originPreset);
  const recoveredFrom = readTrimmedString(spec.originRecoveredFrom);
  return {
    channel,
    channelKey,
    sessionId,
    agentId,
    runId,
    preset,
    telegramChatId: channel === "telegram" ? parsePositiveTelegramChatId(channelKey) : null,
    recoveredFrom:
      recoveredFrom === "direct_request"
      || recoveredFrom === "request_session"
      || recoveredFrom === "telegram_ancestor"
      || recoveredFrom === "migration"
      || recoveredFrom === "none"
        ? recoveredFrom
        : "none",
  };
}

export function applyOrigin(spec: Record<string, unknown>, origin: AgentTaskOrigin | null): void {
  if (!origin) {
    delete spec.originChannel;
    delete spec.originChannelKey;
    delete spec.originSessionId;
    delete spec.originAgentId;
    delete spec.originRunId;
    delete spec.originPreset;
    delete spec.originTelegramChatId;
    delete spec.originRecoveredFrom;
    return;
  }
  spec.originChannel = origin.channel;
  spec.originChannelKey = origin.channelKey;
  spec.originSessionId = origin.sessionId ?? null;
  spec.originAgentId = origin.agentId;
  spec.originRunId = origin.runId ?? null;
  spec.originPreset = origin.preset ?? null;
  spec.originTelegramChatId = origin.telegramChatId ?? null;
  spec.originRecoveredFrom = origin.recoveredFrom;
}

export function clearAgentTaskDeliveryMetadata(spec: Record<string, unknown>): void {
  delete spec.contextMode;
  delete spec.deliveryMode;
  delete spec.resumeUnavailable;
  applyOrigin(spec, null);
}

export function migrateLegacyAgentTaskJobSpecs(
  db: NexusDatabase,
  log?: (msg: string) => void,
): {
  scanned: number;
  alreadyVersioned: number;
  upgradedToSessionResume: number;
  defaultedToReportOnly: number;
  recoverySkippedAmbiguous: number;
} {
  const rows = db.db.prepare("SELECT id, cron, spec_json FROM jobs ORDER BY created_at ASC").all() as Array<{
    id: string;
    cron: string;
    spec_json: string;
  }>;

  let scanned = 0;
  let alreadyVersioned = 0;
  let upgradedToSessionResume = 0;
  let defaultedToReportOnly = 0;
  let recoverySkippedAmbiguous = 0;

  for (const row of rows) {
    const spec = parseJobSpec(row.spec_json);
    if (spec.mode !== "agent_task") continue;
    scanned += 1;

    const existingMode = readDeliveryMode(spec);
    if (existingMode) {
      alreadyVersioned += 1;
      continue;
    }

    const oneShot = isOneShotCron(String(row.cron ?? ""));
    if (oneShot && hasResumableOrigin(spec)) {
      spec.deliveryMode = "session_resume";
      if (!readTrimmedString(spec.originRecoveredFrom)) spec.originRecoveredFrom = "migration";
      delete spec.resumeUnavailable;
      upgradedToSessionResume += 1;
    } else {
      spec.deliveryMode = "report_only";
      if (oneShot) {
        spec.resumeUnavailable = true;
        if (!readTrimmedString(spec.originRecoveredFrom)) spec.originRecoveredFrom = "none";
        recoverySkippedAmbiguous += 1;
      } else {
        delete spec.resumeUnavailable;
      }
      defaultedToReportOnly += 1;
    }

    db.db
      .prepare("UPDATE jobs SET spec_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(spec), Date.now(), row.id);
  }

  if (scanned > 0) {
    log?.(
      `job_spec_migration: scanned=${scanned} already_versioned=${alreadyVersioned} upgraded_to_session_resume=${upgradedToSessionResume} defaulted_to_report_only=${defaultedToReportOnly} recovery_skipped_ambiguous=${recoverySkippedAmbiguous}`,
    );
  }

  return {
    scanned,
    alreadyVersioned,
    upgradedToSessionResume,
    defaultedToReportOnly,
    recoverySkippedAmbiguous,
  };
}
