import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyRoutingFieldEdit, editNexusConfigFile, editNexusConfigRoutingField } from "./config-editor.js";

function baseConfig(): Record<string, unknown> {
  return {
    llm: {
      openaiCompat: {
        baseUrl: "https://openrouter.ai/api/v1",
        model: "moonshotai/kimi-k2.5",
      },
      providers: {
        local: {
          baseUrl: "http://localhost:11434/v1",
          model: "local-model",
        },
      },
      routing: {
        default: { primary: { provider: "default" } },
        byPreset: {},
        byAgent: {},
        localProvider: "local",
      },
      toolRouting: {
        default: {},
        byPreset: {},
        byAgent: {},
      },
    },
  };
}

test("applyRoutingFieldEdit sets and resets orchestrator and preset routes", () => {
  const raw = baseConfig();
  applyRoutingFieldEdit({
    rawConfig: raw,
    target: { kind: "orchestrator" },
    field: "provider",
    action: "set",
    value: "openrouter",
  });
  applyRoutingFieldEdit({
    rawConfig: raw,
    target: { kind: "preset", preset: "coder" },
    field: "model",
    action: "set",
    value: "openai/gpt-5.3-codex",
  });

  const llm = raw.llm as Record<string, unknown>;
  const routing = llm.routing as Record<string, unknown>;
  const byPreset = routing.byPreset as Record<string, unknown>;
  const orchestratorRoute = byPreset.orchestrator as Record<string, unknown>;
  const coderRoute = byPreset.coder as Record<string, unknown>;
  assert.equal((orchestratorRoute.primary as Record<string, unknown>).provider, "openrouter");
  assert.equal((coderRoute.primary as Record<string, unknown>).model, "openai/gpt-5.3-codex");

  applyRoutingFieldEdit({
    rawConfig: raw,
    target: { kind: "orchestrator" },
    field: "provider",
    action: "reset",
  });
  assert.equal(orchestratorRoute.primary, undefined);
});

test("applyRoutingFieldEdit sets and resets tool routes", () => {
  const raw = baseConfig();
  applyRoutingFieldEdit({
    rawConfig: raw,
    target: { kind: "tool", tool: "image_generate" },
    field: "provider",
    action: "set",
    value: "openrouter",
  });
  applyRoutingFieldEdit({
    rawConfig: raw,
    target: { kind: "toolPreset", preset: "graphic-designer", tool: "image_generate" },
    field: "model",
    action: "set",
    value: "google/gemini-3.1-flash-image-preview",
  });

  const llm = raw.llm as Record<string, unknown>;
  const toolRouting = llm.toolRouting as Record<string, unknown>;
  const defaultMap = toolRouting.default as Record<string, unknown>;
  const byPreset = toolRouting.byPreset as Record<string, unknown>;
  assert.equal((defaultMap.image_generate as Record<string, unknown>).provider, "openrouter");
  assert.equal(
    ((byPreset["graphic-designer"] as Record<string, unknown>).image_generate as Record<string, unknown>).model,
    "google/gemini-3.1-flash-image-preview",
  );

  applyRoutingFieldEdit({
    rawConfig: raw,
    target: { kind: "tool", tool: "image_generate" },
    field: "provider",
    action: "reset",
  });
  assert.equal(defaultMap.image_generate, undefined);
});

test("applyRoutingFieldEdit rejects empty set values", () => {
  const raw = baseConfig();
  assert.throws(() =>
    applyRoutingFieldEdit({
      rawConfig: raw,
      target: { kind: "orchestrator" },
      field: "provider",
      action: "set",
      value: "   ",
    }),
  );
});

test("editNexusConfigFile persists edits and validates schema", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-editor-"));
  const configPath = path.join(tmpDir, "nexus.json");
  await fs.writeFile(configPath, `${JSON.stringify(baseConfig(), null, 2)}\n`, "utf8");

  try {
    const result = await editNexusConfigFile({
      configPath,
      mutate: (rawConfig) => {
        applyRoutingFieldEdit({
          rawConfig,
          target: { kind: "preset", preset: "coder" },
          field: "provider",
          action: "set",
          value: "default",
        });
      },
    });
    assert.equal(result.parsedConfig.llm.routing.byPreset.coder?.primary.provider, "default");

    const nextText = await fs.readFile(configPath, "utf8");
    const nextJson = JSON.parse(nextText) as Record<string, unknown>;
    const llm = nextJson.llm as Record<string, unknown>;
    const routing = llm.routing as Record<string, unknown>;
    const byPreset = routing.byPreset as Record<string, unknown>;
    const coderRoute = byPreset.coder as Record<string, unknown>;
    assert.equal((coderRoute.primary as Record<string, unknown>).provider, "default");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("editNexusConfigFile honors lock timeout", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-editor-lock-"));
  const configPath = path.join(tmpDir, "nexus.json");
  const lockPath = `${configPath}.lock`;
  await fs.writeFile(configPath, `${JSON.stringify(baseConfig(), null, 2)}\n`, "utf8");
  await fs.writeFile(lockPath, "locked\n", "utf8");

  try {
    await assert.rejects(
      () =>
        editNexusConfigFile({
          configPath,
          lockTimeoutMs: 120,
          lockPollMs: 30,
          mutate: () => {},
        }),
      /config lock timeout/,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("editNexusConfigFile does not fall back when mutateText fails", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-editor-no-fallback-"));
  const configPath = path.join(tmpDir, "nexus.json");
  await fs.writeFile(configPath, `${JSON.stringify(baseConfig(), null, 2)}\n`, "utf8");

  try {
    await assert.rejects(
      () =>
        editNexusConfigFile({
          configPath,
          mutate: (rawConfig) => {
            applyRoutingFieldEdit({
              rawConfig,
              target: { kind: "orchestrator" },
              field: "provider",
              action: "set",
              value: "default",
            });
          },
          mutateText: () => null,
        }),
      /text edit failed/,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("editNexusConfigRoutingField preserves unrelated comments", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-editor-comments-"));
  const configPath = path.join(tmpDir, "nexus.json");
  const text = `{
  // top comment
  "llm": {
    "openaiCompat": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "model": "moonshotai/kimi-k2.5"
    },
    "providers": {
      "local": {
        "baseUrl": "http://localhost:11434/v1",
        "model": "local-model"
      }
    },
    "routing": {
      "default": { "primary": { "provider": "default" } },
      "byPreset": {
        "orchestrator": {
          // keep this comment
          "primary": {
            "provider": "default"
          }
        }
      },
      "byAgent": {},
      "localProvider": "local"
    },
    "toolRouting": {
      "default": {},
      "byPreset": {},
      "byAgent": {}
    }
  }
}
`;
  await fs.writeFile(configPath, text, "utf8");

  try {
    await editNexusConfigRoutingField({
      configPath,
      target: { kind: "orchestrator" },
      field: "provider",
      action: "set",
      value: "local",
    });
    const next = await fs.readFile(configPath, "utf8");
    assert.match(next, /\/\/ top comment/);
    assert.match(next, /\/\/ keep this comment/);
    assert.match(next, /"provider": "local"/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
