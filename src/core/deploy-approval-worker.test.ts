import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { buildDeployApprovalMetadata } from "./deploy-approval.js";
import { startDeployApprovalWorker } from "./deploy-approval-worker.js";
import { getDeployRequest } from "../storage/deploy-requests.js";
import { openDatabase, type NexusDatabase } from "../storage/database.js";
import { createHumanAction, fulfillHumanAction } from "../storage/human-actions.js";
import { createCandidate, loadCandidate } from "../state/candidates.js";
import { inspectDeployWorktree } from "./deploy-policy.js";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
  return result.stdout.trim();
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
}

async function createRepo(root: string): Promise<string> {
  const repoDir = path.join(root, "repo");
  await fs.mkdir(repoDir, { recursive: true });
  await git(["init", "-b", "main"], repoDir);
  await git(["config", "user.name", "Nexus Test"], repoDir);
  await git(["config", "user.email", "nexus@example.com"], repoDir);
  await writeFile(repoDir, "README.md", "seed\n");
  await writeFile(
    repoDir,
    "package.json",
    JSON.stringify(
      {
        name: "nexus-deploy-approval-worker-test",
        private: true,
        scripts: {
          typecheck: "node -e \"process.exit(0)\"",
          build: "node -e \"process.exit(0)\"",
        },
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(repoDir, "src/tools/index.ts", "export const tools = [];\n");
  await git(["add", "."], repoDir);
  await git(["commit", "-m", "seed"], repoDir);
  return repoDir;
}

async function withRepoAndDb(
  fn: (params: {
    db: NexusDatabase;
    repoDir: string;
    stateDir: string;
    nowMs: () => number;
  }) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-deploy-approval-worker-test-"));
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir, { recursive: true });
  const db = await openDatabase(path.join(root, "nexus.db"));
  let currentNowMs = 1_700_000_000_000;
  try {
    const repoDir = await createRepo(root);
    await fn({
      db,
      repoDir,
      stateDir,
      nowMs: () => currentNowMs,
    });
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("deploy approval worker backfills fulfilled approvals and queues the deploy trigger", async () => {
  await withRepoAndDb(async ({ db, repoDir, stateDir, nowMs }) => {
    const candidateRootDir = path.join(stateDir, "candidates");
    const candidate = await createCandidate({
      liveCodeDir: repoDir,
      candidateRootDir,
      candidateId: "cand-worker-queue",
      nowMs: nowMs(),
    });
    await writeFile(candidate.repoDir, "src/tools/example.ts", "export const example = 1;\n");
    const changes = inspectDeployWorktree(candidate.repoDir);

    const approval = createHumanAction(db, {
      nowMs: nowMs(),
      ttlMs: 60_000,
      sessionId: "session-1",
      channel: "telegram",
      channelKey: "12345",
      agentId: "main:coder",
      kind: "confirm",
      prompt: "approve deploy",
      metadata: buildDeployApprovalMetadata({
        policy: "approval_required",
        changeFingerprint: changes.fingerprint,
        candidate: {
          candidateId: candidate.candidateId,
          baseSha: candidate.baseSha,
        },
        continuation: {
          commitMessage: "queue approved deploy",
          remote: "host",
          branch: "main",
          liveCodeDir: repoDir,
          request: {
            channel: "telegram",
            channelKey: "12345",
            agentId: "main:coder",
            homeAgentId: "main",
            sessionId: "session-1",
            runId: "run-1",
            parentRunId: null,
          },
        },
      }),
    });
    const fulfilled = fulfillHumanAction(db, {
      id: approval.id,
      responseText: "approve",
      respondedByChannel: "telegram",
      respondedByKey: "12345",
      nowMs: nowMs() + 1_000,
    });
    assert.equal(fulfilled.ok, true);

    const worker = startDeployApprovalWorker({
      db,
      stateDir,
      candidateRootDir,
      log: () => {},
    });
    assert.ok(worker, "worker should start");

    const processed = await worker.tick();
    worker.stop();

    assert.ok(processed >= 2, "expected reconcile + queue work to be processed");
    const trigger = JSON.parse(await fs.readFile(path.join(stateDir, "deploy-trigger.json"), "utf8")) as Record<string, unknown>;
    assert.equal(trigger.action, "apply");
    assert.equal(trigger.approvalId, approval.id);
    assert.equal(trigger.candidateId, candidate.candidateId);

    const request = getDeployRequest(db, { approvalId: approval.id });
    assert.equal(request?.status, "queued");
    assert.equal(request?.triggerId, trigger.id);

    const record = await loadCandidate(candidateRootDir, candidate.candidateId);
    assert.equal(record.status, "auto_deploying");
    assert.equal(record.approvalStatus, "approved");
  });
});
