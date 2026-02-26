import type { ToolContext } from "../core/tools.js";
import { getPreset } from "../core/presets.js";
import type { OpenAICompatConfig } from "../llm/openai-compat.js";
import type { ModelRouter } from "../llm/model-router.js";
import type { LlmToolRouteTarget } from "../state/config.js";

export type ResolvedToolRoute = {
  target: LlmToolRouteTarget;
  source: string;
};

function hasConfiguredValue(target: LlmToolRouteTarget | undefined): target is LlmToolRouteTarget {
  if (!target) return false;
  const model = typeof target.model === "string" ? target.model.trim() : "";
  const provider = typeof target.provider === "string" ? target.provider.trim() : "";
  const endpoint = typeof target.endpoint === "string" ? target.endpoint.trim() : "";
  const providerOrder = Array.isArray(target.providerOrder)
    ? target.providerOrder.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  return model.length > 0 || provider.length > 0 || endpoint.length > 0 || providerOrder.length > 0;
}

export function resolveToolRoute(ctx: Pick<ToolContext, "llmToolRouting" | "request">, toolName: string): ResolvedToolRoute | null {
  const routing = ctx.llmToolRouting;
  if (!routing) return null;

  const agentId = ctx.request?.agentId?.trim();
  if (agentId) {
    const agentTarget = routing.byAgent?.[agentId]?.[toolName];
    if (hasConfiguredValue(agentTarget)) {
      return { target: agentTarget, source: `llm.toolRouting.byAgent.${agentId}.${toolName}` };
    }
  }

  const presetName = ctx.request?.preset?.trim();
  if (presetName) {
    const presetTarget = routing.byPreset?.[presetName]?.[toolName];
    if (hasConfiguredValue(presetTarget)) {
      return { target: presetTarget, source: `llm.toolRouting.byPreset.${presetName}.${toolName}` };
    }
  }

  const defaultTarget = routing.default?.[toolName];
  if (hasConfiguredValue(defaultTarget)) {
    return { target: defaultTarget, source: `llm.toolRouting.default.${toolName}` };
  }

  return null;
}

export function resolveLegacyImageDefaults(ctx: { request?: { preset?: string } }, llm: OpenAICompatConfig): { model: string; provider?: string } {
  const presetName = ctx.request?.preset?.trim();
  if (presetName) {
    const preset = getPreset(presetName);
    const presetModel = preset?.imageModel?.trim();
    if (presetModel) {
      return {
        model: presetModel,
        provider: preset?.imageProvider?.trim() || undefined,
      };
    }
  }
  const envModel = (process.env.NEXUS_IMAGE_MODEL ?? "").trim();
  if (envModel) return { model: envModel };
  return { model: llm.model };
}

export function resolveLegacyVideoDefaults(
  ctx: { request?: { preset?: string } },
  llm: OpenAICompatConfig,
): { model: string; provider?: string; providerOrder?: string[] } {
  const presetName = ctx.request?.preset?.trim();
  if (presetName) {
    const preset = getPreset(presetName);
    const presetModel = preset?.videoModel?.trim();
    if (presetModel) {
      return {
        model: presetModel,
        provider: preset?.videoProvider?.trim() || undefined,
        providerOrder: Array.isArray(preset?.videoProviderOrder)
          ? preset.videoProviderOrder.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          : undefined,
      };
    }
  }
  const envModel = (process.env.NEXUS_VIDEO_MODEL ?? "").trim();
  if (envModel) return { model: envModel };
  return { model: llm.model };
}

export function resolveOpenAiToolProviderConfig(params: {
  ctx: ToolContext;
  provider: string;
  syntheticAgentId: string;
}): { config: OpenAICompatConfig; providerName: string } | { error: string } {
  const router = params.ctx.modelRouter as ModelRouter | undefined;
  if (!router) {
    return { error: `tool route provider '${params.provider}' requested, but model router is unavailable` };
  }
  try {
    const route = router.resolve({
      agentId: params.syntheticAgentId,
      mode: "default",
      presetLlm: { primary: { provider: params.provider } },
    });
    return {
      config: route.primary,
      providerName: route.primaryProvider,
    };
  } catch (err) {
    return {
      error: `tool route provider '${params.provider}' failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
