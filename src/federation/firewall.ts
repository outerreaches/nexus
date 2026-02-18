import { evaluateUnifiedFirewallPolicy } from "../firewall/policy.js";

export type FederationFirewallDirection = "ingress" | "egress";

export type FederationFirewallDecision = {
  allowed: boolean;
  decision: "allow" | "deny";
  reason: string;
  methodOrEvent: string;
  operation: string;
  direction: FederationFirewallDirection;
};

export type FederationFirewallRuntimeState = {
  active: boolean;
  signalSource: "federation_disabled" | "runtime_readiness" | "runtime_guardrail";
  reasons: string[];
  ingressReady: boolean;
  egressReady: boolean;
};

export function evaluateFederationFirewall(params: {
  direction: FederationFirewallDirection;
  methodOrEvent: string;
  peerEnabled: boolean;
  peerTrustState: "pending" | "trusted" | "revoked" | "quarantined";
}): FederationFirewallDecision {
  const decision = evaluateUnifiedFirewallPolicy({
    boundary: "federation",
    direction: params.direction,
    methodOrEvent: params.methodOrEvent,
    transportKind: "federation_http",
    peerEnabled: params.peerEnabled,
    peerTrustState: params.peerTrustState,
  });
  return {
    allowed: decision.allowed,
    decision: decision.decision,
    reason: decision.reason,
    methodOrEvent: decision.methodOrEvent,
    operation: decision.operation,
    direction: params.direction,
  };
}

export function deriveFederationFirewallRuntimeState(params: {
  enabled: boolean;
  transportAdapter: string;
  outboxEnabled: boolean;
  dispatcherReady: boolean;
  requireMtls: boolean;
  allowInsecureSignedOnlyDev: boolean;
  webhooksFederatedOnly: boolean;
  webhooksExternalEnabled: boolean;
}): FederationFirewallRuntimeState {
  if (!params.enabled) {
    return {
      active: false,
      signalSource: "federation_disabled",
      reasons: ["federation_disabled"],
      ingressReady: false,
      egressReady: false,
    };
  }

  const reasons: string[] = [];
  const ingressReady = params.transportAdapter === "federation_http";
  if (!ingressReady) {
    reasons.push(`unsupported_transport_adapter:${params.transportAdapter}`);
  }

  const egressReady = !params.outboxEnabled || params.dispatcherReady;
  if (!egressReady) {
    reasons.push("outbox_enabled_but_dispatcher_unavailable");
  }

  if (!params.requireMtls && !params.allowInsecureSignedOnlyDev) {
    reasons.push("insecure_transport_without_explicit_override");
  }

  // External webhooks are intentionally scoped out of v1 hardening.
  if (params.webhooksExternalEnabled) {
    reasons.push("external_webhooks_enabled_before_hardening");
  }

  // Guardrail: external-enabled mode should not be combined with federated-only.
  if (params.webhooksExternalEnabled && params.webhooksFederatedOnly) {
    reasons.push("webhook_mode_conflict_external_plus_federated_only");
  }

  return {
    active: reasons.length === 0,
    signalSource: reasons.length === 0 ? "runtime_readiness" : "runtime_guardrail",
    reasons,
    ingressReady,
    egressReady,
  };
}
