import assert from "node:assert/strict";
import test from "node:test";

import { evaluateUnifiedFirewallPolicy } from "./policy.js";

test("unified firewall allows federation submit_task for trusted peer", () => {
  const decision = evaluateUnifiedFirewallPolicy({
    boundary: "federation",
    direction: "egress",
    methodOrEvent: "submit_task",
    transportKind: "federation_http",
    peerEnabled: true,
    peerTrustState: "trusted",
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.decision, "allow");
});

test("unified firewall denies blocked federation methods", () => {
  const decision = evaluateUnifiedFirewallPolicy({
    boundary: "federation",
    direction: "egress",
    methodOrEvent: "shell_exec",
    transportKind: "federation_http",
    peerEnabled: true,
    peerTrustState: "trusted",
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /blocked_method/);
});

test("unified firewall denies secret-bearing node calls on transparent mode", () => {
  const decision = evaluateUnifiedFirewallPolicy({
    boundary: "node",
    direction: "egress",
    methodOrEvent: "process.start",
    transportKind: "node_ws",
    nodeFirewallMode: "transparent",
    carriesSecretRefs: true,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "secret_material_requires_hermes_mode");
});

test("unified firewall allows secret-bearing node calls on hermes mode", () => {
  const decision = evaluateUnifiedFirewallPolicy({
    boundary: "node",
    direction: "egress",
    methodOrEvent: "process.start",
    transportKind: "node_ws",
    nodeFirewallMode: "hermes",
    carriesSecretRefs: true,
  });
  assert.equal(decision.allowed, true);
});

test("firewall conformance: equivalent contexts yield identical outcomes across adapter kinds", () => {
  const federationHttp = evaluateUnifiedFirewallPolicy({
    boundary: "federation",
    direction: "egress",
    methodOrEvent: "submit_task",
    transportKind: "federation_http",
    peerEnabled: true,
    peerTrustState: "trusted",
  });
  const federationNodeWs = evaluateUnifiedFirewallPolicy({
    boundary: "federation",
    direction: "egress",
    methodOrEvent: "submit_task",
    transportKind: "node_ws",
    peerEnabled: true,
    peerTrustState: "trusted",
  });
  assert.equal(federationHttp.allowed, federationNodeWs.allowed);
  assert.equal(federationHttp.reason, federationNodeWs.reason);

  const nodeHttp = evaluateUnifiedFirewallPolicy({
    boundary: "node",
    direction: "egress",
    methodOrEvent: "process.start",
    transportKind: "federation_http",
    nodeFirewallMode: "transparent",
    carriesSecretRefs: true,
  });
  const nodeWs = evaluateUnifiedFirewallPolicy({
    boundary: "node",
    direction: "egress",
    methodOrEvent: "process.start",
    transportKind: "node_ws",
    nodeFirewallMode: "transparent",
    carriesSecretRefs: true,
  });
  assert.equal(nodeHttp.allowed, nodeWs.allowed);
  assert.equal(nodeHttp.reason, nodeWs.reason);
});
