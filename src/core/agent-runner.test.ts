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
  assert.equal(result.errorClass, "unknown_error");
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
  assert.equal(result.errorClass, "transient_provider_error");
  assert.equal(result.retryPolicy, "yes");
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
  assert.equal(result.errorClass, "unknown_error");
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

test("classifyToolResultStatus classifies validation errors", () => {
  const call = makeCall("spawn_agent");
  const result = classifyToolResultStatus(call, "ERROR: invalid tool arguments for 'spawn_agent' (not valid JSON)");
  assert.equal(result.status, "error");
  assert.equal(result.errorClass, "validation_error");
  assert.equal(result.retryPolicy, "no");
});

test("classifyToolResultStatus classifies rate limit errors", () => {
  const call = makeCall("web_search");
  const result = classifyToolResultStatus(call, "ERROR: web search failed: 429 Too Many Requests");
  assert.equal(result.status, "error");
  assert.equal(result.errorClass, "rate_limited");
  assert.equal(result.retryPolicy, "after_backoff");
});

test("classifyToolResultStatus classifies capability mismatch errors", () => {
  const call = makeCall("image_edit");
  const result = classifyToolResultStatus(call, "ERROR: No endpoints found that support the requested output modalities");
  assert.equal(result.status, "error");
  assert.equal(result.errorClass, "capability_mismatch");
  assert.equal(result.retryPolicy, "no");
});

test("classifyToolResultStatus classifies not_found errors", () => {
  const call = makeCall("file_read");
  const result = classifyToolResultStatus(call, "ERROR: no such file or directory");
  assert.equal(result.status, "error");
  assert.equal(result.errorClass, "not_found");
  assert.equal(result.retryPolicy, "no");
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
