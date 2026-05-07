export type ParsedStatusCommand = {
  kind: "status";
};

export function parseStatusCommandText(text: string): ParsedStatusCommand | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const tokenMatch = trimmed.match(/^(\S+)/);
  if (!tokenMatch) return null;
  const tokenRaw = tokenMatch[1].toLowerCase();
  const token = stripBotMention(tokenRaw);
  if (token !== "/status") return null;
  return { kind: "status" };
}

function stripBotMention(token: string): string {
  if (!token.startsWith("/")) return token;
  const at = token.indexOf("@");
  if (at <= 0) return token;
  return token.slice(0, at);
}
