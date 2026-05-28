import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fileEdit, fileList, filePatch, fileRead } from "./file-ops.js";

type TestCtx = {
  stateDir: string;
  workspaceDir: string;
  codeDir: string;
  candidateRootDir: string;
  allowCodeEdit: boolean;
  allowCodeWrite: boolean;
  request?: {
    preset?: string;
  };
  nowMs: () => number;
  log: (msg: string) => void;
};

async function withToolCtx(fn: (ctx: TestCtx) => Promise<void> | void): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-file-ops-test-"));
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(root, "workspace");
  const codeDir = path.join(root, "code");
  const candidateRootDir = path.join(stateDir, "candidates");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(codeDir, { recursive: true });
  await fs.mkdir(candidateRootDir, { recursive: true });

  const ctx: TestCtx = {
    stateDir,
    workspaceDir,
    codeDir,
    candidateRootDir,
    allowCodeEdit: true,
    allowCodeWrite: true,
    nowMs: () => Date.now(),
    log: () => { },
  };

  try {
    await fn(ctx);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("file_read search mode returns matches with context", async () => {
  await withToolCtx(async (ctx) => {
    const filePath = path.join(ctx.codeDir, "sample.ts");
    await fs.writeFile(
      filePath,
      [
        "import { a } from './a';",
        "const one = 1;",
        "const needle = one + 1;",
        "const two = 2;",
        "function needleFn() { return needle; }",
      ].join("\n"),
      "utf8",
    );

    const result = await fileRead.execute(
      {
        path: filePath,
        search: "needle",
        contextLines: 1,
        maxMatches: 10,
      },
      ctx as any,
    );

    assert.match(result, /Search matches: 2/);
    assert.match(result, /> 3: const needle = one \+ 1;/);
    assert.match(result, /> 5: function needleFn\(\) \{ return needle; \}/);
  });
});

test("file_list supports filterGlob and excludeGlob", async () => {
  await withToolCtx(async (ctx) => {
    await fs.mkdir(path.join(ctx.codeDir, "src"), { recursive: true });
    await fs.mkdir(path.join(ctx.codeDir, "tests"), { recursive: true });
    await fs.writeFile(path.join(ctx.codeDir, "src", "main.ts"), "export const x = 1;\n", "utf8");
    await fs.writeFile(path.join(ctx.codeDir, "src", "main.test.ts"), "test('x',()=>{});\n", "utf8");
    await fs.writeFile(path.join(ctx.codeDir, "README.md"), "# demo\n", "utf8");

    const result = await fileList.execute(
      {
        path: ctx.codeDir,
        recursive: true,
        filterGlob: "**/*.ts",
        excludeGlob: "**/*.test.ts",
        maxEntries: 100,
      },
      ctx as any,
    );

    assert.match(result, /src\/main\.ts/);
    assert.doesNotMatch(result, /main\.test\.ts/);
    assert.doesNotMatch(result, /README\.md/);
  });
});

test("file_edit can target a specific occurrence", async () => {
  await withToolCtx(async (ctx) => {
    const filePath = path.join(ctx.codeDir, "dup.txt");
    await fs.writeFile(filePath, "alpha\nalpha\nalpha\n", "utf8");

    const result = await fileEdit.execute(
      {
        path: filePath,
        find: "alpha",
        replace: "beta",
        occurrence: 2,
      },
      ctx as any,
    );

    assert.match(result, /occurrence 2\/3/);
    const updated = await fs.readFile(filePath, "utf8");
    assert.equal(updated, "alpha\nbeta\nalpha\n");
  });
});

test("file_patch applies a simple unified diff", async () => {
  await withToolCtx(async (ctx) => {
    const filePath = path.join(ctx.codeDir, "patch.txt");
    await fs.writeFile(filePath, "before\n", "utf8");

    const patch = [
      "--- patch.txt",
      "+++ patch.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");

    const result = await filePatch.execute(
      {
        rootPath: ctx.codeDir,
        patch,
        strip: 0,
        checkOnly: false,
      },
      ctx as any,
    );

    assert.match(result, /^OK: patch applied/);
    const updated = await fs.readFile(filePath, "utf8");
    assert.equal(updated, "after\n");
  });
});

test("orchestrator cannot edit repository code directly", async () => {
  await withToolCtx(async (ctx) => {
    const filePath = path.join(ctx.codeDir, "blocked.ts");
    await fs.writeFile(filePath, "export const value = 1;\n", "utf8");

    const result = await fileEdit.execute(
      {
        path: filePath,
        find: "1",
        replace: "2",
      },
      {
        ...ctx,
        request: { preset: "orchestrator" },
      } as any,
    );

    assert.match(result, /orchestrator/i);
    assert.match(result, /must not edit repository code directly/i);
    const unchanged = await fs.readFile(filePath, "utf8");
    assert.equal(unchanged, "export const value = 1;\n");
  });
});

test("orchestrator cannot edit code inside a candidate workspace", async () => {
  await withToolCtx(async (ctx) => {
    // Candidate repo lives under <stateDir>/candidates — an allowed root for
    // ordinary state writes, so the policy must catch source paths there too.
    const candidateSrc = path.join(ctx.candidateRootDir, "cand-1", "repo", "src");
    await fs.mkdir(candidateSrc, { recursive: true });
    const filePath = path.join(candidateSrc, "blocked.ts");
    await fs.writeFile(filePath, "export const value = 1;\n", "utf8");

    const result = await fileEdit.execute(
      { path: filePath, find: "1", replace: "2" },
      { ...ctx, request: { preset: "orchestrator" } } as any,
    );

    assert.match(result, /must not edit repository code directly/i);
    const unchanged = await fs.readFile(filePath, "utf8");
    assert.equal(unchanged, "export const value = 1;\n");
  });
});

test("coder can edit code inside its candidate workspace", async () => {
  await withToolCtx(async (ctx) => {
    const candidateSrc = path.join(ctx.candidateRootDir, "cand-1", "repo", "src");
    await fs.mkdir(candidateSrc, { recursive: true });
    const filePath = path.join(candidateSrc, "ok.ts");
    await fs.writeFile(filePath, "export const value = 1;\n", "utf8");

    const result = await fileEdit.execute(
      { path: filePath, find: "1", replace: "2" },
      { ...ctx, request: { preset: "coder" } } as any,
    );

    assert.doesNotMatch(result, /must not edit repository code directly/i);
    const updated = await fs.readFile(filePath, "utf8");
    assert.equal(updated, "export const value = 2;\n");
  });
});
