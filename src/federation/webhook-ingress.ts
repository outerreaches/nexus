import crypto from "node:crypto";

import type { NexusDatabase } from "../storage/database.js";
import {
  appendFederationEvent,
  getFederationEventByEnvelopeId,
  getFederationGrantProjectionForPeerResource,
  getWebhookEndpointById,
  listWebhookSubscriptions,
  type FederationExportResourceType,
  type WebhookEndpointRecord,
} from "../storage/federation.js";
import { applySharedEventProjection } from "./sharing.js";
import { eventTypeMatchesFilter } from "./webhook.js";

export type CanonicalWebhookIngress = {
  eventId: string;
  traceId: string;
  kind: string;
  ts: number;
  destinationEndpointId: string;
  destinationPeerId?: string | null;
  idempotencyKey?: string | null;
  sensitivity?: string | null;
  payload: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

export type WebhookIngressSource =
  | {
      kind: "federation_peer";
      peerId: string;
      sourceInstance?: string | null;
    }
  | {
      kind: "node";
      nodeId: string;
      sessionId?: string | null;
    };

export type WebhookIngressResult =
  | {
      ok: true;
      duplicate: boolean;
      endpoint: WebhookEndpointRecord | null;
      eventRecordId: string | null;
      storedPayload: Record<string, unknown> | null;
    }
  | {
      ok: false;
      status: number;
      code: string;
      error: string;
    };

function fail(status: number, code: string, error: string): WebhookIngressResult {
  return {
    ok: false,
    status,
    code,
    error,
  };
}

export function mapWebhookEventToResourceType(eventType: string): FederationExportResourceType | null {
  const normalized = eventType.trim().toLowerCase();
  if (normalized.startsWith("node.share.")) return "node_pool";
  if (normalized.startsWith("data_intake.share.")) return "data_intake";
  if (normalized.startsWith("blackboard.share.")) return "blackboard";
  if (normalized.startsWith("mcp.share.")) return "mcp";
  return null;
}

export function ingestWebhookIngressEvent(params: {
  db: NexusDatabase;
  source: WebhookIngressSource;
  ingress: CanonicalWebhookIngress;
  nowMs?: number;
}): WebhookIngressResult {
  const nowMs = params.nowMs ?? Date.now();
  const existing = getFederationEventByEnvelopeId(params.db, {
    envelopeId: params.ingress.eventId,
    direction: "inbound",
  });
  if (existing) {
    return {
      ok: true,
      duplicate: true,
      endpoint: getWebhookEndpointById(params.db, params.ingress.destinationEndpointId),
      eventRecordId: existing.id,
      storedPayload: null,
    };
  }

  const endpoint = getWebhookEndpointById(params.db, params.ingress.destinationEndpointId);
  if (!endpoint || !endpoint.enabled || endpoint.status !== "active") {
    return fail(410, "endpoint_not_active", "endpoint is not active");
  }

  if (params.source.kind === "federation_peer") {
    if (endpoint.ownerScope === "federation_peer" && endpoint.peerId !== params.source.peerId) {
      return fail(403, "endpoint_peer_binding_mismatch", "endpoint peer binding mismatch");
    }
  } else if (endpoint.ownerScope !== "local") {
    return fail(403, "node_ingress_scope_mismatch", "node webhook ingress requires local endpoint ownership");
  }

  const subscriptions = listWebhookSubscriptions(params.db, {
    endpointId: endpoint.id,
    enabledOnly: true,
    limit: 500,
  });
  if (subscriptions.length > 0) {
    const match = subscriptions.some((sub) => eventTypeMatchesFilter(params.ingress.kind, sub.eventType));
    if (!match) return fail(403, "subscription_miss", "no matching subscription for event kind");
  }

  let projectedWebhookPayload: Record<string, unknown> = params.ingress.payload;
  const resourceType = mapWebhookEventToResourceType(params.ingress.kind);
  if (params.source.kind === "federation_peer" && resourceType && endpoint.peerId) {
    const grantProjection = getFederationGrantProjectionForPeerResource(params.db, {
      peerId: endpoint.peerId,
      resourceType,
    });
    if (!grantProjection) {
      return fail(403, "shared_resource_grant_missing", `no grant for shared resource type ${resourceType}`);
    }
    const projectionOutcome = applySharedEventProjection({
      payload: params.ingress.payload,
      projection: grantProjection.projection,
      sensitivityCeiling: grantProjection.sensitivityCeiling,
    });
    if (!projectionOutcome.allowed) {
      return fail(403, "shared_projection_denied", `shared event projection denied: ${projectionOutcome.reason}`);
    }
    projectedWebhookPayload = projectionOutcome.payload;
  }

  const eventRecordId = crypto.randomUUID();
  appendFederationEvent(params.db, {
    id: eventRecordId,
    peerId: params.source.kind === "federation_peer" ? params.source.peerId : null,
    eventType: params.ingress.kind,
    direction: "inbound",
    envelopeId: params.ingress.eventId,
    payload: {
      webhook: projectedWebhookPayload,
      destination: {
        endpointId: params.ingress.destinationEndpointId,
        peerId: params.ingress.destinationPeerId ?? null,
      },
      source:
        params.source.kind === "federation_peer"
          ? {
              kind: "federation_peer",
              peerId: params.source.peerId,
              sourceInstance: params.source.sourceInstance ?? null,
            }
          : {
              kind: "node",
              nodeId: params.source.nodeId,
              sessionId: params.source.sessionId ?? null,
            },
      ingress: {
        idempotencyKey: params.ingress.idempotencyKey ?? null,
        sensitivity: params.ingress.sensitivity ?? null,
        ts: params.ingress.ts,
        meta: params.ingress.meta ?? null,
      },
    },
    traceId: params.ingress.traceId,
    nowMs,
  });

  return {
    ok: true,
    duplicate: false,
    endpoint,
    eventRecordId,
    storedPayload: projectedWebhookPayload,
  };
}
