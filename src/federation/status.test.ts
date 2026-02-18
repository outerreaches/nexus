import assert from "node:assert/strict";
import test from "node:test";

import { deriveFederationState } from "./status.js";

test("deriveFederationState returns standalone when disabled", () => {
  const state = deriveFederationState({
    enabled: false,
    identityValid: false,
    firewallActive: false,
    peers: [],
  });
  assert.equal(state, "standalone");
});

test("deriveFederationState returns federation_capable when enabled with valid identity and no peers", () => {
  const state = deriveFederationState({
    enabled: true,
    identityValid: true,
    firewallActive: true,
    peers: [],
  });
  assert.equal(state, "federation_capable");
});

test("deriveFederationState returns federated_degraded when enabled but identity is missing", () => {
  const state = deriveFederationState({
    enabled: true,
    identityValid: false,
    firewallActive: true,
    peers: [],
  });
  assert.equal(state, "federated_degraded");
});

test("deriveFederationState returns paired_untrusted when only pending peers exist", () => {
  const state = deriveFederationState({
    enabled: true,
    identityValid: true,
    firewallActive: true,
    peers: [{ trustState: "pending", routeHealthy: true, sessionHealthy: true }],
  });
  assert.equal(state, "paired_untrusted");
});

test("deriveFederationState returns revoked when any peer is revoked/quarantined", () => {
  const revoked = deriveFederationState({
    enabled: true,
    identityValid: true,
    firewallActive: true,
    peers: [{ trustState: "revoked", routeHealthy: true, sessionHealthy: true }],
  });
  assert.equal(revoked, "revoked");

  const quarantined = deriveFederationState({
    enabled: true,
    identityValid: true,
    firewallActive: true,
    peers: [{ trustState: "quarantined", routeHealthy: true, sessionHealthy: true }],
  });
  assert.equal(quarantined, "revoked");
});

test("deriveFederationState returns federated_degraded when trusted peer is unhealthy", () => {
  const state = deriveFederationState({
    enabled: true,
    identityValid: true,
    firewallActive: true,
    peers: [{ trustState: "trusted", routeHealthy: true, sessionHealthy: false }],
  });
  assert.equal(state, "federated_degraded");
});

test("deriveFederationState returns active_federated when trusted healthy route/session exists", () => {
  const state = deriveFederationState({
    enabled: true,
    identityValid: true,
    firewallActive: true,
    peers: [{ trustState: "trusted", routeHealthy: true, sessionHealthy: true }],
  });
  assert.equal(state, "active_federated");
});
