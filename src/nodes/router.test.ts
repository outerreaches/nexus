import assert from "node:assert/strict";
import test from "node:test";

import type { Tool, ToolContext } from "../core/tools.js";
import { NodeRegistry } from "./registry.js";
import { NodeToolRouter } from "./router.js";
import { NodeRoutingError } from "./types.js";

function makeTool(name: string): Tool {
  return {
    name,
    description: "test tool",
    jsonSchema: {},
    execute: async () => "ok",
  };
}

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceDir: "",
    stateDir: "",
    codeDir: "",
    executionMode: "remote",
    nowMs: () => Date.now(),
    log: () => {},
    ...overrides,
  };
}

test("node router routes secret-bearing requests to hermes-capable node", async () => {
  const registry = new NodeRegistry({ log: () => {} });
  registry.registerOrUpdate({
    id: "node-transparent",
    label: "Transparent Node",
    publicKey: "pk-transparent",
    fingerprint: "fp-transparent",
    status: "online",
    backend: "nexus",
    firewallMode: "transparent",
    capabilities: ["test_tool"],
    tags: [],
  });
  registry.registerOrUpdate({
    id: "node-hermes",
    label: "Hermes Node",
    publicKey: "pk-hermes",
    fingerprint: "fp-hermes",
    status: "online",
    backend: "nexus",
    firewallMode: "hermes",
    capabilities: ["test_tool", "hermes.mode.hermes"],
    tags: [],
  });

  let routedNodeId: string | null = null;
  const router = new NodeToolRouter({
    registry,
    log: () => {},
    executeOnNode: async ({ nodeId }) => {
      routedNodeId = nodeId;
      return "ok";
    },
  });

  const result = await router.routeToolExecution(
    makeTool("test_tool"),
    { input: "use {{secret:wallet.key}} to sign request" },
    makeContext(),
  );
  assert.equal(result, "ok");
  assert.equal(routedNodeId, "node-hermes");
});

test("node router rejects explicit transparent node when request carries secret refs", async () => {
  const registry = new NodeRegistry({ log: () => {} });
  registry.registerOrUpdate({
    id: "node-transparent",
    label: "Transparent Node",
    publicKey: "pk-transparent",
    fingerprint: "fp-transparent",
    status: "online",
    backend: "nexus",
    firewallMode: "transparent",
    capabilities: ["test_tool"],
    tags: [],
  });

  const router = new NodeToolRouter({
    registry,
    log: () => {},
    executeOnNode: async () => "ok",
  });

  await assert.rejects(
    () =>
      router.routeToolExecution(
        makeTool("test_tool"),
        { input: "run with {{secret:exchange.api_key}}" },
        makeContext({ executionNode: "node-transparent" }),
      ),
    (err: unknown) => {
      assert.ok(err instanceof NodeRoutingError);
      assert.equal(err.code, "SECURITY_CONSTRAINT_UNSATISFIED");
      assert.match(err.message, /secret_material_requires_hermes_mode/);
      return true;
    },
  );
});

test("node router treats provider/path secret references as secret-bearing", async () => {
  const registry = new NodeRegistry({ log: () => {} });
  registry.registerOrUpdate({
    id: "node-transparent",
    label: "Transparent Node",
    publicKey: "pk-transparent",
    fingerprint: "fp-transparent",
    status: "online",
    backend: "nexus",
    firewallMode: "transparent",
    capabilities: ["test_tool"],
    tags: [],
  });

  const router = new NodeToolRouter({
    registry,
    log: () => {},
    executeOnNode: async () => "ok",
  });

  await assert.rejects(
    () =>
      router.routeToolExecution(
        makeTool("test_tool"),
        { input: "run with {{secret:local-main/wallet.hot#password}}" },
        makeContext({ executionNode: "node-transparent" }),
      ),
    (err: unknown) => {
      assert.ok(err instanceof NodeRoutingError);
      assert.equal(err.code, "SECURITY_CONSTRAINT_UNSATISFIED");
      assert.match(err.message, /secret_material_requires_hermes_mode/);
      return true;
    },
  );
});
