const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const key = timeZone;
  const existing = dtfCache.get(key);
  if (existing) return existing;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  dtfCache.set(key, fmt);
  return fmt;
}

export function validateTimeZone(input: string | undefined | null): string {
  const tz = (input ?? "").trim() || "UTC";
  try {
    // Will throw for invalid time zones.
    getFormatter(tz).format(new Date(0));
  } catch {
    throw new Error(`Invalid timezone: ${tz}`);
  }
  return tz;
}

export type ZonedParts = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  weekday: number; // 0=Sun..6=Sat
};

export function getZonedParts(tsMs: number, timeZone: string): ZonedParts {
  const fmt = getFormatter(timeZone);
  const parts = fmt.formatToParts(new Date(tsMs));
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type === "literal") continue;
    map[p.type] = p.value;
  }
  const weekday = WEEKDAY[map.weekday ?? ""];
  if (weekday === undefined) throw new Error(`Unable to parse weekday for tz=${timeZone}`);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday,
  };
}

type ParsedField = { values: Set<number>; wildcard: boolean };

function parseField(raw: string, min: number, max: number, mapValue?: (n: number) => number): ParsedField {
  const field = raw.trim();
  if (!field) throw new Error("Empty cron field");

  const out = new Set<number>();
  let wildcard = false;

  const addValue = (n: number) => {
    const mapped = mapValue ? mapValue(n) : n;
    if (!Number.isInteger(mapped) || mapped < min || mapped > max) {
      throw new Error(`Value out of range (${min}-${max}): ${String(n)}`);
    }
    out.add(mapped);
  };

  const addRange = (a: number, b: number, step: number = 1) => {
    if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid step: ${String(step)}`);
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    for (let v = start; v <= end; v += step) addValue(v);
  };

  const parts = field.split(",").map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    if (part === "*") {
      wildcard = true;
      addRange(min, max, 1);
      continue;
    }

    const [base, stepRaw] = part.split("/", 2);
    const step = stepRaw !== undefined ? Number(stepRaw) : null;

    const baseTrim = (base ?? "").trim();
    if (!baseTrim) throw new Error(`Invalid cron token: ${part}`);

    if (baseTrim === "*") {
      wildcard = true;
      addRange(min, max, step ?? 1);
      continue;
    }

    if (baseTrim.includes("-")) {
      const [aRaw, bRaw] = baseTrim.split("-", 2);
      const a = Number(aRaw);
      const b = Number(bRaw);
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`Invalid range: ${baseTrim}`);
      addRange(a, b, step ?? 1);
      continue;
    }

    const single = Number(baseTrim);
    if (!Number.isInteger(single)) throw new Error(`Invalid number: ${baseTrim}`);
    if (step !== null) addRange(single, max, step);
    else addValue(single);
  }

  return { values: out, wildcard };
}

export type CronSchedule = {
  expr: string;
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  dayOfMonthWildcard: boolean;
  dayOfWeekWildcard: boolean;
};

export function parseCron(expr: string): CronSchedule {
  const raw = expr.trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new Error(`Cron must have 5 fields (min hour dom mon dow): '${expr}'`);

  const minute = parseField(parts[0]!, 0, 59);
  const hour = parseField(parts[1]!, 0, 23);
  const dom = parseField(parts[2]!, 1, 31);
  const month = parseField(parts[3]!, 1, 12);
  const dow = parseField(
    parts[4]!,
    0,
    6,
    // 0 and 7 both mean Sunday in many crons.
    (n) => (n === 7 ? 0 : n),
  );

  return {
    expr: raw,
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dom.values,
    month: month.values,
    dayOfWeek: dow.values,
    dayOfMonthWildcard: dom.wildcard,
    dayOfWeekWildcard: dow.wildcard,
  };
}

export function matchesCron(schedule: CronSchedule, tsMs: number, timeZone: string): boolean {
  const p = getZonedParts(tsMs, timeZone);
  if (!schedule.minute.has(p.minute)) return false;
  if (!schedule.hour.has(p.hour)) return false;
  if (!schedule.month.has(p.month)) return false;

  const domMatch = schedule.dayOfMonth.has(p.day);
  const dowMatch = schedule.dayOfWeek.has(p.weekday);

  // Vixie cron semantics:
  // - If either DOM or DOW is "*", only the other is considered.
  // - If both are restricted, match if either matches.
  if (schedule.dayOfMonthWildcard && schedule.dayOfWeekWildcard) return true;
  if (schedule.dayOfMonthWildcard) return dowMatch;
  if (schedule.dayOfWeekWildcard) return domMatch;
  return domMatch || dowMatch;
}

export function nextCronTimeMs(params: {
  schedule: CronSchedule;
  afterMs: number;
  timeZone: string;
  inclusive?: boolean;
  maxLookaheadDays?: number;
}): number {
  const timeZone = validateTimeZone(params.timeZone);
  const inclusive = Boolean(params.inclusive);
  const maxLookaheadDays = Math.max(1, Math.min(3660, Math.floor(params.maxLookaheadDays ?? 366)));

  const minuteMs = 60_000;
  const start = inclusive
    ? Math.floor(params.afterMs / minuteMs) * minuteMs
    : Math.floor(params.afterMs / minuteMs) * minuteMs + minuteMs;

  const maxSteps = maxLookaheadDays * 24 * 60 + 5;
  let t = start;
  for (let i = 0; i < maxSteps; i++) {
    if (matchesCron(params.schedule, t, timeZone)) return t;
    t += minuteMs;
  }
  throw new Error(`No matching cron time found within ${maxLookaheadDays} days for '${params.schedule.expr}'`);
}

