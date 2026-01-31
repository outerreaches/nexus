import dns from "node:dns/promises";
import net from "node:net";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { CacheEntry } from "./web-shared.js";
import { normalizeCacheKey, readCache, readResponseText, truncateText, withTimeout, writeCache } from "./web-shared.js";

const FETCH_CACHE = new Map<string, CacheEntry<string>>();

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_REDIRECTS = 3;

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DEFAULT_ACCEPT_LANGUAGE = "en-US,en;q=0.9";

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<\/(p|div|br|li|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function isPrivateIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const parts = ip.split(".").map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("fe80:")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    return false;
  }
  return false;
}

async function hostnameResolvesToPrivate(hostname: string): Promise<boolean> {
  try {
    const res = await dns.lookup(hostname, { all: true });
    return res.some((r) => isPrivateIp(r.address));
  } catch {
    return false;
  }
}

async function assertSafeUrl(url: URL): Promise<void> {
  if (process.env.NEXUS_ALLOW_PRIVATE_WEB_FETCH === "1") return;
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "0.0.0.0") {
    throw new Error("Blocked URL hostname (private/loopback).");
  }
  if (net.isIP(hostname) && isPrivateIp(hostname)) {
    throw new Error("Blocked URL IP (private/loopback).");
  }
  if (await hostnameResolvesToPrivate(hostname)) {
    throw new Error("Blocked URL hostname (resolves to private/loopback).");
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchWithRedirects(params: {
  url: string;
  timeoutMs: number;
  maxRedirects: number;
  userAgent: string;
  acceptLanguage: string;
}): Promise<{ res: Response; finalUrl: string }> {
  let current = new URL(params.url);
  await assertSafeUrl(current);

  for (let redirects = 0; redirects <= params.maxRedirects; redirects++) {
    const res = await fetch(current.toString(), {
      method: "GET",
      redirect: "manual",
      headers: {
        Accept: "*/*",
        "User-Agent": params.userAgent,
        "Accept-Language": params.acceptLanguage,
      },
      signal: withTimeout(params.timeoutMs),
    });

    if (isRedirectStatus(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`Redirect missing location header (${res.status})`);
      const next = new URL(loc, current);
      await assertSafeUrl(next);
      void res.body?.cancel();
      current = next;
      continue;
    }

    return { res, finalUrl: current.toString() };
  }

  throw new Error(`Too many redirects (limit: ${params.maxRedirects})`);
}

export const webFetch = defineTool({
  name: "web_fetch",
  description: "Fetch a URL and return extracted text (best-effort). Uses timeouts, redirect limits, and a small cache.",
  parameters: z.object({
    url: z.string().url().max(4096),
    maxChars: z.number().int().positive().default(12000),
    timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
    cacheTtlMs: z.number().int().min(0).default(DEFAULT_CACHE_TTL_MS),
    maxRedirects: z.number().int().min(0).max(10).default(DEFAULT_MAX_REDIRECTS),
    userAgent: z.string().max(500).default(DEFAULT_USER_AGENT),
    acceptLanguage: z.string().max(200).default(DEFAULT_ACCEPT_LANGUAGE),
  }),
  execute: async ({ url, maxChars, timeoutMs, cacheTtlMs, maxRedirects, userAgent, acceptLanguage }) => {
    const cacheKey = normalizeCacheKey(`${url}::${maxChars}`);
    const cached = readCache(FETCH_CACHE, cacheKey);
    if (cached) return cached;

    const { res } = await fetchWithRedirects({ url, timeoutMs, maxRedirects, userAgent, acceptLanguage });
    if (!res.ok) {
      const detail = await readResponseText(res);
      throw new Error(`web_fetch failed: ${res.status} ${res.statusText}${detail ? ` — ${truncateText(detail, 800)}` : ""}`);
    }

    const ct = res.headers.get("content-type") ?? "";
    const body = await res.text();
    const text = ct.toLowerCase().includes("text/html") ? stripHtml(body) : body;
    const out = truncateText(text.trim(), maxChars);
    writeCache(FETCH_CACHE, cacheKey, out, cacheTtlMs);
    return out;
  },
});
