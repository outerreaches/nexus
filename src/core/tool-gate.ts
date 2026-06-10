import {
  HARD_DENY_RULES,
  BUILTIN_TOOL_DEFAULTS,
  UNATTENDED_CHANNELS,
} from "./tool-gate-defaults.js";

export type GateAction = "allow" | "ask" | "deny";

/** Where a verdict came from, in evaluation-priority order. The runner uses
 *  this to decide enforcement strength per phase (e.g. Phase 1 enforces `ask`
 *  only for operator-authored config rules; builtin-default `ask` is
 *  audit-only until the approval flow ships). */
export type GateVerdictSource = "hard_deny" | "config" | "builtin_default" | "fallback";

export type GateVerdict = {
  decision: GateAction;
  source: GateVerdictSource;
  /** Rule that produced the decision, for audit + operator messages. */
  ruleId: string;
  reason: string;
};

export type GateMatcher = {
  /** Dot path into the parsed tool args, e.g. "command" or "options.path". */
  arg: string;
  /** Matches when the string arg starts with any entry. */
  prefix?: string[];
  /** Matches when the string arg equals any entry. */
  equals?: string[];
  /** Matches when the regex (validated at config load) tests true. */
  regex?: string;
};

export type GateRule = {
  id: string;
  /** Tool names; a trailing "*" does prefix matching ("mcp.*", "*"). */
  tools: string[];
  /** All matchers must pass (AND). Omitted = rule matches on tool name alone. */
  match?: GateMatcher[];
  /** Scope filters; "!name" entries exclude. Omitted = applies to all. */
  agents?: string[];
  presets?: string[];
  channels?: string[];
  /** When set, rule applies only to unattended (true) or attended (false) runs. */
  unattended?: boolean;
  action: GateAction;
};

export type ToolGateConfig = {
  default: GateAction;
  /** How `ask` resolves for unattended runs once the approval flow exists:
   *  "deny" rejects immediately, "queue" parks an approval. Pre-approval is
   *  expressed as ordinary allow rules scoped with `unattended: true`. */
  unattended: "deny" | "queue";
  rules: GateRule[];
};

export type GateEvaluationContext = {
  agentId?: string;
  preset?: string;
  channel?: string;
};

export function isUnattendedChannel(channel: string | undefined): boolean {
  if (!channel) return false;
  return UNATTENDED_CHANNELS.has(channel.trim().toLowerCase());
}

function toolNameMatches(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return toolName.startsWith(pattern.slice(0, -1));
  return pattern === toolName;
}

function getArgPath(args: unknown, dotPath: string): unknown {
  let current: unknown = args;
  for (const segment of dotPath.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function matcherPasses(matcher: GateMatcher, args: unknown): boolean {
  const value = getArgPath(args, matcher.arg);
  if (typeof value !== "string") return false;
  if (matcher.equals && matcher.equals.some((entry) => entry === value)) return true;
  if (matcher.prefix && matcher.prefix.some((entry) => value.startsWith(entry))) return true;
  if (matcher.regex) {
    try {
      if (new RegExp(matcher.regex).test(value)) return true;
    } catch {
      // Invalid regexes are rejected at config load; a runtime failure here
      // must not silently widen the rule.
      return false;
    }
  }
  return false;
}

/** Scope list semantics: plain entries are an allowlist (value must be one of
 *  them); "!" entries are exclusions. A list of only exclusions admits
 *  everything not excluded. */
function scopeMatches(list: string[] | undefined, value: string | undefined): boolean {
  if (!list || list.length === 0) return true;
  const includes = list.filter((entry) => !entry.startsWith("!"));
  const excludes = list.filter((entry) => entry.startsWith("!")).map((entry) => entry.slice(1));
  const current = value ?? "";
  if (excludes.includes(current)) return false;
  if (includes.length === 0) return true;
  return includes.includes(current);
}

function ruleMatches(
  rule: GateRule,
  toolName: string,
  args: unknown,
  context: GateEvaluationContext,
  unattended: boolean,
): boolean {
  if (!rule.tools.some((pattern) => toolNameMatches(pattern, toolName))) return false;
  if (rule.unattended !== undefined && rule.unattended !== unattended) return false;
  if (!scopeMatches(rule.agents, context.agentId)) return false;
  if (!scopeMatches(rule.presets, context.preset)) return false;
  if (!scopeMatches(rule.channels, context.channel)) return false;
  if (rule.match && rule.match.length > 0) {
    return rule.match.every((matcher) => matcherPasses(matcher, args));
  }
  return true;
}

/** Evaluate the tool gate for a single call. Pure function — no I/O.
 *
 *  Order: built-in hard deny list → operator config rules (first match wins)
 *  → built-in per-tool defaults → config fallback (allow when unconfigured). */
export function evaluateToolGate(params: {
  toolName: string;
  args: unknown;
  context: GateEvaluationContext;
  config?: ToolGateConfig | null;
}): GateVerdict {
  const { toolName, args, context } = params;
  const unattended = isUnattendedChannel(context.channel);

  for (const rule of HARD_DENY_RULES) {
    if (ruleMatches(rule, toolName, args, context, unattended)) {
      return {
        decision: "deny",
        source: "hard_deny",
        ruleId: rule.id,
        reason: rule.reason,
      };
    }
  }

  const config = params.config ?? null;
  if (config) {
    for (const rule of config.rules) {
      if (ruleMatches(rule, toolName, args, context, unattended)) {
        return {
          decision: rule.action,
          source: "config",
          ruleId: rule.id,
          reason: `matched permissions.gate rule '${rule.id}'`,
        };
      }
    }
  }

  const builtinDefault = BUILTIN_TOOL_DEFAULTS.get(toolName);
  if (builtinDefault) {
    return {
      decision: builtinDefault,
      source: "builtin_default",
      ruleId: `builtin:${toolName}`,
      reason: `built-in default for '${toolName}'`,
    };
  }

  return {
    decision: config?.default ?? "allow",
    source: "fallback",
    ruleId: "fallback",
    reason: config ? "permissions.gate.default" : "tool gate not configured",
  };
}

/** Phase 1 enforcement: hard denies and operator-config deny/ask block the
 *  call (without an approval flow, an operator-requested `ask` resolves to
 *  deny — it is explicit opt-in). Builtin-default `ask` verdicts are
 *  audit-only until the approval flow (Phase 2/3) ships, so enabling the gate
 *  does not break existing deployments. */
export function verdictBlocksExecution(verdict: GateVerdict): boolean {
  if (verdict.decision === "deny") return true;
  if (verdict.decision === "ask") return verdict.source === "config";
  return false;
}
