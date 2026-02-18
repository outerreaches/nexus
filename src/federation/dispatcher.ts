import crypto from "node:crypto";
import type { KeyObject } from "node:crypto";

import { signProtocolEnvelope } from "../nodes/auth.js";
import type { FederationOutboxRecord, FederationPeerRecord, TransportRouteRecord } from "../storage/federation.js";
import { containsRawSecretMaterial } from "../secrets/policy.js";
import { isRetryableHttpStatus, parseRetryAfterHeaderMs } from "../transport/delivery.js";
import type { FederationSignedEnvelope } from "./types.js";
import type { FederationOutboxDispatcher, FederationOutboxDispatchResult } from "./outbox-worker.js";
import { evaluateFederationFirewall } from "./firewall.js";

export type FederationDispatcherSigningMaterial = {
  privateKey: KeyObject;
  keyId: string;
  publicKeyRaw: string;
};

export type FederationDispatcherDeps = {
  localInstanceId: string;
  privateKey?: KeyObject;
  keyId?: string;
  publicKeyRaw?: string;
  getSigningMaterial?: () =>
    | FederationDispatcherSigningMaterial
    | null
    | Promise<FederationDispatcherSigningMaterial | null>;
  getPeerById: (peerId: string) => FederationPeerRecord | null;
  getRouteForPeer?: (peerId: string, adapter: "federation_http") => TransportRouteRecord | null;
  requireMtls: boolean;
  allowInsecureSignedOnlyDev: boolean;
  requestTimeoutMs: number;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  nonceFactory?: () => string;
  audit?: (entry: {
    peerId: string | null;
    eventType: string;
    decision: "allow" | "deny" | "info";
    actor: string;
    traceId: string | null;
    details: Record<string, unknown>;
  }) => void | Promise<void>;
  observeRouteHealth?: (entry: {
    peerId: string;
    adapter: "federation_http";
    endpoint: string;
    healthy: boolean;
    error?: string | null;
    nowMs: number;
  }) => void | Promise<void>;
  observeSessionHeartbeat?: (entry: {
    peerId: string;
    kid: string;
    transportKind: "federation_http";
    direction: "egress";
    envelopeId: string;
    traceId: string | null;
    nowMs: number;
  }) => void | Promise<void>;
  log?: (msg: string) => void;
};

function toInboxUrl(peerEndpoint: string): URL | null {
  try {
    const url = new URL(peerEndpoint);
    const basePath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    url.pathname = `${basePath}/api/federation/inbox`.replace(/\/{2,}/g, "/");
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function buildSignedEnvelope(params: {
  item: FederationOutboxRecord;
  localInstanceId: string;
  destinationPeerId: string;
  kid: string;
  privateKey: KeyObject;
  nowMs: number;
  nonce: string;
}): FederationSignedEnvelope<Record<string, unknown>> {
  const methodOrEventRaw = params.item.envelope.method;
  const methodOrEvent =
    typeof methodOrEventRaw === "string" && methodOrEventRaw.trim().length > 0
      ? methodOrEventRaw.trim()
      : "federation.outbox.dispatch";
  const unsigned = {
    envelopeId: params.item.id,
    schemaVersion: "federation.v1",
    transportKind: "federation_http" as const,
    source: params.localInstanceId,
    destination: params.destinationPeerId,
    methodOrEvent,
    ts: params.nowMs,
    nonce: params.nonce,
    payload: params.item.envelope,
    idempotencyKey: params.item.traceId ?? params.item.id,
    traceId: params.item.traceId ?? params.item.id,
    kid: params.kid,
  };
  const sig = signProtocolEnvelope(unsigned as Record<string, unknown>, params.privateKey);
  return {
    ...unsigned,
    sig,
  };
}

export function createFederationHttpDispatcher(deps: FederationDispatcherDeps): FederationOutboxDispatcher {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const nonceFactory = deps.nonceFactory ?? (() => crypto.randomUUID());
  const log = deps.log ?? (() => {});
  const audit = deps.audit ?? (() => {});
  const observeRouteHealth = deps.observeRouteHealth ?? (() => {});
  const observeSessionHeartbeat = deps.observeSessionHeartbeat ?? (() => {});
  const safeAudit = async (entry: {
    peerId: string | null;
    eventType: string;
    decision: "allow" | "deny" | "info";
    actor: string;
    traceId: string | null;
    details: Record<string, unknown>;
  }): Promise<void> => {
    try {
      await audit(entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`federation/dispatch: audit write failed peer=${entry.peerId ?? "unknown"} error=${message}`);
    }
  };
  const safeObserveRouteHealth = async (entry: {
    peerId: string;
    adapter: "federation_http";
    endpoint: string;
    healthy: boolean;
    error?: string | null;
    nowMs: number;
  }): Promise<void> => {
    try {
      await observeRouteHealth(entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`federation/dispatch: route observation failed peer=${entry.peerId} error=${message}`);
    }
  };
  const safeObserveSessionHeartbeat = async (entry: {
    peerId: string;
    kid: string;
    transportKind: "federation_http";
    direction: "egress";
    envelopeId: string;
    traceId: string | null;
    nowMs: number;
  }): Promise<void> => {
    try {
      await observeSessionHeartbeat(entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`federation/dispatch: session heartbeat observation failed peer=${entry.peerId} error=${message}`);
    }
  };

  const resolveSigningMaterial = async (): Promise<FederationDispatcherSigningMaterial | null> => {
    if (deps.getSigningMaterial) {
      const dynamic = await deps.getSigningMaterial();
      if (!dynamic) return null;
      const keyId = dynamic.keyId.trim();
      const publicKeyRaw = dynamic.publicKeyRaw.trim();
      if (!keyId || !publicKeyRaw) return null;
      return {
        privateKey: dynamic.privateKey,
        keyId,
        publicKeyRaw,
      };
    }
    if (!deps.privateKey || !deps.keyId || !deps.publicKeyRaw) return null;
    const keyId = deps.keyId.trim();
    const publicKeyRaw = deps.publicKeyRaw.trim();
    if (!keyId || !publicKeyRaw) return null;
    return {
      privateKey: deps.privateKey,
      keyId,
      publicKeyRaw,
    };
  };

  const dispatch: FederationOutboxDispatcher = async (item) => {
    if (item.transportKind !== "federation_http") {
      return { ok: false, terminal: true, error: `unsupported_transport:${item.transportKind}` };
    }
    if (!item.peerId) {
      return { ok: false, terminal: true, error: "missing_peer_id" };
    }
    const peer = deps.getPeerById(item.peerId);
    if (!peer) {
      return { ok: false, terminal: true, error: "peer_not_found" };
    }
    if (!peer.enabled) {
      return { ok: false, terminal: true, error: "peer_disabled" };
    }
    if (peer.trustState !== "trusted") {
      return { ok: false, terminal: true, error: `peer_not_trusted:${peer.trustState}` };
    }
    const methodOrEventRaw = item.envelope.method;
    const methodOrEvent =
      typeof methodOrEventRaw === "string" && methodOrEventRaw.trim().length > 0
        ? methodOrEventRaw.trim()
        : "federation.outbox.dispatch";
    if (containsRawSecretMaterial(item.envelope)) {
      await safeAudit({
        peerId: peer.id,
        eventType: "firewall.egress",
        decision: "deny",
        actor: `instance:${deps.localInstanceId}`,
        traceId: item.traceId ?? item.id,
        details: {
          reason: "secret_payload_export_blocked",
          methodOrEvent,
          envelopeId: item.id,
        },
      });
      return {
        ok: false,
        terminal: true,
        error: "secret_payload_export_blocked",
      };
    }
    const firewallDecision = evaluateFederationFirewall({
      direction: "egress",
      methodOrEvent,
      peerEnabled: peer.enabled,
      peerTrustState: peer.trustState,
    });
    await safeAudit({
      peerId: peer.id,
      eventType: "firewall.egress",
      decision: firewallDecision.decision,
      actor: `instance:${deps.localInstanceId}`,
      traceId: item.traceId ?? item.id,
      details: {
        reason: firewallDecision.reason,
        operation: firewallDecision.operation,
        methodOrEvent: firewallDecision.methodOrEvent,
        envelopeId: item.id,
      },
    });
    if (!firewallDecision.allowed) {
      return {
        ok: false,
        terminal: true,
        error: `firewall_egress_denied:${firewallDecision.reason}`,
      };
    }

    const route = deps.getRouteForPeer?.(peer.id, "federation_http") ?? null;
    if (route && route.adapter !== "federation_http") {
      return {
        ok: false,
        terminal: true,
        error: `unsupported_route_adapter:${route.adapter}`,
      };
    }
    const targetEndpoint = route?.endpoint ?? peer.endpoint;
    const targetUrl = toInboxUrl(targetEndpoint);
    if (!targetUrl) {
      return { ok: false, terminal: true, error: "invalid_peer_endpoint" };
    }
    if (deps.requireMtls && targetUrl.protocol !== "https:") {
      return { ok: false, terminal: true, error: "mtls_required_https_only" };
    }
    if (targetUrl.protocol !== "https:" && !deps.allowInsecureSignedOnlyDev) {
      return { ok: false, terminal: true, error: "insecure_transport_disallowed" };
    }

    const timestampMs = nowMs();
    const signingMaterial = await resolveSigningMaterial();
    if (!signingMaterial) {
      return {
        ok: false,
        retryAt: timestampMs + 10_000,
        error: "signing_identity_unavailable",
      };
    }
    const envelope = buildSignedEnvelope({
      item,
      localInstanceId: deps.localInstanceId,
      destinationPeerId: peer.id,
      kid: signingMaterial.keyId,
      privateKey: signingMaterial.privateKey,
      nowMs: timestampMs,
      nonce: nonceFactory(),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, deps.requestTimeoutMs));
    try {
      const response = await fetchImpl(targetUrl.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nexus-instance-id": deps.localInstanceId,
          "x-nexus-kid": signingMaterial.keyId,
          "x-nexus-public-key": signingMaterial.publicKeyRaw,
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });

      if (response.ok || response.status === 409) {
        await safeObserveRouteHealth({
          peerId: peer.id,
          adapter: "federation_http",
          endpoint: targetEndpoint,
          healthy: true,
          error: null,
          nowMs: timestampMs,
        });
        await safeObserveSessionHeartbeat({
          peerId: peer.id,
          kid: signingMaterial.keyId,
          transportKind: "federation_http",
          direction: "egress",
          envelopeId: envelope.envelopeId,
          traceId: envelope.traceId ?? null,
          nowMs: timestampMs,
        });
        return { ok: true };
      }

      const status = response.status;
      if (isRetryableHttpStatus(status)) {
        const retryAt = parseRetryAfterHeaderMs(response.headers.get("retry-after"), timestampMs);
        await safeObserveRouteHealth({
          peerId: peer.id,
          adapter: "federation_http",
          endpoint: targetEndpoint,
          healthy: false,
          error: `http_${status}`,
          nowMs: timestampMs,
        });
        return {
          ok: false,
          retryAt: retryAt ?? (timestampMs + 10_000),
          error: `http_${status}`,
        };
      }
      await safeObserveRouteHealth({
        peerId: peer.id,
        adapter: "federation_http",
        endpoint: targetEndpoint,
        healthy: false,
        error: `http_${status}`,
        nowMs: timestampMs,
      });
      return {
        ok: false,
        terminal: true,
        error: `http_${status}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`federation/dispatch: send failed peer=${peer.id} error=${message}`);
      await safeObserveRouteHealth({
        peerId: peer.id,
        adapter: "federation_http",
        endpoint: targetEndpoint,
        healthy: false,
        error: `network_error:${message}`,
        nowMs: timestampMs,
      });
      return {
        ok: false,
        retryAt: timestampMs + 10_000,
        error: `network_error:${message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  return async (item): Promise<FederationOutboxDispatchResult> => dispatch(item);
}
