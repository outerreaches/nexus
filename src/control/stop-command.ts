export type ParsedStopCommand = {
  kind: "stop" | "stopall";
  cooldownMs?: number;
  rawCooldown?: string;
};

type ParseDurationOptions = {
  defaultUnit?: "ms" | "s" | "m" | "h" | "d";
  minMs?: number;
  maxMs?: number;
};

const DEFAULT_DURATION_OPTS: Required<ParseDurationOptions> = {
  defaultUnit: "m",
  minMs: 1_000,
  maxMs: 7 * 24 * 60 * 60_000,
};

export function parseStopCommandText(text: string): ParsedStopCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const tokenMatch = trimmed.match(/^\S+/);
  const tokenRaw = tokenMatch ? tokenMatch[0].toLowerCase() : "";
  const token = normalizeCommandToken(tokenRaw);
  if (token !== "/stop" && token !== "/stopall") return null;

  if (token === "/stop") return { kind: "stop" };

  const rest = trimmed.slice(tokenMatch?.[0].length ?? 0).trim();
  if (!rest) return { kind: "stopall" };
  const firstArg = rest.match(/^\S+/)?.[0] ?? "";
  const parsedMs = parseDurationToMs(firstArg);
  if (parsedMs === null) {
    return {
      kind: "stopall",
      rawCooldown: firstArg,
    };
  }
  return {
    kind: "stopall",
    cooldownMs: parsedMs,
    rawCooldown: firstArg,
  };
}

function normalizeCommandToken(token: string): string {
  if (!token.startsWith("/")) return token;
  const at = token.indexOf("@");
  if (at <= 0) return token;
  return token.slice(0, at);
}

export function parseDurationToMs(raw: string, opts: ParseDurationOptions = {}): number | null {
  const merged = {
    ...DEFAULT_DURATION_OPTS,
    ...opts,
  };
  const input = raw.trim().toLowerCase();
  if (!input) return null;

  const match = input.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = (match[2] ?? merged.defaultUnit).toLowerCase();
  let multiplier = 1;
  switch (unit) {
    case "ms":
      multiplier = 1;
      break;
    case "s":
      multiplier = 1_000;
      break;
    case "m":
      multiplier = 60_000;
      break;
    case "h":
      multiplier = 60 * 60_000;
      break;
    case "d":
      multiplier = 24 * 60 * 60_000;
      break;
    default:
      return null;
  }

  const ms = Math.floor(value * multiplier);
  if (!Number.isFinite(ms)) return null;
  if (ms < merged.minMs) return merged.minMs;
  if (ms > merged.maxMs) return merged.maxMs;
  return ms;
}

export function formatDurationMs(ms: number): string {
  const value = Math.max(0, Math.floor(ms));
  if (value % (24 * 60 * 60_000) === 0) return `${value / (24 * 60 * 60_000)}d`;
  if (value % (60 * 60_000) === 0) return `${value / (60 * 60_000)}h`;
  if (value % 60_000 === 0) return `${value / 60_000}m`;
  if (value % 1_000 === 0) return `${value / 1_000}s`;
  return `${value}ms`;
}
