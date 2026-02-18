import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCredentialLocality,
  isMonetizationLocalPath,
  isMonetizationOnlyCredentialId,
  isMonetizationProfile,
} from "./locality.js";

test("isMonetizationOnlyCredentialId matches sensitive prefixes", () => {
  assert.equal(isMonetizationOnlyCredentialId("wallet.trading.hot"), true);
  assert.equal(isMonetizationOnlyCredentialId("exchange.binance.key"), true);
  assert.equal(isMonetizationOnlyCredentialId("cred.general"), false);
});

test("assertCredentialLocality blocks sensitive credentials outside monetization profile", () => {
  assert.throws(
    () =>
      assertCredentialLocality({
        credentialId: "wallet.hot",
        runtimeProfile: "primary",
        operation: "resolve",
      }),
    /credential_locality_violation/,
  );
  assert.doesNotThrow(() =>
    assertCredentialLocality({
      credentialId: "wallet.hot",
      runtimeProfile: "monetization",
      operation: "resolve",
    }),
  );
});

test("isMonetizationLocalPath detects risk and credential store paths", () => {
  assert.equal(isMonetizationLocalPath("/data/nexus/secrets/credentials.json"), true);
  assert.equal(isMonetizationLocalPath("C:\\nexus\\monetization\\risk-policy.json"), true);
  assert.equal(isMonetizationLocalPath("/data/nexus/workspace/notes.md"), false);
});

test("isMonetizationProfile reads expected profile names", () => {
  assert.equal(isMonetizationProfile("monetization"), true);
  assert.equal(isMonetizationProfile("primary"), false);
});
