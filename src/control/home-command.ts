export type ParsedHomeCommand = {
  kind: "sethome" | "unsethome";
};

export function parseHomeCommandText(text: string): ParsedHomeCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const tokenMatch = trimmed.match(/^\S+/);
  const tokenRaw = tokenMatch ? tokenMatch[0].toLowerCase() : "";
  const token = normalizeCommandToken(tokenRaw);
  if (token === "/sethome") return { kind: "sethome" };
  if (token === "/unsethome") return { kind: "unsethome" };
  return null;
}

function normalizeCommandToken(token: string): string {
  if (!token.startsWith("/")) return token;
  const at = token.indexOf("@");
  if (at <= 0) return token;
  return token.slice(0, at);
}
