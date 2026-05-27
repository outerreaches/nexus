import assert from "node:assert/strict";
import test from "node:test";

import { SlotCacheManager, sanitizeSlotFilename } from "./slot-cache.js";

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
