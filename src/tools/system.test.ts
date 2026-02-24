import assert from "node:assert/strict";
import test from "node:test";

import { isMutatingGitOnCodeDir } from "./system.js";

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
