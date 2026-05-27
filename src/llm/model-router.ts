import type { NexusConfig } from "../state/config.js";
import type { AgentPreset } from "../core/presets.js";
import {
  OpenAICompatClient,
  type LLMClient,
  type LLMCompleteChatParams,
  type OpenAICompatConfig,
} from "./openai-compat.js";
import { CodexResponsesClient } from "./codex-responses.js";
import { SlotCacheManager } from "./slot-cache.js";

export type ModelRoutingMode = "default" | "local_only";

export type SerializableSlotCacheConfig = {
  enabled: boolean;
  slotCount: number;
  requestTimeoutMs?: number;
};

export type SerializableOpenAICompatConfig = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  maxTokens?: number;
  stream?: boolean;
  stripCacheControl?: boolean;
  slotCache?: SerializableSlotCacheConfig;
};

type LlmRouteTarget = {
  provider: string;
  model?: string;
};

type LlmRouteDefinition = {
  primary: LlmRouteTarget;
  fallback?: LlmRouteTarget;
};

export type ResolvedModelRoute = {
  mode: ModelRoutingMode;
  source: string;
  primaryProvider: string;
  primary: OpenAICompatConfig;
};

/** Dynamically resolves credentials for a provider (e.g. OAuth token refresh). */
export type ProviderCredentialResolver = () => Promise<{ baseUrl: string; apiKey: string }>;

export type ModelRouterConfig = {
  defaultProvider: SerializableOpenAICompatConfig;
  providers?: Record<string, SerializableOpenAICompatConfig>;
  routing: NexusConfig["llm"]["routing"];
  credentialResolvers?: Record<string, ProviderCredentialResolver>;
  /** Providers that use the Responses API instead of chat/completions. */
  responsesApiProviders?: string[];
};

export class ModelRouter {
  private readonly providers: Record<string, OpenAICompatConfig>;
  private readonly credentialResolvers: Record<string, ProviderCredentialResolver>;
  private readonly responsesApiProviders: Set<string>;
  private routing: NexusConfig["llm"]["routing"];
  /** Slot-cache managers per provider name. One manager per opted-in provider
   *  so all calls to the same provider share allocator state (LRU, in-flight
   *  lock map, owner table). */
  private readonly slotCaches = new Map<string, SlotCacheManager>();

  constructor(private readonly opts: ModelRouterConfig) {
    const sourceProviders: Record<string, SerializableOpenAICompatConfig> = {
      default: opts.defaultProvider,
      ...(opts.providers ?? {}),
    };
    // Instantiate one slot cache manager per provider that opted in. This must
    // happen before we materialize this.providers so each runtime config can
    // carry a reference to its shared manager.
    for (const [name, cfg] of Object.entries(sourceProviders)) {
      const slot = cfg.slotCache;
      if (slot && slot.enabled && slot.slotCount > 0 && cfg.baseUrl && cfg.baseUrl !== "dynamic") {
        this.slotCaches.set(
          name,
          new SlotCacheManager({
            baseUrl: cfg.baseUrl,
            apiKey: cfg.apiKey,
            slotCount: slot.slotCount,
            requestTimeoutMs: slot.requestTimeoutMs,
          }),
        );
      }
    }
    this.providers = {};
    for (const [name, cfg] of Object.entries(sourceProviders)) {
      this.providers[name] = toRuntimeConfig(cfg, this.slotCaches.get(name));
    }
    this.credentialResolvers = { ...(opts.credentialResolvers ?? {}) };
    this.responsesApiProviders = new Set(opts.responsesApiProviders ?? []);
    // Auto-register stub providers for credential resolvers without explicit config.
    // The resolver will override baseUrl/apiKey at request time.
    for (const name of Object.keys(this.credentialResolvers)) {
      if (!this.providers[name]) {
        this.providers[name] = { baseUrl: "dynamic", model: "gpt-5.3-codex" };
      }
    }
    this.routing = cloneRouting(opts.routing);
  }

  /** Save every live slot cache to disk. Call from shutdown handlers if you
   *  want explicit flushes beyond the default eviction-only policy. */
  async flushSlotCaches(): Promise<void> {
    await Promise.allSettled([...this.slotCaches.values()].map((m) => m.flushAll()));
  }

  resolve(params: {
    agentId: string;
    preset?: string;
    mode?: ModelRoutingMode;
    presetLlm?: AgentPreset["llm"];
  }): ResolvedModelRoute {
    const mode = params.mode ?? "default";
    let route: LlmRouteDefinition = this.routing.default;
    let source = "routing.default";

    const presetRoute = params.preset ? this.routing.byPreset[params.preset] : undefined;
    if (presetRoute) {
      route = presetRoute;
      source = `routing.byPreset.${params.preset}`;
    }

    if (params.presetLlm) {
      route = applyPresetLlmOverride(route, params.presetLlm);
      source = params.preset ? `preset.${params.preset}.llm` : "preset.llm";
    }

    const agentRoute = this.routing.byAgent[params.agentId];
    if (agentRoute) {
      route = agentRoute;
      source = `routing.byAgent.${params.agentId}`;
    }

    if (mode === "local_only") {
      const localProvider = this.routing.localProvider;
      const localPrimary =
        route.primary.provider === localProvider
          ? route.primary
          : {
              provider: localProvider,
            };
      route = {
        primary: localPrimary,
      };
      source += " (local_only)";
    }

    const primary = this.resolveTarget(route.primary);

    return {
      mode,
      source,
      primaryProvider: primary.provider,
      primary: primary.config,
    };
  }

  createClient(
    route: ResolvedModelRoute,
    opts?: {
      onLog?: (line: string) => void;
    },
  ): LLMClient {
    const resolver = this.credentialResolvers[route.primaryProvider];
    if (resolver) {
      const useResponses = this.responsesApiProviders.has(route.primaryProvider);
      return new DynamicCredentialClient(route.primary, resolver, opts?.onLog, useResponses);
    }
    return new OpenAICompatClient({ ...route.primary, onLog: opts?.onLog });
  }

  exportConfig(): ModelRouterConfig {
    const providers: Record<string, SerializableOpenAICompatConfig> = {};
    for (const [name, cfg] of Object.entries(this.providers)) {
      if (name === "default") continue;
      providers[name] = sanitizeConfig(cfg);
    }
    return {
      defaultProvider: sanitizeConfig(this.providers.default),
      providers,
      routing: cloneRouting(this.routing),
    };
  }

  updateRouting(routing: NexusConfig["llm"]["routing"]): void {
    this.routing = cloneRouting(routing);
  }

  listProviderNames(): string[] {
    return Object.keys(this.providers).sort();
  }

  private resolveTarget(target: LlmRouteTarget): { provider: string; config: OpenAICompatConfig } {
    const provider = target.provider;
    const base = this.providers[provider];
    if (!base) {
      const known = Object.keys(this.providers).sort().join(", ");
      throw new Error(`Unknown LLM provider "${provider}" in model routing config. Known providers: ${known}`);
    }
    return {
      provider,
      config: {
        ...base,
        model: target.model ?? base.model,
      },
    };
  }
}

/**
 * LLMClient wrapper that resolves dynamic credentials (e.g. OAuth token refresh)
 * before each request, then delegates to a fresh OpenAICompatClient.
 */
class DynamicCredentialClient implements LLMClient {
  constructor(
    private readonly baseConfig: OpenAICompatConfig,
    private readonly resolver: ProviderCredentialResolver,
    private readonly onLog?: (line: string) => void,
    private readonly useResponsesApi?: boolean,
  ) {}

  async completeChat(params: LLMCompleteChatParams) {
    const creds = await this.resolver();
    if (this.useResponsesApi) {
      const client = new CodexResponsesClient({
        baseUrl: creds.baseUrl,
        apiKey: creds.apiKey,
        model: this.baseConfig.model,
        onLog: this.onLog,
      });
      return client.completeChat(params);
    }
    const client = new OpenAICompatClient({
      ...this.baseConfig,
      baseUrl: creds.baseUrl,
      apiKey: creds.apiKey,
      onLog: this.onLog,
    });
    return client.completeChat(params);
  }
}

function cloneRouting(routing: NexusConfig["llm"]["routing"]): NexusConfig["llm"]["routing"] {
  return JSON.parse(JSON.stringify(routing)) as NexusConfig["llm"]["routing"];
}

function sanitizeConfig(cfg: OpenAICompatConfig): SerializableOpenAICompatConfig {
  return toSerializableConfig(cfg);
}

/** Convert a runtime OpenAICompatConfig (may contain a live SlotCacheManager
 *  instance) to a JSON-safe form for IPC payloads. */
export function toSerializableConfig(cfg: OpenAICompatConfig): SerializableOpenAICompatConfig {
  return {
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    maxTokens: cfg.maxTokens,
    stream: cfg.stream,
    stripCacheControl: cfg.stripCacheControl,
  };
}

/** Convert a JSON-safe config into a runtime config, optionally attaching a
 *  pre-constructed SlotCacheManager (e.g. the one held by the parent
 *  ModelRouter). Workers without manager access pass undefined. */
export function toRuntimeConfig(cfg: SerializableOpenAICompatConfig, slotCache: SlotCacheManager | undefined): OpenAICompatConfig {
  return {
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    maxTokens: cfg.maxTokens,
    stream: cfg.stream,
    stripCacheControl: cfg.stripCacheControl,
    ...(slotCache ? { slotCache } : {}),
  };
}

function applyPresetLlmOverride(base: LlmRouteDefinition, preset: AgentPreset["llm"]): LlmRouteDefinition {
  if (!preset) return base;
  let next: LlmRouteDefinition = {
    primary: {
      provider: base.primary.provider,
      model: base.primary.model,
    },
    fallback: base.fallback
      ? {
          provider: base.fallback.provider,
          model: base.fallback.model,
        }
      : undefined,
  };

  if (preset.primary) {
    next = {
      ...next,
      primary: {
        provider: preset.primary.provider ?? next.primary.provider,
        model: preset.primary.model ?? next.primary.model,
      },
    };
  }

  if (Object.prototype.hasOwnProperty.call(preset, "fallback")) {
    if (preset.fallback === null) {
      next = {
        ...next,
        fallback: undefined,
      };
    } else if (preset.fallback) {
      const existingFallback = next.fallback ?? { provider: next.primary.provider };
      next = {
        ...next,
        fallback: {
          provider: preset.fallback.provider ?? existingFallback.provider,
          model: preset.fallback.model ?? existingFallback.model,
        },
      };
    }
  }

  return next;
}
