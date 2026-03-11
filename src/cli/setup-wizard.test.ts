import assert from "node:assert/strict";
import test from "node:test";

import { validateDefaultSidecarProviderProfile } from "./setup-wizard.js";

test("validateDefaultSidecarProviderProfile accepts the expected seeded sidecar profile", () => {
  const result = validateDefaultSidecarProviderProfile({
    id: "sidecar-main",
    kind: "sidecar_http",
    endpointRef: "unix:///run/nexus/secret-sidecar.sock",
    authMode: "unix_peer",
    strictMode: true,
    config: {},
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  });

  assert.equal(result, null);
});

test("validateDefaultSidecarProviderProfile rejects missing or malformed profiles", () => {
  assert.equal(validateDefaultSidecarProviderProfile(null), "profile missing");

  assert.equal(
    validateDefaultSidecarProviderProfile({
      id: "sidecar-main",
      kind: "sidecar_http",
      endpointRef: "unix:///tmp/wrong.sock",
      authMode: "unix_peer",
      strictMode: true,
      config: {},
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }),
    "unexpected endpoint unix:///tmp/wrong.sock",
  );

  assert.equal(
    validateDefaultSidecarProviderProfile({
      id: "sidecar-main",
      kind: "sidecar_http",
      endpointRef: "unix:///run/nexus/secret-sidecar.sock",
      authMode: "none",
      strictMode: true,
      config: {},
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }),
    "unexpected auth mode none",
  );
});
