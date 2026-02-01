import fs from "node:fs/promises";
import path from "node:path";

import JSON5 from "json5";
import { z } from "zod";

import { getDefaultConfigPath } from "./paths.js";

const EnvString = z.string().transform((val) => {
  return val.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name) => process.env[name] ?? match);
});

const TelegramChannelSchema = z
  .object({
    enabled: z.boolean().default(false),
    token: EnvString.optional(),
    mode: z.enum(["polling", "webhook"]).default("polling"),
    webhookUrl: EnvString.optional(),
    webhookPublicUrl: EnvString.optional(),
    webhookPath: z.string().default("/telegram-webhook"),
    webhookSecretToken: EnvString.optional(),
    allowFrom: z.array(z.number().int()).default([]),
    requireMentionInGroups: z.boolean().default(true),
    agentId: z.string().default("main"),
    pairing: z
      .object({
        enabled: z.boolean().default(true),
        codeTtlMs: z.number().int().positive().default(60 * 60 * 1000),
        maxPending: z.number().int().positive().default(3),
      })
      .default({}),
  })
  .default({});

const ProactiveSchema = z
  .object({
    enabled: z.boolean().default(false),
    agentId: z.string().default("main"),
    intervalMs: z.number().int().positive().default(15 * 60_000),
    maxIntervalMs: z.number().int().positive().default(60 * 60_000),
    jitterMs: z.number().int().min(0).default(5_000),
    notifyTelegram: z.boolean().default(true),
  })
  .default({});

const SchedulerSchema = z
  .object({
    enabled: z.boolean().default(true),
    tickIntervalMs: z.number().int().positive().default(15_000),
    maxRunsPerTick: z.number().int().positive().default(5),
    leaseTtlMs: z.number().int().positive().default(10 * 60_000),
    maxConsecutiveFailures: z.number().int().positive().default(5),
    notifyAgentOnFailure: z.boolean().default(true),
    notifyCooldownMs: z.number().int().min(0).default(5 * 60_000),
  })
  .default({});


const OpenAICompatProviderSchema = z
  .object({
    baseUrl: EnvString.default("https://openrouter.ai/api/v1"),
    apiKey: EnvString.optional(),
    model: z.string().default("moonshot/kimi-k2.5"),
  })
  .default({});

export const ConfigSchema = z.object({
  port: z.number().int().positive().default(18789),
  stateDir: EnvString.optional(),
  workspaceDir: EnvString.optional(),
  codeDir: EnvString.optional(),
  llm: z
    .object({
      openaiCompat: OpenAICompatProviderSchema,
    })
    .default({ openaiCompat: {} }),
  channels: z
    .object({
      telegram: TelegramChannelSchema,
    })
    .default({ telegram: {} }),
  proactive: ProactiveSchema,
  scheduler: SchedulerSchema,
  permissions: z
    .object({
      allowShellExec: z.boolean().default(false),
      allowCodeEdit: z.boolean().default(true),
    })
    .default({}),
  limits: z
    .object({
      maxConcurrentAgents: z.number().int().positive().default(5),
      maxToolCallsPerRun: z.number().int().positive().default(120),
      maxIterationsPerRun: z.number().int().positive().default(40),
      maxContextTokens: z.number().int().min(0).default(128_000),
    })
    .default({}),
});

export type NexusConfig = z.infer<typeof ConfigSchema>;

export async function loadConfig(configPath: string = getDefaultConfigPath()): Promise<NexusConfig> {
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = JSON5.parse(raw) as unknown;
  return ConfigSchema.parse(parsed);
}

export async function ensureConfigExists(configPath: string): Promise<void> {
  try {
    await fs.access(configPath);
    return;
  } catch {
    // fallthrough
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const defaultConfig: NexusConfig = ConfigSchema.parse({});
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        ...defaultConfig,
        channels: {
          telegram: {
            enabled: false,
            token: "${TELEGRAM_BOT_TOKEN}",
            mode: "polling",
            webhookUrl: "${NEXUS_TELEGRAM_WEBHOOK_URL}",
            webhookPublicUrl: "${NEXUS_TELEGRAM_WEBHOOK_PUBLIC_URL}",
            webhookPath: "/telegram-webhook",
            webhookSecretToken: "${NEXUS_TELEGRAM_WEBHOOK_SECRET}",
            allowFrom: [],
            requireMentionInGroups: true,
            agentId: "main",
            pairing: {
              enabled: true,
              codeTtlMs: 3600000,
              maxPending: 3
            }
          },
        },
        llm: {
          openaiCompat: {
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "${OPENROUTER_API_KEY}",
            model: "openai/gpt-4o-mini",
          },
        },
        permissions: {
          allowShellExec: false,
          allowCodeEdit: true,
        },
        proactive: {
          enabled: false,
          agentId: "main",
          intervalMs: 900000,
          maxIntervalMs: 3600000,
          jitterMs: 5000,
          notifyTelegram: true,
        },
        scheduler: {
          enabled: true,
          tickIntervalMs: 15000,
          maxRunsPerTick: 5,
          leaseTtlMs: 600000,
          maxConsecutiveFailures: 5,
          notifyAgentOnFailure: true,
          notifyCooldownMs: 300000,
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}
