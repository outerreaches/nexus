export type InfoCommandTopic =
  | "tools"
  | "nodes"
  | "jobs"
  | "intakes"
  | "processes"
  | "mcp"
  | "federation"
  | "blackboard";

export type ParsedInfoCommand = {
  kind: "info";
  topic: InfoCommandTopic;
  limit?: number;
  rawLimit?: string;
};

const INFO_COMMANDS: Record<string, InfoCommandTopic> = {
  "/tools": "tools",
  "/nodes": "nodes",
  "/jobs": "jobs",
  "/intakes": "intakes",
  "/processes": "processes",
  "/mcp": "mcp",
  "/federation": "federation",
  "/blackboard": "blackboard",
};

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

export function parseInfoCommandText(text: string): ParsedInfoCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const tokenMatch = trimmed.match(/^\S+/);
  const tokenRaw = tokenMatch ? tokenMatch[0].toLowerCase() : "";
  const token = normalizeCommandToken(tokenRaw);
  const topic = INFO_COMMANDS[token];
  if (!topic) return null;

  const rest = trimmed.slice(tokenMatch?.[0].length ?? 0).trim();
  if (!rest) {
    return {
      kind: "info",
      topic,
      limit: DEFAULT_LIMIT,
    };
  }

  const rawLimit = rest.match(/^\S+/)?.[0] ?? "";
  const parsedLimit = parseLimit(rawLimit);
  if (parsedLimit === null) {
    return {
      kind: "info",
      topic,
      rawLimit,
    };
  }
  return {
    kind: "info",
    topic,
    limit: parsedLimit,
    rawLimit,
  };
}

function parseLimit(raw: string): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const intVal = Math.floor(value);
  if (intVal < MIN_LIMIT || intVal > MAX_LIMIT) return null;
  return intVal;
}

function normalizeCommandToken(token: string): string {
  if (!token.startsWith("/")) return token;
  const at = token.indexOf("@");
  if (at <= 0) return token;
  return token.slice(0, at);
}
