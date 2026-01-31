import { withTimeout } from "../tools/web-shared.js";
import type { GmailOauthConfig } from "./auth.js";
import { getValidGmailAccessToken } from "./auth.js";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";

export type GmailApiDeps = {
  stateDir: string;
  oauth: GmailOauthConfig;
  timeoutMs: number;
};

export async function gmailRequest<T>(
  deps: GmailApiDeps,
  params: { method: string; path: string; query?: Record<string, string | string[]>; body?: unknown },
): Promise<T> {
  const { accessToken } = await getValidGmailAccessToken({
    stateDir: deps.stateDir,
    oauth: deps.oauth,
    timeoutMs: deps.timeoutMs,
  });

  const url = new URL(`${GMAIL_API_BASE}${params.path}`);
  for (const [k, v] of Object.entries(params.query ?? {})) {
    if (Array.isArray(v)) {
      for (const item of v) url.searchParams.append(k, item);
      continue;
    }
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    method: params.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
    signal: withTimeout(deps.timeoutMs),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Gmail API error (${res.status}): ${text || res.statusText}`);
  }

  return JSON.parse(text) as T;
}
