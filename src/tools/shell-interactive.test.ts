import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { paginateUtf8Chunk, shellInteractive } from "./shell-interactive.js";

test("paginateUtf8Chunk advances only returned bytes for ASCII output", () => {
  const source = Buffer.from("abcdefghij", "utf8");
  const first = paginateUtf8Chunk(source, 4);
  assert.equal(first.output, "abcd");
  assert.equal(first.consumedBytes, 4);
  assert.equal(first.truncatedByChars, true);

  const second = paginateUtf8Chunk(source.subarray(first.consumedBytes), 8);
  assert.equal(second.output, "efghij");
  assert.equal(first.output + second.output, "abcdefghij");
});

test("paginateUtf8Chunk respects UTF-8 boundaries", () => {
  const sourceText = "🙂🙂abc";
  const source = Buffer.from(sourceText, "utf8");
  const first = paginateUtf8Chunk(source, 1);
  assert.equal(first.output, "🙂");
  assert.equal(first.consumedBytes, Buffer.byteLength("🙂", "utf8"));

  const second = paginateUtf8Chunk(source.subarray(first.consumedBytes), 4);
  assert.equal(second.output, "🙂abc");
  assert.equal(first.output + second.output, sourceText);
});

test("shell_interactive is disabled when allowShellExec is false", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-shell-interactive-test-"));
  try {
    const result = await shellInteractive.execute(
      { action: "list", target: "local" },
      {
        workspaceDir: tempDir,
        stateDir: tempDir,
        codeDir: tempDir,
        allowShellExec: false,
        request: {
          channel: "cli",
          channelKey: "test",
          agentId: "main",
          sessionId: "s-1",
          preset: "orchestrator",
        },
        nowMs: () => Date.now(),
        log: () => { },
      },
    );
    assert.equal(result, "ERROR: shell_interactive is disabled by policy");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("security-researcher preset is allowed to use shell_interactive", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-shell-interactive-test-"));
  try {
    const result = await shellInteractive.execute(
      { action: "list", target: "local" },
      {
        workspaceDir: tempDir,
        stateDir: tempDir,
        codeDir: tempDir,
        allowShellExec: true,
        request: {
          channel: "cli",
          channelKey: "test",
          agentId: "main",
          sessionId: "s-1",
          preset: "security-researcher",
        },
        nowMs: () => Date.now(),
        log: () => { },
      },
    );
    const parsed = JSON.parse(result) as Record<string, unknown>;
    assert.equal(parsed.ok, true);
    assert.equal(parsed.action, "list");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
