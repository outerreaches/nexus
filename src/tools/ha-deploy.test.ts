import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { ToolContext } from "../core/tools.js";
import { buildDeployApprovalMetadata } from "../core/deploy-approval.js";
import { inspectDeployWorktree } from "../core/deploy-policy.js";
import { createCandidate, loadCandidate } from "../state/candidates.js";
import { openDatabase, type NexusDatabase } from "../storage/database.js";
import { setHomeSession } from "../storage/sessions.js";
import { fulfillHumanAction, listHumanActions } from "../storage/human-actions.js";
import { getRunReportById } from "../storage/run-reports.js";
import { continueApprovedDeployAfterApproval, haDeploy } from "./ha-deploy.js";

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
        name: "nexus-ha-deploy-test",
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

async function configureOfflineInstallableVerificationRepo(repoDir: string): Promise<void> {
  await writeFile(
    repoDir,
    "vendor/bootstrap-ok/package.json",
    JSON.stringify(
      {
        name: "bootstrap-ok",
        version: "1.0.0",
        private: true,
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(repoDir, "vendor/bootstrap-ok/typecheck.js", "process.exit(0);\n");
  await writeFile(repoDir, "vendor/bootstrap-ok/build.js", "process.exit(0);\n");
  await writeFile(
    repoDir,
    "package.json",
    JSON.stringify(
      {
        name: "nexus-ha-deploy-test",
        private: true,
        dependencies: {
          "bootstrap-ok": "file:vendor/bootstrap-ok",
        },
        scripts: {
          typecheck: "node node_modules/bootstrap-ok/typecheck.js",
          build: "node node_modules/bootstrap-ok/build.js",
        },
      },
      null,
      2,
    ) + "\n",
  );
  await execFileAsync("npm", ["install", "--package-lock-only"], {
    cwd: repoDir,
    encoding: "utf8",
    timeout: 60_000,
  });
  await fs.rm(path.join(repoDir, "node_modules"), { recursive: true, force: true });
  await git(["add", "."], repoDir);
  await git(["commit", "-m", "offline deps"], repoDir);
}

function latestRunReportId(db: NexusDatabase): string | null {
  const row = db.db
    .prepare("SELECT id FROM run_reports ORDER BY created_at DESC LIMIT 1")
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

function createContext(params: {
  db: NexusDatabase;
  repoDir: string;
  stateDir: string;
  nowMs: () => number;
  telegram?: ToolContext["telegram"];
  agentId?: string;
  homeAgentId?: string;
}): ToolContext {
  return {
    db: params.db,
    workspaceDir: params.stateDir,
    stateDir: params.stateDir,
    codeDir: params.repoDir,
    liveCodeDir: params.repoDir,
    request: {
      channel: "cli",
      channelKey: "local",
      agentId: params.agentId ?? "agent:test",
      homeAgentId: params.homeAgentId ?? params.agentId ?? "agent:test",
      preset: "coder",
      sessionId: "session-1",
      runId: "run-1",
      parentRunId: undefined,
      modelMode: "default",
    },
    telegram: params.telegram,
    nowMs: params.nowMs,
    log: () => undefined,
  };
}

async function withRepoAndDb(
  fn: (params: {
    db: NexusDatabase;
    repoDir: string;
    stateDir: string;
    nowMs: () => number;
    setNowMs: (next: number) => void;
  }) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-ha-deploy-test-"));
  const stateDir = path.join(root, "state");
  const dbPath = path.join(root, "nexus.db");
  await fs.mkdir(stateDir, { recursive: true });
  const db = await openDatabase(dbPath);
  let currentTime = 1_700_000_000_000;
  try {
    const repoDir = await createRepo(root);
    await fn({
      db,
      repoDir,
      stateDir,
      nowMs: () => currentTime,
      setNowMs: (next) => {
        currentTime = next;
      },
    });
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("ha_deploy creates a human approval request for approval-gated changes", async () => {
  await withRepoAndDb(async ({ db, repoDir, stateDir, nowMs }) => {
    await writeFile(repoDir, "src/tools/example.ts", "export const example = 1;\n");

    const result = await haDeploy.execute(
      {
        action: "apply",
        remote: "host",
        branch: "main",
        timeoutMs: 1_000,
      },
      createContext({ db, repoDir, stateDir, nowMs }),
    );

    assert.match(result, /APPROVAL REQUIRED/);
    assert.match(result, /There is no dashboard approval UI/i);
    const pending = listHumanActions(db, {
      nowMs: nowMs(),
      status: "pending",
      sessionId: "session-1",
    });
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.kind, "confirm");
    const metadata = JSON.parse(pending[0]?.metadataJson ?? "{}") as Record<string, unknown>;
    assert.equal(metadata.kind, "ha_deploy_approval");
    assert.equal(metadata.policy, "approval_required");
  });
});

test("ha_deploy queues a home-channel notification when creating an approval request", async () => {
  await withRepoAndDb(async ({ db, repoDir, stateDir, nowMs }) => {
    await writeFile(repoDir, "src/tools/example.ts", "export const example = 1;\n");
    setHomeSession({
      db,
      agentId: "agent:test",
      channel: "telegram",
      channelKey: "12345",
      nowMs: nowMs(),
    });

    const result = await haDeploy.execute(
      {
        action: "apply",
        remote: "host",
        branch: "main",
        timeoutMs: 1_000,
      },
      createContext({ db, repoDir, stateDir, nowMs }),
    );

    assert.match(result, /Operator notification: queued for home-channel delivery/i);
    const reportId = latestRunReportId(db);
    assert.ok(reportId, "expected a queued run report");
    const report = getRunReportById(db, reportId!);
    assert.equal(report?.kind, "deploy_approval");
    assert.equal(report?.targetChannel, "home_channel");
    assert.equal(report?.targetAgentId, "agent:test");
    assert.match(report?.body ?? "", /Deploy approval required/i);
    assert.match(report?.body ?? "", /\/act HA[A-Z0-9]+ approve/i);
  });
});

test("ha_deploy targets the home agent when invoked from a worker agent", async () => {
  await withRepoAndDb(async ({ db, repoDir, stateDir, nowMs }) => {
    await writeFile(repoDir, "src/tools/example.ts", "export const example = 1;\n");
    setHomeSession({
      db,
      agentId: "main",
      channel: "telegram",
      channelKey: "12345",
      nowMs: nowMs(),
    });

    const result = await haDeploy.execute(
      {
        action: "apply",
        remote: "host",
        branch: "main",
        timeoutMs: 1_000,
      },
      createContext({
        db,
        repoDir,
        stateDir,
        nowMs,
        agentId: "main:coder",
        homeAgentId: "main",
      }),
    );

    assert.match(result, /Operator notification: queued for home-channel delivery/i);
    const reportId = latestRunReportId(db);
    assert.ok(reportId, "expected a queued run report");
    const report = getRunReportById(db, reportId!);
    assert.equal(report?.targetChannel, "home_channel");
    assert.equal(report?.targetAgentId, "main");
    assert.equal(report?.sourceAgentId, "main:coder");
  });
});

test("ha_deploy creates a fresh approval request when the first apply call supplies a bogus approvalId", async () => {
  await withRepoAndDb(async ({ db, repoDir, stateDir, nowMs }) => {
    await writeFile(repoDir, "src/tools/example.ts", "export const example = 1;\n");

    const result = await haDeploy.execute(
      {
        action: "apply",
        approvalId: "core-cosmetic-change-2026",
        remote: "host",
        branch: "main",
        timeoutMs: 1_000,
      },
      createContext({ db, repoDir, stateDir, nowMs }),
    );

    assert.match(result, /APPROVAL REQUIRED/);
    assert.match(result, /Provided approvalId 'core-cosmetic-change-2026' was not found/i);
    const pending = listHumanActions(db, {
      nowMs: nowMs(),
      status: "pending",
      sessionId: "session-1",
    });
    assert.equal(pending.length, 1);
  });
});

test("ha_deploy rejects stale approval ids after the candidate changes", async () => {
  await withRepoAndDb(async ({ db, repoDir, stateDir, nowMs, setNowMs }) => {
    await writeFile(repoDir, "src/tools/example.ts", "export const example = 1;\n");

    await haDeploy.execute(
      {
        action: "apply",
        remote: "host",
        branch: "main",
        timeoutMs: 1_000,
      },
      createContext({ db, repoDir, stateDir, nowMs }),
    );

    const pending = listHumanActions(db, {
      nowMs: nowMs(),
      status: "pending",
      sessionId: "session-1",
    });
    assert.equal(pending.length, 1);
    const approvalId = pending[0]!.id;

    setNowMs(nowMs() + 1_000);
    const fulfilled = fulfillHumanAction(db, {
      id: approvalId,
      responseText: "approve",
      respondedByChannel: "cli",
      respondedByKey: "local",
      nowMs: nowMs(),
    });
    assert.equal(fulfilled.ok, true);

    await writeFile(repoDir, "src/core/example.ts", "export const example = true;\n");

    const result = await haDeploy.execute(
      {
        action: "apply",
        approvalId,
        remote: "host",
        branch: "main",
        timeoutMs: 1_000,
      },
      createContext({ db, repoDir, stateDir, nowMs }),
    );

    assert.match(result, /no longer matches the current code changes/i);
  });
});

test("ha_deploy records candidate approval state for approval-gated candidates", async () => {
  await withRepoAndDb(async ({ db, repoDir, stateDir, nowMs, setNowMs }) => {
    const candidateRootDir = path.join(stateDir, "candidates");
    const candidate = await createCandidate({
      liveCodeDir: repoDir,
      candidateRootDir,
      candidateId: "cand-approval",
      nowMs: nowMs(),
    });
    await writeFile(candidate.repoDir, "src/tools/example.ts", "export const example = 1;\n");

    const baseContext = createContext({ db, repoDir: candidate.repoDir, stateDir, nowMs });
    const result = await haDeploy.execute(
      {
        action: "apply",
        remote: "host",
        branch: "main",
        timeoutMs: 1_000,
      },
      {
        ...baseContext,
        liveCodeDir: repoDir,
        candidateRootDir,
        candidate: {
          candidateId: candidate.candidateId,
          baseSha: candidate.baseSha,
          repoDir: candidate.repoDir,
        },
      },
    );

    assert.match(result, /APPROVAL REQUIRED/);
    const pending = listHumanActions(db, {
      nowMs: nowMs(),
      status: "pending",
      sessionId: "session-1",
    });
    assert.equal(pending.length, 1);
    const record = await loadCandidate(candidateRootDir, candidate.candidateId);
    assert.equal(record.status, "pending_approval");
    assert.equal(record.classification, "approval_required");
    assert.equal(record.approvalId, pending[0]?.id ?? null);

    setNowMs(nowMs() + 1_000);
    const denied = fulfillHumanAction(db, {
      id: pending[0]!.id,
      responseText: "reject",
      respondedByChannel: "cli",
      respondedByKey: "local",
      nowMs: nowMs(),
    });
    assert.equal(denied.ok, true);

    const deniedResult = await haDeploy.execute(
      {
        action: "apply",
        approvalId: pending[0]!.id,
        remote: "host",
        branch: "main",
        timeoutMs: 1_000,
      },
      {
        ...baseContext,
        liveCodeDir: repoDir,
        candidateRootDir,
        candidate: {
          candidateId: candidate.candidateId,
          baseSha: candidate.baseSha,
          repoDir: candidate.repoDir,
        },
      },
    );

    assert.match(deniedResult, /was denied/i);
    const rejected = await loadCandidate(candidateRootDir, candidate.candidateId);
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.approvalStatus, "rejected");
  });
});

test("ha_deploy blocks deploy when verification fails", async () => {
  await withRepoAndDb(async ({ db, repoDir, stateDir, nowMs }) => {
    await writeFile(
      repoDir,
      "package.json",
      JSON.stringify(
        {
          name: "nexus-ha-deploy-test",
          private: true,
          scripts: {
            typecheck: "node -e \"process.exit(1)\"",
            build: "node -e \"process.exit(0)\"",
          },
        },
        null,
        2,
      ) + "\n",
    );
    await writeFile(repoDir, "src/tools/example.ts", "export const example = 1;\n");

    const result = await haDeploy.execute(
      {
        action: "apply",
        remote: "host",
        branch: "main",
        timeoutMs: 1_000,
      },
      createContext({ db, repoDir, stateDir, nowMs }),
    );

    assert.match(result, /verification failed during typecheck/i);
    const pending = listHumanActions(db, {
      nowMs: nowMs(),
      status: "pending",
      sessionId: "session-1",
    });
    assert.equal(pending.length, 0);
  });
});

test("ha_deploy bootstraps candidate dependencies before verification", async () => {
  await withRepoAndDb(async ({ db, repoDir, stateDir, nowMs }) => {
    await configureOfflineInstallableVerificationRepo(repoDir);
    await writeFile(repoDir, "src/tools/example.ts", "export const example = 1;\n");

    const result = await haDeploy.execute(
      {
        action: "apply",
        remote: "host",
        branch: "main",
        timeoutMs: 1_000,
      },
      createContext({ db, repoDir, stateDir, nowMs }),
    );

    assert.match(result, /APPROVAL REQUIRED/);
    const installedModule = path.join(repoDir, "node_modules", "bootstrap-ok", "typecheck.js");
    await fs.access(installedModule);
  });
});

test("continueApprovedDeployAfterApproval queues the deploy trigger automatically", async () => {
  await withRepoAndDb(async ({ repoDir, stateDir, nowMs }) => {
    const candidateRootDir = path.join(stateDir, "candidates");
    const candidate = await createCandidate({
      liveCodeDir: repoDir,
      candidateRootDir,
      candidateId: "cand-auto-continue",
      nowMs: nowMs(),
    });
    await writeFile(candidate.repoDir, "src/tools/example.ts", "export const example = 1;\n");
    const changes = inspectDeployWorktree(candidate.repoDir);

    const metadata = buildDeployApprovalMetadata({
      policy: "approval_required",
      changeFingerprint: changes.fingerprint,
      candidate: {
        candidateId: candidate.candidateId,
        baseSha: candidate.baseSha,
      },
      continuation: {
        commitMessage: "test auto continuation",
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
    });

    const result = await continueApprovedDeployAfterApproval({
      approvalId: "HATEST",
      metadataJson: JSON.stringify(metadata),
      stateDir,
      candidateRootDir,
      nowMs: nowMs(),
      log: () => undefined,
    });

    assert.equal(result.ok, true);
    assert.match(result.message, /Automatic deploy continuation has been queued/i);
    const trigger = JSON.parse(await fs.readFile(path.join(stateDir, "deploy-trigger.json"), "utf8")) as Record<string, unknown>;
    assert.equal(trigger.action, "apply");
    assert.equal(trigger.candidateId, candidate.candidateId);
    assert.equal(trigger.sourceCodeDir, candidate.repoDir);
  });
});
