import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compactShellReadPayload,
  compactProgressOutput,
  orchestratorCodeShellPolicyError,
  paginateUtf8Chunk,
  shellInteractive,
} from "./shell-interactive.js";

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

test("orchestrator cannot open shell_interactive in repository code root", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-shell-interactive-test-"));
  try {
    const codeDir = path.join(tempDir, "repo");
    await fs.mkdir(codeDir, { recursive: true });
    const result = orchestratorCodeShellPolicyError(
      {
        workspaceDir: tempDir,
        stateDir: tempDir,
        codeDir,
        allowShellExec: true,
        request: {
          channel: "cli",
          channelKey: "test",
          agentId: "main",
          sessionId: "s-1",
          preset: "orchestrator",
        },
        nowMs: () => Date.now(),
        log: () => {},
      },
      codeDir,
    );
    assert.match(result ?? "", /must not use shell_interactive inside the repository code root/i);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("compactProgressOutput collapses carriage-return progress redraws", () => {
  const output = "download 10%\rdownload 40%\rdownload 100%\r";
  const compacted = compactProgressOutput(output);
  assert.equal(compacted.compacted, true);
  assert.equal(compacted.suppressedFrames, 2);
  assert.equal(compacted.originalChars, output.length);
  assert.match(compacted.output, /progress updates compacted: 2 frames; latest: download 100%/i);
});

test("compactProgressOutput leaves normal multiline output unchanged", () => {
  const output = "line one\nline two\nline three\n";
  const compacted = compactProgressOutput(output);
  assert.equal(compacted.compacted, false);
  assert.equal(compacted.suppressedFrames, 0);
  assert.equal(compacted.output, output);
});

test("compactShellReadPayload adds progress metadata only for read payloads", () => {
  const payload = compactShellReadPayload({
    action: "read",
    session: "shell-1",
    output: "step 1\rstep 2\rstep 3\r",
    running: true,
  });
  assert.equal(payload.progressCompacted, true);
  assert.equal(payload.suppressedFrames, 2);
  assert.equal(payload.outputOriginalChars, "step 1\rstep 2\rstep 3\r".length);
  assert.match(String(payload.output), /latest: step 3/i);

  const untouched = compactShellReadPayload({
    action: "send",
    session: "shell-1",
    output: "ignored",
  });
  assert.equal(untouched.progressCompacted, undefined);
  assert.equal(untouched.output, "ignored");
});
