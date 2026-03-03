export type ParsedThemeCommand = {
  kind: "theme";
  requestedTheme?: string;
};

export function parseThemeCommandText(text: string): ParsedThemeCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const tokenMatch = trimmed.match(/^\S+/);
  const tokenRaw = tokenMatch ? tokenMatch[0].toLowerCase() : "";
  const token = normalizeCommandToken(tokenRaw);
  if (token !== "/theme") return null;

  const rest = trimmed.slice(tokenMatch?.[0].length ?? 0).trim();
  if (!rest) return { kind: "theme" };
  const firstArg = rest.match(/^\S+/)?.[0] ?? "";
  return {
    kind: "theme",
    requestedTheme: firstArg,
  };
}

function normalizeCommandToken(token: string): string {
  if (!token.startsWith("/")) return token;
  const at = token.indexOf("@");
  if (at <= 0) return token;
  return token.slice(0, at);
}
