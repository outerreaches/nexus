export type RoutingTarget =
  | { kind: "orchestrator" }
  | { kind: "preset"; preset: string }
  | { kind: "tool"; tool: string }
  | { kind: "toolPreset"; preset: string; tool: string };

export type ParsedProviderModelCommand = {
  kind: "provider" | "model";
  action: "show" | "set" | "reset";
  target: RoutingTarget;
  value?: string;
  error?: string;
};

export type ParsedPresetsCommand = {
  kind: "presets";
  presetName?: string;
  error?: string;
};

export type ParsedModelSettingsCommand = ParsedProviderModelCommand | ParsedPresetsCommand;

export function parseModelSettingsCommandText(text: string): ParsedModelSettingsCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const tokenMatch = trimmed.match(/^\S+/);
  const tokenRaw = tokenMatch ? tokenMatch[0].toLowerCase() : "";
  const token = normalizeCommandToken(tokenRaw);

  if (token === "/presets") {
    return parsePresetsCommand(trimmed, tokenMatch?.[0].length ?? 0);
  }
  if (token !== "/provider" && token !== "/model") return null;

  const kind = token === "/provider" ? "provider" : "model";
  const rest = trimmed.slice(tokenMatch?.[0].length ?? 0).trim();
  const args = rest.length > 0 ? rest.split(/\s+/) : [];

  if (args.length === 0) {
    return {
      kind,
      action: "show",
      target: { kind: "orchestrator" },
    };
  }

  // Flag-style form: --preset/--tool + optional --reset, with the value as the
  // remaining positional. Explicit flags eliminate the ambiguity in the legacy
  // positional form where a typo'd target would silently get parsed as a value.
  const flagParsed = tryParseFlagForm(kind, args);
  if (flagParsed) return flagParsed;

  const first = (args[0] ?? "").trim();
  const firstLower = first.toLowerCase();

  if (firstLower === "show") {
    if (args.length > 2) {
      return {
        kind,
        action: "show",
        target: { kind: "orchestrator" },
        error: "too many arguments",
      };
    }
    if (args.length === 1) {
      return {
        kind,
        action: "show",
        target: { kind: "orchestrator" },
      };
    }
    const target = parseRoutingTarget(args[1] ?? "");
    if (!target) {
      return {
        kind,
        action: "show",
        target: { kind: "orchestrator" },
        error: `invalid target "${args[1] ?? ""}"`,
      };
    }
    return {
      kind,
      action: "show",
      target,
    };
  }

  if (firstLower === "reset") {
    if (args.length > 2) {
      return {
        kind,
        action: "reset",
        target: { kind: "orchestrator" },
        error: "too many arguments",
      };
    }
    if (args.length === 1) {
      return {
        kind,
        action: "reset",
        target: { kind: "orchestrator" },
      };
    }
    const target = parseRoutingTarget(args[1] ?? "");
    if (!target) {
      return {
        kind,
        action: "reset",
        target: { kind: "orchestrator" },
        error: `invalid target "${args[1] ?? ""}"`,
      };
    }
    return {
      kind,
      action: "reset",
      target,
    };
  }

  if (args.length === 1) {
    return {
      kind,
      action: "set",
      target: { kind: "orchestrator" },
      value: first,
    };
  }

  if (args.length === 2) {
    const target = parseRoutingTarget(first);
    if (!target) {
      return {
        kind,
        action: "set",
        target: { kind: "orchestrator" },
        value: args[1] ?? "",
        error: `invalid target "${first}"`,
      };
    }
    return {
      kind,
      action: "set",
      target,
      value: args[1] ?? "",
    };
  }

  return {
    kind,
    action: "set",
    target: { kind: "orchestrator" },
    value: args[args.length - 1],
    error: "too many arguments",
  };
}

export function formatRoutingTarget(target: RoutingTarget): string {
  if (target.kind === "orchestrator") return "orchestrator";
  if (target.kind === "preset") return `preset:${target.preset}`;
  if (target.kind === "tool") return `tool:${target.tool}`;
  return `tool:${target.preset}:${target.tool}`;
}

function parsePresetsCommand(trimmed: string, tokenLen: number): ParsedPresetsCommand {
  const rest = trimmed.slice(tokenLen).trim();
  if (!rest) return { kind: "presets" };
  const args = rest.split(/\s+/);
  if (args.length > 1) {
    return {
      kind: "presets",
      presetName: args[0] ?? "",
      error: "too many arguments",
    };
  }
  const presetName = args[0]?.trim();
  if (!presetName) return { kind: "presets" };
  return {
    kind: "presets",
    presetName,
  };
}

function parseRoutingTarget(raw: string): RoutingTarget | null {
  const value = raw.trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower === "orchestrator") {
    return { kind: "orchestrator" };
  }
  if (lower.startsWith("preset:")) {
    const preset = value.slice(7).trim();
    if (!preset) return null;
    return { kind: "preset", preset };
  }
  if (lower.startsWith("tool:")) {
    const body = value.slice(5).trim();
    if (!body) return null;
    const firstColon = body.indexOf(":");
    if (firstColon <= 0 || firstColon >= body.length - 1) {
      if (firstColon === -1) {
        return { kind: "tool", tool: body };
      }
      return null;
    }
    const preset = body.slice(0, firstColon).trim();
    const tool = body.slice(firstColon + 1).trim();
    if (!preset || !tool) return null;
    return {
      kind: "toolPreset",
      preset,
      tool,
    };
  }
  return null;
}

function normalizeCommandToken(token: string): string {
  if (!token.startsWith("/")) return token;
  const at = token.indexOf("@");
  if (at <= 0) return token;
  return token.slice(0, at);
}

/**
 * Parses the explicit-flag form: `--preset NAME` / `--tool NAME[:TOOL]` plus
 * optional `--reset`. Returns null when no flag is present so the legacy
 * positional parser (above) handles unchanged input.
 *
 * Examples:
 *   /provider --preset coder openrouter
 *   /provider --tool image_generate openai
 *   /provider --tool coder:code_search openrouter
 *   /provider --reset --preset coder
 *   /model --preset coder gpt-4o
 */
function tryParseFlagForm(
  kind: "provider" | "model",
  args: string[],
): ParsedProviderModelCommand | null {
  if (!args.some((arg) => arg.startsWith("--"))) return null;

  let presetFlagValue: string | undefined;
  let toolFlagValue: string | undefined;
  let resetFlag = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const raw = args[i] ?? "";
    if (raw === "--reset") {
      resetFlag = true;
      continue;
    }
    if (raw === "--preset") {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        return {
          kind,
          action: "set",
          target: { kind: "orchestrator" },
          error: "--preset requires a name (e.g. --preset coder)",
        };
      }
      presetFlagValue = next;
      i += 1;
      continue;
    }
    if (raw === "--tool") {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        return {
          kind,
          action: "set",
          target: { kind: "orchestrator" },
          error: "--tool requires a name (e.g. --tool image_generate or --tool coder:code_search)",
        };
      }
      toolFlagValue = next;
      i += 1;
      continue;
    }
    if (raw.startsWith("--")) {
      return {
        kind,
        action: "set",
        target: { kind: "orchestrator" },
        error: `unknown flag "${raw}". Use --preset, --tool, or --reset.`,
      };
    }
    positional.push(raw);
  }

  if (presetFlagValue && toolFlagValue) {
    return {
      kind,
      action: "set",
      target: { kind: "orchestrator" },
      error: "use either --preset or --tool, not both",
    };
  }

  let target: RoutingTarget = { kind: "orchestrator" };
  if (presetFlagValue) {
    target = { kind: "preset", preset: presetFlagValue };
  } else if (toolFlagValue) {
    const colon = toolFlagValue.indexOf(":");
    if (colon === -1) {
      target = { kind: "tool", tool: toolFlagValue };
    } else {
      const preset = toolFlagValue.slice(0, colon).trim();
      const tool = toolFlagValue.slice(colon + 1).trim();
      if (!preset || !tool) {
        return {
          kind,
          action: "set",
          target: { kind: "orchestrator" },
          error: `invalid --tool value "${toolFlagValue}". Use TOOL_NAME or PRESET:TOOL_NAME.`,
        };
      }
      target = { kind: "toolPreset", preset, tool };
    }
  }

  if (resetFlag) {
    if (positional.length > 0) {
      return {
        kind,
        action: "reset",
        target,
        error: `--reset takes no value (got "${positional.join(" ")}")`,
      };
    }
    return { kind, action: "reset", target };
  }

  if (positional.length === 0) {
    // No value and no --reset → treat as show, so `/provider --preset coder`
    // works as a quick "what's the current state for this preset" probe.
    return { kind, action: "show", target };
  }
  if (positional.length > 1) {
    return {
      kind,
      action: "set",
      target,
      value: positional[positional.length - 1],
      error: `too many values (got ${positional.length}: ${positional.join(" ")})`,
    };
  }
  return { kind, action: "set", target, value: positional[0]! };
}
