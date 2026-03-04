import crypto from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { KeyObject } from "node:crypto";
import type { LookupAddress } from "node:dns";
import type { IncomingHttpHeaders } from "node:http";

import {
  appendWebhookDlq,
  getFederationGrantProjectionForPeerResource,
  getFederationEventById,
  getFederationPeerById,
  getWebhookEndpointById,
  listWebhookDeliveries,
  listWebhookSubscriptions,
  updateWebhookDeliveryStatus,
  type FederationExportResourceType,
} from "../storage/federation.js";
import type { NexusDatabase } from "../storage/database.js";
import {
  buildWebhookCanonicalSigningInput,
  eventTypeMatchesFilter,
  signWebhookCanonicalInput,
  signWebhookCanonicalInputHmac,
  type FederationWebhookEnvelope,
} from "./webhook.js";
import { evaluateFederationFirewall } from "./firewall.js";
import { applySharedEventProjection } from "./sharing.js";
import { containsRawSecretMaterial } from "../secrets/policy.js";
import { resolveSecretReference } from "../secrets/provider.js";
import { classifyHttpDelivery } from "../transport/delivery.js";

export type WebhookDeliverySigningMaterial = {
  privateKey: KeyObject;
  keyId: string;
};

export type WebhookDeliveryWorker = {
  stop: () => void;
  tick: () => Promise<number>;
};

function isLocalOrPrivateLiteralIp(hostname: string): boolean {
  const kind = net.isIP(hostname);
  if (kind === 0) return false;
  if (kind === 4) {
    const octets = hostname.split(".").map((part) => Number(part));
    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 0) return true;
    return false;
  }
  const normalized = hostname.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("fe80:")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  return false;
}

function isHostAllowed(url: URL): boolean {
  const host = url.hostname.trim().toLowerCase();
  if (!host) return false;
  if (host === "localhost") return false;
  if (host.endsWith(".localhost")) return false;
  if (host === "metadata.google.internal") return false;
  if (host === "metadata.google.internal.") return false;
  if (host === "metadata.azure.internal") return false;
  if (host === "metadata") return false;
  if (isLocalOrPrivateLiteralIp(host)) return false;
  return true;
}

function mapEventTypeToResourceType(eventType: string): FederationExportResourceType | null {
  const normalized = eventType.trim().toLowerCase();
  if (normalized.startsWith("node.share.")) return "node_pool";
  if (normalized.startsWith("data_intake.share.")) return "data_intake";
  if (normalized.startsWith("blackboard.share.")) return "blackboard";
  if (normalized.startsWith("mcp.share.")) return "mcp";
  return null;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars);
}

function isRetryableSecretResolutionError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("timeout")) return true;
  if (normalized.includes("econnrefused")) return true;
  if (normalized.includes("ehostunreach")) return true;
  if (normalized.includes("enetunreach")) return true;
  if (normalized.includes("secret_broker_http_5")) return true;
  if (normalized.includes("secret_provider_unavailable")) return true;
  return false;
}

type WebhookHttpResponse = {
  status: number;
  ok: boolean;
  headers: Headers;
  body: string;
};

type WebhookDnsLookup = (hostname: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>;

type WebhookPinnedAddress = {
  address: string;
  family: number;
};

function normalizeIpForCompare(value: string): string {
  let normalized = value.trim().toLowerCase();
  if (!normalized) return normalized;
  normalized = normalized.replace(/^\[/, "").replace(/\]$/, "");
  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);
  if (normalized.startsWith("::ffff:")) {
    return normalized.slice("::ffff:".length);
  }
  return normalized;
}

function ipMatchesPinnedAddress(remoteAddress: string | undefined | null, pinnedAddress: string): boolean {
  if (!remoteAddress) return false;
  return normalizeIpForCompare(remoteAddress) === normalizeIpForCompare(pinnedAddress);
}

async function readFetchResponseBodyLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  while (!done) {
    const result = await reader.read();
    if (result.done) {
      done = true;
      continue;
    }
    const value = result.value;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error("response_body_too_large");
    }
    chunks.push(value);
  }
  if (chunks.length === 0) return "";
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function sendWebhookRequestWithFetch(params: {
  fetchImpl: typeof fetch;
  url: URL;
  headers: Record<string, string>;
  bodyJson: string;
  requestTimeoutMs: number;
  maxResponseBytes: number;
}): Promise<WebhookHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.requestTimeoutMs);
  try {
    const response = await params.fetchImpl(params.url.toString(), {
      method: "POST",
      headers: params.headers,
      body: params.bodyJson,
      redirect: "manual",
      signal: controller.signal,
    });
    const body = await readFetchResponseBodyLimited(response, params.maxResponseBytes);
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      body,
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildHeadersFromIncoming(value: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, headerValue] of Object.entries(value)) {
    if (!headerValue) continue;
    if (Array.isArray(headerValue)) {
      headers.set(key, headerValue.join(", "));
      continue;
    }
    headers.set(key, headerValue);
  }
  return headers;
}

async function sendWebhookRequestPinned(params: {
  url: URL;
  headers: Record<string, string>;
  bodyJson: string;
  pinnedAddress: WebhookPinnedAddress;
  requestTimeoutMs: number;
  connectTimeoutMs: number;
  readTimeoutMs: number;
  maxResponseBytes: number;
}): Promise<WebhookHttpResponse> {
  const transport = params.url.protocol === "https:" ? https : http;
  const connectEvent = params.url.protocol === "https:" ? "secureConnect" : "connect";
  return await new Promise<WebhookHttpResponse>((resolve, reject) => {
    let settled = false;
    const settleReject = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const settleResolve = (result: WebhookHttpResponse): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const request = transport.request(
      {
        protocol: params.url.protocol,
        hostname: params.url.hostname,
        port: params.url.port ? Number(params.url.port) : undefined,
        method: "POST",
        path: `${params.url.pathname}${params.url.search}`,
        headers: {
          ...params.headers,
          "content-length": Buffer.byteLength(params.bodyJson).toString(),
        },
        lookup: (_hostname, _options, callback) => {
          callback(null, params.pinnedAddress.address, params.pinnedAddress.family);
        },
        servername: params.url.hostname,
        rejectUnauthorized: true,
      },
      (response) => {
        response.setTimeout(params.readTimeoutMs, () => {
          response.destroy(new Error("read_timeout"));
        });
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > params.maxResponseBytes) {
            response.destroy(new Error("response_body_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", (err) => {
          settleReject(err);
        });
        response.on("end", () => {
          const body = chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "";
          const status = response.statusCode ?? 0;
          settleResolve({
            status,
            ok: status >= 200 && status < 300,
            headers: buildHeadersFromIncoming(response.headers),
            body,
          });
        });
      },
    );
    request.setTimeout(params.requestTimeoutMs, () => {
      request.destroy(new Error("request_timeout"));
    });
    request.on("socket", (socket) => {
      const connectTimer = setTimeout(() => {
        request.destroy(new Error("connect_timeout"));
      }, params.connectTimeoutMs);
      const onConnected = () => {
        clearTimeout(connectTimer);
        if (!ipMatchesPinnedAddress(socket.remoteAddress, params.pinnedAddress.address)) {
          request.destroy(new Error("connect_target_mismatch"));
        }
      };
      socket.once(connectEvent, onConnected);
      socket.once("error", (err) => {
        clearTimeout(connectTimer);
        settleReject(err);
      });
      socket.once("close", () => {
        clearTimeout(connectTimer);
      });
    });
    request.on("error", (err) => {
      settleReject(err);
    });
    request.write(params.bodyJson);
    request.end();
  });
}

async function resolvePinnedAddress(params: {
  url: URL;
  lookupHost: WebhookDnsLookup;
}): Promise<WebhookPinnedAddress> {
  const records = await params.lookupHost(params.url.hostname, {
    all: true,
    verbatim: true,
  });
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("hostname_not_resolved");
  }
  const deduped = new Map<string, WebhookPinnedAddress>();
  for (const record of records) {
    const address = record.address.trim();
    if (!address) continue;
    const key = `${record.family}:${address}`;
    if (!deduped.has(key)) {
      deduped.set(key, {
        address,
        family: record.family,
      });
    }
  }
  const normalized = [...deduped.values()];
  if (normalized.length === 0) {
    throw new Error("hostname_not_resolved");
  }
  const blocked = normalized.find((entry) => isLocalOrPrivateLiteralIp(entry.address));
  if (blocked) {
    throw new Error(`dns_resolves_to_blocked_ip:${blocked.address}`);
  }
  return normalized[0]!;
}

export function startWebhookDeliveryWorker(params: {
  db: NexusDatabase;
  stateDir: string;
  localInstanceId: string;
  getSigningMaterial: () => WebhookDeliverySigningMaterial | null | Promise<WebhookDeliverySigningMaterial | null>;
  webhooksFederatedOnly: boolean;
  webhooksExternalEnabled: boolean;
  isFederationEgressDisabled?: () => boolean;
  allowInsecureHttp?: boolean;
  intervalMs?: number;
  maxBatch?: number;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
  lookupHost?: WebhookDnsLookup;
  log?: (msg: string) => void;
}): WebhookDeliveryWorker {
  const fetchImpl = params.fetchImpl;
  const lookupHost = params.lookupHost ?? dns.lookup.bind(dns);
  const log = params.log ?? (() => {});
  const allowInsecureHttp = params.allowInsecureHttp === true;
  const intervalMs = Math.max(1_000, params.intervalMs ?? 5_000);
  const maxBatch = Math.max(1, params.maxBatch ?? 20);
  const maxAttempts = Math.max(1, params.maxAttempts ?? 12);
  const requestTimeoutMs = Math.max(1_000, params.requestTimeoutMs ?? 10_000);
  const connectTimeoutMs = Math.max(500, Math.min(requestTimeoutMs, params.connectTimeoutMs ?? 3_000));
  const readTimeoutMs = Math.max(500, params.readTimeoutMs ?? 8_000);
  const maxResponseBytes = Math.max(1_024, params.maxResponseBytes ?? 32_768);
  let closed = false;
  let inFlight = false;

  const markDeadLetter = (args: {
    deliveryId: string;
    endpointId: string;
    attempts: number;
    nowMs: number;
    reason: string;
    traceId: string | null;
    payload?: Record<string, unknown>;
  }): void => {
    updateWebhookDeliveryStatus(params.db, {
      id: args.deliveryId,
      status: "dead_letter",
      attempts: args.attempts,
      responseCode: null,
      responseBody: truncate(args.reason, 500),
      nextAttemptAt: null,
      lastAttemptAt: args.nowMs,
      nowMs: args.nowMs,
    });
    appendWebhookDlq(params.db, {
      id: crypto.randomUUID(),
      deliveryId: args.deliveryId,
      endpointId: args.endpointId,
      reason: args.reason,
      payload: {
        traceId: args.traceId,
        ...args.payload,
      },
      nowMs: args.nowMs,
    });
  };

  const tick = async (): Promise<number> => {
    if (closed || inFlight) return 0;
    inFlight = true;
    try {
      const nowMs = Date.now();
      if (params.isFederationEgressDisabled?.() === true) {
        return 0;
      }
      const candidates = listWebhookDeliveries(params.db, {
        limit: maxBatch * 3,
      }).filter(
        (row) =>
          (row.status === "pending" || row.status === "failed") &&
          (row.nextAttemptAt == null || row.nextAttemptAt <= nowMs),
      ).slice(0, maxBatch);

      let processed = 0;
      for (const row of candidates) {
        const attempts = row.attempts + 1;
        updateWebhookDeliveryStatus(params.db, {
          id: row.id,
          status: "sending",
          attempts,
          responseCode: null,
          responseBody: null,
          nextAttemptAt: null,
          lastAttemptAt: nowMs,
          nowMs,
        });

        const endpoint = getWebhookEndpointById(params.db, row.endpointId);
        if (!endpoint) {
          markDeadLetter({
            deliveryId: row.id,
            endpointId: row.endpointId,
            attempts,
            nowMs,
            reason: "endpoint_not_found",
            traceId: row.traceId,
          });
          processed += 1;
          continue;
        }
        if (!endpoint.enabled || endpoint.status !== "active") {
          markDeadLetter({
            deliveryId: row.id,
            endpointId: row.endpointId,
            attempts,
            nowMs,
            reason: "endpoint_not_active",
            traceId: row.traceId,
          });
          processed += 1;
          continue;
        }
        let targetUrl: URL;
        try {
          targetUrl = new URL(endpoint.url);
        } catch {
          markDeadLetter({
            deliveryId: row.id,
            endpointId: row.endpointId,
            attempts,
            nowMs,
            reason: "endpoint_invalid_url",
            traceId: row.traceId,
          });
          processed += 1;
          continue;
        }
        if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
          markDeadLetter({
            deliveryId: row.id,
            endpointId: row.endpointId,
            attempts,
            nowMs,
            reason: "endpoint_invalid_scheme",
            traceId: row.traceId,
          });
          processed += 1;
          continue;
        }
        if (targetUrl.protocol === "http:" && !allowInsecureHttp) {
          markDeadLetter({
            deliveryId: row.id,
            endpointId: row.endpointId,
            attempts,
            nowMs,
            reason: "endpoint_http_blocked_by_policy",
            traceId: row.traceId,
          });
          processed += 1;
          continue;
        }
        if (!isHostAllowed(targetUrl)) {
          markDeadLetter({
            deliveryId: row.id,
            endpointId: row.endpointId,
            attempts,
            nowMs,
            reason: "endpoint_host_not_allowlisted",
            traceId: row.traceId,
            payload: { host: targetUrl.hostname },
          });
          processed += 1;
          continue;
        }

        if (params.webhooksFederatedOnly) {
          if (endpoint.ownerScope !== "federation_peer" || !endpoint.peerId) {
            markDeadLetter({
              deliveryId: row.id,
              endpointId: row.endpointId,
              attempts,
              nowMs,
              reason: "webhook_mode_federated_only_requires_peer_endpoint",
              traceId: row.traceId,
            });
            processed += 1;
            continue;
          }
        } else if (!params.webhooksExternalEnabled && endpoint.ownerScope !== "federation_peer") {
          markDeadLetter({
            deliveryId: row.id,
            endpointId: row.endpointId,
            attempts,
            nowMs,
            reason: "external_webhooks_disabled",
            traceId: row.traceId,
          });
          processed += 1;
          continue;
        }

        const peer = endpoint.peerId ? getFederationPeerById(params.db, endpoint.peerId) : null;
        if (endpoint.ownerScope === "federation_peer") {
          if (!peer || !peer.enabled || peer.trustState !== "trusted") {
            markDeadLetter({
              deliveryId: row.id,
              endpointId: row.endpointId,
              attempts,
              nowMs,
              reason: "peer_not_trusted_for_webhook_delivery",
              traceId: row.traceId,
            });
            processed += 1;
            continue;
          }
          try {
            const peerUrl = new URL(peer.endpoint);
            if (peerUrl.hostname.toLowerCase() !== targetUrl.hostname.toLowerCase()) {
              markDeadLetter({
                deliveryId: row.id,
                endpointId: row.endpointId,
                attempts,
                nowMs,
                reason: "webhook_host_mismatch_with_peer",
                traceId: row.traceId,
              });
              processed += 1;
              continue;
            }
          } catch {
            markDeadLetter({
              deliveryId: row.id,
              endpointId: row.endpointId,
              attempts,
              nowMs,
              reason: "peer_endpoint_invalid_url",
              traceId: row.traceId,
            });
            processed += 1;
            continue;
          }
          if (endpoint.signingMode !== "ed25519") {
            markDeadLetter({
              deliveryId: row.id,
              endpointId: row.endpointId,
              attempts,
              nowMs,
              reason: "federation_peer_requires_ed25519_signing",
              traceId: row.traceId,
            });
            processed += 1;
            continue;
          }
        }

        if (!row.eventId) {
          markDeadLetter({
            deliveryId: row.id,
            endpointId: row.endpointId,
            attempts,
            nowMs,
            reason: "delivery_missing_event_id",
            traceId: row.traceId,
          });
          processed += 1;
          continue;
        }
        const event = getFederationEventById(params.db, row.eventId);
        if (!event) {
          markDeadLetter({
            deliveryId: row.id,
            endpointId: row.endpointId,
            attempts,
            nowMs,
            reason: "delivery_event_not_found",
            traceId: row.traceId,
            payload: { eventId: row.eventId },
          });
          processed += 1;
          continue;
        }

        const activeSubscriptions = listWebhookSubscriptions(params.db, {
          endpointId: endpoint.id,
          enabledOnly: true,
          limit: 500,
        });
        if (activeSubscriptions.length > 0) {
          const match = activeSubscriptions.some((sub) => eventTypeMatchesFilter(event.eventType, sub.eventType));
          if (!match) {
            updateWebhookDeliveryStatus(params.db, {
              id: row.id,
              status: "acked",
              attempts,
              responseCode: 204,
              responseBody: "filtered_out",
              nextAttemptAt: null,
              lastAttemptAt: nowMs,
              nowMs,
            });
            processed += 1;
            continue;
          }
        }
        if (endpoint.eventFilter.length > 0) {
          const endpointFilterMatch = endpoint.eventFilter.some((filter) => eventTypeMatchesFilter(event.eventType, filter));
          if (!endpointFilterMatch) {
            updateWebhookDeliveryStatus(params.db, {
              id: row.id,
              status: "acked",
              attempts,
              responseCode: 204,
              responseBody: "endpoint_filter_excluded",
              nextAttemptAt: null,
              lastAttemptAt: nowMs,
              nowMs,
            });
            processed += 1;
            continue;
          }
        }

        const requiredResourceType = mapEventTypeToResourceType(event.eventType);
        let projectedPayload: Record<string, unknown> = event.payload;
        if (requiredResourceType && endpoint.peerId) {
          const grantProjection = getFederationGrantProjectionForPeerResource(params.db, {
            peerId: endpoint.peerId,
            resourceType: requiredResourceType,
          });
          if (!grantProjection) {
            markDeadLetter({
              deliveryId: row.id,
              endpointId: row.endpointId,
              attempts,
              nowMs,
              reason: `grant_missing:${requiredResourceType}`,
              traceId: row.traceId,
              payload: { eventType: event.eventType },
            });
            processed += 1;
            continue;
          }
          const projectionOutcome = applySharedEventProjection({
            payload: event.payload,
            projection: grantProjection.projection,
            sensitivityCeiling: grantProjection.sensitivityCeiling,
          });
          if (!projectionOutcome.allowed) {
            markDeadLetter({
              deliveryId: row.id,
              endpointId: row.endpointId,
              attempts,
              nowMs,
              reason: `projection_denied:${projectionOutcome.reason}`,
              traceId: row.traceId,
              payload: {
                eventType: event.eventType,
                grantId: grantProjection.grantId,
              },
            });
            processed += 1;
            continue;
          }
          projectedPayload = projectionOutcome.payload;
        }
        if (containsRawSecretMaterial(projectedPayload)) {
          markDeadLetter({
            deliveryId: row.id,
            endpointId: row.endpointId,
            attempts,
            nowMs,
            reason: "secret_payload_export_blocked",
            traceId: row.traceId,
            payload: { eventType: event.eventType },
          });
          processed += 1;
          continue;
        }

        const firewallDecision = evaluateFederationFirewall({
          direction: "egress",
          methodOrEvent: "webhook.deliver",
          peerEnabled: peer?.enabled ?? true,
          peerTrustState: peer?.trustState ?? "trusted",
        });
        if (!firewallDecision.allowed) {
          markDeadLetter({
            deliveryId: row.id,
            endpointId: row.endpointId,
            attempts,
            nowMs,
            reason: `firewall_egress_denied:${firewallDecision.reason}`,
            traceId: row.traceId,
          });
          processed += 1;
          continue;
        }

        const bodyEnvelope: FederationWebhookEnvelope<Record<string, unknown>> = {
          schemaVersion: "1.0",
          eventId: event.id,
          traceId: event.traceId ?? row.traceId ?? event.id,
          kind: event.eventType,
          sourceInstance: params.localInstanceId,
          destination: {
            peerId: endpoint.peerId ?? undefined,
            endpointId: endpoint.id,
          },
          ts: nowMs,
          nonce: crypto.randomUUID(),
          idempotencyKey: `${event.id}:${endpoint.id}`,
          sensitivity: "internal",
          payload: projectedPayload,
          meta: {
            attempt: attempts,
            maxAttempts,
            orderingKey: `event:${event.id}`,
          },
        };
        const bodyJson = JSON.stringify(bodyEnvelope);
        const timestampHeader = String(nowMs);
        const canonical = buildWebhookCanonicalSigningInput({
          method: "POST",
          path: targetUrl.pathname || "/",
          timestamp: timestampHeader,
          nonce: bodyEnvelope.nonce,
          eventId: bodyEnvelope.eventId,
          bodyBytes: bodyJson,
        });

        let signature: string | null = null;
        let keyIdHeader: string | null = null;
        if (endpoint.signingMode === "hmac") {
          if (!endpoint.secretRef) {
            markDeadLetter({
              deliveryId: row.id,
              endpointId: endpoint.id,
              attempts,
              nowMs,
              reason: "endpoint_hmac_missing_secret_ref",
              traceId: row.traceId,
            });
            processed += 1;
            continue;
          }
          try {
            const secret = await resolveSecretReference({
              db: params.db,
              stateDir: params.stateDir,
              reference: endpoint.secretRef,
              traceId: row.traceId ?? event.traceId ?? row.id,
              actor: "webhook:dispatcher",
              firewallSession: `webhook:${row.id}`,
              nowMs,
            });
            signature = signWebhookCanonicalInputHmac(canonical, secret.value);
            keyIdHeader = `hmac:${secret.providerId}`;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (attempts >= maxAttempts || !isRetryableSecretResolutionError(message)) {
              markDeadLetter({
                deliveryId: row.id,
                endpointId: endpoint.id,
                attempts,
                nowMs,
                reason: `secret_resolution_failed:${message}`,
                traceId: row.traceId,
              });
            } else {
              const retryAt = nowMs + Math.min(60_000, attempts * 5_000);
              updateWebhookDeliveryStatus(params.db, {
                id: row.id,
                status: "failed",
                attempts,
                responseCode: null,
                responseBody: truncate(`secret_resolution_failed:${message}`, 1000),
                nextAttemptAt: retryAt,
                lastAttemptAt: nowMs,
                nowMs,
              });
            }
            processed += 1;
            continue;
          }
        } else {
          const signingMaterial = await params.getSigningMaterial();
          if (!signingMaterial) {
            const retryAt = nowMs + Math.min(60_000, attempts * 5_000);
            updateWebhookDeliveryStatus(params.db, {
              id: row.id,
              status: "failed",
              attempts,
              responseCode: null,
              responseBody: "signing_identity_unavailable",
              nextAttemptAt: retryAt,
              lastAttemptAt: nowMs,
              nowMs,
            });
            processed += 1;
            continue;
          }
          signature = signWebhookCanonicalInput(canonical, signingMaterial.privateKey);
          keyIdHeader = signingMaterial.keyId;
        }
        if (!signature) {
          markDeadLetter({
            deliveryId: row.id,
            endpointId: endpoint.id,
            attempts,
            nowMs,
            reason: "signature_generation_failed",
            traceId: row.traceId,
          });
          processed += 1;
          continue;
        }

        let pinnedAddress: WebhookPinnedAddress;
        try {
          pinnedAddress = await resolvePinnedAddress({
            url: targetUrl,
            lookupHost,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          markDeadLetter({
            deliveryId: row.id,
            endpointId: endpoint.id,
            attempts,
            nowMs,
            reason: `endpoint_dns_validation_failed:${message}`,
            traceId: row.traceId,
            payload: { host: targetUrl.hostname },
          });
          processed += 1;
          continue;
        }

        const requestHeaders: Record<string, string> = {
          "content-type": "application/json",
          "x-nexus-event-id": bodyEnvelope.eventId,
          "x-nexus-timestamp": timestampHeader,
          "x-nexus-nonce": bodyEnvelope.nonce,
          "x-nexus-signature": signature,
          "x-nexus-attempt": String(attempts),
          "x-nexus-instance-id": params.localInstanceId,
        };
        if (keyIdHeader) {
          requestHeaders["x-nexus-key-id"] = keyIdHeader;
        }

        try {
          const response = fetchImpl
            ? await sendWebhookRequestWithFetch({
              fetchImpl,
              url: targetUrl,
              headers: requestHeaders,
              bodyJson,
              requestTimeoutMs,
              maxResponseBytes,
            })
            : await sendWebhookRequestPinned({
              url: targetUrl,
              headers: requestHeaders,
              bodyJson,
              pinnedAddress,
              requestTimeoutMs,
              connectTimeoutMs,
              readTimeoutMs,
              maxResponseBytes,
            });
          const responseBody = truncate(response.body, 4000);
          const deliveryDecision = classifyHttpDelivery({
            status: response.status,
            nowMs,
            attempts,
            maxAttempts,
            retryAfterHeader: response.headers.get("retry-after"),
            defaultRetryAt: nowMs + Math.min(60_000, attempts * 5_000),
          });
          if (deliveryDecision.decision === "ack") {
            updateWebhookDeliveryStatus(params.db, {
              id: row.id,
              status: "acked",
              attempts,
              responseCode: response.status,
              responseBody,
              nextAttemptAt: null,
              lastAttemptAt: nowMs,
              nowMs,
            });
            processed += 1;
            continue;
          }

          if (deliveryDecision.decision === "retry" && deliveryDecision.retryAt != null) {
            updateWebhookDeliveryStatus(params.db, {
              id: row.id,
              status: "failed",
              attempts,
              responseCode: response.status,
              responseBody,
              nextAttemptAt: deliveryDecision.retryAt,
              lastAttemptAt: nowMs,
              nowMs,
            });
            processed += 1;
            continue;
          }

          markDeadLetter({
            deliveryId: row.id,
            endpointId: endpoint.id,
            attempts,
            nowMs,
            reason: `delivery_failed_http_${response.status}`,
            traceId: row.traceId,
            payload: { responseBody },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (attempts >= maxAttempts) {
            markDeadLetter({
              deliveryId: row.id,
              endpointId: endpoint.id,
              attempts,
              nowMs,
              reason: `delivery_failed_network:${message}`,
              traceId: row.traceId,
            });
          } else {
            const retryAt = nowMs + Math.min(60_000, attempts * 5_000);
            updateWebhookDeliveryStatus(params.db, {
              id: row.id,
              status: "failed",
              attempts,
              responseCode: null,
              responseBody: truncate(message, 1000),
              nextAttemptAt: retryAt,
              lastAttemptAt: nowMs,
              nowMs,
            });
          }
        }
        processed += 1;
      }

      if (processed > 0) {
        log(`webhook/worker: processed=${processed}`);
      }
      return processed;
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => {
    void tick().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log(`webhook/worker: tick_failed err=${message}`);
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop: () => {
      closed = true;
      clearInterval(timer);
    },
    tick,
  };
}
