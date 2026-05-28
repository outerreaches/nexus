import assert from "node:assert/strict";
import test from "node:test";

import { SlotCacheManager, deriveSlotEndpointBaseUrl, sanitizeSlotFilename } from "./slot-cache.js";

type FetchRecord = {
  url: string;
  body: unknown;
};

function stubFetch(handler: (url: string, body: unknown) => { status: number; bodyText?: string }) {
  const calls: FetchRecord[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ url: u, body });
    const response = handler(u, body);
    return new Response(response.bodyText ?? "", { status: response.status });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test("deriveSlotEndpointBaseUrl strips path/query so /slots/{N} hits the server root", () => {
  assert.equal(deriveSlotEndpointBaseUrl("http://localhost:8083/v1"), "http://localhost:8083");
  assert.equal(deriveSlotEndpointBaseUrl("http://localhost:8083/v1/"), "http://localhost:8083");
  assert.equal(deriveSlotEndpointBaseUrl("http://localhost:8083"), "http://localhost:8083");
  assert.equal(deriveSlotEndpointBaseUrl("https://gateway.local/llama/v1"), "https://gateway.local");
  // Invalid input falls through unchanged so a misconfigured value is at
  // least visible to the operator instead of becoming an empty URL.
  assert.equal(deriveSlotEndpointBaseUrl("not-a-url"), "not-a-url");
});

test("SlotCacheManager hits /slots/{N} at the server root (not under /v1)", async () => {
  const calls: Array<{ url: string }> = [];
  const stub = stubFetch((url) => {
    calls.push({ url });
    if (url.endsWith("?action=save")) return { status: 200, bodyText: "{}" };
    if (url.endsWith("?action=restore")) return { status: 404, bodyText: "file not found" };
    return { status: 200, bodyText: "{}" };
  });
  try {
    const mgr = new SlotCacheManager({ baseUrl: "http://localhost:8083/v1", slotCount: 1 });
    const a = await mgr.acquire("session-A");
    a.release();
    const b = await mgr.acquire("session-B");
    b.release();
    for (const call of calls) {
      assert.match(call.url, /^http:\/\/localhost:8083\/slots\/0\?action=(save|restore|erase)$/,
        `expected root-level /slots URL but got ${call.url}`);
      assert.doesNotMatch(call.url, /\/v1\/slots\//,
        `slot endpoint must not include the /v1 OpenAI-compat prefix (got ${call.url})`);
    }
  } finally {
    stub.restore();
  }
});

test("SlotCacheManager honors slotEndpointBaseUrl override for proxy/path-prefix deployments", async () => {
  const calls: Array<{ url: string }> = [];
  const stub = stubFetch((url) => {
    calls.push({ url });
    if (url.endsWith("?action=save")) return { status: 200, bodyText: "{}" };
    if (url.endsWith("?action=restore")) return { status: 404, bodyText: "file not found" };
    return { status: 200, bodyText: "{}" };
  });
  try {
    const mgr = new SlotCacheManager({
      baseUrl: "https://gateway.local/llama/v1",
      slotEndpointBaseUrl: "https://gateway.local/llama",
      slotCount: 1,
    });
    const a = await mgr.acquire("session-A");
    a.release();
    const b = await mgr.acquire("session-B");
    b.release();
    for (const call of calls) {
      assert.match(call.url, /^https:\/\/gateway\.local\/llama\/slots\/0\?action=(save|restore|erase)$/);
    }
  } finally {
    stub.restore();
  }
});

test("SlotCacheManager soft-fails a 404 on save and surfaces the actionable error via the logger", async () => {
  const stub = stubFetch((url) => {
    if (url.endsWith("?action=save")) {
      return { status: 404, bodyText: '{"error":{"message":"File Not Found","type":"not_found_error","code":404}}' };
    }
    if (url.endsWith("?action=restore")) return { status: 404, bodyText: "file not found" };
    return { status: 200, bodyText: "{}" };
  });
  const logs: string[] = [];
  try {
    const mgr = new SlotCacheManager({
      baseUrl: "http://localhost:8083/v1",
      slotCount: 1,
      log: (line) => logs.push(line),
    });
    (await mgr.acquire("session-A")).release();
    // Save of A fails when we evict to acquire B. The manager must still
    // return a usable lease (id_slot pinning is what prevents thrash) and
    // log a slot_cache_save_failed warning with the actionable hint.
    const lease = await mgr.acquire("session-B");
    try {
      assert.equal(lease.slotId, 0);
      assert.equal(lease.slotKey, "session-B");
      assert.equal(lease.restored, false);
    } finally {
      lease.release();
    }
    const saveFailedLine = logs.find((l) => l.startsWith("slot_cache_save_failed"));
    assert.ok(saveFailedLine, `expected a slot_cache_save_failed log line, got:\n${logs.join("\n")}`);
    assert.match(saveFailedLine!, /slot save failed: 404/);
    assert.match(saveFailedLine!, /at http:\/\/localhost:8083\/slots\/0\?action=save/);
    assert.match(saveFailedLine!, /--slot-save-path/);
  } finally {
    stub.restore();
  }
});

test("SlotCacheManager soft-fails a restore error and erases the slot before handing it out", async () => {
  const stub = stubFetch((url) => {
    if (url.endsWith("?action=save")) return { status: 200, bodyText: "{}" };
    if (url.endsWith("?action=restore")) {
      return {
        status: 400,
        bodyText: '{"error":{"code":400,"message":"Unable to restore slot, no available space in KV cache or invalid slot save file","type":"invalid_request_error"}}',
      };
    }
    if (url.endsWith("?action=erase")) return { status: 200, bodyText: "{}" };
    return { status: 200, bodyText: "{}" };
  });
  const logs: string[] = [];
  try {
    const mgr = new SlotCacheManager({
      baseUrl: "http://localhost:8083/v1",
      slotCount: 1,
      log: (line) => logs.push(line),
    });
    const lease = await mgr.acquire("session-fresh");
    try {
      assert.equal(lease.restored, false, "restored should be false when the underlying restore failed");
      assert.equal(lease.slotId, 0, "lease must still pin to a slot so id_slot can be set");
    } finally {
      lease.release();
    }
    const actions = stub.calls.map((c) => c.url.split("?action=")[1]).filter(Boolean);
    assert.deepEqual(actions, ["restore", "erase"], "after a restore failure we must erase before serving the lease");
    const restoreFailedLine = logs.find((l) => l.startsWith("slot_cache_restore_failed"));
    assert.ok(restoreFailedLine, `expected a slot_cache_restore_failed log line, got:\n${logs.join("\n")}`);
    assert.match(restoreFailedLine!, /Unable to restore slot/);
  } finally {
    stub.restore();
  }
});

test("sanitizeSlotFilename produces safe filenames and uses hash fallback for pathological keys", () => {
  assert.equal(sanitizeSlotFilename("telegram:1234:interactive:orchestrator"), "telegram_1234_interactive_orchestrator.bin");
  assert.equal(sanitizeSlotFilename("heartbeat:gateway:background:orchestrator"), "heartbeat_gateway_background_orchestrator.bin");
  // Very long key -> hash fallback.
  const longKey = "x".repeat(500);
  const filename = sanitizeSlotFilename(longKey);
  assert.match(filename, /^slot_[0-9a-f]{8}\.bin$/);
  // Empty input -> still produces a file name.
  assert.match(sanitizeSlotFilename(""), /^slot_[0-9a-f]{8}\.bin$/);
});

test("acquire reuses an existing slot owner without HTTP calls", async () => {
  const stub = stubFetch(() => ({ status: 404 }));
  try {
    const mgr = new SlotCacheManager({ baseUrl: "http://localhost:8083/v1", slotCount: 1 });
    const a = await mgr.acquire("session-A");
    a.release();
    const callsBefore = stub.calls.length;
    const b = await mgr.acquire("session-A");
    b.release();
    assert.equal(stub.calls.length, callsBefore, "reusing the same key must skip save/restore HTTP calls");
    assert.equal(b.restored, false);
  } finally {
    stub.restore();
  }
});

test("acquiring a new key on a busy single-slot pool triggers save-then-restore", async () => {
  const stub = stubFetch((url) => {
    if (url.endsWith("?action=save")) return { status: 200, bodyText: "{}" };
    if (url.endsWith("?action=restore")) return { status: 404, bodyText: "file not found" };
    return { status: 200, bodyText: "{}" };
  });
  try {
    const mgr = new SlotCacheManager({ baseUrl: "http://localhost:8083/v1", slotCount: 1 });
    const a = await mgr.acquire("session-A");
    a.release();
    // First acquire of A also probed for a saved snapshot (404). We're
    // interested in the eviction sequence triggered by switching to B.
    const callsAfterA = stub.calls.length;
    const b = await mgr.acquire("session-B");
    try {
      const evictionCalls = stub.calls.slice(callsAfterA);
      const actions = evictionCalls.map((c) => c.url.split("?action=")[1]);
      assert.deepEqual(actions, ["save", "restore"]);
      const saveBody = evictionCalls[0]!.body as { filename: string };
      assert.equal(saveBody.filename, "session-A.bin");
      const restoreBody = evictionCalls[1]!.body as { filename: string };
      assert.equal(restoreBody.filename, "session-B.bin");
      assert.equal(b.restored, false);
    } finally {
      b.release();
    }
  } finally {
    stub.restore();
  }
});

test("a restored slot reports restored=true", async () => {
  const stub = stubFetch((url) => {
    if (url.endsWith("?action=save")) return { status: 200, bodyText: "{}" };
    if (url.endsWith("?action=restore")) return { status: 200, bodyText: "{}" };
    return { status: 200, bodyText: "{}" };
  });
  try {
    const mgr = new SlotCacheManager({ baseUrl: "http://localhost:8083/v1", slotCount: 1 });
    (await mgr.acquire("A")).release();
    (await mgr.acquire("B")).release();
    const second = await mgr.acquire("A");
    try {
      assert.equal(second.restored, true);
    } finally {
      second.release();
    }
  } finally {
    stub.restore();
  }
});

test("concurrent acquires for the same key serialize on the slot lock", async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  const stub = stubFetch(() => ({ status: 200, bodyText: "{}" }));
  try {
    const mgr = new SlotCacheManager({ baseUrl: "http://localhost:8083/v1", slotCount: 1 });
    async function work(key: string) {
      const lease = await mgr.acquire(key);
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      // Hold the slot briefly to expose any races.
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      lease.release();
    }
    await Promise.all([work("A"), work("A"), work("A"), work("A")]);
    assert.equal(maxConcurrent, 1, "single-slot pool must serialize concurrent acquires");
  } finally {
    stub.restore();
  }
});

test("LRU evicts the least-recently-used owner when the pool is full", async () => {
  const stub = stubFetch((url) => {
    if (url.endsWith("?action=save")) return { status: 200, bodyText: "{}" };
    if (url.endsWith("?action=restore")) return { status: 404, bodyText: "file not found" };
    return { status: 200, bodyText: "{}" };
  });
  try {
    const mgr = new SlotCacheManager({ baseUrl: "http://localhost:8083/v1", slotCount: 2 });
    (await mgr.acquire("A")).release();
    (await mgr.acquire("B")).release();
    // Re-touch A so B becomes LRU.
    (await mgr.acquire("A")).release();
    const callsBefore = stub.calls.length;
    const c = await mgr.acquire("C");
    c.release();
    // We should see exactly one save targeting B (the LRU) and one restore for C.
    const newCalls = stub.calls.slice(callsBefore);
    const saves = newCalls.filter((call) => call.url.includes("action=save"));
    assert.equal(saves.length, 1);
    assert.equal((saves[0]!.body as { filename: string }).filename, "B.bin");
  } finally {
    stub.restore();
  }
});
