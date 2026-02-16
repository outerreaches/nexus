#!/usr/bin/env tsx
import assert from "node:assert/strict";
import process from "node:process";

type HttpResult = {
  ok: boolean;
  status: number;
  json: Record<string, unknown> | null;
  text: string;
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseArgs(argv: string[]): { dryRun: boolean } {
  return { dryRun: argv.includes("--dry-run") };
}

async function requestJson(url: string, init?: RequestInit): Promise<HttpResult> {
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = asObject(JSON.parse(text));
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  } catch (err) {
    return { ok: false, status: 0, json: null, text: err instanceof Error ? err.message : String(err) };
  }
}

async function waitForCondition(params: {
  timeoutMs: number;
  intervalMs: number;
  message: string;
  predicate: () => Promise<boolean>;
}): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    if (await params.predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, params.intervalMs));
  }
  throw new Error(params.message);
}

async function waitForMode(params: {
  url: string;
  mode: "active" | "standby";
  timeoutMs: number;
}): Promise<void> {
  await waitForCondition({
    timeoutMs: params.timeoutMs,
    intervalMs: 500,
    message: `mode check timed out url=${params.url} expected=${params.mode}`,
    predicate: async () => {
      const res = await requestJson(`${params.url}/api/mode`);
      if (!res.ok || !res.json) return false;
      return asString(res.json.mode) === params.mode;
    },
  });
}

async function expectNodeEndpointStatus(params: { url: string; expectedStatus: number; label: string }): Promise<void> {
  const res = await requestJson(`${params.url}/nx/nodes`);
  assert.equal(
    res.status,
    params.expectedStatus,
    `${params.label}: expected /nx/nodes status ${params.expectedStatus}, got ${res.status} body=${res.text}`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const haproxyUrl = process.env.NEXUS_HA_SMOKE_HAPROXY_URL ?? "http://127.0.0.1:18789";
  const primaryUrl = process.env.NEXUS_HA_SMOKE_PRIMARY_URL ?? "http://127.0.0.1:18891";
  const standbyUrl = process.env.NEXUS_HA_SMOKE_STANDBY_URL ?? "http://127.0.0.1:18892";
  const timeoutMs = Number(process.env.NEXUS_HA_SMOKE_TIMEOUT_MS ?? 90_000);

  if (args.dryRun) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          mode: "dry-run",
          haproxyUrl,
          primaryUrl,
          standbyUrl,
          timeoutMs,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  try {
    await waitForCondition({
      timeoutMs,
      intervalMs: 1000,
      message: "primary /health/live not ready",
      predicate: async () => {
        const res = await requestJson(`${primaryUrl}/health/live`);
        return res.ok;
      },
    });
    await waitForCondition({
      timeoutMs,
      intervalMs: 1000,
      message: "standby /health/live not ready",
      predicate: async () => {
        const res = await requestJson(`${standbyUrl}/health/live`);
        return res.ok;
      },
    });
    await waitForCondition({
      timeoutMs,
      intervalMs: 1000,
      message: "haproxy /health/live not ready",
      predicate: async () => {
        const res = await requestJson(`${haproxyUrl}/health/live`);
        return res.ok;
      },
    });

    await waitForMode({ url: primaryUrl, mode: "active", timeoutMs });
    await waitForMode({ url: standbyUrl, mode: "standby", timeoutMs });

    const primaryReady = await requestJson(`${primaryUrl}/health/ready`);
    assert.equal(primaryReady.status, 200, `primary should be ready: ${primaryReady.text}`);
    const standbyReady = await requestJson(`${standbyUrl}/health/ready`);
    assert.equal(standbyReady.status, 503, `standby should not be ready: ${standbyReady.text}`);

    await expectNodeEndpointStatus({
      url: primaryUrl,
      expectedStatus: 426,
      label: "primary before failover",
    });
    await expectNodeEndpointStatus({
      url: standbyUrl,
      expectedStatus: 503,
      label: "standby before failover",
    });

    const deactivatePrimary = await requestJson(`${primaryUrl}/api/deactivate`, { method: "POST" });
    assert.equal(deactivatePrimary.status, 200, `primary deactivate failed: ${deactivatePrimary.text}`);
    await waitForMode({ url: primaryUrl, mode: "standby", timeoutMs });

    const activateStandby = await requestJson(`${standbyUrl}/api/activate`, { method: "POST" });
    assert.equal(activateStandby.status, 200, `standby activate failed: ${activateStandby.text}`);
    await waitForMode({ url: standbyUrl, mode: "active", timeoutMs });

    await waitForCondition({
      timeoutMs,
      intervalMs: 500,
      message: "haproxy did not route to active backend",
      predicate: async () => {
        const res = await requestJson(`${haproxyUrl}/api/mode`);
        if (!res.ok || !res.json) return false;
        return asString(res.json.mode) === "active";
      },
    });

    const standbyNowReady = await requestJson(`${standbyUrl}/health/ready`);
    assert.equal(standbyNowReady.status, 200, `new active should be ready: ${standbyNowReady.text}`);
    const primaryNowReady = await requestJson(`${primaryUrl}/health/ready`);
    assert.equal(primaryNowReady.status, 503, `old primary should be standby/not ready: ${primaryNowReady.text}`);

    await expectNodeEndpointStatus({
      url: standbyUrl,
      expectedStatus: 426,
      label: "new active after failover",
    });
    await expectNodeEndpointStatus({
      url: primaryUrl,
      expectedStatus: 503,
      label: "old primary after failover",
    });

    process.stdout.write("[ha-smoke] PASS: active/standby transition + node endpoint gating verified\n");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ha-smoke] FAIL: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
