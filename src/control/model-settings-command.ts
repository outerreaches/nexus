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
