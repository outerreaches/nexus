import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveRuntimePaths } from "./paths.js";

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (typeof value === "undefined") delete process.env[key];
    else process.env[key] = value;
  }
}

test("resolveRuntimePaths derives liveCodeDir and candidateRootDir defaults", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-paths-test-"));
  const snapshot = {
    NEXUS_LIVE_CODE_DIR: process.env.NEXUS_LIVE_CODE_DIR,
    NEXUS_CODE_DIR: process.env.NEXUS_CODE_DIR,
    NEXUS_CANDIDATE_ROOT_DIR: process.env.NEXUS_CANDIDATE_ROOT_DIR,
    NEXUS_WORKSPACE_DIR: process.env.NEXUS_WORKSPACE_DIR,
  };

  delete process.env.NEXUS_LIVE_CODE_DIR;
  delete process.env.NEXUS_CODE_DIR;
  delete process.env.NEXUS_CANDIDATE_ROOT_DIR;
  delete process.env.NEXUS_WORKSPACE_DIR;

  try {
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const codeDir = path.join(root, "code");
    const paths = await resolveRuntimePaths({ stateDir, workspaceDir, codeDir });

    assert.equal(paths.stateDir, path.resolve(stateDir));
    assert.equal(paths.workspaceDir, path.resolve(workspaceDir));
    assert.equal(paths.codeDir, path.resolve(codeDir));
    assert.equal(paths.liveCodeDir, path.resolve(codeDir));
    assert.equal(paths.candidateRootDir, path.resolve(path.join(stateDir, "candidates")));
    assert.equal(paths.dbPath, path.join(path.resolve(stateDir), "nexus.db"));
  } finally {
    restoreEnv(snapshot);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("resolveRuntimePaths honors liveCodeDir and candidateRootDir environment references", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-paths-env-test-"));
  const snapshot = {
    NEXUS_LIVE_CODE_DIR: process.env.NEXUS_LIVE_CODE_DIR,
    NEXUS_CODE_DIR: process.env.NEXUS_CODE_DIR,
    NEXUS_CANDIDATE_ROOT_DIR: process.env.NEXUS_CANDIDATE_ROOT_DIR,
  };

  process.env.NEXUS_LIVE_CODE_DIR = path.join(root, "env-live");
  process.env.NEXUS_CANDIDATE_ROOT_DIR = path.join(root, "env-candidates");
  delete process.env.NEXUS_CODE_DIR;

  try {
    const paths = await resolveRuntimePaths({
      stateDir: path.join(root, "state"),
      liveCodeDir: "${NEXUS_LIVE_CODE_DIR}",
      candidateRootDir: "${NEXUS_CANDIDATE_ROOT_DIR}",
    });

    assert.equal(paths.codeDir, path.resolve(process.env.NEXUS_LIVE_CODE_DIR!));
    assert.equal(paths.liveCodeDir, path.resolve(process.env.NEXUS_LIVE_CODE_DIR!));
    assert.equal(paths.candidateRootDir, path.resolve(process.env.NEXUS_CANDIDATE_ROOT_DIR!));
  } finally {
    restoreEnv(snapshot);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("resolveRuntimePaths prefers explicit liveCodeDir over legacy codeDir", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-paths-live-test-"));
  try {
    const paths = await resolveRuntimePaths({
      stateDir: path.join(root, "state"),
      codeDir: path.join(root, "legacy-code"),
      liveCodeDir: path.join(root, "live-code"),
    });

    assert.equal(paths.codeDir, path.resolve(path.join(root, "live-code")));
    assert.equal(paths.liveCodeDir, path.resolve(path.join(root, "live-code")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
