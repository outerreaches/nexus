import assert from "node:assert/strict";
import test from "node:test";

import { matchesCron, nextCronTimeMs, parseCron, type CronSchedule } from "./cron.js";

test("nextCronTimeMs finds Feb 29 occurrences years out", () => {
  const schedule = parseCron("0 0 29 2 *");
  // From a non-leap year the next occurrence is ~20 months out — beyond the old
  // 366-day minute-stepping horizon, which threw and disabled the job.
  const next = nextCronTimeMs({ schedule, afterMs: Date.UTC(2027, 5, 1), timeZone: "UTC" });
  assert.equal(new Date(next).toISOString(), "2028-02-29T00:00:00.000Z");
});

test("nextCronTimeMs throws quickly for impossible schedules", () => {
  const schedule = parseCron("0 0 31 2 *"); // February 31st never occurs
  const started = Date.now();
  assert.throws(
    () => nextCronTimeMs({ schedule, afterMs: Date.UTC(2026, 0, 1), timeZone: "UTC" }),
    /No matching cron time found/,
  );
  // Field-wise jumping must not minute-step the whole 10-year lookahead.
  assert.ok(Date.now() - started < 1_000, "impossible-cron scan should complete fast");
});

test("nextCronTimeMs matches the previous minute-stepping results across zones", () => {
  // Reference implementation: the original minute-stepping algorithm.
  const reference = (schedule: CronSchedule, afterMs: number, timeZone: string): number => {
    const minuteMs = 60_000;
    const start = Math.floor(afterMs / minuteMs) * minuteMs + minuteMs;
    const maxSteps = 366 * 24 * 60 + 5;
    let t = start;
    for (let i = 0; i < maxSteps; i++) {
      if (matchesCron(schedule, t, timeZone)) return t;
      t += minuteMs;
    }
    throw new Error("no match within 366 days");
  };

  const cases = [
    "* * * * *",
    "*/15 * * * *",
    "30 4 * * *",
    "0 9 * * 1-5",
    "0 0 1 * *",
    "0 2 13 10 5",
    "30 2 * * *",
    "30 1 * * *",
    "45 23 31 12 *",
  ];
  const zones = ["UTC", "America/New_York", "Europe/Berlin", "Asia/Tehran"];
  const starts = [
    Date.UTC(2026, 0, 15, 10, 30),
    Date.UTC(2026, 2, 8, 6, 0), // US spring forward
    Date.UTC(2026, 10, 1, 5, 0), // US fall back
    Date.UTC(2026, 5, 30, 23, 45),
  ];

  for (const expr of cases) {
    for (const timeZone of zones) {
      for (const afterMs of starts) {
        const schedule = parseCron(expr);
        let expected: number | null = null;
        try {
          expected = reference(schedule, afterMs, timeZone);
        } catch {
          expected = null;
        }
        let actual: number | null = null;
        try {
          actual = nextCronTimeMs({ schedule, afterMs, timeZone });
        } catch {
          actual = null;
        }
        assert.equal(actual, expected, `${expr} @ ${timeZone} after=${new Date(afterMs).toISOString()}`);
      }
    }
  }
});

test("nextCronTimeMs honors inclusive semantics", () => {
  const schedule = parseCron("0 12 * * *");
  const atNoon = Date.UTC(2026, 3, 10, 12, 0);
  assert.equal(
    nextCronTimeMs({ schedule, afterMs: atNoon, timeZone: "UTC", inclusive: true }),
    atNoon,
  );
  assert.equal(
    nextCronTimeMs({ schedule, afterMs: atNoon, timeZone: "UTC" }),
    Date.UTC(2026, 3, 11, 12, 0),
  );
});

test("nextCronTimeMs skips a DST-nonexistent wall time", () => {
  // America/New_York 2026-03-08: 02:00-02:59 does not exist (spring forward).
  const schedule = parseCron("30 2 * * *");
  const next = nextCronTimeMs({ schedule, afterMs: Date.UTC(2026, 2, 8, 0, 0), timeZone: "America/New_York" });
  // The gap day is skipped entirely; the next valid 02:30 is March 9 (EDT, UTC-4).
  assert.equal(new Date(next).toISOString(), "2026-03-09T06:30:00.000Z");
});
