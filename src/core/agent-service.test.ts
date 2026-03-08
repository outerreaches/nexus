import assert from "node:assert/strict";
import test from "node:test";

import { shouldAckPending } from "./agent-service.js";

test("shouldAckPending matches exact run id when present", () => {
  assert.equal(
    shouldAckPending(
      {
        triggerId: "trigger-1",
        expectedAckRunId: "run-123",
        request: {
          sessionId: "session-1",
          channel: "telegram",
          channelKey: "123",
          homeAgentId: "main",
        },
      },
      {
        runId: "run-123",
        sessionId: "session-2",
        channel: "cli",
        channelKey: "local",
        agentId: "other",
      },
    ),
    true,
  );
});

test("shouldAckPending falls back to exact session/channel correlation when run id is unavailable", () => {
  assert.equal(
    shouldAckPending(
      {
        triggerId: "trigger-2",
        request: {
          sessionId: "session-1",
          channel: "telegram",
          channelKey: "123",
          homeAgentId: "main",
        },
      },
      {
        runId: null,
        sessionId: "session-1",
        channel: "telegram",
        channelKey: "123",
        agentId: "main",
      },
    ),
    true,
  );
});

test("shouldAckPending does not ack on channel-only correlation", () => {
  assert.equal(
    shouldAckPending(
      {
        triggerId: "trigger-3",
        request: {
          channel: "telegram",
          channelKey: "123",
          homeAgentId: "main",
        },
      },
      {
        runId: null,
        sessionId: "other-session",
        channel: "telegram",
        channelKey: "123",
        agentId: "main",
      },
    ),
    false,
  );
});

test("shouldAckPending requires matching agent when session fallback is used", () => {
  assert.equal(
    shouldAckPending(
      {
        triggerId: "trigger-4",
        request: {
          sessionId: "session-1",
          channel: "telegram",
          channelKey: "123",
          homeAgentId: "main",
        },
      },
      {
        runId: null,
        sessionId: "session-1",
        channel: "telegram",
        channelKey: "123",
        agentId: "worker",
      },
    ),
    false,
  );
});
