import assert from "node:assert/strict";
import test from "node:test";

import {
  __resetTelegramRateLimitRegistryForTests,
  createTelegramStreamPreview,
  formatTelegramHandlerErrorMessage,
  getTelegramRetryAfterMs,
  mergeTelegramFinalTextWithToolSummary,
} from "./telegram.js";

test("mergeTelegramFinalTextWithToolSummary preserves tool notifications above final text", () => {
  const merged = mergeTelegramFinalTextWithToolSummary(
    "Final assistant reply.",
    "Tool activity:\n- file_read: src/gateway/start.ts\n- shell_exec: npm run build",
  );

  assert.match(merged, /^Tool activity:/);
  assert.match(merged, /Final assistant reply\.$/);
  assert.match(merged, /file_read: src\/gateway\/start\.ts/);
});

test("mergeTelegramFinalTextWithToolSummary returns summary when final text is empty", () => {
  const merged = mergeTelegramFinalTextWithToolSummary(
    "",
    "Tool activity:\n- ha_deploy: apply",
  );

  assert.equal(merged, "Tool activity:\n- ha_deploy: apply");
});

test("mergeTelegramFinalTextWithToolSummary returns final text when no tool summary exists", () => {
  const merged = mergeTelegramFinalTextWithToolSummary(
    "Final assistant reply.",
    "",
  );

  assert.equal(merged, "Final assistant reply.");
});

test("getTelegramRetryAfterMs parses Telegram flood waits", () => {
  assert.equal(
    getTelegramRetryAfterMs(new Error("Call to 'editMessageText' failed! (429: Too Many Requests: retry after 82)")),
    83_000,
  );
  assert.equal(
    getTelegramRetryAfterMs({ parameters: { retry_after: 5 } }),
    6_000,
  );
  assert.equal(getTelegramRetryAfterMs(new Error("message is not modified")), null);
});

test("formatTelegramHandlerErrorMessage describes Telegram rate limits", () => {
  const message = formatTelegramHandlerErrorMessage(
    new Error("Call to 'sendMessage' failed! (429: Too Many Requests: retry after 82)"),
  );

  assert.match(message, /^ERROR: Telegram rate limit hit\./);
  assert.match(message, /about 1m 23s/);
  assert.match(message, /sendMessage/);
});

test("formatTelegramHandlerErrorMessage describes backend connection failures", () => {
  const message = formatTelegramHandlerErrorMessage(new Error("fetch failed: ECONNREFUSED 127.0.0.1:8000"));

  assert.match(message, /^ERROR: model\/backend connection failed:/);
  assert.match(message, /ECONNREFUSED/);
});

test("formatTelegramHandlerErrorMessage redacts secret-looking values", () => {
  const message = formatTelegramHandlerErrorMessage(
    new Error("provider failed token=abc123 sk-1234567890abcdefghijklmnop"),
  );

  assert.doesNotMatch(message, /abc123/);
  assert.doesNotMatch(message, /sk-1234567890/);
  assert.match(message, /\[redacted/);
});

test("stream preview survives a mid-stream 429 and recovers after the cooldown", async () => {
  __resetTelegramRateLimitRegistryForTests();
  const logs: string[] = [];
  let editCalls = 0;
  const preview = createTelegramStreamPreview({
    api: {
      sendMessage: async () => ({ message_id: 42 }),
      // Only the first edit 429s; subsequent edits succeed so the recovery
      // path can complete and flush() returns within ~1s.
      editMessageText: async () => {
        editCalls += 1;
        if (editCalls === 1) {
          throw new Error("Call to 'editMessageText' failed! (429: Too Many Requests: retry after 0)");
        }
      },
      deleteMessage: async () => true,
    } as any,
    chatId: 123,
    throttleMs: 30,
    log: (msg) => logs.push(msg),
    warn: (msg) => logs.push(msg),
  });

  preview.onTextDelta("hello");
  await preview.flush(); // sendMessage path — creates the preview message
  preview.onTextDelta(" world");
  // flush() blocks until the recovery timer fires and succeeds. The first
  // attempt 429s (recovery scheduled ~1s); the second succeeds.
  await preview.flush();

  const state = preview.state();
  assert.equal(editCalls, 2, "expected initial 429 + successful recovery");
  assert.equal(state.failed, false, "mid-stream 429 must NOT kill the stream");
  assert.equal(state.hadPreview, true);
  assert.equal(state.messageId, 42);
  // The diagnostic vars persist after a successful recovery so the operator
  // still sees the most recent rate-limit hit; they're cleared on
  // clear()/finish().
  assert.equal(state.retryAfterMs, 1_000);
  assert.ok(typeof state.rateLimitedUntilMs === "number");
  assert.match(logs.join("\n"), /stream_preview_rate_limited\b/);
  assert.doesNotMatch(logs.join("\n"), /stream_preview_rate_limited_at_finish/);

  await preview.clear();
  __resetTelegramRateLimitRegistryForTests();
});

test("stream preview gives up after sustained 429s (bounded recovery)", async () => {
  __resetTelegramRateLimitRegistryForTests();
  const logs: string[] = [];
  let editCalls = 0;
  const preview = createTelegramStreamPreview({
    api: {
      sendMessage: async () => ({ message_id: 43 }),
      editMessageText: async () => {
        editCalls += 1;
        throw new Error("Call to 'editMessageText' failed! (429: Too Many Requests: retry after 0)");
      },
      deleteMessage: async () => true,
    } as any,
    chatId: 124,
    throttleMs: 30,
    log: (msg) => logs.push(msg),
    warn: (msg) => logs.push(msg),
  });

  preview.onTextDelta("hello");
  await preview.flush(); // sendMessage success
  preview.onTextDelta(" world");
  // Trigger the initial 429; recovery timers will fire each ~1s in the
  // background. After MAX_CONSECUTIVE_RATE_LIMIT_ATTEMPTS the stream gives
  // up. Wait long enough for all recovery attempts to elapse.
  preview.flush().catch(() => {});
  await new Promise((r) => setTimeout(r, 3_500));

  const state = preview.state();
  assert.equal(state.failed, true, "stream gives up after MAX_CONSECUTIVE_RATE_LIMIT_ATTEMPTS");
  assert.match(logs.join("\n"), /stream_preview_rate_limit_persistent/);
  // 1 initial 429 + 3 recovery 429s = 4 edits total.
  assert.ok(editCalls >= 4, `expected ≥4 attempts, got ${editCalls}`);
  await preview.clear();
  __resetTelegramRateLimitRegistryForTests();
});

test("stream preview at finish time gives up on a long cooldown instead of blocking", async () => {
  __resetTelegramRateLimitRegistryForTests();
  const logs: string[] = [];
  const preview = createTelegramStreamPreview({
    api: {
      sendMessage: async () => ({ message_id: 99 }),
      editMessageText: async () => {
        throw new Error("Call to 'editMessageText' failed! (429: Too Many Requests: retry after 30)");
      },
      deleteMessage: async () => true,
    } as any,
    chatId: 456,
    throttleMs: 50,
    log: (msg) => logs.push(msg),
    warn: (msg) => logs.push(msg),
  });

  preview.onTextDelta("hello");
  await preview.flush(); // sendMessage initial preview
  preview.onTextDelta(" world");
  // finish() must not block on the cooldown — it gives up so the finalize
  // path can take over (which itself respects the registry and waits).
  const before = Date.now();
  await preview.finish();
  const elapsed = Date.now() - before;
  assert.ok(elapsed < 1_000, `finish should give up quickly on 429, took ${elapsed}ms`);

  const state = preview.state();
  assert.equal(state.failed, true, "finish-time 429 sets failed so the finalize path can take over");
  assert.match(logs.join("\n"), /stream_preview_rate_limited_at_finish/);
  __resetTelegramRateLimitRegistryForTests();
});

test("stream preview gives up immediately on a long mid-stream cooldown", async () => {
  __resetTelegramRateLimitRegistryForTests();
  const logs: string[] = [];
  let editCalls = 0;
  const preview = createTelegramStreamPreview({
    api: {
      sendMessage: async () => ({ message_id: 77 }),
      editMessageText: async () => {
        editCalls += 1;
        throw new Error("Call to 'editMessageText' failed! (429: Too Many Requests: retry after 20)");
      },
      deleteMessage: async () => true,
    } as any,
    chatId: 457,
    throttleMs: 50,
    log: (msg) => logs.push(msg),
    warn: (msg) => logs.push(msg),
  });

  preview.onTextDelta("hello");
  await preview.flush();
  preview.onTextDelta(" world");
  const before = Date.now();
  await preview.flush();
  const elapsed = Date.now() - before;

  const state = preview.state();
  assert.equal(editCalls, 1, "long cooldown should not schedule preview retries");
  assert.equal(state.failed, true);
  assert.equal(state.retryAfterMs, 21_000);
  assert.ok(elapsed < 1_000, `long cooldown preview shutdown should be quick, took ${elapsed}ms`);
  assert.match(logs.join("\n"), /stream_preview_rate_limit_suspended/);
  __resetTelegramRateLimitRegistryForTests();
});

test("per-chat registry: a 429 in one preview makes subsequent flushes on the same chat wait", async () => {
  __resetTelegramRateLimitRegistryForTests();
  let editCalls = 0;
  const editCallTimestamps: number[] = [];
  const start = Date.now();
  const preview = createTelegramStreamPreview({
    api: {
      sendMessage: async () => ({ message_id: 11 }),
      editMessageText: async () => {
        editCalls += 1;
        editCallTimestamps.push(Date.now() - start);
        if (editCalls === 1) {
          // First attempt 429s with a 2s retry-after (plus 1s grace = 3000ms).
          throw new Error("Call to 'editMessageText' failed! (429: Too Many Requests: retry after 2)");
        }
        // Subsequent attempts succeed (so we can observe when they were
        // actually allowed to fire).
      },
      deleteMessage: async () => true,
    } as any,
    chatId: 789,
    throttleMs: 30,
    log: () => {},
    warn: () => {},
  });

  preview.onTextDelta("first");
  await preview.flush(); // sendMessage
  preview.onTextDelta(" again");
  // Drive the first 429 by letting the throttle timer fire + runFlush + 429.
  await new Promise((r) => setTimeout(r, 150));
  // First edit attempt has happened (and 429'd) by now. Registry holds chat
  // 789 blocked for ~3s.

  // Now ANOTHER caller flushes. This must wait for the registry cooldown to
  // elapse before the second editMessageText runs.
  preview.onTextDelta("!");
  await preview.flush();

  // The first edit fired at ~throttle+sendMs after start. The SECOND edit
  // must have fired ~3s after the first (matching the registry cooldown,
  // grace included).
  assert.equal(editCalls, 2);
  const gap = editCallTimestamps[1]! - editCallTimestamps[0]!;
  assert.ok(
    gap >= 2_500,
    `expected the second editMessageText to wait the cooldown, gap=${gap}ms timestamps=${JSON.stringify(editCallTimestamps)}`,
  );
  __resetTelegramRateLimitRegistryForTests();
});
