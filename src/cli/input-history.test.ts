import assert from "node:assert/strict";
import test from "node:test";

import { InputHistory } from "./input-history.js";

test("up walks from newest to oldest, then stops", () => {
  const h = new InputHistory(["one", "two", "three"]);
  assert.equal(h.up(""), "three");
  assert.equal(h.up(""), "two");
  assert.equal(h.up(""), "one");
  assert.equal(h.up(""), null); // already at oldest
});

test("down walks back toward the live draft and restores it", () => {
  const h = new InputHistory(["one", "two"]);
  // First ↑ from a draft saves the draft, shows newest entry.
  assert.equal(h.up("draft in progress"), "two");
  assert.equal(h.up(""), "one");
  assert.equal(h.down(), "two");
  // Stepping past the newest entry restores the exact draft.
  assert.equal(h.down(), "draft in progress");
  assert.equal(h.down(), null); // already on the live draft
});

test("accidental up then down recovers an unsent draft", () => {
  const h = new InputHistory(["earlier message"]);
  const draft = "half-typed thought";
  assert.equal(h.up(draft), "earlier message"); // oops, hit up
  assert.equal(h.down(), draft); // down brings the draft right back
});

test("up with no history returns null and preserves nothing", () => {
  const h = new InputHistory();
  assert.equal(h.up("draft"), null);
  assert.equal(h.down(), null);
});

test("push records entries, skips empties and consecutive duplicates", () => {
  const h = new InputHistory();
  h.push("a");
  h.push("a"); // duplicate of previous → ignored
  h.push("");  // empty → ignored
  h.push("b");
  assert.deepEqual(h.list(), ["a", "b"]);
});

test("push resets the navigation cursor to the live draft", () => {
  const h = new InputHistory(["old"]);
  h.up("draft"); // now browsing history
  h.push("fresh submission");
  // After a submit, ↑ starts again from the newest entry, and the saved draft
  // from the previous navigation is gone.
  assert.equal(h.up("new draft"), "fresh submission");
  assert.equal(h.down(), "new draft");
});

test("constructor drops empty seed lines", () => {
  const h = new InputHistory(["", "real", ""]);
  assert.deepEqual(h.list(), ["real"]);
});

test("editing a recalled entry then navigating discards the edit but keeps the draft", () => {
  const h = new InputHistory(["alpha", "beta"]);
  assert.equal(h.up("mydraft"), "beta");
  // operator edits "beta" → "beta-edited" then presses ↑ again; the edit is not
  // persisted, but the original live draft is still protected on the way down.
  assert.equal(h.up("beta-edited"), "alpha");
  assert.equal(h.down(), "beta"); // original entry, not the edit
  assert.equal(h.down(), "mydraft");
});
