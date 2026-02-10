import test from "node:test";
import assert from "node:assert/strict";

import { classifyToolResultStatus, toolResultIndicatesDeployApplied } from "./agent-runner.js";
import type { ToolCall } from "./types.js";

function makeCall(name: string): ToolCall {
  return {
    id: "call-1",
    name,
    arguments: "{}",
  };
}

test("classifyToolResultStatus marks plain ERROR-prefixed output as error", () => {
  const call = makeCall("file_write");
  const result = classifyToolResultStatus(call, "ERROR: write failed");
  assert.equal(result.status, "error");
  assert.equal(result.errorSummary, "ERROR: write failed");
});

test("classifyToolResultStatus marks spawn_agent failed JSON status as error", () => {
  const call = makeCall("spawn_agent");
  const payload = JSON.stringify({
    status: "failed",
    output: "ERROR: worker process timed out",
    toolCallsUsed: 0,
    iterationsUsed: 0,
  });
  const result = classifyToolResultStatus(call, payload);
  assert.equal(result.status, "error");
  assert.equal(result.errorSummary, "ERROR: worker process timed out");
});

test("classifyToolResultStatus marks spawn_agent budget_exhausted JSON status as error", () => {
  const call = makeCall("spawn_agent");
  const payload = JSON.stringify({
    status: "budget_exhausted",
    output: "Budget exhausted while iterating.",
  });
  const result = classifyToolResultStatus(call, payload);
  assert.equal(result.status, "error");
  assert.equal(result.errorSummary, "Budget exhausted while iterating.");
});

test("classifyToolResultStatus keeps spawn_agent complete JSON status as ok", () => {
  const call = makeCall("spawn_agent");
  const payload = JSON.stringify({
    status: "complete",
    output: "Done",
  });
  const result = classifyToolResultStatus(call, payload);
  assert.equal(result.status, "ok");
});

test("classifyToolResultStatus does not parse non-spawn JSON payloads", () => {
  const call = makeCall("web_fetch");
  const payload = JSON.stringify({
    status: "failed",
    output: "bad",
  });
  const result = classifyToolResultStatus(call, payload);
  assert.equal(result.status, "ok");
});

test("toolResultIndicatesDeployApplied detects direct ha_deploy apply success", () => {
  const call = makeCall("ha_deploy");
  const didApply = toolResultIndicatesDeployApplied(call, { action: "apply" }, "OK: deploy completed");
  assert.equal(didApply, true);
});

test("toolResultIndicatesDeployApplied ignores ha_deploy status action", () => {
  const call = makeCall("ha_deploy");
  const didApply = toolResultIndicatesDeployApplied(call, { action: "status" }, "LAST_STATUS=ok");
  assert.equal(didApply, false);
});

test("toolResultIndicatesDeployApplied detects spawn_agent deployApplied flag", () => {
  const call = makeCall("spawn_agent");
  const payload = JSON.stringify({
    status: "complete",
    output: "Done",
    deployApplied: true,
  });
  const didApply = toolResultIndicatesDeployApplied(call, {}, payload);
  assert.equal(didApply, true);
});

test("toolResultIndicatesDeployApplied ignores ERROR-prefixed results", () => {
  const call = makeCall("ha_deploy");
  const didApply = toolResultIndicatesDeployApplied(call, { action: "apply" }, "ERROR: failed");
  assert.equal(didApply, false);
});
