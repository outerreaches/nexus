import type { NexusConfig } from "../state/config.js";
import type { AgentPreset } from "../core/presets.js";
import {
  OpenAICompatClient,
  type LLMClient,
  type LLMCompleteChatParams,
  type OpenAICompatConfig,
} from "./openai-compat.js";

export type ModelRoutingMode = "default" | "local_only";

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
  fallbackProvider?: string;
  fallback?: OpenAICompatConfig;
};

type RouterOptions = {
  defaultProvider: OpenAICompatConfig;
  providers?: Record<string, OpenAICompatConfig>;
  routing: NexusConfig["llm"]["routing"];
};

export class ModelRouter {
  private readonly providers: Record<string, OpenAICompatConfig>;

  constructor(private readonly opts: RouterOptions) {
    this.providers = {
      default: opts.defaultProvider,
      ...(opts.providers ?? {}),
    };
  }

  resolve(params: {
    agentId: string;
    preset?: string;
    mode?: ModelRoutingMode;
    presetLlm?: AgentPreset["llm"];
  }): ResolvedModelRoute {
    const mode = params.mode ?? "default";
    let route: LlmRouteDefinition = this.opts.routing.default;
    let source = "routing.default";

    const presetRoute = params.preset ? this.opts.routing.byPreset[params.preset] : undefined;
    if (presetRoute) {
      route = presetRoute;
      source = `routing.byPreset.${params.preset}`;
    }

    if (params.presetLlm) {
      route = applyPresetLlmOverride(route, params.presetLlm);
      source = params.preset ? `preset.${params.preset}.llm` : "preset.llm";
    }

    const agentRoute = this.opts.routing.byAgent[params.agentId];
    if (agentRoute) {
      route = agentRoute;
      source = `routing.byAgent.${params.agentId}`;
    }

    if (mode === "local_only") {
      const localProvider = this.opts.routing.localProvider;
      const localPrimary =
        route.primary.provider === localProvider
          ? route.primary
          : {
              provider: localProvider,
            };
      const localFallback =
        route.fallback && route.fallback.provider === localProvider
          ? route.fallback
          : undefined;
      route = {
        primary: localPrimary,
        fallback: localFallback,
      };
      source += " (local_only)";
    }

    const primary = this.resolveTarget(route.primary);
    const fallback = route.fallback ? this.resolveOptionalTarget(route.fallback) : undefined;
    const fallbackDistinct =
      Boolean(fallback) &&
      (fallback!.provider !== primary.provider || fallback!.config.model !== primary.config.model);

    return {
      mode,
      source,
      primaryProvider: primary.provider,
      primary: primary.config,
      fallbackProvider: fallbackDistinct ? fallback?.provider : undefined,
      fallback: fallbackDistinct ? fallback?.config : undefined,
    };
  }

  createClient(
    route: ResolvedModelRoute,
    opts?: {
      onFallback?: (line: string) => void;
      onLog?: (line: string) => void;
    },
  ): LLMClient {
    return createRoutedClientFromConfigs({
      primary: { ...route.primary, onLog: opts?.onLog },
      fallback: route.fallback ? { ...route.fallback, onLog: opts?.onLog } : undefined,
      primaryLabel: `${route.primaryProvider}/${route.primary.model}`,
      fallbackLabel:
        route.fallback && route.fallbackProvider
          ? `${route.fallbackProvider}/${route.fallback.model}`
          : undefined,
      onFallback: opts?.onFallback,
    });
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

  private resolveOptionalTarget(target: LlmRouteTarget): { provider: string; config: OpenAICompatConfig } | undefined {
    const provider = target.provider;
    const base = this.providers[provider];
    if (!base) return undefined;
    return {
      provider,
      config: {
        ...base,
        model: target.model ?? base.model,
      },
    };
  }
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

export function createRoutedClientFromConfigs(params: {
  primary: OpenAICompatConfig;
  fallback?: OpenAICompatConfig;
  primaryLabel?: string;
  fallbackLabel?: string;
  onFallback?: (line: string) => void;
}): LLMClient {
  const primary = new OpenAICompatClient(params.primary);
  const fallback = params.fallback ? new OpenAICompatClient(params.fallback) : undefined;
  if (!fallback) return primary;
  return new RoutedOpenAICompatClient({
    primary,
    fallback,
    primaryLabel: params.primaryLabel ?? params.primary.model,
    fallbackLabel: params.fallbackLabel ?? params.fallback?.model ?? "fallback",
    onFallback: params.onFallback,
  });
}

class RoutedOpenAICompatClient implements LLMClient {
  constructor(
    private readonly deps: {
      primary: OpenAICompatClient;
      fallback: OpenAICompatClient;
      primaryLabel: string;
      fallbackLabel: string;
      onFallback?: (line: string) => void;
    },
  ) {}

  async completeChat(params: LLMCompleteChatParams): ReturnType<LLMClient["completeChat"]> {
    try {
      return await this.deps.primary.completeChat(params);
    } catch (primaryErr) {
      if (!shouldFallbackFromError(primaryErr)) throw primaryErr;
      const firstMessage = getErrorMessage(primaryErr);
      this.deps.onFallback?.(
        `llm_fallback primary=${this.deps.primaryLabel} fallback=${this.deps.fallbackLabel} reason=${firstMessage}`,
      );
      try {
        return await this.deps.fallback.completeChat(params);
      } catch (fallbackErr) {
        const secondMessage = getErrorMessage(fallbackErr);
        throw new Error(
          `Primary and fallback LLM requests failed (primary=${this.deps.primaryLabel}, fallback=${this.deps.fallbackLabel}). ` +
            `Primary error: ${firstMessage}. Fallback error: ${secondMessage}.`,
        );
      }
    }
  }
}

function shouldFallbackFromError(err: unknown): boolean {
  const message = getErrorMessage(err);
  if (/LLM request timed out/i.test(message)) return true;
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(message)) {
    return true;
  }
  const statusMatch = message.match(/LLM request failed:\s*(\d{3})\b/);
  if (!statusMatch) return false;
  const status = Number(statusMatch[1]);
  if (!Number.isFinite(status)) return false;
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
