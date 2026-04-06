import { getPreset, getPresetNames } from "../core/presets.js";
import type { ModelRouter } from "../llm/model-router.js";
import { getCodexAuthStatus } from "../llm/codex-auth.js";
import {
  editNexusConfigRoutingField,
  type ConfigRoutingField,
  type ConfigRoutingTarget,
} from "../state/config-editor.js";
import type { NexusConfig } from "../state/config.js";
import type { ParsedModelSettingsCommand, ParsedProviderModelCommand, RoutingTarget } from "./model-settings-command.js";

type ToolLike = {
  name: string;
};

export type ModelSettingsCommandHandlerDeps = {
  configPath: string;
  config: NexusConfig;
  modelRouter?: ModelRouter;
  listTools: () => ToolLike[];
  applyRuntimeConfig?: (next: NexusConfig) => void;
  stateDir?: string;
  log?: (line: string) => void;
};

export async function executeModelSettingsCommand(params: {
  command: ParsedModelSettingsCommand;
  deps: ModelSettingsCommandHandlerDeps;
}): Promise<string> {
  if (params.command.kind === "presets") {
    return renderPresetsCommand(params.command, params.deps);
  }
  return await executeProviderModelCommand(params.command, params.deps);
}

async function executeProviderModelCommand(
  command: ParsedProviderModelCommand,
  deps: ModelSettingsCommandHandlerDeps,
): Promise<string> {
  const field: ConfigRoutingField = command.kind === "provider" ? "provider" : "model";
  if (command.error) {
    return `${formatModelSettingsUsage(command.kind)}\n\nERROR: ${command.error}.`;
  }

  const targetValidation = validateTarget(command.target, deps);
  if (targetValidation !== null) return targetValidation;

  if (command.action === "show") {
    return renderProviderModelState({ target: command.target, deps });
  }

  if (command.action === "set") {
    const value = (command.value ?? "").trim();
    if (!value) {
      return `${formatModelSettingsUsage(command.kind)}\n\nERROR: missing ${command.kind} value.`;
    }
    if (field === "provider") {
      const providers = deps.modelRouter
        ? new Set(deps.modelRouter.listProviderNames())
        : new Set(["default", ...Object.keys(deps.config.llm.providers)]);
      if (!providers.has(value)) {
        return `ERROR: unknown provider "${value}". Known providers: ${[...providers].sort().join(", ")}.`;
      }
      // Check codex auth before allowing provider switch
      if (value === "codex" && deps.stateDir) {
        const status = await getCodexAuthStatus(deps.stateDir);
        if (!status.loggedIn) {
          return "ERROR: Codex provider requires authentication. Run /codex login first to authenticate with your ChatGPT account.";
        }
      }
    }

    const saved = await persistModelSettingsUpdate({
      deps,
      target: command.target,
      field,
      action: "set",
      value,
    });
    if (!saved.ok) return saved.error;
    const pathLabel = describeTargetPath(command.target, field);
    const liveState = renderProviderModelState({ target: command.target, deps });
    if (!saved.liveApplied) {
      return [
        `OK: saved ${pathLabel}=${value} in nexus.json.`,
        `WARN: live apply failed (${saved.liveApplyError ?? "unknown"}). Restart required for runtime changes.`,
        liveState,
      ].join("\n");
    }
    return [
      `OK: updated ${pathLabel}=${value}.`,
      liveState,
    ].join("\n");
  }

  const saved = await persistModelSettingsUpdate({
    deps,
    target: command.target,
    field,
    action: "reset",
  });
  if (!saved.ok) return saved.error;
  const pathLabel = describeTargetPath(command.target, field);
  const liveState = renderProviderModelState({ target: command.target, deps });
  if (!saved.liveApplied) {
    return [
      `OK: reset ${pathLabel} in nexus.json.`,
      `WARN: live apply failed (${saved.liveApplyError ?? "unknown"}). Restart required for runtime changes.`,
      liveState,
    ].join("\n");
  }
  return [
    `OK: reset ${pathLabel}.`,
    liveState,
  ].join("\n");
}

function renderPresetsCommand(
  command: Extract<ParsedModelSettingsCommand, { kind: "presets" }>,
  deps: ModelSettingsCommandHandlerDeps,
): string {
  if (command.error) {
    return `${formatPresetsUsage()}\n\nERROR: ${command.error}.`;
  }

  const requestedPreset = command.presetName?.trim();
  const presetNames = getPresetNames();
  if (requestedPreset && !presetNames.includes(requestedPreset)) {
    return `ERROR: unknown preset "${requestedPreset}". Available presets: ${presetNames.join(", ")}.`;
  }
  const names = requestedPreset ? [requestedPreset] : presetNames;

  const defaultToolOverrides = Object.keys(deps.config.llm.toolRouting.default ?? {}).length;
  const lines: string[] = [];
  lines.push("Preset routes:");
  for (const presetName of names) {
    const agentId = presetName === "orchestrator" ? "main" : `main:${presetName}`;
    const route = resolveRouteForPreset(deps, presetName, agentId);
    const presetToolOverrides = Object.keys(deps.config.llm.toolRouting.byPreset?.[presetName] ?? {}).length;
    const agentToolOverrides = Object.keys(deps.config.llm.toolRouting.byAgent?.[agentId] ?? {}).length;
    lines.push(
      `- ${presetName}: ${route.provider}/${route.model} source=${route.source} tools(default=${defaultToolOverrides},preset=${presetToolOverrides},agent=${agentToolOverrides})`,
    );
  }
  return lines.join("\n");
}

function renderProviderModelState(params: {
  target: RoutingTarget;
  deps: ModelSettingsCommandHandlerDeps;
}): string {
  const targetLabel = formatRoutingTarget(params.target);
  if (params.target.kind === "tool" || params.target.kind === "toolPreset") {
    const configured = readConfiguredToolTarget(params.deps.config, params.target);
    return `${targetLabel}: provider=${configured.provider} model=${configured.model} source=${configured.source}`;
  }
  const presetName = params.target.kind === "orchestrator" ? "orchestrator" : params.target.preset;
  const agentId = presetName === "orchestrator" ? "main" : `main:${presetName}`;
  const configuredPrimary = params.deps.config.llm.routing.byPreset[presetName]?.primary;
  const configuredProvider = configuredPrimary?.provider ?? "(inherit)";
  const configuredModel = configuredPrimary?.model ?? "(inherit)";
  const route = resolveRouteForPreset(params.deps, presetName, agentId);
  return `${targetLabel}: configured provider=${configuredProvider} model=${configuredModel} | effective ${route.provider}/${route.model} source=${route.source}`;
}

function resolveRouteForPreset(
  deps: ModelSettingsCommandHandlerDeps,
  presetName: string,
  agentId: string,
): { provider: string; model: string; source: string } {
  if (deps.modelRouter) {
    const route = deps.modelRouter.resolve({
      agentId,
      preset: presetName,
      mode: "default",
      presetLlm: getPreset(presetName)?.llm,
    });
    return {
      provider: route.primaryProvider,
      model: route.primary.model,
      source: route.source,
    };
  }

  const byPresetRoute = deps.config.llm.routing.byPreset[presetName];
  const primary = byPresetRoute?.primary ?? deps.config.llm.routing.default.primary;
  const provider = primary.provider;
  const providerConfig = provider === "default"
    ? deps.config.llm.openaiCompat
    : deps.config.llm.providers[provider];
  return {
    provider,
    model: primary.model ?? providerConfig?.model ?? deps.config.llm.openaiCompat.model,
    source: byPresetRoute ? `routing.byPreset.${presetName}` : "routing.default",
  };
}

function readConfiguredToolTarget(config: NexusConfig, target: Extract<RoutingTarget, { kind: "tool" | "toolPreset" }>): {
  provider: string;
  model: string;
  source: string;
} {
  if (target.kind === "tool") {
    const entry = config.llm.toolRouting.default?.[target.tool];
    return {
      provider: entry?.provider ?? "(inherit)",
      model: entry?.model ?? "(inherit)",
      source: entry ? `llm.toolRouting.default.${target.tool}` : "inherited",
    };
  }
  const entry = config.llm.toolRouting.byPreset?.[target.preset]?.[target.tool];
  return {
    provider: entry?.provider ?? "(inherit)",
    model: entry?.model ?? "(inherit)",
    source: entry ? `llm.toolRouting.byPreset.${target.preset}.${target.tool}` : "inherited",
  };
}

function validateTarget(target: RoutingTarget, deps: ModelSettingsCommandHandlerDeps): string | null {
  if (target.kind === "orchestrator") return null;

  const presetNames = new Set(getPresetNames({ includeHidden: true }));
  if (target.kind === "preset" || target.kind === "toolPreset") {
    if (!presetNames.has(target.preset)) {
      return `ERROR: unknown preset "${target.preset}". Available presets: ${[...presetNames].sort().join(", ")}.`;
    }
  }

  if (target.kind === "tool" || target.kind === "toolPreset") {
    const toolName = target.tool;
    const knownTools = new Set(deps.listTools().map((entry) => entry.name));
    if (!knownTools.has(toolName)) {
      return `ERROR: unknown tool "${toolName}". Use /tools to list available tool names.`;
    }
  }
  return null;
}

async function persistModelSettingsUpdate(params: {
  deps: ModelSettingsCommandHandlerDeps;
  target: RoutingTarget;
  field: ConfigRoutingField;
  action: "set" | "reset";
  value?: string;
}): Promise<{ ok: true; liveApplied: boolean; liveApplyError?: string } | { ok: false; error: string }> {
  const configTarget = toConfigTarget(params.target);
  let parsedConfig: NexusConfig;
  try {
    const result = await editNexusConfigRoutingField({
      configPath: params.deps.configPath,
      target: configTarget,
      field: params.field,
      action: params.action,
      value: params.value,
    });
    parsedConfig = result.parsedConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `ERROR: failed to update nexus.json (${message}).` };
  }

  let liveApplied = true;
  let liveApplyError: string | undefined;
  try {
    params.deps.config.llm.routing = parsedConfig.llm.routing;
    params.deps.config.llm.toolRouting = parsedConfig.llm.toolRouting;
    params.deps.modelRouter?.updateRouting(parsedConfig.llm.routing);
    params.deps.applyRuntimeConfig?.(parsedConfig);
  } catch (err) {
    liveApplied = false;
    liveApplyError = err instanceof Error ? err.message : String(err);
    params.deps.log?.(`model_settings: live_apply_failed ${liveApplyError}`);
  }
  return { ok: true, liveApplied, liveApplyError };
}

function toConfigTarget(target: RoutingTarget): ConfigRoutingTarget {
  if (target.kind === "orchestrator") return { kind: "orchestrator" };
  if (target.kind === "preset") return { kind: "preset", preset: target.preset };
  if (target.kind === "tool") return { kind: "tool", tool: target.tool };
  return { kind: "toolPreset", preset: target.preset, tool: target.tool };
}

function describeTargetPath(target: RoutingTarget, field: ConfigRoutingField): string {
  if (target.kind === "orchestrator") {
    return `llm.routing.byPreset.orchestrator.primary.${field}`;
  }
  if (target.kind === "preset") {
    return `llm.routing.byPreset.${target.preset}.primary.${field}`;
  }
  if (target.kind === "tool") {
    return `llm.toolRouting.default.${target.tool}.${field}`;
  }
  return `llm.toolRouting.byPreset.${target.preset}.${target.tool}.${field}`;
}

function formatRoutingTarget(target: RoutingTarget): string {
  if (target.kind === "orchestrator") return "orchestrator";
  if (target.kind === "preset") return `preset:${target.preset}`;
  if (target.kind === "tool") return `tool:${target.tool}`;
  return `tool:${target.preset}:${target.tool}`;
}

function formatModelSettingsUsage(kind: "provider" | "model"): string {
  return [
    `Usage: /${kind}`,
    `       /${kind} <${kind}>`,
    `       /${kind} <target> <${kind}>`,
    `       /${kind} show [target]`,
    `       /${kind} reset [target]`,
    "Targets: orchestrator | preset:<name> | tool:<toolName> | tool:<presetName>:<toolName>",
  ].join("\n");
}

function formatPresetsUsage(): string {
  return [
    "Usage: /presets [name]",
    "Example: /presets coder",
  ].join("\n");
}
