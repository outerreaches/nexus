export type HelpChannel = "terminal" | "telegram" | "generic";

export function renderHelpText(channel: HelpChannel): string {
  const lines: string[] = [];
  lines.push("Nexus commands:");
  lines.push("- /help");
  lines.push("- /stop");
  lines.push("- /stopall [cooldown] (e.g. 30s, 5m, 1h, 1d)");
  lines.push("- /sethome");
  lines.push("- /unsethome");
  lines.push("- /tools [limit]");
  lines.push("- /nodes [limit]");
  lines.push("- /jobs [limit]");
  lines.push("- /intakes [limit]");
  lines.push("- /processes [limit]");
  lines.push("- /mcp [limit]");
  lines.push("- /federation [limit]");
  lines.push("- /blackboard [limit]");

  if (channel === "terminal") {
    lines.push("");
    lines.push("Terminal-only:");
    lines.push("- /theme [name]");
    lines.push("- /exit (or /quit)");
    lines.push("- Enter sends, Alt+Enter/Ctrl+J inserts newline");
  } else if (channel === "telegram") {
    lines.push("");
    lines.push("Telegram-specific:");
    lines.push("- /act <id> <response>");
    lines.push("- /pair (when pairing is required)");
  }

  lines.push("");
  lines.push("Notes: list commands are read-only; optional limit range is 1..100 (default 20).");
  return lines.join("\n");
}
