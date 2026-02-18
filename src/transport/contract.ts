import type { FederationOutboxRecord } from "../storage/federation.js";
import type { FederationTransportKind } from "../federation/types.js";

export type CanonicalTransportMessage =
  | {
    kind: "request";
    envelopeId: string;
    traceId: string;
    method: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }
  | {
    kind: "event";
    envelopeId: string;
    traceId: string;
    eventType: string;
    payload: Record<string, unknown>;
    orderingKey: string | null;
  }
  | {
    kind: "ack";
    envelopeId: string;
    traceId: string;
    ackStatus: "ack" | "retry";
    reason: string | null;
  };

export type TransportAdapterContract = {
  request: string;
  event: string;
  ack: string;
};

export const TRANSPORT_ADAPTER_CONTRACT: Record<FederationTransportKind, TransportAdapterContract> = {
  federation_http: {
    request: "POST /api/federation/inbox",
    event: "POST /federation-webhook",
    ack: "HTTP status or receipt",
  },
  node_ws: {
    request: "protocol.request.send",
    event: "protocol.event.publish",
    ack: "protocol.delivery.ack/retry",
  },
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseCanonicalTransportMessage(item: FederationOutboxRecord): CanonicalTransportMessage | null {
  const payload = asObject(item.envelope);
  const traceId = item.traceId ?? item.id;

  const method = asText(payload.method);
  if (method) {
    return {
      kind: "request",
      envelopeId: item.id,
      traceId,
      method,
      payload,
      idempotencyKey: traceId,
    };
  }

  const eventType = asText(payload.eventType ?? payload.kind);
  if (eventType) {
    return {
      kind: "event",
      envelopeId: item.id,
      traceId,
      eventType,
      payload,
      orderingKey: asText(asObject(payload.meta).orderingKey),
    };
  }

  const ackRaw = asText(payload.ackStatus ?? payload.status);
  if (ackRaw === "ack" || ackRaw === "retry") {
    return {
      kind: "ack",
      envelopeId: item.id,
      traceId,
      ackStatus: ackRaw,
      reason: asText(payload.reason),
    };
  }

  return null;
}
