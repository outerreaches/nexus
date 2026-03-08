import assert from "node:assert/strict";
import test from "node:test";

import { mergeTelegramFinalTextWithToolSummary } from "./telegram.js";

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
