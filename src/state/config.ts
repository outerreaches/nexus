import fs from "node:fs/promises";
import path from "node:path";

import JSON5 from "json5";
import { z } from "zod";

import { getDefaultConfigPath } from "./paths.js";

const EnvString = z.string().transform((val) => {
  return val.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name) => process.env[name] ?? match);
});

const TelegramStreamingSchema = z
  .object({
    enabled: z.boolean().default(true),
    serializePerChat: z.boolean().default(true),
    maxConcurrentPerChat: z.number().int().positive().max(8).default(1),
    previewTransport: z.enum(["auto", "message", "draft"]).default("message"),
    previewThrottleMs: z.number().int().min(200).max(5000).default(650),
    fallbackToSendOutput: z.boolean().default(true),
    emitFallbackNotice: z.boolean().default(true),
  })
  .default({});

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
    streaming: TelegramStreamingSchema,
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
    pauseOnActiveTelegram: z.boolean().default(true),
    activeTelegramQuietMs: z.number().int().min(0).default(45_000),
  })
  .default({});

const SchedulerSchema = z
  .object({
    enabled: z.boolean().default(true),
    tickIntervalMs: z.number().int().positive().default(15_000),
    maxRunsPerTick: z.number().int().positive().default(5),
    concurrency: z.number().int().positive().default(5),
    leaseTtlMs: z.number().int().positive().default(10 * 60_000),
    maxConsecutiveFailures: z.number().int().positive().default(5),
    notifyAgentOnFailure: z.boolean().default(true),
    notifyCooldownMs: z.number().int().min(0).default(5 * 60_000),
    contextMode: z.enum(["full", "delta", "none"]).default("delta"),
  })
  .default({});

const NudgesSchema = z
  .object({
    enabled: z.boolean().default(true),
    channels: z.array(z.string().min(1)).default(["cli", "telegram"]),
    memoryTurnInterval: z.number().int().min(0).default(10),
    skillIterationInterval: z.number().int().min(0).default(20),
  })
  .default({});

const SkillsPromptSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxInlineSkills: z.number().int().min(0).max(20).default(5),
    includeReferences: z.boolean().default(true),
    maxReferencesPerSkill: z.number().int().min(0).max(10).default(2),
    maxReferenceChars: z.number().int().min(200).max(8_000).default(1_600),
  })
  .default({});

const SkillsSchema = z
  .object({
    enabled: z.boolean().default(true),
    prompt: SkillsPromptSchema,
  })
  .default({});

const MaintenanceSchema = z
  .object({
    enabled: z.boolean().default(true),
    archiveRetentionDays: z.number().int().min(30).max(365).default(180),
    jobRunRetentionDays: z.number().int().min(7).max(180).default(60),
    ttlCleanupEnabled: z.boolean().default(true),
  })
  .default({});

const RuntimeProfileSchema = z.enum([
  "standard",
  "primary",
  "standby",
  "monetization",
  "service_custom",
  "portable",
  "execution_node_host",
]);

const RuntimeSchema = z
  .object({
    profile: RuntimeProfileSchema.default("primary"),
  })
  .default({});

const FederationTrustStateSchema = z.enum(["pending", "trusted", "revoked", "quarantined"]);

const FederationPeerSchema = z.object({
  id: z.string().min(1),
  endpoint: EnvString.pipe(z.string().url()),
  signingKey: EnvString.pipe(z.string().min(1)),
  trustState: FederationTrustStateSchema.default("pending"),
  mtlsRequired: z.boolean().default(true),
  enabled: z.boolean().default(true),
  createdAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
});

const FederationTransportSchema = z
  .object({
    adapter: z.enum(["federation_http"]).default("federation_http"),
    webhookFirst: z.boolean().default(true),
    pollingFallbackEnabled: z.boolean().default(true),
    requireMtls: z.boolean().default(true),
    allowInsecureSignedOnlyDev: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (!value.requireMtls && !value.allowInsecureSignedOnlyDev) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requireMtls"],
        message: "requireMtls=false requires explicit allowInsecureSignedOnlyDev=true override",
      });
    }
  })
  .default({});

const FederationWebhookSchema = z
  .object({
    federatedOnly: z.boolean().default(true),
    externalEnabled: z.boolean().default(false),
    allowInsecureHttpDev: z.boolean().default(false),
  })
  .default({});

const FederationOutboxSchema = z
  .object({
    enabled: z.boolean().default(false),
    intervalMs: z.number().int().positive().default(5_000),
    maxBatch: z.number().int().positive().default(20),
    requestTimeoutMs: z.number().int().positive().default(10_000),
  })
  .default({});

const FederationSchema = z
  .object({
    enabled: z.boolean().default(false),
    localInstanceId: z.string().min(1).default("local"),
    transport: FederationTransportSchema,
    webhooks: FederationWebhookSchema,
    outbox: FederationOutboxSchema,
    peers: z.array(FederationPeerSchema).default([]),
  })
  .default({});

const OpenAICompatProviderSchema = z
  .object({
    baseUrl: EnvString.default("https://openrouter.ai/api/v1"),
    apiKey: EnvString.optional(),
    model: EnvString.default("moonshotai/kimi-k2.5"),
    maxTokens: z.number().int().positive().optional().describe("Max output tokens per LLM call. Defaults to 16384 if omitted."),
    stream: z.boolean().optional().describe("When true, force streaming chat-completions transport for this provider."),
    stripCacheControl: z.boolean().default(false).describe("Strip cache_control fields from messages. Required for providers that reject extra fields (e.g. Fireworks)."),
  })
  .default({});

const LlmRouteTargetSchema = z
  .object({
    provider: z.string().min(1).default("default"),
    model: EnvString.optional(),
  })
  .default({ provider: "default" });

const LlmRouteSchema = z
  .object({
    primary: LlmRouteTargetSchema.default({ provider: "default" }),
    fallback: LlmRouteTargetSchema.optional(),
  })
  .default({ primary: { provider: "default" } });

const LlmRoutingSchema = z
  .object({
    default: LlmRouteSchema.default({ primary: { provider: "default" } }),
    byPreset: z.record(LlmRouteSchema).default({}),
    byAgent: z.record(LlmRouteSchema).default({}),
    localProvider: z.string().min(1).default("local"),
  })
  .default({});

const LlmToolRouteTargetSchema = z
  .object({
    provider: z.string().min(1).optional().describe("Tool-specific provider name (for tools that support provider routing)."),
    model: EnvString.optional().describe("Tool-specific model override."),
    endpoint: EnvString.optional().describe("Optional API endpoint override for direct-provider tools."),
    providerOrder: z.array(z.string().min(1)).optional().describe("Optional provider ordering hint (tool-specific)."),
  })
  .default({});

const LlmToolRoutingSchema = z
  .object({
    default: z.record(LlmToolRouteTargetSchema).default({}),
    byPreset: z.record(z.record(LlmToolRouteTargetSchema)).default({}),
    byAgent: z.record(z.record(LlmToolRouteTargetSchema)).default({}),
  })
  .default({});

const SecretsSchema = z
  .object({
    /** Map env var names to {{secret:provider/path#field}} references or plain values. */
    env: z.record(z.string()).default({}),
  })
  .default({});

export const ConfigSchema = z.object({
  port: z.number().int().positive().default(18789),
  stateDir: EnvString.optional(),
  workspaceDir: EnvString.optional(),
  codeDir: EnvString.optional(),
  liveCodeDir: EnvString.optional(),
  candidateRootDir: EnvString.optional(),
  runtime: RuntimeSchema,
  federation: FederationSchema,
  secrets: SecretsSchema,
  llm: z
    .object({
      openaiCompat: OpenAICompatProviderSchema,
      providers: z.record(OpenAICompatProviderSchema).default({}),
      routing: LlmRoutingSchema,
      toolRouting: LlmToolRoutingSchema,
      /** Max retries for transient LLM errors (429, 5xx, network). Default 5. */
      transientRetries: z.number().int().min(0).max(20).default(5),
    })
    .default({ openaiCompat: {}, providers: {}, routing: {}, toolRouting: {} }),
  channels: z
    .object({
      telegram: TelegramChannelSchema,
    })
    .default({ telegram: {} }),
  proactive: ProactiveSchema,
  scheduler: SchedulerSchema,
  nudges: NudgesSchema,
  skills: SkillsSchema,
  maintenance: MaintenanceSchema,
  permissions: z
    .object({
      allowShellExec: z.boolean().default(false),
      allowCodeEdit: z.boolean().default(true),
      allowCodeWrite: z.boolean().default(false),
    })
    .default({}),
  limits: z
    .object({
      maxConcurrentAgents: z.number().int().positive().default(5),
      maxToolCallsPerRun: z.number().int().positive().default(140),
      maxIterationsPerRun: z.number().int().positive().default(80),
      maxContextTokens: z.number().int().min(0).default(128_000),
    })
    .default({}),
});

export type NexusConfig = z.infer<typeof ConfigSchema>;
export type LlmToolRouting = z.infer<typeof LlmToolRoutingSchema>;
export type LlmToolRouteTarget = z.infer<typeof LlmToolRouteTargetSchema>;
export type SkillsConfig = z.infer<typeof SkillsSchema>;

export function buildBootstrapConfigTemplate(): Record<string, unknown> {
  return {
    port: 18789,
    secrets: {
      env: {},
    },
    runtime: {
      profile: "primary",
    },
    llm: {
      openaiCompat: {
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "${OPENROUTER_API_KEY}",
        model: "moonshotai/kimi-k2.5",
        stream: true,
      },
      providers: {
        local: {
          baseUrl: "${NEXUS_LOCAL_LLM_BASE_URL}",
          apiKey: "${NEXUS_LOCAL_LLM_API_KEY}",
          model: "${NEXUS_LOCAL_LLM_MODEL}",
        },
        baseten: {
          baseUrl: "https://inference.baseten.co/v1",
          apiKey: "${BASETEN_API_KEY}",
          model: "moonshotai/Kimi-K2.5",
        },
        openrouter: {
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "${OPENROUTER_API_KEY}",
          model: "moonshotai/kimi-k2.5",
        },
        codex: {
          baseUrl: "https://chatgpt.com/backend-api/codex",
          model: "gpt-5.3-codex",
        },
      },
      routing: {
        default: {
          primary: { provider: "default" },
          fallback: { provider: "local" },
        },
        byPreset: {
          "security-researcher": { primary: { provider: "openrouter", model: "openai/gpt-5.3-codex" }, fallback: { provider: "local" } },
          "intake-manager": { primary: { provider: "openrouter", model: "minimax/minimax-m2.5" }, fallback: { provider: "local" } },
          coder: { primary: { provider: "openrouter", model: "openai/gpt-5.3-codex" }, fallback: { provider: "local" } },
          trader: { primary: { provider: "openrouter", model: "minimax/minimax-m2.5" }, fallback: { provider: "local" } },
          analyst: { primary: { provider: "openrouter", model: "google/gemini-3.1-pro-preview" }, fallback: { provider: "local" } },
          "graphic-designer": { primary: { provider: "openrouter", model: "minimax/minimax-m2.5" }, fallback: { provider: "local" } },
        },
        byAgent: {},
        localProvider: "local",
      },
      toolRouting: {
        default: {
          image_generate: { provider: "openrouter", model: "google/gemini-3.1-flash-image-preview" },
          image_edit: { provider: "openrouter", model: "google/gemini-3.1-flash-image-preview" },
          video_analyze: { provider: "openrouter", model: "google/gemini-2.5-flash-lite" },
          generate_svg: { provider: "quiver", model: "arrow-preview" },
          vectorize: { provider: "quiver", model: "arrow-preview" },
        },
        byPreset: {
          "graphic-designer": {
            image_generate: { provider: "openrouter", model: "google/gemini-3-pro-image-preview" },
            image_edit: { provider: "openrouter", model: "google/gemini-3-pro-image-preview" },
            generate_svg: { provider: "quiver", model: "arrow-preview" },
            vectorize: { provider: "quiver", model: "arrow-preview" },
          },
        },
        byAgent: {},
      },
      transientRetries: 5,
    },
    channels: {
      telegram: {
        enabled: true,
        token: "${TELEGRAM_BOT_TOKEN}",
        mode: "polling",
        allowFrom: [],
        requireMentionInGroups: true,
        agentId: "main",
        streaming: {
          enabled: true,
          serializePerChat: true,
          maxConcurrentPerChat: 1,
          previewTransport: "message",
          previewThrottleMs: 650,
          fallbackToSendOutput: true,
          emitFallbackNotice: true,
        },
        pairing: {
          enabled: true,
          codeTtlMs: 3600000,
          maxPending: 3,
        },
      },
    },
    proactive: {
      enabled: true,
      agentId: "main",
      intervalMs: 900000,
      maxIntervalMs: 3600000,
      jitterMs: 5000,
      notifyTelegram: true,
      pauseOnActiveTelegram: true,
      activeTelegramQuietMs: 120000,
    },
    scheduler: {
      enabled: true,
      tickIntervalMs: 15000,
      maxRunsPerTick: 5,
      concurrency: 5,
      leaseTtlMs: 600000,
      maxConsecutiveFailures: 5,
      notifyAgentOnFailure: true,
      notifyCooldownMs: 300000,
      contextMode: "delta",
    },
    nudges: {
      enabled: true,
      channels: ["cli", "telegram"],
      memoryTurnInterval: 10,
      skillIterationInterval: 20,
    },
    skills: {
      enabled: true,
      prompt: {
        enabled: true,
        maxInlineSkills: 5,
        includeReferences: true,
        maxReferencesPerSkill: 2,
        maxReferenceChars: 1600,
      },
    },
    maintenance: {
      enabled: true,
      archiveRetentionDays: 180,
      jobRunRetentionDays: 60,
      ttlCleanupEnabled: true,
    },
    permissions: {
      allowShellExec: true,
      allowCodeEdit: true,
      allowCodeWrite: true,
    },
    limits: {
      maxConcurrentAgents: 5,
      maxToolCallsPerRun: 200,
      maxIterationsPerRun: 100,
      maxContextTokens: 128000,
    },
    federation: {
      enabled: true,
      localInstanceId: "local",
    },
  };
}

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
  await fs.writeFile(
    configPath,
    JSON.stringify(buildBootstrapConfigTemplate(), null, 2) + "\n",
    "utf8",
  );
}
