export type ParsedCodexCommand = {
  kind: "login" | "logout" | "status";
  error?: string;
};

export function parseCodexCommandText(text: string): ParsedCodexCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/codex")) return null;

  const rest = trimmed.slice("/codex".length).trim().toLowerCase();

  if (!rest || rest === "login") return { kind: "login" };
  if (rest === "logout") return { kind: "logout" };
  if (rest === "status") return { kind: "status" };

  return {
    kind: "login",
    error: `Unknown /codex subcommand: "${rest}". Usage: /codex [login|logout|status]`,
  };
}
