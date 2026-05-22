import { getSecret } from "../secrets/resolve-env.js";
import { withTimeout } from "./web-shared.js";

/**
 * Shared Firecrawl client config + scrape helper.
 *
 * Firecrawl is reachable either via the hosted cloud API (needs FIRECRAWL_API_KEY)
 * or a self-hosted instance (set FIRECRAWL_API_URL; auth is typically disabled).
 * All endpoints share one base — `{base}/v1/{scrape,search,map,crawl}`.
 */

/** Default Firecrawl cloud API base. Self-hosted instances override via FIRECRAWL_API_URL. */
export const DEFAULT_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev";

/** Resolved Firecrawl base URL — trailing slashes stripped, no `/v1` suffix. */
export function firecrawlBaseUrl(): string {
  const raw = (getSecret("FIRECRAWL_API_URL") ?? "").trim();
  const base = raw || DEFAULT_FIRECRAWL_BASE_URL;
  return base.replace(/\/+$/, "");
}

/** Resolved Firecrawl API key, or "" when none is configured. */
export function firecrawlApiKey(): string {
  return (getSecret("FIRECRAWL_API_KEY") ?? "").trim();
}

/**
 * Whether Firecrawl is usable. True when a custom FIRECRAWL_API_URL is set
 * (self-hosted, typically no auth) OR a FIRECRAWL_API_KEY is set (cloud).
 */
export function firecrawlConfigured(): boolean {
  return firecrawlBaseUrl() !== DEFAULT_FIRECRAWL_BASE_URL || firecrawlApiKey().length > 0;
}

/** Build a Firecrawl v1 endpoint URL for the given path. */
export function firecrawlUrl(path: "search" | "scrape" | "map" | "crawl"): string {
  return `${firecrawlBaseUrl()}/v1/${path}`;
}

/** Request headers — includes bearer auth only when an API key is configured. */
export function firecrawlHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = firecrawlApiKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

export type FirecrawlScrapeResult = {
  markdown: string;
  metadata?: { title?: string; description?: string; sourceURL?: string };
};

/**
 * Scrape a single URL via Firecrawl, returning clean markdown + metadata.
 *
 * Returns null on any failure (Firecrawl not configured, non-2xx, network /
 * timeout error, unexpected response shape) so callers can fall back.
 */
export async function firecrawlScrape(
  url: string,
  opts: { timeoutMs: number; scrapeTimeoutCapMs?: number },
): Promise<FirecrawlScrapeResult | null> {
  if (!firecrawlConfigured()) return null;

  const cap = opts.scrapeTimeoutCapMs ?? 30_000;
  try {
    const res = await fetch(firecrawlUrl("scrape"), {
      method: "POST",
      headers: firecrawlHeaders(),
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        timeout: Math.min(opts.timeoutMs, cap),
      }),
      signal: withTimeout(opts.timeoutMs),
    });

    if (!res.ok) {
      // Non-2xx — let caller fall back.
      void res.body?.cancel();
      return null;
    }

    const json = (await res.json()) as { success?: boolean; data?: FirecrawlScrapeResult };
    if (!json.success || !json.data?.markdown) return null;

    return json.data;
  } catch {
    // Network / timeout / parse error — fall back silently.
    return null;
  }
}
