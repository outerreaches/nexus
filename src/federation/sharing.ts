const SECRET_LIKE_KEY_PATTERN = /(secret|token|password|passphrase|mnemonic|seed|private[_-]?key|api[_-]?key|credential|wallet[_-]?key|client[_-]?secret|access[_-]?key)/i;
const PATH_LIKE_KEY_PATTERN = /(path|filepath|file_path|localpath|cwd)/i;

const SENSITIVITY_RANK: Record<string, number> = {
  public: 0,
  internal: 1,
  sensitive: 2,
  restricted: 3,
};

export type SharedEventProjectionResult = {
  allowed: boolean;
  payload: Record<string, unknown>;
  reason: string;
};

function normalizeSensitivity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized in SENSITIVITY_RANK ? normalized : null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseMaxDepth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 8;
  return Math.max(1, Math.min(16, Math.floor(value)));
}

function getSensitivityRank(value: string): number {
  switch (value) {
    case "public":
      return SENSITIVITY_RANK.public;
    case "internal":
      return SENSITIVITY_RANK.internal;
    case "sensitive":
      return SENSITIVITY_RANK.sensitive;
    default:
      return SENSITIVITY_RANK.restricted;
  }
}

function sanitizeValue(params: {
  value: unknown;
  depth: number;
  maxDepth: number;
  stripSecretLike: boolean;
}): unknown {
  if (params.depth > params.maxDepth) return undefined;
  const value = params.value;
  if (value == null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const next = value
      .map((entry) =>
        sanitizeValue({
          value: entry,
          depth: params.depth + 1,
          maxDepth: params.maxDepth,
          stripSecretLike: params.stripSecretLike,
        }))
      .filter((entry) => entry !== undefined);
    return next;
  }
  if (typeof value === "object") {
    const entries: Array<[string, unknown]> = [];
    for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
      const key = rawKey.trim();
      if (!key) continue;
      if (PATH_LIKE_KEY_PATTERN.test(key)) continue;
      if (params.stripSecretLike && SECRET_LIKE_KEY_PATTERN.test(key)) continue;
      const nextValue = sanitizeValue({
        value: rawValue,
        depth: params.depth + 1,
        maxDepth: params.maxDepth,
        stripSecretLike: params.stripSecretLike,
      });
      if (nextValue === undefined) continue;
      entries.push([key, nextValue]);
    }
    return Object.fromEntries(entries);
  }
  return undefined;
}

export function applySharedEventProjection(params: {
  payload: Record<string, unknown>;
  projection: Record<string, unknown>;
  sensitivityCeiling?: string | null;
}): SharedEventProjectionResult {
  const payloadSensitivity = normalizeSensitivity(params.payload.sensitivity);
  const sensitivityCeiling = normalizeSensitivity(params.sensitivityCeiling ?? null) ?? "restricted";
  if (payloadSensitivity && getSensitivityRank(payloadSensitivity) > getSensitivityRank(sensitivityCeiling)) {
    return {
      allowed: false,
      payload: {},
      reason: `sensitivity_above_ceiling:${payloadSensitivity}>${sensitivityCeiling}`,
    };
  }

  const stripSecretLike = parseBoolean(params.projection.stripSecretLike) !== false;
  const maxDepth = parseMaxDepth(params.projection.maxDepth);
  const includeFields = parseStringList(params.projection.includeFields ?? params.projection.allowFields);
  const excludeFields = parseStringList(params.projection.excludeFields ?? params.projection.denyFields);

  const sanitized = sanitizeValue({
    value: params.payload,
    depth: 0,
    maxDepth,
    stripSecretLike,
  });
  const base = sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : {};

  let projected: Record<string, unknown>;
  if (includeFields.length > 0) {
    const entries: Array<[string, unknown]> = [];
    const baseEntries = new Map<string, unknown>(Object.entries(base));
    for (const key of includeFields) {
      if (!baseEntries.has(key)) continue;
      entries.push([key, baseEntries.get(key)]);
    }
    projected = Object.fromEntries(entries);
  } else {
    projected = { ...base };
  }
  const excluded = new Set(excludeFields);
  if (excluded.size > 0) {
    projected = Object.fromEntries(Object.entries(projected).filter(([key]) => !excluded.has(key)));
  }

  return {
    allowed: true,
    payload: projected,
    reason: "projected",
  };
}
