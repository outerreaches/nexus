import assert from "node:assert/strict";
import test from "node:test";

import { ConfigSchema } from "./config.js";

test("config federation defaults are safe/off", () => {
  const parsed = ConfigSchema.parse({});
  assert.equal(parsed.runtime.profile, "primary");
  assert.equal(parsed.federation.enabled, false);
  assert.equal(parsed.federation.transport.requireMtls, true);
  assert.equal(parsed.federation.transport.allowInsecureSignedOnlyDev, false);
  assert.equal(parsed.federation.webhooks.federatedOnly, true);
  assert.equal(parsed.federation.webhooks.externalEnabled, false);
  assert.equal(parsed.federation.webhooks.allowInsecureHttpDev, false);
  assert.equal(parsed.federation.outbox.enabled, false);
  assert.equal(parsed.federation.outbox.intervalMs, 5000);
  assert.equal(parsed.federation.outbox.maxBatch, 20);
  assert.equal(parsed.federation.outbox.requestTimeoutMs, 10000);
  assert.deepEqual(parsed.federation.peers, []);
  assert.equal(parsed.nudges.enabled, true);
  assert.deepEqual(parsed.nudges.channels, ["cli", "telegram"]);
  assert.equal(parsed.nudges.memoryTurnInterval, 10);
  assert.equal(parsed.nudges.skillIterationInterval, 20);
});

test("config federation peer endpoint must be a URL", () => {
  assert.throws(() =>
    ConfigSchema.parse({
      federation: {
        enabled: true,
        peers: [
          {
            id: "peer-1",
            endpoint: "not-a-url",
            signingKey: "abc123",
          },
        ],
      },
    }),
  );
});

test("config rejects signed-only transport unless insecure override is explicit", () => {
  assert.throws(() =>
    ConfigSchema.parse({
      federation: {
        enabled: true,
        transport: {
          requireMtls: false,
          allowInsecureSignedOnlyDev: false,
        },
      },
    }),
  );
});
