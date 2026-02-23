import { randomUUID } from "node:crypto";

import { containsRawSecretMaterial } from "../secrets/policy.js";
import type { NexusDatabase } from "../storage/database.js";
import { appendFederationAudit } from "../storage/federation.js";
import { enqueueRunReport } from "../storage/run-reports.js";
import { ingestWebhookIngressEvent } from "../federation/webhook-ingress.js";

export type NodeWebhookIngressContext = {
  nodeId: string;
  sessionId: string;
  event: string;
  payload: Record<string, unknown>;
  receivedAt: number;
};

type CanonicalNodeWebhook = {
  eventId: string;
  traceId: string;
  kind: string;
  ts: number;
  endpointId: string;
  destinationPeerId: string | null;
  idempotencyKey: string;
  sensitivity: string;
  payload: Record<string, unknown>;
  meta: Record<string, unknown>;
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

function asNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…(+${value.length - maxChars} chars)`;
}

function normalizeNodeWebhook(ctx: NodeWebhookIngressContext): CanonicalNodeWebhook | null {
  if (ctx.event !== "webhook.deliver" && ctx.event !== "transport.event.ingest") return null;
  const wrapper = asObject(ctx.payload);
  const transportEventType = asString(wrapper.eventType) ?? asString(wrapper.kind);
  let body = wrapper;
  if (ctx.event === "transport.event.ingest") {
    if (transportEventType && transportEventType !== "webhook.deliver") return null;
    const nested = asObject(wrapper.payload);
    if (Object.keys(nested).length > 0) body = nested;
  }

  const destination = asObject(body.destination);
  const endpointId = asString(destination.endpointId) ?? asString(body.endpointId);
  if (!endpointId) return null;

  const eventId = asString(body.eventId) ?? asString(body.id) ?? randomUUID();
  const traceId = asString(body.traceId) ?? eventId;
  const kind = asString(body.kind) ?? asString(body.eventType) ?? "node.webhook.received";
  const ts = asNumber(body.ts) ?? ctx.receivedAt;
  const idempotencyKey = asString(body.idempotencyKey) ?? eventId;
  const sensitivity = asString(body.sensitivity) ?? "internal";
  const payload = asObject(body.payload);
  const meta = asObject(body.meta);
  const destinationPeerId = asString(destination.peerId);

  return {
    eventId,
    traceId,
    kind,
    ts,
    endpointId,
    destinationPeerId: destinationPeerId ?? null,
    idempotencyKey,
    sensitivity,
    payload,
    meta,
  };
}

export function createNodeWebhookIngressHandler(deps: {
  db: NexusDatabase;
  log: (line: string) => void;
  targetAgentId?: string;
}): {
  handle: (ctx: NodeWebhookIngressContext) => Promise<boolean>;
} {
  const targetAgentId = (deps.targetAgentId ?? "main").trim() || "main";

  const handle = async (ctx: NodeWebhookIngressContext): Promise<boolean> => {
    const normalized = normalizeNodeWebhook(ctx);
    if (!normalized) return false;

    const ingress = ingestWebhookIngressEvent({
      db: deps.db,
      source: {
        kind: "node",
        nodeId: ctx.nodeId,
        sessionId: ctx.sessionId,
      },
      ingress: {
        eventId: normalized.eventId,
        traceId: normalized.traceId,
        kind: normalized.kind,
        ts: normalized.ts,
        destinationEndpointId: normalized.endpointId,
        destinationPeerId: normalized.destinationPeerId,
        idempotencyKey: normalized.idempotencyKey,
        sensitivity: normalized.sensitivity,
        payload: normalized.payload,
        meta: normalized.meta,
      },
      nowMs: ctx.receivedAt,
    });

    if (!ingress.ok) {
      appendFederationAudit(deps.db, {
        id: randomUUID(),
        peerId: null,
        eventType: "control.node_webhook_ingress.rejected",
        decision: "deny",
        actor: `node:${ctx.nodeId}`,
        traceId: normalized.traceId,
        details: {
          code: ingress.code,
          reason: ingress.error,
          endpointId: normalized.endpointId,
          kind: normalized.kind,
          eventId: normalized.eventId,
          sessionId: ctx.sessionId,
        },
        nowMs: ctx.receivedAt,
      });
      deps.log(
        `node/webhook: rejected node=${ctx.nodeId} endpoint=${normalized.endpointId} kind=${normalized.kind} code=${ingress.code} reason=${ingress.error}`,
      );
      return true;
    }

    if (ingress.duplicate) {
      appendFederationAudit(deps.db, {
        id: randomUUID(),
        peerId: null,
        eventType: "control.node_webhook_ingress.duplicate",
        decision: "info",
        actor: `node:${ctx.nodeId}`,
        traceId: normalized.traceId,
        details: {
          endpointId: normalized.endpointId,
          kind: normalized.kind,
          eventId: normalized.eventId,
          sessionId: ctx.sessionId,
        },
        nowMs: ctx.receivedAt,
      });
      deps.log(
        `node/webhook: duplicate node=${ctx.nodeId} endpoint=${normalized.endpointId} kind=${normalized.kind} event=${normalized.eventId}`,
      );
      return true;
    }

    const payloadHasSecrets = containsRawSecretMaterial(normalized.payload);
    const payloadPreview = payloadHasSecrets
      ? "[redacted: payload contains secret-like material]"
      : truncate(JSON.stringify(normalized.payload, null, 2), 6000);
    const reportBody = [
      "NODE WEBHOOK EVENT",
      `node_id=${ctx.nodeId}`,
      `session_id=${ctx.sessionId}`,
      `event_id=${normalized.eventId}`,
      `trace_id=${normalized.traceId}`,
      `kind=${normalized.kind}`,
      `endpoint_id=${normalized.endpointId}`,
      `received_at=${new Date(ctx.receivedAt).toISOString()}`,
      "",
      "Payload:",
      payloadPreview,
    ].join("\n");

    const reportId = enqueueRunReport(deps.db, {
      kind: "node_webhook",
      title: `NODE WEBHOOK (${normalized.kind})`,
      body: reportBody,
      sourceAgentId: `node:${ctx.nodeId}`,
      sourceChannel: "node_webhook",
      sourceChannelKey: ctx.nodeId,
      targetAgentId,
      targetChannel: "agent",
      targetChannelKey: `node:${ctx.nodeId}:webhook`,
      metadata: {
        targetPreset: "orchestrator",
        nodeId: ctx.nodeId,
        sessionId: ctx.sessionId,
        endpointId: normalized.endpointId,
        kind: normalized.kind,
        eventId: normalized.eventId,
        traceId: normalized.traceId,
        payloadRedacted: payloadHasSecrets,
      },
      nowMs: ctx.receivedAt,
    });
    appendFederationAudit(deps.db, {
      id: randomUUID(),
      peerId: null,
      eventType: "control.node_webhook_ingress.accepted",
      decision: "info",
      actor: `node:${ctx.nodeId}`,
      traceId: normalized.traceId,
      details: {
        endpointId: normalized.endpointId,
        kind: normalized.kind,
        eventId: normalized.eventId,
        reportId,
        sessionId: ctx.sessionId,
      },
      nowMs: ctx.receivedAt,
    });
    deps.log(
      `node/webhook: accepted node=${ctx.nodeId} endpoint=${normalized.endpointId} kind=${normalized.kind} event=${normalized.eventId} report=${reportId}`,
    );
    return true;
  };

  return {
    handle,
  };
}
