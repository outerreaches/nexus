import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { listCandidates } from "../state/candidates.js";
import { resolveRunCodeContext } from "./run-code-context.js";
import type { ToolContext } from "./tools.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
  return result.stdout.trim();
}

async function createLiveRepo(root: string): Promise<string> {
  const liveCodeDir = path.join(root, "live");
  await fs.mkdir(liveCodeDir, { recursive: true });
  await git(["init", "-b", "main"], liveCodeDir);
  await git(["config", "user.name", "Nexus Test"], liveCodeDir);
  await git(["config", "user.email", "nexus@example.com"], liveCodeDir);
  await fs.writeFile(path.join(liveCodeDir, "README.md"), "seed\n", "utf8");
  await git(["add", "README.md"], liveCodeDir);
  await git(["commit", "-m", "seed"], liveCodeDir);
  return liveCodeDir;
}

async function createBaseContext(root: string): Promise<ToolContext> {
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(root, "workspace");
  const candidateRootDir = path.join(stateDir, "candidates");
  const liveCodeDir = await createLiveRepo(root);
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(candidateRootDir, { recursive: true });
  return {
    stateDir,
    workspaceDir,
    codeDir: liveCodeDir,
    liveCodeDir,
    candidateRootDir,
    nowMs: () => 1234,
    log: () => {},
  };
}

test("resolveRunCodeContext creates a candidate for local coder write runs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-run-code-context-write-"));
  try {
    const ctx = await createBaseContext(root);
    const next = await resolveRunCodeContext({
      baseContext: ctx,
      presetName: "coder",
      taskType: "write",
      runId: "run-1",
      sessionId: "session-1",
    });

    assert.ok(next.candidate);
    assert.notEqual(next.codeDir, ctx.liveCodeDir);
    assert.equal(next.codeDir, next.candidate?.repoDir);
    assert.equal(next.liveCodeDir, path.resolve(ctx.liveCodeDir!));

    const candidates = await listCandidates(ctx.candidateRootDir!);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.ownerRunId, "run-1");
    assert.equal(candidates[0]?.ownerSessionId, "session-1");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("resolveRunCodeContext skips candidate creation for read-only coder tasks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-run-code-context-readonly-"));
  try {
    const ctx = await createBaseContext(root);
    const next = await resolveRunCodeContext({
      baseContext: ctx,
      presetName: "coder",
      taskType: "plan",
      runId: "run-2",
      sessionId: "session-2",
    });

    assert.equal(next.candidate, undefined);
    assert.equal(next.codeDir, path.resolve(ctx.liveCodeDir!));
    assert.deepEqual(await listCandidates(ctx.candidateRootDir!), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("resolveRunCodeContext reuses an existing candidate for child runs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-run-code-context-reuse-"));
  try {
    const ctx = await createBaseContext(root);
    const parent = await resolveRunCodeContext({
      baseContext: ctx,
      presetName: "coder",
      taskType: "write",
      runId: "run-parent",
      sessionId: "session-parent",
    });
    const child = await resolveRunCodeContext({
      baseContext: parent,
      presetName: "researcher",
      runId: "run-child",
      sessionId: "session-child",
    });

    assert.ok(parent.candidate);
    assert.deepEqual(child.candidate, parent.candidate);
    assert.equal(child.codeDir, parent.codeDir);
    assert.equal((await listCandidates(ctx.candidateRootDir!)).length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("resolveRunCodeContext skips candidate creation for node-target coder runs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-run-code-context-node-"));
  try {
    const ctx = await createBaseContext(root);
    const next = await resolveRunCodeContext({
      baseContext: ctx,
      presetName: "coder",
      taskType: "write",
      runId: "run-node",
      sessionId: "session-node",
      executionTarget: { target: "node", nodeId: "node-1" },
    });

    assert.equal(next.candidate, undefined);
    assert.equal(next.codeDir, path.resolve(ctx.liveCodeDir!));
    assert.deepEqual(await listCandidates(ctx.candidateRootDir!), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
