import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ModelRouter } from "../llm/model-router.js";
import { ConfigSchema, type NexusConfig } from "../state/config.js";
import { executeModelSettingsCommand } from "./model-settings-command-handler.js";
import { parseModelSettingsCommandText } from "./model-settings-command.js";

function baseConfig(): NexusConfig {
  return ConfigSchema.parse({
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
  });
}

test("executeModelSettingsCommand defaults /provider <provider> to orchestrator target", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-model-settings-handler-"));
  const configPath = path.join(tmpDir, "nexus.json");
  const config = baseConfig();
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const modelRouter = new ModelRouter({
    defaultProvider: config.llm.openaiCompat,
    providers: config.llm.providers,
    routing: config.llm.routing,
  });

  try {
    const parsed = parseModelSettingsCommandText("/provider local");
    assert.ok(parsed);
    assert.equal(parsed.kind, "provider");

    const text = await executeModelSettingsCommand({
      command: parsed,
      deps: {
        configPath,
        config,
        modelRouter,
        listTools: () => [{ name: "image_generate" }, { name: "shell_exec" }],
      },
    });
    assert.match(text, /orchestrator/);

    const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      llm?: { routing?: { byPreset?: { orchestrator?: { primary?: { provider?: string } } } } };
    };
    assert.equal(saved.llm?.routing?.byPreset?.orchestrator?.primary?.provider, "local");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("executeModelSettingsCommand rejects unknown provider", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-model-settings-invalid-provider-"));
  const configPath = path.join(tmpDir, "nexus.json");
  const config = baseConfig();
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  try {
    const parsed = parseModelSettingsCommandText("/provider not-a-provider");
    assert.ok(parsed);
    assert.equal(parsed.kind, "provider");

    const text = await executeModelSettingsCommand({
      command: parsed,
      deps: {
        configPath,
        config,
        listTools: () => [{ name: "image_generate" }],
      },
    });
    assert.match(text, /unknown provider/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("executeModelSettingsCommand rejects unknown preset and tool targets", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-model-settings-invalid-target-"));
  const configPath = path.join(tmpDir, "nexus.json");
  const config = baseConfig();
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  try {
    const unknownPreset = parseModelSettingsCommandText("/model preset:missing gpt-4o");
    assert.ok(unknownPreset);
    assert.equal(unknownPreset.kind, "model");
    const presetText = await executeModelSettingsCommand({
      command: unknownPreset,
      deps: {
        configPath,
        config,
        listTools: () => [{ name: "image_generate" }],
      },
    });
    assert.match(presetText, /unknown preset/);

    const unknownTool = parseModelSettingsCommandText("/provider tool:not_real default");
    assert.ok(unknownTool);
    assert.equal(unknownTool.kind, "provider");
    const toolText = await executeModelSettingsCommand({
      command: unknownTool,
      deps: {
        configPath,
        config,
        listTools: () => [{ name: "image_generate" }],
      },
    });
    assert.match(toolText, /unknown tool/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
