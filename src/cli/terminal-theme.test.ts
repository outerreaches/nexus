import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_TERMINAL_THEME,
  loadTerminalThemePreference,
  resolveTerminalThemeId,
  saveTerminalThemePreference,
} from "./terminal-theme.js";

test("resolveTerminalThemeId maps aliases", () => {
  assert.equal(resolveTerminalThemeId("green"), "terminal-green");
  assert.equal(resolveTerminalThemeId("amber"), "terminal-amber");
  assert.equal(resolveTerminalThemeId("dos"), "dos-bw");
  assert.equal(resolveTerminalThemeId("mc"), "midnight");
  assert.equal(resolveTerminalThemeId("light"), "light");
  assert.equal(resolveTerminalThemeId("unknown-theme"), null);
});

test("loadTerminalThemePreference falls back to default when prefs are missing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-theme-test-"));
  try {
    const loaded = await loadTerminalThemePreference(dir);
    assert.equal(loaded, DEFAULT_TERMINAL_THEME);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("saveTerminalThemePreference persists selected theme", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-theme-test-"));
  try {
    await saveTerminalThemePreference(dir, "terminal-amber");
    const loaded = await loadTerminalThemePreference(dir);
    assert.equal(loaded, "terminal-amber");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadTerminalThemePreference falls back on invalid stored theme", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-theme-test-"));
  try {
    const prefPath = path.join(dir, "terminal-ui.json");
    await fs.writeFile(prefPath, JSON.stringify({ theme: "bogus" }), "utf8");
    const loaded = await loadTerminalThemePreference(dir);
    assert.equal(loaded, DEFAULT_TERMINAL_THEME);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
