import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  clampIndex,
  computeWindow,
  filterSelectItems,
  promptListSelection,
  type SelectItem,
} from "./select-list.js";
import { createSharedTui } from "./tui.js";

const items: SelectItem[] = [
  { value: "accounts/fireworks/models/kimi-k2p6" },
  { value: "openai/gpt-5.3-codex" },
  { value: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
];

test("filterSelectItems returns everything for an empty query", () => {
  assert.equal(filterSelectItems(items, "   ").length, 3);
});

test("filterSelectItems matches substrings case-insensitively across value and label", () => {
  assert.deepEqual(
    filterSelectItems(items, "GPT").map((i) => i.value),
    ["openai/gpt-5.3-codex"],
  );
  // "Gemini" only appears in the label, not the value.
  assert.deepEqual(
    filterSelectItems(items, "gemini").map((i) => i.value),
    ["google/gemini-3.1-pro-preview"],
  );
});

test("filterSelectItems requires all whitespace-separated terms to match", () => {
  assert.deepEqual(
    filterSelectItems(items, "openai codex").map((i) => i.value),
    ["openai/gpt-5.3-codex"],
  );
  assert.equal(filterSelectItems(items, "openai gemini").length, 0);
});

test("clampIndex keeps the cursor within bounds", () => {
  assert.equal(clampIndex(-5, 3), 0);
  assert.equal(clampIndex(10, 3), 2);
  assert.equal(clampIndex(1, 3), 1);
  assert.equal(clampIndex(0, 0), 0); // empty list
  assert.equal(clampIndex(Number.NaN, 3), 0);
});

test("computeWindow shows the whole list when it fits", () => {
  assert.deepEqual(computeWindow({ total: 4, active: 2, pageSize: 10 }), { start: 0, end: 4 });
});

test("computeWindow centres the active row and clamps at the edges", () => {
  // active near the top → window pinned to the start
  assert.deepEqual(computeWindow({ total: 100, active: 0, pageSize: 10 }), { start: 0, end: 10 });
  // active in the middle → window centred
  assert.deepEqual(computeWindow({ total: 100, active: 50, pageSize: 10 }), { start: 45, end: 55 });
  // active near the bottom → window pinned to the end
  assert.deepEqual(computeWindow({ total: 100, active: 99, pageSize: 10 }), { start: 90, end: 100 });
});

// --- promptListSelection driven by a mock TTY ------------------------------

function makeMockTty() {
  const input = new EventEmitter() as EventEmitter & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode: (v: boolean) => void;
    resume: () => void;
    pause: () => void;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (v: boolean) => { input.isRaw = v; };
  input.resume = () => {};
  input.pause = () => {};

  const output = {
    isTTY: true as const,
    columns: 80,
    rows: 24,
    chunks: [] as string[],
    write(s: string) { this.chunks.push(s); return true; },
  };

  return { input, output };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

async function runPicker(items: SelectItem[], keys: string[], opts: { currentValue?: string } = {}) {
  const { input, output } = makeMockTty();
  const tui = createSharedTui({ colorEnabled: false });
  const promise = promptListSelection({
    title: "Test",
    items,
    tui,
    currentValue: opts.currentValue,
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  });
  // The picker awaits a dynamic import before attaching its "data" listener;
  // wait for it so the first keystroke isn't dropped.
  for (let i = 0; i < 200 && input.listenerCount("data") === 0; i++) await tick();
  for (const key of keys) {
    input.emit("data", Buffer.from(key, "utf8"));
    await tick();
  }
  return await promise;
}

const PICK_ITEMS: SelectItem[] = [
  { value: "alpha" },
  { value: "bravo" },
  { value: "charlie" },
];

test("promptListSelection: Down twice then Enter picks the third item", async () => {
  const result = await runPicker(PICK_ITEMS, ["\x1b[B", "\x1b[B", "\r"]);
  assert.equal(result, "charlie");
});

test("promptListSelection: typing filters then Enter picks the match", async () => {
  const result = await runPicker(PICK_ITEMS, ["b", "r", "\r"]);
  assert.equal(result, "bravo");
});

test("promptListSelection: Esc cancels and resolves null", async () => {
  const result = await runPicker(PICK_ITEMS, ["\x1b"]);
  assert.equal(result, null);
});

test("promptListSelection: Ctrl+C cancels and resolves null", async () => {
  const result = await runPicker(PICK_ITEMS, ["\x03"]);
  assert.equal(result, null);
});

test("promptListSelection: starts highlighted on currentValue", async () => {
  // currentValue=charlie starts active; Enter with no movement selects it.
  const result = await runPicker(PICK_ITEMS, ["\r"], { currentValue: "charlie" });
  assert.equal(result, "charlie");
});

test("promptListSelection: Up at the top stays on the first item", async () => {
  const result = await runPicker(PICK_ITEMS, ["\x1b[A", "\x1b[A", "\r"]);
  assert.equal(result, "alpha");
});

test("promptListSelection: Enter with no matches is ignored, then backspace recovers", async () => {
  // "zzz" matches nothing; Enter does nothing; backspace x3 clears filter; Enter picks first.
  const result = await runPicker(PICK_ITEMS, ["z", "z", "z", "\r", "\x7f", "\x7f", "\x7f", "\r"]);
  assert.equal(result, "alpha");
});

test("promptListSelection: restores raw mode to its prior state on exit", async () => {
  const { input, output } = makeMockTty();
  const tui = createSharedTui({ colorEnabled: false });
  const promise = promptListSelection({
    title: "Test",
    items: PICK_ITEMS,
    tui,
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  });
  for (let i = 0; i < 200 && input.listenerCount("data") === 0; i++) await tick();
  input.emit("data", Buffer.from("\r", "utf8"));
  await promise;
  assert.equal(input.isRaw, false);
});

test("promptListSelection: returns null without touching a non-TTY stream", async () => {
  const tui = createSharedTui({ colorEnabled: false });
  const result = await promptListSelection({
    title: "Test",
    items: PICK_ITEMS,
    tui,
    input: { isTTY: false } as unknown as NodeJS.ReadStream,
    output: { isTTY: false } as unknown as NodeJS.WriteStream,
  });
  assert.equal(result, null);
});
