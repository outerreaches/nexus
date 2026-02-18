import assert from "node:assert/strict";
import test from "node:test";

import { containsRawSecretMaterial } from "./policy.js";

test("containsRawSecretMaterial detects secret-like keyed values", () => {
  assert.equal(
    containsRawSecretMaterial({
      password: "super-secret",
    }),
    true,
  );
});

test("containsRawSecretMaterial allows secret references", () => {
  assert.equal(
    containsRawSecretMaterial({
      password: "{{secret:local-main/cred-1#password}}",
    }),
    false,
  );
});

test("containsRawSecretMaterial detects private key material", () => {
  assert.equal(
    containsRawSecretMaterial({
      pem: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    }),
    true,
  );
});

test("containsRawSecretMaterial ignores non-secret payloads", () => {
  assert.equal(
    containsRawSecretMaterial({
      symbol: "BTC-USD",
      status: "running",
    }),
    false,
  );
});

test("containsRawSecretMaterial detects monetization-local secret file paths", () => {
  assert.equal(
    containsRawSecretMaterial({
      artifactPath: "/data/nexus/secrets/credentials.json",
    }),
    true,
  );
});
