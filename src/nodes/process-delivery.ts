import fs from "node:fs/promises";
import path from "node:path";

import type { NexusDatabase } from "../storage/database.js";

type ProcessDeliveryContext = {
  nodeId: string;
  payload: Record<string, unknown>;
  receivedAt: number;
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRawString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value !== "boolean") return null;
  return value;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function normalizeNodeProcessStatus(value: string | null): "queued" | "running" | "completed" | "failed" | "cancelled" {
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

function mapGatewayStatus(status: "queued" | "running" | "completed" | "failed" | "cancelled"): "running" | "exited" | "stopped" {
  switch (status) {
    case "queued":
    case "running":
      return "running";
    case "completed":
    case "failed":
      return "exited";
    case "cancelled":
      return "stopped";
  }
}

function normalizeRouting(payload: Record<string, unknown>): Record<string, unknown> {
  const routing = asObject(payload.routing);
  if (Object.keys(routing).length > 0) return routing;
  return {
    runId: asString(payload.runId) ?? null,
    parentRunId: asString(payload.parentRunId) ?? null,
    sessionId: asString(payload.sessionId) ?? null,
    channel: asString(payload.channel) ?? null,
    channelKey: asString(payload.channelKey) ?? null,
    firewallSession: asString(payload.firewallSession) ?? null,
  };
}

function sanitizeRoutingForMetadata(routing: Record<string, unknown>): Record<string, unknown> {
  return {
    runId: asString(routing.runId),
    parentRunId: asString(routing.parentRunId),
    sessionId: asString(routing.sessionId),
    channel: asString(routing.channel),
    channelKey: asString(routing.channelKey),
    firewallSession: asString(routing.firewallSession),
    firewallMode: asString(routing.firewallMode),
  };
}

function sanitizeHermesMetadata(payload: Record<string, unknown>): Record<string, unknown> | null {
  const hermes = asObject(payload.hermes);
  if (Object.keys(hermes).length === 0) return null;
  const referencesRaw = Array.isArray(hermes.references) ? hermes.references : [];
  const references = referencesRaw
    .map((item) => {
      const row = asObject(item);
      const refId = asString(row.refId);
      const sourceType = asString(row.sourceType);
      if (!refId || !sourceType) return null;
      return {
        refId,
        sourceType,
        title: asString(row.title),
      };
    })
    .filter((item): item is { refId: string; sourceType: string; title: string | null } => item !== null);
  return {
    mode: asString(hermes.mode),
    sanitized: asBoolean(hermes.sanitized) === true,
    references,
  };
}

function extractNotifyConfig(payload: Record<string, unknown>, routing: Record<string, unknown>): {
  mode: "never" | "on_failure" | "on_exit";
  chatId: number | null;
  preset: string | null;
} {
  const notify = asObject(routing.notify);
  const modeRaw = asString(notify.mode);
  const mode =
    modeRaw === "on_exit" || modeRaw === "on_failure" || modeRaw === "never"
      ? modeRaw
      : asString(routing.channel) === "telegram"
        ? "on_failure"
        : "never";
  const explicitChat = asNumber(notify.chatId);
  const fallbackChannelKey = Number(asString(routing.channelKey));
  const chatId =
    typeof explicitChat === "number" && explicitChat > 0
      ? Math.floor(explicitChat)
      : Number.isFinite(fallbackChannelKey) && fallbackChannelKey > 0
        ? Math.floor(fallbackChannelKey)
        : null;
  const preset = asString(notify.preset) ?? "orchestrator";
  return { mode, chatId, preset };
}

async function appendText(logPath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, text, "utf8");
}

export function createNodeProcessDeliveryHandler(deps: {
  db: NexusDatabase;
  stateDir: string;
  log: (line: string) => void;
}): {
  handleProcessUpdate: (ctx: ProcessDeliveryContext) => Promise<boolean>;
  handleLogAppend: (ctx: ProcessDeliveryContext) => Promise<void>;
} {
  const nodeLogsDir = path.join(deps.stateDir, "node-processes");

  const resolveLogPath = (nodeId: string, processId: string): string =>
    path.join(nodeLogsDir, `${safeFileName(nodeId)}_${safeFileName(processId)}.log`);

  const upsertRow = (params: {
    processId: string;
    nodeId: string;
    command: string;
    cwd: string;
    status: "running" | "exited" | "stopped";
    startedAt: number;
    endedAt: number | null;
    exitCode: number | null;
    signal: string | null;
    logPath: string;
    routing: Record<string, unknown>;
    metadata: Record<string, unknown>;
    notifyMode: "never" | "on_failure" | "on_exit";
    notifyChatId: number | null;
    notifyPreset: string | null;
    nowMs: number;
  }): void => {
    const requestChannel = asString(params.routing.channel);
    const requestChannelKey = asString(params.routing.channelKey);
    const requestSessionId = asString(params.routing.sessionId);
    const requestRunId = asString(params.routing.runId);
    const requestParentRunId = asString(params.routing.parentRunId);
    deps.db.db
      .prepare(
        `
        INSERT INTO process_runs (
          id, backend, status, command, cwd, pid, started_at, ended_at, exit_code, signal, log_path,
          node_id, node_execution_id, created_by_job_id, created_by_job_run_id,
          request_channel, request_channel_key, request_agent_id, request_preset, request_session_id, request_run_id, request_parent_run_id,
          metadata_json, notify_mode, notify_chat_id, notify_preset, notify_attempts, notify_last_error, notify_next_attempt_at, notified_at,
          created_at, updated_at
        ) VALUES (
          @id, 'node_process', @status, @command, @cwd, NULL, @started_at, @ended_at, @exit_code, @signal, @log_path,
          @node_id, @node_execution_id, NULL, NULL,
          @request_channel, @request_channel_key, NULL, NULL, @request_session_id, @request_run_id, @request_parent_run_id,
          @metadata_json, @notify_mode, @notify_chat_id, @notify_preset, 0, NULL, NULL, NULL,
          @created_at, @updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
          backend = 'node_process',
          status = excluded.status,
          command = CASE WHEN process_runs.command = '' OR process_runs.command IS NULL THEN excluded.command ELSE process_runs.command END,
          cwd = CASE WHEN process_runs.cwd = '' OR process_runs.cwd IS NULL THEN excluded.cwd ELSE process_runs.cwd END,
          ended_at = COALESCE(excluded.ended_at, process_runs.ended_at),
          exit_code = COALESCE(excluded.exit_code, process_runs.exit_code),
          signal = COALESCE(excluded.signal, process_runs.signal),
          log_path = CASE WHEN process_runs.log_path = '' OR process_runs.log_path IS NULL THEN excluded.log_path ELSE process_runs.log_path END,
          node_id = COALESCE(process_runs.node_id, excluded.node_id),
          node_execution_id = COALESCE(process_runs.node_execution_id, excluded.node_execution_id),
          request_channel = COALESCE(process_runs.request_channel, excluded.request_channel),
          request_channel_key = COALESCE(process_runs.request_channel_key, excluded.request_channel_key),
          request_session_id = COALESCE(process_runs.request_session_id, excluded.request_session_id),
          request_run_id = COALESCE(process_runs.request_run_id, excluded.request_run_id),
          request_parent_run_id = COALESCE(process_runs.request_parent_run_id, excluded.request_parent_run_id),
          metadata_json = excluded.metadata_json,
          notify_mode = CASE WHEN process_runs.notify_mode = 'never' THEN excluded.notify_mode ELSE process_runs.notify_mode END,
          notify_chat_id = COALESCE(process_runs.notify_chat_id, excluded.notify_chat_id),
          notify_preset = COALESCE(process_runs.notify_preset, excluded.notify_preset),
          updated_at = excluded.updated_at
      `,
      )
      .run({
        id: params.processId,
        status: params.status,
        command: params.command,
        cwd: params.cwd,
        started_at: params.startedAt,
        ended_at: params.endedAt,
        exit_code: params.exitCode,
        signal: params.signal,
        log_path: params.logPath,
        node_id: params.nodeId,
        node_execution_id: params.processId,
        request_channel: requestChannel,
        request_channel_key: requestChannelKey,
        request_session_id: requestSessionId,
        request_run_id: requestRunId,
        request_parent_run_id: requestParentRunId,
        metadata_json: JSON.stringify(params.metadata),
        notify_mode: params.notifyMode,
        notify_chat_id: params.notifyChatId,
        notify_preset: params.notifyPreset,
        created_at: params.startedAt,
        updated_at: params.nowMs,
      });
  };

  const handleProcessUpdate = async (ctx: ProcessDeliveryContext): Promise<boolean> => {
    const processId = asString(ctx.payload.processId);
    if (!processId) {
      deps.log(`nodes/ws: process.update missing processId node=${ctx.nodeId}`);
      return false;
    }
    const nodeStatus = normalizeNodeProcessStatus(asString(ctx.payload.status));
    const gatewayStatus = mapGatewayStatus(nodeStatus);
    const startedAt = asNumber(ctx.payload.startedAt) ?? ctx.receivedAt;
    const endedAtRaw = asNumber(ctx.payload.endedAt);
    const endedAt = gatewayStatus === "running" ? null : endedAtRaw ?? ctx.receivedAt;
    const exitCodeRaw = asNumber(ctx.payload.exitCode);
    const exitCode =
      gatewayStatus === "running"
        ? null
        : exitCodeRaw ?? (nodeStatus === "completed" ? 0 : nodeStatus === "failed" ? 1 : null);
    const signal = asString(ctx.payload.signal);
    const summary = asString(ctx.payload.summary);
    const command = asString(ctx.payload.command) ?? `node_process ${processId}`;
    const cwd = asString(ctx.payload.cwd) ?? "/";
    const deliveryId = asString(ctx.payload.deliveryId);
    const routing = normalizeRouting(ctx.payload);
    const metadata: Record<string, unknown> = {
      node: {
        id: ctx.nodeId,
        processId,
        status: nodeStatus,
        deliveryId,
        ts: asNumber(ctx.payload.ts) ?? ctx.receivedAt,
      },
      routing: sanitizeRoutingForMetadata(routing),
    };
    const hermesMetadata = sanitizeHermesMetadata(ctx.payload);
    if (hermesMetadata) metadata.hermes = hermesMetadata;
    const notify = extractNotifyConfig(ctx.payload, routing);
    const logPath = resolveLogPath(ctx.nodeId, processId);

    if (summary) {
      try {
        await appendText(
          logPath,
          `\n[node-summary ${new Date(ctx.receivedAt).toISOString()} status=${nodeStatus}] ${summary}\n`,
        );
      } catch (err) {
        deps.log(
          `nodes/ws: failed to append process summary node=${ctx.nodeId} process=${processId} error=${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    try {
      upsertRow({
        processId,
        nodeId: ctx.nodeId,
        command,
        cwd,
        status: gatewayStatus,
        startedAt,
        endedAt,
        exitCode,
        signal,
        logPath,
        routing,
        metadata,
        notifyMode: notify.mode,
        notifyChatId: notify.chatId,
        notifyPreset: notify.preset,
        nowMs: ctx.receivedAt,
      });
      return true;
    } catch (err) {
      deps.log(
        `nodes/ws: failed to persist process.update node=${ctx.nodeId} process=${processId} error=${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  const handleLogAppend = async (ctx: ProcessDeliveryContext): Promise<void> => {
    const processId = asString(ctx.payload.processId);
    const chunk = asRawString(ctx.payload.chunk);
    if (!processId || chunk === null) return;
    const stream = asString(ctx.payload.stream) ?? "stdout";
    const logPath = resolveLogPath(ctx.nodeId, processId);
    try {
      await appendText(logPath, chunk);
    } catch (err) {
      deps.log(
        `nodes/ws: failed to persist log.append node=${ctx.nodeId} process=${processId} error=${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    // Ensure a process row exists even if only log chunks were observed first.
    try {
      const existing = deps.db.db
        .prepare("SELECT id FROM process_runs WHERE id = ?")
        .get(processId) as { id?: string } | undefined;
      if (!existing?.id) {
        upsertRow({
          processId,
          nodeId: ctx.nodeId,
          command: `node_process ${processId}`,
          cwd: "/",
          status: "running",
          startedAt: ctx.receivedAt,
          endedAt: null,
          exitCode: null,
          signal: null,
          logPath,
          routing: {},
          metadata: {
            node: {
              id: ctx.nodeId,
              processId,
              status: "running",
            },
            stream,
          },
          notifyMode: "never",
          notifyChatId: null,
          notifyPreset: null,
          nowMs: ctx.receivedAt,
        });
      }
    } catch (err) {
      deps.log(
        `nodes/ws: failed to upsert log-only process row node=${ctx.nodeId} process=${processId} error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return {
    handleProcessUpdate,
    handleLogAppend,
  };
}
