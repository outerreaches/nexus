import assert from "node:assert/strict";
import test from "node:test";

import { createSharedTui } from "./tui.js";

test("checkbox renders checked and unchecked markers", () => {
  const tui = createSharedTui({ colorEnabled: false, width: 72 });
  assert.equal(tui.checkbox("Feature", true), "[x] Feature");
  assert.equal(tui.checkbox("Feature", false), "[ ] Feature");
});

test("panel includes title and wrapped content", () => {
  const tui = createSharedTui({ colorEnabled: false, width: 48 });
  const out = tui.panel("Panel Title", [
    "This is a long line that should wrap within the panel width without overflowing.",
  ]);
  assert.match(out, /\| Panel Title/);
  assert.match(out, /\| This is a long line that should wrap within/);
  assert.match(out, /\|\s+the panel width without overflowing\./);
});

test("logoPanel includes the Nexus ASCII logo", () => {
  const tui = createSharedTui({ colorEnabled: false, width: 72 });
  const out = tui.logoPanel("Header", "Sub");
  assert.match(out, /███╗   ██╗███████╗██╗  ██╗██╗   ██╗███████╗/);
  assert.match(out, /\| Header/);
  assert.match(out, /\| Sub/);
});
