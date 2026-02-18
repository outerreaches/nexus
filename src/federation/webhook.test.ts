import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  buildWebhookCanonicalSigningInput,
  eventTypeMatchesFilter,
  signWebhookCanonicalInput,
  signWebhookCanonicalInputHmac,
  verifyWebhookCanonicalInput,
  verifyWebhookCanonicalInputHmac,
} from "./webhook.js";

test("webhook canonical signing input verifies with matching payload", () => {
  const pair = generateKeyPairSync("ed25519");
  const body = JSON.stringify({ ok: true, eventId: "evt-1" });
  const input = buildWebhookCanonicalSigningInput({
    method: "POST",
    path: "/federation-webhook",
    timestamp: "1700000000000",
    nonce: "nonce-1",
    eventId: "evt-1",
    bodyBytes: body,
  });
  const sig = signWebhookCanonicalInput(input, pair.privateKey);
  const verified = verifyWebhookCanonicalInput({
    input,
    signatureHeader: sig,
    publicKey: pair.publicKey,
  });
  assert.equal(verified, true);
});

test("webhook canonical verification fails when body hash differs", () => {
  const pair = generateKeyPairSync("ed25519");
  const inputA = buildWebhookCanonicalSigningInput({
    method: "POST",
    path: "/federation-webhook",
    timestamp: "1700000000000",
    nonce: "nonce-1",
    eventId: "evt-1",
    bodyBytes: JSON.stringify({ ok: true }),
  });
  const sig = signWebhookCanonicalInput(inputA, pair.privateKey);
  const inputB = buildWebhookCanonicalSigningInput({
    method: "POST",
    path: "/federation-webhook",
    timestamp: "1700000000000",
    nonce: "nonce-1",
    eventId: "evt-1",
    bodyBytes: JSON.stringify({ ok: false }),
  });
  const verified = verifyWebhookCanonicalInput({
    input: inputB,
    signatureHeader: sig,
    publicKey: pair.publicKey,
  });
  assert.equal(verified, false);
});

test("webhook event filters support exact and wildcard matching", () => {
  assert.equal(eventTypeMatchesFilter("federation.task.updated", "federation.task.*"), true);
  assert.equal(eventTypeMatchesFilter("federation.task.updated", "federation.task.updated"), true);
  assert.equal(eventTypeMatchesFilter("federation.task.updated", "federation.peer.*"), false);
});

test("webhook hmac signing and verification works for shared-secret endpoints", () => {
  const input = buildWebhookCanonicalSigningInput({
    method: "POST",
    path: "/webhook",
    timestamp: "1700000000000",
    nonce: "nonce-hmac",
    eventId: "evt-hmac-1",
    bodyBytes: JSON.stringify({ ok: true }),
  });
  const sig = signWebhookCanonicalInputHmac(input, "shared-secret");
  assert.equal(
    verifyWebhookCanonicalInputHmac({
      input,
      signatureHeader: sig,
      sharedSecret: "shared-secret",
    }),
    true,
  );
  assert.equal(
    verifyWebhookCanonicalInputHmac({
      input,
      signatureHeader: sig,
      sharedSecret: "wrong-secret",
    }),
    false,
  );
});
