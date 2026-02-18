import assert from "node:assert/strict";
import test from "node:test";

import { deriveFederationFirewallRuntimeState, evaluateFederationFirewall } from "./firewall.js";

test("federation firewall allows trusted submit_task ingress", () => {
  const decision = evaluateFederationFirewall({
    direction: "ingress",
    methodOrEvent: "submit_task",
    peerEnabled: true,
    peerTrustState: "trusted",
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.decision, "allow");
});

test("federation firewall denies blocked method egress", () => {
  const decision = evaluateFederationFirewall({
    direction: "egress",
    methodOrEvent: "shell_exec",
    peerEnabled: true,
    peerTrustState: "trusted",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.decision, "deny");
  assert.ok(decision.reason.startsWith("blocked_method:"));
});

test("federation firewall denies non-allowlisted ingress method", () => {
  const decision = evaluateFederationFirewall({
    direction: "ingress",
    methodOrEvent: "event.publish",
    peerEnabled: true,
    peerTrustState: "trusted",
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.decision, "deny");
  assert.ok(decision.reason.startsWith("ingress_method_not_allowlisted:"));
});

test("runtime firewall state is active when federation readiness checks pass", () => {
  const state = deriveFederationFirewallRuntimeState({
    enabled: true,
    transportAdapter: "federation_http",
    outboxEnabled: true,
    dispatcherReady: true,
    requireMtls: true,
    allowInsecureSignedOnlyDev: false,
    webhooksFederatedOnly: true,
    webhooksExternalEnabled: false,
  });
  assert.equal(state.active, true);
  assert.equal(state.signalSource, "runtime_readiness");
  assert.deepEqual(state.reasons, []);
  assert.equal(state.ingressReady, true);
  assert.equal(state.egressReady, true);
});

test("runtime firewall state is guarded when external webhooks are enabled", () => {
  const state = deriveFederationFirewallRuntimeState({
    enabled: true,
    transportAdapter: "federation_http",
    outboxEnabled: false,
    dispatcherReady: false,
    requireMtls: true,
    allowInsecureSignedOnlyDev: false,
    webhooksFederatedOnly: true,
    webhooksExternalEnabled: true,
  });
  assert.equal(state.active, false);
  assert.equal(state.signalSource, "runtime_guardrail");
  assert.ok(state.reasons.includes("external_webhooks_enabled_before_hardening"));
  assert.ok(state.reasons.includes("webhook_mode_conflict_external_plus_federated_only"));
});
