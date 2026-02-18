import type { NodeWebSocketGateway } from "../nodes/ws-gateway.js";
import { NodeRoutingError } from "../nodes/types.js";
import type { FederationOutboxRecord, TransportRouteRecord } from "../storage/federation.js";
import { parseCanonicalTransportMessage } from "../transport/contract.js";
import type { FederationOutboxDispatcher } from "./outbox-worker.js";

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRetryableNodeCode(code: string): boolean {
  return code === "NODE_SOCKET_UNAVAILABLE" || code === "NODE_RESPONSE_TIMEOUT";
}

function resolveNodeIdFromRecord(item: FederationOutboxRecord, route: TransportRouteRecord | null): string | null {
  const routeEndpoint = route ? asText(route.endpoint) : null;
  if (routeEndpoint) return routeEndpoint;
  if (item.peerId) return item.peerId;
  const envelope = asObject(item.envelope);
  return asText(envelope.nodeId) ?? asText(envelope.targetNodeId);
}

type NodeTransportDispatchResult = {
  method: string;
  params: Record<string, unknown>;
};

function toNodeTransportDispatch(item: FederationOutboxRecord): NodeTransportDispatchResult | null {
  const canonical = parseCanonicalTransportMessage(item);
  if (!canonical) return null;
  if (canonical.kind === "request") {
    const envelope = asObject(canonical.payload);
    const requestPayload = asObject(envelope.request);
    return {
      method: canonical.method,
      params: Object.keys(requestPayload).length > 0 ? requestPayload : envelope,
    };
  }
  if (canonical.kind === "event") {
    const envelope = asObject(canonical.payload);
    const payload = asObject(envelope.payload);
    return {
      method: "transport.event.publish",
      params: {
        eventType: canonical.eventType,
        payload: Object.keys(payload).length > 0 ? payload : envelope,
      },
    };
  }
  return {
    method: canonical.ackStatus === "retry" ? "transport.delivery.retry" : "transport.delivery.ack",
    params: canonical.reason ? { reason: canonical.reason } : {},
  };
}

export function createNodeWsDispatcher(params: {
  nodeGateway: NodeWebSocketGateway;
  getRouteForPeer?: (peerId: string, adapter: "node_ws") => TransportRouteRecord | null;
  observeRouteHealth?: (entry: {
    peerId: string;
    adapter: "node_ws";
    endpoint: string;
    healthy: boolean;
    error?: string | null;
    nowMs: number;
  }) => void | Promise<void>;
  log?: (msg: string) => void;
}): FederationOutboxDispatcher {
  const log = params.log ?? (() => {});
  const observeRouteHealth = params.observeRouteHealth ?? (() => {});
  const safeObserveRouteHealth = async (entry: {
    peerId: string;
    adapter: "node_ws";
    endpoint: string;
    healthy: boolean;
    error?: string | null;
    nowMs: number;
  }): Promise<void> => {
    try {
      await observeRouteHealth(entry);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`transport/node_ws: route observation failed peer=${entry.peerId} error=${message}`);
    }
  };
  return async (item) => {
    if (item.transportKind !== "node_ws") {
      return {
        ok: false,
        terminal: true,
        error: `unsupported_transport:${item.transportKind}`,
      };
    }

    const route = item.peerId ? (params.getRouteForPeer?.(item.peerId, "node_ws") ?? null) : null;
    const routeEndpoint = route ? asText(route.endpoint) : null;
    const nodeId = resolveNodeIdFromRecord(item, route);
    if (!nodeId) {
      return {
        ok: false,
        terminal: true,
        error: "missing_node_target",
      };
    }

    const dispatch = toNodeTransportDispatch(item);
    if (!dispatch) {
      return {
        ok: false,
        terminal: true,
        error: "invalid_transport_envelope",
      };
    }

    try {
      const response = await params.nodeGateway.requestTransportOperation({
        nodeId,
        method: dispatch.method,
        params: dispatch.params,
      });
      const observedEndpoint = routeEndpoint ?? nodeId;
      if (response.ok) {
        if (item.peerId) {
          await safeObserveRouteHealth({
            peerId: item.peerId,
            adapter: "node_ws",
            endpoint: observedEndpoint,
            healthy: true,
            error: null,
            nowMs: Date.now(),
          });
        }
        return { ok: true };
      }
      const code = response.error?.code ?? "NODE_EXECUTION_FAILED";
      const message = response.error?.message ?? "node request failed";
      const retryable = response.error?.retryable === true || isRetryableNodeCode(code);
      if (item.peerId) {
        await safeObserveRouteHealth({
          peerId: item.peerId,
          adapter: "node_ws",
          endpoint: observedEndpoint,
          healthy: false,
          error: `node_ws_error:${code}:${message}`,
          nowMs: Date.now(),
        });
      }
      if (retryable) {
        return {
          ok: false,
          retryAt: Date.now() + 10_000,
          error: `node_ws_error:${code}:${message}`,
        };
      }
      return {
        ok: false,
        terminal: true,
        error: `node_ws_error:${code}:${message}`,
      };
    } catch (err) {
      if (err instanceof NodeRoutingError) {
        const observedEndpoint = routeEndpoint ?? nodeId;
        if (item.peerId) {
          await safeObserveRouteHealth({
            peerId: item.peerId,
            adapter: "node_ws",
            endpoint: observedEndpoint,
            healthy: false,
            error: `node_ws_error:${err.code}:${err.message}`,
            nowMs: Date.now(),
          });
        }
        if (isRetryableNodeCode(err.code)) {
          return {
            ok: false,
            retryAt: Date.now() + 10_000,
            error: `node_ws_error:${err.code}:${err.message}`,
          };
        }
        return {
          ok: false,
          terminal: true,
          error: `node_ws_error:${err.code}:${err.message}`,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      log(`transport/node_ws: dispatch failure node=${nodeId} method=${dispatch.method} error=${message}`);
      const observedEndpoint = routeEndpoint ?? nodeId;
      if (item.peerId) {
        await safeObserveRouteHealth({
          peerId: item.peerId,
          adapter: "node_ws",
          endpoint: observedEndpoint,
          healthy: false,
          error: `node_ws_dispatch_error:${message}`,
          nowMs: Date.now(),
        });
      }
      return {
        ok: false,
        retryAt: Date.now() + 10_000,
        error: `node_ws_dispatch_error:${message}`,
      };
    }
  };
}
