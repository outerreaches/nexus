import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCsi,
  deleteWordAfter,
  deleteWordBefore,
  getCompletions,
  longestCommonPrefix,
  planCompletion,
  wordLeft,
  wordRight,
  type CompletionContext,
} from "./editor-actions.js";

// --- word motion -----------------------------------------------------------

test("wordLeft jumps to the start of the previous word", () => {
  const v = "hello world foo";
  assert.equal(wordLeft(v, v.length), 12); // -> start of "foo"
  assert.equal(wordLeft(v, 12), 6); // -> start of "world"
  assert.equal(wordLeft(v, 6), 0); // -> start of "hello"
  assert.equal(wordLeft(v, 0), 0);
});

test("wordLeft skips trailing whitespace before the word", () => {
  const v = "alpha   beta";
  assert.equal(wordLeft(v, v.length), 8); // start of "beta"
  assert.equal(wordLeft(v, 8), 0); // skip spaces then "alpha"
});

test("wordRight jumps past the next word", () => {
  const v = "hello world foo";
  assert.equal(wordRight(v, 0), 5); // end of "hello"
  assert.equal(wordRight(v, 5), 11); // skip space, end of "world"
  assert.equal(wordRight(v, 11), 15); // end of "foo"
  assert.equal(wordRight(v, 15), 15);
});

test("word motion treats newlines as boundaries", () => {
  const v = "one\ntwo";
  assert.equal(wordLeft(v, v.length), 4); // start of "two"
  assert.equal(wordRight(v, 0), 3); // end of "one"
});

test("deleteWordBefore removes the previous word", () => {
  assert.deepEqual(deleteWordBefore("hello world", 11), { value: "hello ", cursorPos: 6 });
  assert.deepEqual(deleteWordBefore("hello world", 5), { value: " world", cursorPos: 0 });
});

test("deleteWordAfter removes the next word", () => {
  assert.deepEqual(deleteWordAfter("hello world", 0), { value: " world", cursorPos: 0 });
  assert.deepEqual(deleteWordAfter("hello world", 5), { value: "hello", cursorPos: 5 });
});

// --- CSI classification ----------------------------------------------------

test("classifyCsi maps plain and modified arrows", () => {
  assert.equal(classifyCsi("A"), "up");
  assert.equal(classifyCsi("B"), "down");
  assert.equal(classifyCsi("C"), "right");
  assert.equal(classifyCsi("D"), "left");
  assert.equal(classifyCsi("1;5D"), "word-left"); // Ctrl+Left
  assert.equal(classifyCsi("1;3C"), "word-right"); // Alt+Right
  assert.equal(classifyCsi("1;5H"), "home");
});

test("classifyCsi maps home/end/delete variants", () => {
  assert.equal(classifyCsi("H"), "home");
  assert.equal(classifyCsi("F"), "end");
  assert.equal(classifyCsi("3~"), "delete");
  assert.equal(classifyCsi("3;5~"), "delete-word"); // Ctrl+Delete
  assert.equal(classifyCsi("1~"), "home");
  assert.equal(classifyCsi("4~"), "end");
});

test("classifyCsi returns null for unknown sequences", () => {
  assert.equal(classifyCsi("5~"), null); // PageUp — not handled in the editor
  assert.equal(classifyCsi("Z"), null);
});

// --- completion ------------------------------------------------------------

test("longestCommonPrefix finds the shared head", () => {
  assert.equal(longestCommonPrefix(["/stop", "/stopall", "/status"]), "/st");
  assert.equal(longestCommonPrefix(["/model"]), "/model");
  assert.equal(longestCommonPrefix(["/a", "/b"]), "/");
  assert.equal(longestCommonPrefix([]), "");
});

const ctx: CompletionContext = {
  commands: ["/help", "/model", "/provider", "/presets", "/stop", "/stopall", "/status", "/theme"],
  presets: ["coder", "trader", "analyst"],
  themes: ["dracula", "nord", "midnight"],
  providers: ["fireworks", "openrouter", "local"],
};

test("getCompletions completes the command word", () => {
  const res = getCompletions("/st", 3, ctx);
  assert.deepEqual(res, { start: 0, end: 3, candidates: ["/stop", "/stopall", "/status"] });
});

test("getCompletions ignores non-slash first tokens (plain chat)", () => {
  assert.equal(getCompletions("hello wor", 9, ctx), null);
});

test("getCompletions completes theme and preset arguments", () => {
  assert.deepEqual(getCompletions("/theme dra", 10, ctx)?.candidates, ["dracula"]);
  assert.deepEqual(getCompletions("/presets t", 10, ctx)?.candidates, ["trader"]);
});

test("getCompletions completes provider names and flags", () => {
  assert.deepEqual(getCompletions("/provider open", 14, ctx)?.candidates, ["openrouter"]);
  assert.deepEqual(getCompletions("/model --", 9, ctx)?.candidates, ["--preset", "--tool", "--reset"]);
});

test("planCompletion: single match completes and adds a trailing space", () => {
  const plan = planCompletion("/mod", 4, ctx, null);
  assert.deepEqual(plan, { value: "/model ", cursorPos: 7, cycle: null });
});

test("planCompletion: multiple matches grow to the common prefix first", () => {
  // "/s" -> grows to the common prefix "/st" of /stop,/stopall,/status; no cycle yet.
  const grow = planCompletion("/s", 2, ctx, null);
  assert.equal(grow?.value, "/st");
  assert.equal(grow?.cycle, null);
});

test("planCompletion: cycles through matches once at the common prefix", () => {
  // At the common prefix "/st", Tab starts cycling.
  const first = planCompletion("/st", 3, ctx, null);
  assert.equal(first?.value, "/stop");
  assert.ok(first?.cycle);
  const second = planCompletion(first!.value, first!.cursorPos, ctx, first!.cycle);
  assert.equal(second?.value, "/stopall");
  const third = planCompletion(second!.value, second!.cursorPos, ctx, second!.cycle);
  assert.equal(third?.value, "/status");
  const wrap = planCompletion(third!.value, third!.cursorPos, ctx, third!.cycle);
  assert.equal(wrap?.value, "/stop"); // wraps around
});

test("planCompletion: returns null when nothing matches", () => {
  assert.equal(planCompletion("/zzz", 4, ctx, null), null);
  assert.equal(planCompletion("plain text", 10, ctx, null), null);
});

test("planCompletion: a fresh prefix abandons a stale cycle", () => {
  const cycle = { candidates: ["/stop", "/stopall"], index: 0, start: 0, end: 5 };
  // value/cursor no longer match the cycle's parked position → recompute fresh.
  const plan = planCompletion("/the", 4, ctx, cycle);
  assert.equal(plan?.value, "/theme ");
  assert.equal(plan?.cycle, null);
});
