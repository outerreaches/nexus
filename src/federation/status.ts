export type FederationDerivedState =
  | "standalone"
  | "federation_capable"
  | "paired_untrusted"
  | "federated_degraded"
  | "active_federated"
  | "revoked";

export type FederationPeerTrustState = "pending" | "trusted" | "revoked" | "quarantined";

export interface FederationPeerStatusSnapshot {
  trustState: FederationPeerTrustState;
  routeHealthy: boolean;
  sessionHealthy: boolean;
}

export interface FederationStateInput {
  enabled: boolean;
  identityValid: boolean;
  firewallActive: boolean;
  peers: FederationPeerStatusSnapshot[];
}

export function deriveFederationState(input: FederationStateInput): FederationDerivedState {
  if (!input.enabled) return "standalone";

  const hasRevokedOrQuarantinedPeer = input.peers.some(
    (peer) => peer.trustState === "revoked" || peer.trustState === "quarantined",
  );
  if (hasRevokedOrQuarantinedPeer) return "revoked";

  if (!input.identityValid) {
    return "federated_degraded";
  }

  const hasTrustedPeer = input.peers.some((peer) => peer.trustState === "trusted");
  const hasAnyPeer = input.peers.length > 0;

  if (!hasTrustedPeer) {
    return hasAnyPeer ? "paired_untrusted" : "federation_capable";
  }

  if (!input.firewallActive) {
    return "federated_degraded";
  }

  const hasHealthyTrustedRoute = input.peers.some(
    (peer) => peer.trustState === "trusted" && peer.routeHealthy && peer.sessionHealthy,
  );
  if (!hasHealthyTrustedRoute) return "federated_degraded";

  return "active_federated";
}
