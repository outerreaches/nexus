export type FederationTransportKind = "node_ws" | "federation_http";

export type FederationTransportOperation =
  | "transport.peer.register"
  | "transport.peer.update"
  | "transport.peer.remove"
  | "transport.request.send"
  | "transport.response.handle"
  | "transport.event.publish"
  | "transport.event.ingest"
  | "transport.delivery.ack"
  | "transport.delivery.retry"
  | "transport.health.check";

export interface FederationEnvelope<TPayload = unknown> {
  envelopeId: string;
  schemaVersion: string;
  transportKind: FederationTransportKind;
  source: string;
  destination: string;
  methodOrEvent: string;
  ts: number;
  nonce: string;
  payload: TPayload;
  idempotencyKey?: string;
  traceId: string;
}

export interface FederationSignedEnvelope<TPayload = unknown> extends FederationEnvelope<TPayload> {
  kid: string;
  sig: string;
}

export interface FederationDeliveryReceipt {
  envelopeId: string;
  status: "ack" | "retry";
  reason?: string;
  ts: number;
}

export type FederationWebhookMode = "federated_only" | "external_enabled";

export interface FederationWebhookEvent<TPayload = unknown> {
  eventId: string;
  eventType: string;
  sourceInstance: string;
  targetInstance?: string;
  payload: TPayload;
  ts: number;
  traceId: string;
}
