import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildDeployApprovalMetadata,
  formatDeployApprovalFulfillmentMessage,
  syncCandidateForDeployApproval,
} from "./deploy-approval.js";
import { createCandidate, loadCandidate } from "../state/candidates.js";

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

test("syncCandidateForDeployApproval updates candidate state immediately on rejection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-deploy-approval-test-"));
  try {
    const liveCodeDir = await createLiveRepo(root);
    const candidateRootDir = path.join(root, "candidates");
    const candidate = await createCandidate({
      liveCodeDir,
      candidateRootDir,
      candidateId: "cand-approval-sync",
      nowMs: 100,
    });

    const metadata = buildDeployApprovalMetadata({
      policy: "approval_required",
      changeFingerprint: "fingerprint-123",
      candidate: {
        candidateId: candidate.candidateId,
        baseSha: candidate.baseSha,
      },
    });

    await syncCandidateForDeployApproval({
      candidateRootDir,
      approvalId: "HA123",
      metadataJson: JSON.stringify(metadata),
      status: "fulfilled",
      responseText: "reject",
      nowMs: 200,
    });

    const record = await loadCandidate(candidateRootDir, candidate.candidateId);
    assert.equal(record.status, "rejected");
    assert.equal(record.approvalStatus, "rejected");
    assert.equal(record.approvalId, "HA123");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("formatDeployApprovalFulfillmentMessage clarifies that approval does not auto-deploy", () => {
  const text = formatDeployApprovalFulfillmentMessage({
    approvalId: "HA123",
    responseText: "approve",
  });
  assert.match(text, /does not deploy by itself/i);
  assert.match(text, /approvalId='HA123'/i);
});
