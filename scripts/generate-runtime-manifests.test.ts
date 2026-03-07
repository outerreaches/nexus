import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateRuntimeManifests } from "./generate-runtime-manifests.js";

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
}

test("generateRuntimeManifests emits deterministic intake and runtime tool manifests", async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-generate-runtime-manifests-"));
  try {
    await writeFile(
      repoRoot,
      "src/data-intake/types.ts",
      "export type DataSource = { id: string; name: string; description: string; tags: string[]; schemaVersion: number; defaultTtlMs: number; fetch: (...args: unknown[]) => Promise<unknown>; normalize: (...args: unknown[]) => unknown; };\n",
    );
    await writeFile(
      repoRoot,
      "src/core/tools.ts",
      "export type Tool = { name: string; description: string; jsonSchema: Record<string, unknown>; execute: (...args: unknown[]) => Promise<string>; };\n",
    );
    await writeFile(
      repoRoot,
      "src/data-intake/sources/weather-custom.ts",
      [
        'export const weatherCustomSource = {',
        '  id: "weather.custom",',
        '  name: "Weather Custom",',
        '  description: "Weather intake",',
        '  tags: ["weather"],',
        '  schemaVersion: 1,',
        '  defaultTtlMs: 60000,',
        '  async fetch() { return {}; },',
        '  normalize() { return []; },',
        '};',
        "",
      ].join("\n"),
    );
    await writeFile(
      repoRoot,
      "src/tools/runtime/example.ts",
      [
        'export const exampleRuntimeTool = {',
        '  name: "example_runtime_tool",',
        '  description: "Example runtime tool",',
        '  jsonSchema: { type: "object", properties: {} },',
        '  async execute() { return "ok"; },',
        '};',
        "",
      ].join("\n"),
    );

    const firstPass = await generateRuntimeManifests(repoRoot);
    assert.deepEqual(firstPass.changed.sort(), [
      "src/data-intake/generated-sources.ts",
      "src/tools/generated-runtime-tools.ts",
    ]);
    assert.deepEqual(firstPass.files.generatedSources, ["src/data-intake/sources/weather-custom.ts"]);
    assert.deepEqual(firstPass.files.generatedRuntimeTools, ["src/tools/runtime/example.ts"]);

    const generatedSources = await fs.readFile(path.join(repoRoot, "src/data-intake/generated-sources.ts"), "utf8");
    assert.match(generatedSources, /sources\/weather-custom\.js/);
    assert.match(generatedSources, /GENERATED_DATA_SOURCE_MANIFEST/);
    assert.match(generatedSources, /sourceId: source\.id/);

    const generatedRuntimeTools = await fs.readFile(path.join(repoRoot, "src/tools/generated-runtime-tools.ts"), "utf8");
    assert.match(generatedRuntimeTools, /runtime\/example\.js/);
    assert.match(generatedRuntimeTools, /GENERATED_RUNTIME_TOOL_MANIFEST/);
    assert.match(generatedRuntimeTools, /toolName: tool\.name/);

    const secondPass = await generateRuntimeManifests(repoRoot);
    assert.deepEqual(secondPass.changed, []);
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
});
