import assert from "node:assert/strict";
import test from "node:test";

import { applySharedEventProjection } from "./sharing.js";

test("shared event projection strips secret/path fields by default", () => {
  const result = applySharedEventProjection({
    payload: {
      sensitivity: "internal",
      taskId: "task-1",
      apiKey: "abc",
      walletKey: "secret",
      filePath: "/tmp/x",
      nested: {
        token: "abc",
        keep: "ok",
      },
    },
    projection: {},
    sensitivityCeiling: "restricted",
  });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.payload, {
    sensitivity: "internal",
    taskId: "task-1",
    nested: {
      keep: "ok",
    },
  });
});

test("shared event projection enforces sensitivity ceiling", () => {
  const result = applySharedEventProjection({
    payload: {
      sensitivity: "restricted",
      taskId: "task-1",
    },
    projection: {},
    sensitivityCeiling: "internal",
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /sensitivity_above_ceiling/);
});

test("shared event projection applies include/exclude filters", () => {
  const result = applySharedEventProjection({
    payload: {
      taskId: "task-1",
      status: "running",
      pnl: 42,
      notes: "alpha",
    },
    projection: {
      includeFields: ["taskId", "status", "pnl", "notes"],
      excludeFields: ["notes"],
    },
    sensitivityCeiling: "restricted",
  });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.payload, {
    taskId: "task-1",
    status: "running",
    pnl: 42,
  });
});
