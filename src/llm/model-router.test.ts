import assert from "node:assert/strict";
import test from "node:test";

import { ModelRouter } from "./model-router.js";
import { OpenAICompatClient } from "./openai-compat.js";

function stubFetch(handler: (url: string, body: unknown) => { status: number; bodyText?: string }) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const body = init?.body ? JSON.parse(init.body as string) : null;
    const response = handler(u, body);
    return new Response(response.bodyText ?? "", { status: response.status });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

const baseRouting = {
  default: { primary: { provider: "default" } },
  byPreset: {},
  byAgent: {},
  localProvider: "local",
};

test("ModelRouter prefixes SlotCacheManager log lines with the provider name", async () => {
  const logs: string[] = [];
  const stub = stubFetch((url) => {
    if (url.endsWith("?action=save")) return { status: 200, bodyText: "{}" };
    if (url.endsWith("?action=restore")) return { status: 404, bodyText: "file not found" };
    return { status: 200, bodyText: "{}" };
  });
  try {
    const router = new ModelRouter({
      defaultProvider: { baseUrl: "http://localhost:9999/v1", model: "test-model" },
      providers: {
        local: {
          baseUrl: "http://localhost:9999/v1",
          model: "test-model",
          slotCache: { enabled: true, slotCount: 1 },
        },
      },
      routing: baseRouting,
      log: (line) => logs.push(line),
    });

    const route = router.resolve({ agentId: "main", preset: "orchestrator", mode: "local_only" });
    assert.equal(route.primaryProvider, "local");
    assert.ok(route.primary.slotCache, "local provider must carry a slotCache reference");

    // Drive the cache twice so we exercise save+restore on eviction.
    const lease1 = await route.primary.slotCache.acquire("session-A");
    lease1.release();
    const lease2 = await route.primary.slotCache.acquire("session-B");
    lease2.release();

    const slotLines = logs.filter((l) => l.startsWith("slot_cache:"));
    assert.ok(
      slotLines.some((l) => /^slot_cache:local slot_cache_save\b/.test(l)),
      `expected a 'slot_cache:local slot_cache_save' line, got:\n${slotLines.join("\n")}`,
    );
    assert.ok(
      slotLines.some((l) => /^slot_cache:local slot_cache_restore\b/.test(l)),
      `expected a 'slot_cache:local slot_cache_restore' line, got:\n${slotLines.join("\n")}`,
    );
  } finally {
    stub.restore();
  }
});

test("OpenAICompatClient throws slot_lease_failed instead of falling back when slot acquire fails", async () => {
  // Stub: restore returns 404 (expected cache miss), save returns 500 — this
  // models a broken slot persistence endpoint. The first acquire of A
  // succeeds (no prevOwner to save). The second acquire (B) triggers a save
  // of A on eviction, which throws and propagates out of completeChat.
  let chatCalled = false;
  const stub = stubFetch((url) => {
    if (/\/chat\/completions/.test(url)) {
      chatCalled = true;
      return { status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
    }
    if (url.endsWith("?action=save")) return { status: 500, bodyText: "boom" };
    if (url.endsWith("?action=restore")) return { status: 404, bodyText: "file not found" };
    return { status: 200, bodyText: "{}" };
  });
  try {
    const router = new ModelRouter({
      defaultProvider: { baseUrl: "http://localhost:9999/v1", model: "test-model" },
      providers: {
        local: {
          baseUrl: "http://localhost:9999/v1",
          model: "test-model",
          slotCache: { enabled: true, slotCount: 1 },
        },
      },
      routing: baseRouting,
    });
    const route = router.resolve({ agentId: "main", preset: "orchestrator", mode: "local_only" });
    const cache = route.primary.slotCache;
    assert.ok(cache, "expected route.primary.slotCache to be defined");
    // Pre-load slot A so the next acquire for B forces an eviction save.
    const lease = await cache.acquire("session-A");
    lease.release();

    const client = new OpenAICompatClient(route.primary);
    await assert.rejects(
      client.completeChat({
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        slotKey: "session-B",
      }),
      /slot_lease_failed/,
    );
    assert.equal(chatCalled, false, "completeChat must not call /chat/completions when slot lease fails");
  } finally {
    stub.restore();
  }
});

test("ModelRouter omits slot cache wiring for providers that did not opt in", () => {
  const router = new ModelRouter({
    defaultProvider: { baseUrl: "http://localhost:9999/v1", model: "test-model" },
    providers: {
      remote: { baseUrl: "http://localhost:9999/v1", model: "test-model" },
    },
    routing: baseRouting,
    log: () => {},
  });
  const route = router.resolve({ agentId: "main", preset: "orchestrator" });
  assert.equal(route.primary.slotCache, undefined);
});
