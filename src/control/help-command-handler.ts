export type HelpChannel = "terminal" | "telegram" | "generic";

type CommandCatalogEntry = {
  /** Slash command name as typed, e.g. "/model". */
  name: string;
  /** Help line including arguments, e.g. "/model [target] [model]". */
  usage: string;
  /** Alternate names accepted by the dispatcher (included in completion). */
  aliases?: string[];
  /** Restrict to a single channel; undefined = available everywhere. */
  channel?: HelpChannel;
};

/** Single source of truth for slash commands: drives /help rendering and
 *  terminal Tab completion so the two cannot drift apart. */
export const COMMAND_CATALOG: CommandCatalogEntry[] = [
  { name: "/help", usage: "/help" },
  { name: "/stop", usage: "/stop" },
  { name: "/stopall", usage: "/stopall [cooldown] (e.g. 30s, 5m, 1h, 1d)" },
  { name: "/status", usage: "/status" },
  { name: "/sethome", usage: "/sethome" },
  { name: "/unsethome", usage: "/unsethome" },
  { name: "/provider", usage: "/provider [target] [provider]" },
  { name: "/model", usage: "/model [target] [model]" },
  { name: "/presets", usage: "/presets [name]" },
  { name: "/tools", usage: "/tools [limit]" },
  { name: "/nodes", usage: "/nodes [limit]" },
  { name: "/jobs", usage: "/jobs [limit]" },
  { name: "/intakes", usage: "/intakes [limit]" },
  { name: "/processes", usage: "/processes [limit]" },
  { name: "/mcp", usage: "/mcp [limit]" },
  { name: "/federation", usage: "/federation [limit]" },
  { name: "/blackboard", usage: "/blackboard [limit]" },
  { name: "/codex", usage: "/codex login|logout|status" },
  { name: "/theme", usage: "/theme [name]", channel: "terminal" },
  { name: "/exit", usage: "/exit (or /quit)", aliases: ["/quit"], channel: "terminal" },
  { name: "/act", usage: "/act <id> <response>", channel: "telegram" },
  { name: "/pair", usage: "/pair (when pairing is required)", channel: "telegram" },
];

/** Command names (including aliases) available on the given channel, for
 *  Tab completion. */
export function listSlashCommands(channel: HelpChannel): string[] {
  const names: string[] = [];
  for (const entry of COMMAND_CATALOG) {
    if (entry.channel && entry.channel !== channel) continue;
    names.push(entry.name);
    if (entry.aliases) names.push(...entry.aliases);
  }
  return names;
}

export function renderHelpText(channel: HelpChannel): string {
  const lines: string[] = [];
  lines.push("Nexus commands:");
  for (const entry of COMMAND_CATALOG) {
    if (entry.channel) continue;
    lines.push(`- ${entry.usage}`);
  }

  if (channel === "terminal") {
    lines.push("");
    lines.push("Terminal-only:");
    for (const entry of COMMAND_CATALOG) {
      if (entry.channel !== "terminal") continue;
      lines.push(`- ${entry.usage}`);
    }
    lines.push("- Enter sends, Alt+Enter/Ctrl+J inserts newline");
    lines.push("- Up/Down arrows recall previous input (drafts are preserved)");
    lines.push("- Tab completes slash commands and arguments (repeat Tab to cycle matches)");
    lines.push("- Alt/Ctrl+Left/Right jump by word; Alt+Backspace/Alt+d delete a word");
    lines.push("- Bare /model and /provider open an arrow-key picker (type to filter, Esc cancels)");
  } else if (channel === "telegram") {
    lines.push("");
    lines.push("Telegram-specific:");
    for (const entry of COMMAND_CATALOG) {
      if (entry.channel !== "telegram") continue;
      lines.push(`- ${entry.usage}`);
    }
  }

  lines.push("");
  lines.push("Notes: list commands are read-only; optional limit range is 1..100 (default 20).");
  return lines.join("\n");
}
