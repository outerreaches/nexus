import type { GateAction, GateRule } from "./tool-gate.js";

/** Command-bearing arguments per exec tool: shell_exec / process_manage take
 *  `command`; shell_interactive feeds the terminal via `input`. */
const EXEC_COMMAND_MATCHERS = [
  { tools: ["shell_exec", "process_manage"], arg: "command" },
  { tools: ["shell_interactive"], arg: "input" },
];

function execDenyRules(params: { idSuffix: string; regex: string; reason: string }): Array<GateRule & { reason: string }> {
  return EXEC_COMMAND_MATCHERS.map((entry, index) => ({
    id: `hard:${params.idSuffix}${index === 0 ? "" : `-${entry.arg}`}`,
    tools: entry.tools,
    match: [{ arg: entry.arg, regex: params.regex }],
    action: "deny" as const,
    reason: params.reason,
  }));
}

/** Hard deny rules: catastrophic patterns that cannot be configured off.
 *  Kept deliberately narrow — every pattern here must be something no
 *  legitimate agent workflow needs. Broader restrictions belong in operator
 *  config rules, not this list. */
export const HARD_DENY_RULES: ReadonlyArray<GateRule & { reason: string }> = [
  ...execDenyRules({
    idSuffix: "rm-root",
    regex: "rm\\s+(-[a-zA-Z]*[rf][a-zA-Z]*\\s+)+(/|/\\*)(\\s|$)",
    reason: "recursive delete of filesystem root",
  }),
  ...execDenyRules({
    idSuffix: "mkfs",
    regex: "(^|[;&|]\\s*)mkfs(\\.|\\s)",
    reason: "filesystem format command",
  }),
  ...execDenyRules({
    idSuffix: "dd-device",
    regex: "\\bdd\\b[^;|&]*\\bof=/dev/",
    reason: "raw write to block device",
  }),
  ...execDenyRules({
    idSuffix: "fork-bomb",
    regex: ":\\(\\)\\s*\\{\\s*:\\|:&\\s*\\}\\s*;\\s*:",
    reason: "fork bomb",
  }),
  ...execDenyRules({
    idSuffix: "force-push-main",
    regex: "git\\s+push\\b[^;|&]*(--force\\b|\\s-f\\b)[^;|&]*\\s(main|master)(\\s|$)",
    reason: "force push to main/master",
  }),
];

/** Built-in per-tool defaults applied when no operator rule matches. `ask`
 *  entries are audit-only in Phase 1 (see verdictBlocksExecution) and become
 *  enforced once the approval flow ships. Read-only tools are intentionally
 *  absent — they fall through to the configured fallback (allow). */
export const BUILTIN_TOOL_DEFAULTS: ReadonlyMap<string, GateAction> = new Map<string, GateAction>([
  // Exec
  ["shell_exec", "ask"],
  ["shell_interactive", "ask"],
  ["process_manage", "ask"],
  // Outbound side effects
  ["telegram_send", "ask"],
  ["paper_trade", "ask"],
  // Infra mutation
  ["node_manage", "ask"],
  ["db_maintenance", "ask"],
  ["db_backup", "ask"],
  // Self-modification: ha_deploy keeps its own bespoke approval flow, which is
  // stronger than the Phase 1 gate; it is deliberately not listed here.
]);

/** Channels whose runs have no human watching the conversation in real time.
 *  Used by `unattended` rule scoping and (Phase 3) ask→queue/deny resolution. */
export const UNATTENDED_CHANNELS: ReadonlySet<string> = new Set([
  "scheduler",
  "proactive",
  "nudge",
  "system",
  "federation",
]);
