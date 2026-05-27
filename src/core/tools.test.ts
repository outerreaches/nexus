import assert from "node:assert/strict";
import test from "node:test";

import { buildRunState, LAZY_LOADING_KERNEL_TOOLS } from "./tools.js";

test("buildRunState returns null when preset has no kernel (lazy loading disabled)", () => {
  const state = buildRunState({
    presetKernel: undefined,
    presetTools: ["a", "b", "c"],
    filteredToolNames: ["a", "b", "c"],
  });
  assert.equal(state, null);
});

test("buildRunState builds kernel ∩ filteredTools plus discovery tools", () => {
  const state = buildRunState({
    presetKernel: ["spawn_agent", "skill_get", "missing_tool"],
    presetTools: ["spawn_agent", "skill_get", "missing_tool", "job_manage", "tool_search", "tool_load", "tool_unload"],
    filteredToolNames: ["spawn_agent", "skill_get", "job_manage", "tool_search", "tool_load", "tool_unload"],
  });
  assert.ok(state);
  // missing_tool is in kernel config but not in filteredToolNames → not in kernel.
  assert.equal(state.kernelToolNames.has("missing_tool"), false);
  // Discovery tools are auto-added if present in filteredToolNames.
  for (const name of LAZY_LOADING_KERNEL_TOOLS) {
    assert.equal(state.kernelToolNames.has(name), true, `${name} should be in kernel`);
  }
  // Configured kernel members in the filter survive.
  assert.equal(state.kernelToolNames.has("spawn_agent"), true);
  assert.equal(state.kernelToolNames.has("skill_get"), true);
  // Available includes everything in the filtered list.
  assert.equal(state.availableToolNames.has("job_manage"), true);
  assert.equal(state.availableToolNames.has("spawn_agent"), true);
  // Loaded extras start empty.
  assert.equal(state.loadedToolNames.size, 0);
});

test("buildRunState catalog = available − kernel", () => {
  const state = buildRunState({
    presetKernel: ["spawn_agent"],
    presetTools: ["spawn_agent", "job_manage", "mcp_manage", "tool_search", "tool_load", "tool_unload"],
    filteredToolNames: ["spawn_agent", "job_manage", "mcp_manage", "tool_search", "tool_load", "tool_unload"],
  });
  assert.ok(state);
  const catalog = [...state.availableToolNames].filter((n) => !state.kernelToolNames.has(n));
  assert.deepEqual(catalog.sort(), ["job_manage", "mcp_manage"]);
});

test("buildRunState loadedToolNames is a fresh mutable Set per call", () => {
  const a = buildRunState({
    presetKernel: ["spawn_agent"],
    presetTools: ["spawn_agent", "job_manage"],
    filteredToolNames: ["spawn_agent", "job_manage"],
  });
  const b = buildRunState({
    presetKernel: ["spawn_agent"],
    presetTools: ["spawn_agent", "job_manage"],
    filteredToolNames: ["spawn_agent", "job_manage"],
  });
  assert.ok(a && b);
  a.loadedToolNames.add("job_manage");
  assert.equal(b.loadedToolNames.has("job_manage"), false);
});
