import assert from "node:assert/strict";
import test from "node:test";

import { countWrappedPromptRows, getPromptLayout } from "./input-layout.js";

test("single prompt line stays on one row when it fits terminal width", () => {
  assert.equal(
    countWrappedPromptRows({
      value: "x".repeat(77),
      promptLen: 2,
      columns: 80,
    }),
    1,
  );
});

test("line that exactly fills terminal width advances to next physical row", () => {
  assert.equal(
    countWrappedPromptRows({
      value: "x".repeat(78),
      promptLen: 2,
      columns: 80,
    }),
    2,
  );
});

test("single prompt line wraps to multiple physical rows", () => {
  assert.equal(
    countWrappedPromptRows({
      value: "x".repeat(79),
      promptLen: 2,
      columns: 80,
    }),
    2,
  );
  assert.equal(
    countWrappedPromptRows({
      value: "x".repeat(200),
      promptLen: 2,
      columns: 80,
    }),
    3,
  );
});

test("getPromptLayout returns physical cursor row/column for wrapped lines", () => {
  const layoutMid = getPromptLayout({
    value: "x".repeat(79),
    cursorPos: 40,
    promptLen: 2,
    columns: 80,
  });
  assert.equal(layoutMid.totalRows, 2);
  assert.equal(layoutMid.cursorRow, 0);
  assert.equal(layoutMid.cursorCol, 42);

  const layoutEnd = getPromptLayout({
    value: "x".repeat(79),
    cursorPos: 79,
    promptLen: 2,
    columns: 80,
  });
  assert.equal(layoutEnd.totalRows, 2);
  assert.equal(layoutEnd.cursorRow, 1);
  assert.equal(layoutEnd.cursorCol, 1);
});

test("getPromptLayout handles newline boundaries correctly", () => {
  const value = `${"x".repeat(90)}\nabc`;

  const atLineEnd = getPromptLayout({
    value,
    cursorPos: 90,
    promptLen: 2,
    columns: 80,
  });
  assert.equal(atLineEnd.cursorRow, 1);
  assert.equal(atLineEnd.cursorCol, 12);

  const atNextLineStart = getPromptLayout({
    value,
    cursorPos: 91,
    promptLen: 2,
    columns: 80,
  });
  assert.equal(atNextLineStart.cursorRow, 2);
  assert.equal(atNextLineStart.cursorCol, 2);
});

test("explicit newlines and wrapped logical lines both count toward total rows", () => {
  assert.equal(
    countWrappedPromptRows({
      value: `${"x".repeat(90)}\n${"y".repeat(5)}\n${"z".repeat(170)}`,
      promptLen: 2,
      columns: 80,
    }),
    6,
  );
});
