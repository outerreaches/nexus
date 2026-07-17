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
    previewTransport: z.literal("message").default("message"),
    previewThrottleMs: z.number().int().min(200).max(5000).default(2500),
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
    // Explicit escape hatch for running webhook mode without a secret token
    // (e.g. behind a reverse proxy that authenticates the path). Without a
    // secret, anyone who can reach the HTTP port can forge Telegram updates.
    webhookAllowInsecure: z.boolean().default(false),
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

const GateActionSchema = z.enum(["allow", "ask", "deny"]);

const GateMatcherSchema = z
  .object({
    arg: z.string().min(1).max(200),
    prefix: z.array(z.string().min(1)).optional(),
    equals: z.array(z.string()).optional(),
    regex: z
      .string()
      .min(1)
      .max(500)
      .superRefine((value, ctx) => {
        try {
          new RegExp(value);
        } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid regex: ${value}` });
        }
      })
      .optional(),
  })
  .refine((m) => Boolean(m.prefix?.length || m.equals?.length || m.regex), {
    message: "matcher needs at least one of prefix/equals/regex",
  });

const GateRuleSchema = z.object({
  id: z.string().min(1).max(100),
  tools: z.array(z.string().min(1)).min(1),
  match: z.array(GateMatcherSchema).optional(),
  agents: z.array(z.string().min(1)).optional(),
  presets: z.array(z.string().min(1)).optional(),
  channels: z.array(z.string().min(1)).optional(),
  unattended: z.boolean().optional(),
  action: GateActionSchema,
});

/** Tool gate (see internal-doc). `default` is the fallback when no rule
 *  or built-in default matches; `unattended` controls how `ask` resolves for
 *  runs without a live human (deny now, queue once the approval flow ships —
 *  pre-approval is an allow rule scoped `unattended: true`). */
const ToolGateSchema = z
  .object({
    default: GateActionSchema.default("allow"),
    unattended: z.enum(["deny", "queue"]).default("deny"),
    rules: z.array(GateRuleSchema).default([]),
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

const SlotCacheConfigSchema = z
  .object({
    enabled: z.boolean().default(false).describe("Enable llama.cpp slot save/restore for this provider. Requires the server to be started with --slot-save-path."),
    slotCount: z.number().int().min(1).max(64).describe("Server slot count (must match the llama.cpp server's -np flag)."),
    requestTimeoutMs: z.number().int().min(1_000).max(600_000).default(60_000).describe("Per-call HTTP timeout for slot save/restore/erase admin endpoints."),
    endpointBaseUrl: EnvString.optional().describe("Optional override for the slot endpoint root. Defaults to the provider's baseUrl with its path stripped (correct for raw llama-server, where /slots/{N} lives at the server root, not under /v1). Set this when the server is behind a reverse proxy with a path prefix."),
  })
  .optional()
  .describe("Optional llama.cpp slot cache config. Routes calls through a logical-key → physical-slot allocator with save+restore on eviction.");

const OpenAICompatProviderSchema = z
  .object({
    baseUrl: EnvString.default("https://openrouter.ai/api/v1"),
    apiKey: EnvString.optional(),
    model: EnvString.default("moonshotai/kimi-k2.5"),
    maxTokens: z.number().int().positive().optional().describe("Max output tokens per LLM call. Defaults to 16384 if omitted."),
    stream: z.boolean().optional().describe("When true, force streaming chat-completions transport for this provider."),
    stripCacheControl: z.boolean().default(false).describe("Strip cache_control fields from messages. Required for providers that reject extra fields (e.g. Fireworks)."),
    slotCache: SlotCacheConfigSchema,
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
      gate: ToolGateSchema,
    })
    .default({}),
  limits: z
    .object({
      maxConcurrentAgents: z.number().int().positive().default(5),
      maxToolCallsPerRun: z.number().int().positive().default(200),
      maxIterationsPerRun: z.number().int().positive().default(100),
      // Default is set well below typical llama.cpp 131_072 / OpenRouter 200K
      // context sizes so the compaction trigger has real headroom against
      // estimator drift. Operators with larger context targets should raise
      // this via NEXUS_MAX_CONTEXT_TOKENS or nexus.json.
      maxContextTokens: z.number().int().min(0).default(110_000),
    })
    .default({}),
  // Per-preset overrides. `kernelExtra` promotes additional preset tools into
  // the always-loaded kernel so they skip the `tool_load` discovery round-trip.
  // Only tools already in the preset's `tools` pool are honored; unknown names
  // are ignored. Useful on large-context deployments where extra tool-schema
  // tokens are cheap relative to the per-turn latency saved.
  presets: z
    .record(
      z.string(),
      z
        .object({
          kernelExtra: z.array(z.string()).default([]),
        })
        .default({}),
    )
    .default({}),
});

export type NexusConfig = z.infer<typeof ConfigSchema>;
export type ToolGateConfigFromSchema = z.infer<typeof ToolGateSchema>;
export type LlmToolRouting = z.infer<typeof LlmToolRoutingSchema>;
export type LlmToolRouteTarget = z.infer<typeof LlmToolRouteTargetSchema>;
export type SkillsConfig = z.infer<typeof SkillsSchema>;

export function buildBootstrapConfigTemplate(): Record<string, unknown> {
  return {
    port: 18789,
    secrets: {
      env: {
        OPENROUTER_API_KEY: "{{secret:sidecar-main/llm.openrouter.api#password}}",
        FIREWORKS_API_KEY: "{{secret:sidecar-main/llm.fireworks.api#password}}",
        BASETEN_API_KEY: "{{secret:sidecar-main/llm.baseten.k2.5.api#password}}",
        BRAVE_API_KEY: "{{secret:sidecar-main/search.brave.api#password}}",
        FIRECRAWL_API_KEY: "{{secret:sidecar-main/search.firecrawl.api#password}}",
        PERPLEXITY_API_KEY: "{{secret:sidecar-main/search.perplexity.api#password}}",
        QUIVER_SVG_API_KEY: "{{secret:sidecar-main/quiver.svg.api#password}}",
        TELEGRAM_BOT_TOKEN: "{{secret:sidecar-main/telegram.bot.token#password}}",
        GOOGLE_CLIENT_ID: "{{secret:sidecar-main/google.oauth#username}}",
        GOOGLE_CLIENT_SECRET: "{{secret:sidecar-main/google.oauth#password}}",
        ALPHAVANTAGE_API_KEY: "{{secret:sidecar-main/data.alphavantage.api#password}}",
        MARKETSTACK_API_KEY: "{{secret:sidecar-main/data.marketstack.api#password}}",
        TWELVEDATA_API_KEY: "{{secret:sidecar-main/data.twelvedata.api#password}}",
        COINLAYER_API_KEY: "{{secret:sidecar-main/data.coinlayer.api#password}}",
        CRYPTOCOMPARE_API_KEY: "{{secret:sidecar-main/data.cryptocompare.api#password}}",
        OPEN_METALS_API_KEY: "{{secret:sidecar-main/data.openmetals.api#password}}",
        AUTH_TOKEN: "{{secret:sidecar-main/twitter.auth.auth_token#password}}",
        CT0: "{{secret:sidecar-main/twitter.auth.ct0#password}}",
      },
    },
    runtime: {
      profile: "primary",
    },
    llm: {
      openaiCompat: {
        baseUrl: "https://api.fireworks.ai/inference/v1",
        apiKey: "${FIREWORKS_API_KEY}",
        model: "accounts/fireworks/models/kimi-k2p6",
        stream: true,
        stripCacheControl: true,
      },
      providers: {
        local: {
          baseUrl: "${NEXUS_LOCAL_LLM_BASE_URL}",
          apiKey: "${NEXUS_LOCAL_LLM_API_KEY}",
          model: "${NEXUS_LOCAL_LLM_MODEL}",
        },
        fireworks: {
          baseUrl: "https://api.fireworks.ai/inference/v1",
          apiKey: "${FIREWORKS_API_KEY}",
          model: "accounts/fireworks/models/kimi-k2p6",
          stream: true,
          stripCacheControl: true,
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
          previewThrottleMs: 2500,
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
