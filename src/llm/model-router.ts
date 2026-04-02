import type { NexusConfig } from "../state/config.js";
import type { AgentPreset } from "../core/presets.js";
import {
  OpenAICompatClient,
  type LLMClient,
  type LLMCompleteChatParams,
  type OpenAICompatConfig,
} from "./openai-compat.js";

export type ModelRoutingMode = "default" | "local_only";

export type SerializableOpenAICompatConfig = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  maxTokens?: number;
  stream?: boolean;
  stripCacheControl?: boolean;
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
};

export class ModelRouter {
  private readonly providers: Record<string, OpenAICompatConfig>;
  private readonly credentialResolvers: Record<string, ProviderCredentialResolver>;
  private routing: NexusConfig["llm"]["routing"];

  constructor(private readonly opts: ModelRouterConfig) {
    this.providers = {
      default: opts.defaultProvider,
      ...(opts.providers ?? {}),
    };
    this.credentialResolvers = { ...(opts.credentialResolvers ?? {}) };
    // Auto-register stub providers for credential resolvers without explicit config.
    // The resolver will override baseUrl/apiKey at request time.
    for (const name of Object.keys(this.credentialResolvers)) {
      if (!this.providers[name]) {
        this.providers[name] = { baseUrl: "dynamic", model: "gpt-5.3-codex" };
      }
    }
    this.routing = cloneRouting(opts.routing);
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
      return new DynamicCredentialClient(route.primary, resolver, opts?.onLog);
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
  ) {}

  async completeChat(params: LLMCompleteChatParams) {
    const creds = await this.resolver();
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
  return {
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    maxTokens: cfg.maxTokens,
    stream: cfg.stream,
    stripCacheControl: cfg.stripCacheControl,
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
