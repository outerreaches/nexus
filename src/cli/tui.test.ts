import assert from "node:assert/strict";
import test from "node:test";

import { createSharedTui } from "./tui.js";

test("checkbox renders checked and unchecked markers", () => {
  const tui = createSharedTui({ colorEnabled: false, width: 72 });
  assert.equal(tui.checkbox("Feature", true), "[x] Feature");
  assert.equal(tui.checkbox("Feature", false), "[ ] Feature");
});

test("panel includes title and wrapped content", () => {
  const tui = createSharedTui({ colorEnabled: false, useUnicode: false, width: 48 });
  const out = tui.panel("Panel Title", [
    "This is a long line that should wrap within the panel width without overflowing.",
  ]);
  assert.match(out, /\| Panel Title/);
  assert.match(out, /\| This is a long line that should wrap within/);
  assert.match(out, /\|\s+the panel width without overflowing\./);
});

test("panel truncates overly long titles to panel width", () => {
  const tui = createSharedTui({ colorEnabled: false, useUnicode: false, width: 48 });
  const out = tui.panel("X".repeat(120), ["body"]);
  const lines = out.split("\n");
  assert.equal(lines[0].length, 48);
  assert.equal(lines[1].length, 48);
  assert.equal(lines[lines.length - 1].length, 48);
});

test("logoPanel includes the Nexus ASCII logo", () => {
  const tui = createSharedTui({ colorEnabled: false, useUnicode: false, width: 72 });
  const out = tui.logoPanel("Header", "Sub");
  assert.match(out, /███╗ {3}██╗███████╗██╗ {2}██╗██╗ {3}██╗███████╗/);
  assert.match(out, /\| Header/);
  assert.match(out, /\| Sub/);
});

test("promptString omits underscore cursor marker", () => {
  const tui = createSharedTui({ colorEnabled: false, width: 72 });
  assert.equal(tui.promptString(), "> ");
});

test("wrapLine preserves leading whitespace on wrapped lines", () => {
  const tui = createSharedTui({ colorEnabled: false, useUnicode: false, width: 48 });
  const out = tui.panel("Indent Test", [
    "  - This indented bullet should keep its indent when wrapping across lines.",
  ]);
  // Panel body: "| " + content + padding + " |" — indent preserved on both lines
  assert.match(out, /\| {3}- This indented bullet should keep its/);
  assert.match(out, /\| {3}indent when wrapping across lines\./);
});

test("defaults to Unicode boxes when locale is not explicitly non-UTF", () => {
  const prevLang = process.env.LANG;
  const prevLcAll = process.env.LC_ALL;
  const prevLcCtype = process.env.LC_CTYPE;
  const prevTerm = process.env.TERM;
  const prevOverride = process.env.NEXUS_TUI_UNICODE;
  try {
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LC_CTYPE;
    process.env.TERM = "xterm-256color";
    delete process.env.NEXUS_TUI_UNICODE;

    const tui = createSharedTui({ colorEnabled: false, width: 48 });
    const out = tui.panel("Unicode", ["line"]);
    assert.match(out, /┌/);
    assert.match(out, /└/);
  } finally {
    if (prevLang === undefined) delete process.env.LANG;
    else process.env.LANG = prevLang;
    if (prevLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = prevLcAll;
    if (prevLcCtype === undefined) delete process.env.LC_CTYPE;
    else process.env.LC_CTYPE = prevLcCtype;
    if (prevTerm === undefined) delete process.env.TERM;
    else process.env.TERM = prevTerm;
    if (prevOverride === undefined) delete process.env.NEXUS_TUI_UNICODE;
    else process.env.NEXUS_TUI_UNICODE = prevOverride;
  }
});
