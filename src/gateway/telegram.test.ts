import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("stream preview records rate-limited edit state without throwing", async () => {
  const sentMessages: string[] = [];
  const editedMessages: string[] = [];
  const logs: string[] = [];
  const beforeMs = Date.now();

  const preview = createTelegramStreamPreview({
    api: {
      sendMessage: async (_chatId: number, text: string) => {
        sentMessages.push(text);
        return { message_id: 42 };
      },
      editMessageText: async (_chatId: number, _messageId: number, text: string) => {
        editedMessages.push(text);
        throw new Error("Call to 'editMessageText' failed! (429: Too Many Requests: retry after 82)");
      },
      deleteMessage: async () => true,
    } as any,
    chatId: 123,
    transport: "message",
    throttleMs: 200,
    log: (msg) => logs.push(msg),
    warn: (msg) => logs.push(msg),
  });

  preview.onTextDelta("hello");
  await preview.flush();
  preview.onTextDelta(" world");
  await preview.flush();

  const state = preview.state();
  assert.deepEqual(sentMessages, ["hello"]);
  assert.deepEqual(editedMessages, ["hello world"]);
  assert.equal(state.failed, true);
  assert.equal(state.hadPreview, true);
  assert.equal(state.messageId, 42);
  assert.equal(state.retryAfterMs, 83_000);
  assert.ok(typeof state.rateLimitedUntilMs === "number");
  assert.ok(state.rateLimitedUntilMs >= beforeMs + 83_000);
  assert.match(logs.join("\n"), /stream_preview_error/);
});
