import assert from "node:assert/strict";
import test from "node:test";

import { classifyHttpDelivery, isRetryableHttpStatus, parseRetryAfterHeaderMs } from "./delivery.js";

test("parseRetryAfterHeaderMs supports seconds and HTTP date", () => {
  const nowMs = 1_700_000_000_000;
  assert.equal(parseRetryAfterHeaderMs("7", nowMs), nowMs + 7000);
  const date = new Date(nowMs + 12_000).toUTCString();
  assert.equal(parseRetryAfterHeaderMs(date, nowMs), nowMs + 12_000);
});

test("isRetryableHttpStatus classifies retryable HTTP statuses", () => {
  assert.equal(isRetryableHttpStatus(408), true);
  assert.equal(isRetryableHttpStatus(429), true);
  assert.equal(isRetryableHttpStatus(503), true);
  assert.equal(isRetryableHttpStatus(400), false);
});

test("classifyHttpDelivery returns ack, retry, and dead_letter decisions", () => {
  const nowMs = 1_700_000_000_000;
  assert.equal(
    classifyHttpDelivery({
      status: 202,
      nowMs,
      attempts: 1,
      maxAttempts: 3,
      retryAfterHeader: null,
      defaultRetryAt: nowMs + 1000,
    }).decision,
    "ack",
  );
  const retry = classifyHttpDelivery({
    status: 503,
    nowMs,
    attempts: 1,
    maxAttempts: 3,
    retryAfterHeader: "5",
    defaultRetryAt: nowMs + 1000,
  });
  assert.equal(retry.decision, "retry");
  assert.equal(retry.retryAt, nowMs + 5000);

  const dead = classifyHttpDelivery({
    status: 503,
    nowMs,
    attempts: 3,
    maxAttempts: 3,
    retryAfterHeader: "5",
    defaultRetryAt: nowMs + 1000,
  });
  assert.equal(dead.decision, "dead_letter");
});
