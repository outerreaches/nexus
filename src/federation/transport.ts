import type { FederationOutboxDispatchResult, FederationOutboxDispatcher } from "./outbox-worker.js";
import type { FederationOutboxRecord } from "../storage/federation.js";
import type { FederationTransportKind } from "./types.js";
import { parseCanonicalTransportMessage, TRANSPORT_ADAPTER_CONTRACT, type TransportAdapterContract } from "../transport/contract.js";

export type TransportAdapterDispatcher = (item: FederationOutboxRecord) => Promise<FederationOutboxDispatchResult>;

export type FederationTransportRouter = {
  dispatch: FederationOutboxDispatcher;
  adapters: FederationTransportKind[];
  contract: Partial<Record<FederationTransportKind, TransportAdapterContract>>;
};

function parseTransportKind(value: string): FederationTransportKind | null {
  if (value === "federation_http") return "federation_http";
  if (value === "node_ws") return "node_ws";
  return null;
}

export function createFederationTransportRouter(params: {
  adapterDispatchers: Partial<Record<FederationTransportKind, TransportAdapterDispatcher>>;
  log?: (msg: string) => void;
}): FederationTransportRouter {
  const log = params.log ?? (() => {});
  const adapters = Object.keys(params.adapterDispatchers) as FederationTransportKind[];
  const contract: Partial<Record<FederationTransportKind, TransportAdapterContract>> = {};
  if (adapters.includes("federation_http")) {
    contract.federation_http = TRANSPORT_ADAPTER_CONTRACT.federation_http;
  }
  if (adapters.includes("node_ws")) {
    contract.node_ws = TRANSPORT_ADAPTER_CONTRACT.node_ws;
  }

  const dispatch: FederationOutboxDispatcher = async (item) => {
    const kind = parseTransportKind(item.transportKind);
    if (!kind) {
      return {
        ok: false,
        terminal: true,
        error: `unsupported_transport_kind:${item.transportKind}`,
      };
    }
    const adapter = kind === "federation_http"
      ? params.adapterDispatchers.federation_http
      : params.adapterDispatchers.node_ws;
    if (!adapter) {
      return {
        ok: false,
        terminal: true,
        error: `missing_transport_adapter:${kind}`,
      };
    }
    const canonicalMessage = parseCanonicalTransportMessage(item);
    if (!canonicalMessage) {
      return {
        ok: false,
        terminal: true,
        error: "invalid_transport_envelope",
      };
    }
    log(`transport/router: adapter=${kind} message_kind=${canonicalMessage.kind} envelope=${item.id}`);
    const result = await adapter(item);
    if (!result.ok && result.error) {
      log(`transport/router: adapter=${kind} dispatch_error=${result.error}`);
    }
    return result;
  };

  return {
    dispatch,
    adapters,
    contract,
  };
}
