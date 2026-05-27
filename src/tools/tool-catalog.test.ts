import assert from "node:assert/strict";
import test from "node:test";

import type { RunState, Tool, ToolContext } from "../core/tools.js";
import { toolLoad, toolSearch, toolUnload } from "./tool-catalog.js";
import type { ToolRegistry } from "../core/tool-registry.js";

function fakeTool(name: string, description: string): Tool {
  return {
    name,
    description,
    nodeRoutable: false,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => "ok",
  };
}

function makeCtx(opts: { tools: Tool[]; runState: RunState | null }): ToolContext {
  const registry = { list: () => opts.tools } as unknown as ToolRegistry;
  return {
    workspaceDir: "/tmp",
    stateDir: "/tmp",
    codeDir: "/tmp",
    nowMs: () => Date.now(),
    log: () => {},
    registry,
    ...(opts.runState ? { runState: opts.runState } : {}),
  } as ToolContext;
}

function makeState(kernel: string[], available: string[]): RunState {
  return {
    kernelToolNames: new Set(kernel),
    availableToolNames: new Set(available),
    loadedToolNames: new Set<string>(),
  };
}

test("tool_search returns kernel + catalog with loaded flags", async () => {
  const tools = [
    fakeTool("spawn_agent", "Spawn a worker"),
    fakeTool("job_manage", "Manage scheduled jobs"),
    fakeTool("hidden_tool", "Should not appear"),
  ];
  const state = makeState(["spawn_agent"], ["spawn_agent", "job_manage"]);
  const ctx = makeCtx({ tools, runState: state });

  const result = await toolSearch.execute({ limit: 25 }, ctx);
  const parsed = JSON.parse(result);
  const names = parsed.tools.map((t: { name: string }) => t.name).sort();
  assert.deepEqual(names, ["job_manage", "spawn_agent"]);
  const spawnEntry = parsed.tools.find((t: { name: string }) => t.name === "spawn_agent");
  assert.equal(spawnEntry.kernel, true);
  assert.equal(spawnEntry.loaded, true);
  const jobEntry = parsed.tools.find((t: { name: string }) => t.name === "job_manage");
  assert.equal(jobEntry.kernel, false);
  assert.equal(jobEntry.loaded, false);
});

test("tool_search filters by query against name and description", async () => {
  const tools = [
    fakeTool("spawn_agent", "Spawn a worker"),
    fakeTool("job_manage", "Manage scheduled jobs"),
    fakeTool("mcp_manage", "MCP server admin"),
  ];
  const state = makeState([], ["spawn_agent", "job_manage", "mcp_manage"]);
  const ctx = makeCtx({ tools, runState: state });

  const byName = JSON.parse(await toolSearch.execute({ query: "spawn", limit: 25 }, ctx));
  assert.deepEqual(byName.tools.map((t: { name: string }) => t.name), ["spawn_agent"]);

  const byDescription = JSON.parse(await toolSearch.execute({ query: "scheduled", limit: 25 }, ctx));
  assert.deepEqual(byDescription.tools.map((t: { name: string }) => t.name), ["job_manage"]);
});

test("tool_load mutates loadedToolNames for catalog entries and reports kernel/unknown", async () => {
  const tools = [
    fakeTool("spawn_agent", ""),
    fakeTool("job_manage", ""),
  ];
  const state = makeState(["spawn_agent"], ["spawn_agent", "job_manage"]);
  const ctx = makeCtx({ tools, runState: state });

  const r1 = JSON.parse(await toolLoad.execute({ names: ["job_manage"] }, ctx));
  assert.deepEqual(r1.loaded, ["job_manage"]);
  assert.equal(state.loadedToolNames.has("job_manage"), true);

  // Already loaded → reported as such, no double-add.
  const r2 = JSON.parse(await toolLoad.execute({ names: ["job_manage"] }, ctx));
  assert.deepEqual(r2.loaded, []);
  assert.deepEqual(r2.already_loaded, ["job_manage"]);

  // Kernel tool → not added to loaded set.
  const r3 = JSON.parse(await toolLoad.execute({ names: ["spawn_agent"] }, ctx));
  assert.deepEqual(r3.already_kernel, ["spawn_agent"]);
  assert.equal(state.loadedToolNames.has("spawn_agent"), false);

  // Unknown tool → reported, ignored.
  const r4 = JSON.parse(await toolLoad.execute({ names: ["nope"] }, ctx));
  assert.deepEqual(r4.unknown, ["nope"]);
});

test("tool_unload drops loaded extras and refuses kernel tools", async () => {
  const tools = [fakeTool("spawn_agent", ""), fakeTool("job_manage", "")];
  const state = makeState(["spawn_agent"], ["spawn_agent", "job_manage"]);
  state.loadedToolNames.add("job_manage");
  const ctx = makeCtx({ tools, runState: state });

  const r = JSON.parse(await toolUnload.execute({ names: ["spawn_agent", "job_manage", "missing"] }, ctx));
  assert.deepEqual(r.unloaded, ["job_manage"]);
  assert.deepEqual(r.refused_kernel, ["spawn_agent"]);
  assert.deepEqual(r.not_loaded, ["missing"]);
  assert.equal(state.loadedToolNames.has("job_manage"), false);
});

test("tool_load / tool_unload return ERROR when runState is missing", async () => {
  const ctx = makeCtx({ tools: [], runState: null });
  const loadResult = await toolLoad.execute({ names: ["x"] }, ctx);
  assert.match(loadResult, /lazy tool-loading is not enabled/);
  const unloadResult = await toolUnload.execute({ names: ["x"] }, ctx);
  assert.match(unloadResult, /lazy tool-loading is not enabled/);
});
