import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isMutatingGitOnCodeDir, isOrchestratorShellDelegationCommand, shellExec } from "./system.js";

test("isMutatingGitOnCodeDir flags mutating git commands in code root", () => {
  const codeDir = "/tmp/project/code";
  assert.equal(isMutatingGitOnCodeDir("git commit -m test", codeDir, { cwd: codeDir }), true);
  assert.equal(isMutatingGitOnCodeDir("git status", codeDir, { cwd: codeDir }), false);
});

test("isMutatingGitOnCodeDir allows mutating git commands outside code root", () => {
  const codeDir = "/tmp/project/code";
  assert.equal(isMutatingGitOnCodeDir("git commit -m test", codeDir, { cwd: "/tmp/project/work" }), false);
  assert.equal(isMutatingGitOnCodeDir("git -C /tmp/project/work commit -m test", codeDir, { cwd: codeDir }), false);
});

test("isMutatingGitOnCodeDir detects -C targeting code root", () => {
  const codeDir = "/tmp/project/code";
  assert.equal(
    isMutatingGitOnCodeDir("git -C /tmp/project/code add .", codeDir, { cwd: "/tmp/project/work" }),
    true,
  );
});

test("isOrchestratorShellDelegationCommand flags local Node and package-manager commands", () => {
  assert.equal(isOrchestratorShellDelegationCommand("npx ts-node -e \"console.log(1)\""), true);
  assert.equal(isOrchestratorShellDelegationCommand("npm run build"), true);
  assert.equal(isOrchestratorShellDelegationCommand("git status"), false);
});

test("shell_exec blocks orchestrator from local Node execution", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-system-test-"));
  try {
    const result = await shellExec.execute(
      { command: "node -e \"console.log('hi')\"", timeoutMs: 5_000 },
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
          preset: "orchestrator",
        },
        nowMs: () => Date.now(),
        log: () => {},
      },
    );
    assert.match(result, /must not use shell_exec to run local Node\/package-manager commands/i);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("shell_exec runs commands in codeDir by default", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-system-test-"));
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-system-workspace-"));
  try {
    const result = await shellExec.execute(
      { command: "pwd", timeoutMs: 5_000 },
      {
        workspaceDir,
        stateDir: workspaceDir,
        codeDir: tempDir,
        allowShellExec: true,
        request: {
          channel: "cli",
          channelKey: "test",
          agentId: "coder",
          sessionId: "s-2",
          preset: "coder",
        },
        nowMs: () => Date.now(),
        log: () => {},
      },
    );
    const resolvedTempDir = await fs.realpath(tempDir);
    assert.equal(result.trim(), resolvedTempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
