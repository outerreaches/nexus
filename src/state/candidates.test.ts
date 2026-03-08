import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createCandidate,
  deleteCandidate,
  listCandidates,
  loadCandidate,
  pruneCandidates,
  updateCandidate,
} from "./candidates.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
  return result.stdout.trim();
}

async function createLiveRepo(root: string): Promise<{ liveCodeDir: string; baseSha: string }> {
  const liveCodeDir = path.join(root, "live");
  await fs.mkdir(liveCodeDir, { recursive: true });
  await git(["init", "-b", "main"], liveCodeDir);
  await git(["config", "user.name", "Nexus Test"], liveCodeDir);
  await git(["config", "user.email", "nexus@example.com"], liveCodeDir);
  await fs.writeFile(path.join(liveCodeDir, "README.md"), "seed\n", "utf8");
  await git(["add", "README.md"], liveCodeDir);
  await git(["commit", "-m", "seed"], liveCodeDir);
  return { liveCodeDir, baseSha: await git(["rev-parse", "HEAD"], liveCodeDir) };
}

test("createCandidate clones the live repo and persists metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-candidates-test-"));
  try {
    const { liveCodeDir, baseSha } = await createLiveRepo(root);
    const candidateRootDir = path.join(root, "candidates");
    const record = await createCandidate({
      liveCodeDir,
      candidateRootDir,
      candidateId: "cand-test",
      ownerRunId: "run-123",
      ownerSessionId: "session-456",
      nowMs: 1234,
    });

    assert.equal(record.candidateId, "cand-test");
    assert.equal(record.liveCodeDir, path.resolve(liveCodeDir));
    assert.equal(record.repoDir, path.join(path.resolve(candidateRootDir), "cand-test", "repo"));
    assert.equal(record.baseSha, baseSha);
    assert.equal(record.status, "active");
    assert.equal(record.verificationStatus, "pending");
    assert.equal(record.approvalStatus, "pending");
    assert.equal(record.classification, "pending");
    assert.equal(record.updatedAt, 1234);
    assert.equal(record.lastActivityAt, 1234);

    const clonedReadme = await fs.readFile(path.join(record.repoDir, "README.md"), "utf8");
    assert.equal(clonedReadme, "seed\n");
    assert.equal(await git(["rev-parse", "HEAD"], record.repoDir), baseSha);

    const loaded = await loadCandidate(candidateRootDir, "cand-test");
    assert.deepEqual(loaded, record);

    const listed = await listCandidates(candidateRootDir);
    assert.deepEqual(listed, [record]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("createCandidate seeds a private node_modules copy into the candidate and excludes it from git status", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-candidates-node-modules-test-"));
  try {
    const { liveCodeDir } = await createLiveRepo(root);
    const liveNodeModulesDir = path.join(liveCodeDir, "node_modules");
    await fs.mkdir(path.join(liveNodeModulesDir, ".bin"), { recursive: true });
    await fs.writeFile(path.join(liveNodeModulesDir, ".bin", "tsx"), "#!/bin/sh\n", "utf8");

    const candidateRootDir = path.join(root, "candidates");
    const record = await createCandidate({
      liveCodeDir,
      candidateRootDir,
      candidateId: "cand-node-modules",
    });

    const candidateNodeModulesDir = path.join(record.repoDir, "node_modules");
    const stat = await fs.lstat(candidateNodeModulesDir);
    assert.equal(stat.isDirectory(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(await fs.readFile(path.join(candidateNodeModulesDir, ".bin", "tsx"), "utf8"), "#!/bin/sh\n");

    await fs.rm(liveNodeModulesDir, { recursive: true, force: true });
    await fs.access(path.join(candidateNodeModulesDir, ".bin", "tsx"));

    const excludePath = path.join(record.repoDir, ".git", "info", "exclude");
    const excludeText = await fs.readFile(excludePath, "utf8");
    assert.match(excludeText, /^\/node_modules$/m);

    const status = await git(["status", "--short"], record.repoDir);
    assert.equal(status, "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("updateCandidate persists lifecycle metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-candidates-update-test-"));
  try {
    const { liveCodeDir } = await createLiveRepo(root);
    const candidateRootDir = path.join(root, "candidates");
    const record = await createCandidate({
      liveCodeDir,
      candidateRootDir,
      candidateId: "cand-update",
      nowMs: 100,
    });

    const updated = await updateCandidate(candidateRootDir, record.candidateId, {
      status: "pending_approval",
      classification: "approval_required",
      approvalStatus: "pending",
      approvalId: "HA123",
      lastError: "waiting for approval",
      nowMs: 250,
    });

    assert.equal(updated.status, "pending_approval");
    assert.equal(updated.classification, "approval_required");
    assert.equal(updated.approvalId, "HA123");
    assert.equal(updated.lastError, "waiting for approval");
    assert.equal(updated.updatedAt, 250);
    assert.equal(updated.lastActivityAt, 250);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("pruneCandidates removes rejected and stale candidates while retaining recent deployed ones", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-candidates-prune-test-"));
  try {
    const { liveCodeDir } = await createLiveRepo(root);
    const candidateRootDir = path.join(root, "candidates");

    await createCandidate({
      liveCodeDir,
      candidateRootDir,
      candidateId: "cand-stale",
      nowMs: 100,
    });

    await createCandidate({
      liveCodeDir,
      candidateRootDir,
      candidateId: "cand-rejected",
      nowMs: 200,
    });

    await createCandidate({
      liveCodeDir,
      candidateRootDir,
      candidateId: "cand-deployed",
      nowMs: 300,
    });

    await updateCandidate(candidateRootDir, "cand-stale", {
      status: "active",
      nowMs: 150,
      lastActivityAt: 150,
    });
    await updateCandidate(candidateRootDir, "cand-rejected", {
      status: "rejected",
      approvalStatus: "rejected",
      nowMs: 250,
      lastActivityAt: 250,
    });
    await updateCandidate(candidateRootDir, "cand-deployed", {
      status: "deployed",
      nowMs: 310,
      lastActivityAt: 310,
    });

    const result = await pruneCandidates(candidateRootDir, {
      nowMs: 400,
      gcPolicy: {
        activeTtlMs: 100,
        deployedRetentionMs: 200,
      },
    });

    assert.deepEqual(
      result.pruned.map((entry) => [entry.candidateId, entry.reason]),
      [
        ["cand-rejected", "rejected"],
        ["cand-stale", "stale"],
      ],
    );
    const remaining = await listCandidates(candidateRootDir);
    assert.deepEqual(remaining.map((candidate) => candidate.candidateId), ["cand-deployed"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("createCandidate enforces the soft cap per live checkout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-candidates-soft-cap-test-"));
  try {
    const { liveCodeDir } = await createLiveRepo(root);
    const candidateRootDir = path.join(root, "candidates");

    await createCandidate({
      liveCodeDir,
      candidateRootDir,
      candidateId: "cand-one",
      nowMs: 100,
      gcPolicy: {
        softCapPerLiveCodeDir: 1,
      },
    });

    await assert.rejects(
      () =>
        createCandidate({
          liveCodeDir,
          candidateRootDir,
          candidateId: "cand-two",
          nowMs: 200,
          gcPolicy: {
            softCapPerLiveCodeDir: 1,
          },
        }),
      /candidate soft cap exceeded/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("deleteCandidate removes the candidate workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-candidates-delete-test-"));
  try {
    const { liveCodeDir } = await createLiveRepo(root);
    const candidateRootDir = path.join(root, "candidates");
    const record = await createCandidate({
      liveCodeDir,
      candidateRootDir,
      candidateId: "cand-delete",
    });

    await deleteCandidate(candidateRootDir, record.candidateId);

    await assert.rejects(() => fs.stat(record.candidateDir), /ENOENT/);
    assert.deepEqual(await listCandidates(candidateRootDir), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
