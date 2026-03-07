import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

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
    "src/data-intake/sources/weather.ts",
    'export const weatherSource = { id: "weather.default", name: "Weather", description: "Weather", tags: ["weather"], schemaVersion: 1, defaultTtlMs: 60000, async fetch() { return {}; }, normalize() { return []; } };\n',
  );
  await writeFile(
    repoDir,
    "src/data-intake/generated-sources.ts",
    'export const GENERATED_DATA_SOURCES = [{ id: "weather.default", name: "Weather" }];\n',
  );
  await writeFile(repoDir, "src/tools/index.ts", "export const tools = [];\n");
  await writeFile(repoDir, "src/core/bootstrap.ts", "export const bootstrap = true;\n");
  await git(["add", "."], repoDir);
  await git(["commit", "-m", "seed"], repoDir);
  return repoDir;
}

test("inspectDeployWorktree classifies intake-only changes for auto deploy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-deploy-policy-intake-"));
  try {
    const repoDir = await createRepo(root);
    await writeFile(
      repoDir,
      "src/data-intake/sources/weather-custom.ts",
      'export const weatherCustomSource = { id: "weather.custom", name: "Weather Custom" };\n',
    );
    await writeFile(
      repoDir,
      "src/data-intake/generated-sources.ts",
      "export const GENERATED_DATA_SOURCES = [{ id: 'weather.custom', name: 'Weather Custom' }];\n",
    );

    const inspection = inspectDeployWorktree(repoDir);

    assert.equal(inspection.policy, "intake_auto_deploy");
    assert.deepEqual(inspection.approvalRequired, []);
    assert.deepEqual(
      inspection.deployable.sort(),
      ["src/data-intake/generated-sources.ts", "src/data-intake/sources/weather-custom.ts"],
    );
    assert.ok(inspection.fingerprint);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("inspectDeployWorktree requires approval when changes touch tool or core paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-deploy-policy-approval-"));
  try {
    const repoDir = await createRepo(root);
    await writeFile(repoDir, "src/tools/example.ts", "export const example = 1;\n");
    await writeFile(
      repoDir,
      "src/data-intake/sources/weather-custom.ts",
      'export const weatherCustomSource = { id: "weather.custom", name: "Weather Custom" };\n',
    );

    const inspection = inspectDeployWorktree(repoDir);

    assert.equal(inspection.policy, "approval_required");
    assert.deepEqual(inspection.approvalRequired, ["src/tools/example.ts"]);
    assert.deepEqual(inspection.intakeDeployable, ["src/data-intake/sources/weather-custom.ts"]);
    assert.ok(inspection.fingerprint);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("inspectDeployWorktree skips deploy when only doc changes exist", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-deploy-policy-docs-"));
  try {
    const repoDir = await createRepo(root);
    await writeFile(repoDir, "README.md", "changed\n");

    const inspection = inspectDeployWorktree(repoDir);

    assert.equal(inspection.policy, "none");
    assert.deepEqual(inspection.deployable, []);
    assert.deepEqual(inspection.skipped, ["README.md"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("inspectDeployWorktree requires approval when an intake source_id changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-deploy-policy-source-id-"));
  try {
    const repoDir = await createRepo(root);
    await writeFile(
      repoDir,
      "src/data-intake/sources/weather-custom.ts",
      'export const weatherCustomSource = { id: "weather.custom", name: "Weather Custom" };\n',
    );
    await git(["add", "src/data-intake/sources/weather-custom.ts"], repoDir);
    await git(["commit", "-m", "add weather custom"], repoDir);

    await writeFile(
      repoDir,
      "src/data-intake/sources/weather-custom.ts",
      'export const weatherCustomSource = { id: "weather.custom-v2", name: "Weather Custom" };\n',
    );

    const inspection = inspectDeployWorktree(repoDir);

    assert.equal(inspection.policy, "approval_required");
    assert.match(inspection.intakeCompatibilityIssues.join("\n"), /source\.id changed/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("inspectDeployWorktree requires approval when only the generated intake manifest changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-deploy-policy-registry-only-"));
  try {
    const repoDir = await createRepo(root);
    await writeFile(
      repoDir,
      "src/data-intake/generated-sources.ts",
      "export const GENERATED_DATA_SOURCES = [{ id: 'weather.custom', name: 'Weather Custom' }];\n",
    );

    const inspection = inspectDeployWorktree(repoDir);

    assert.equal(inspection.policy, "approval_required");
    assert.match(inspection.intakeCompatibilityIssues.join("\n"), /generated intake manifest changed/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
