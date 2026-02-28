import dns from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import { getSecret } from "../secrets/resolve-env.js";
import type { CacheEntry } from "./web-shared.js";
import { normalizeCacheKey, readCache, readResponseText, truncateText, withTimeout, writeCache } from "./web-shared.js";

const FETCH_CACHE = new Map<string, CacheEntry<string>>();

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_BINARY_BYTES = 25 * 1024 * 1024;

const IMAGE_MIME_PREFIXES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "image/bmp"];
const TEXT_MIME_EXACT = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "application/csv",
  "application/x-ndjson",
]);
const TEXT_MIME_PREFIXES = ["text/"];

function isImageContentType(ct: string): boolean {
  const normalized = ct.toLowerCase().split(";")[0]?.trim() ?? "";
  return IMAGE_MIME_PREFIXES.some((prefix) => normalized === prefix) || normalized.startsWith("image/");
}

function normalizeContentType(ct: string): string {
  return ct.toLowerCase().split(";")[0]?.trim() ?? "";
}

function isLikelyTextContentType(ct: string): boolean {
  const normalized = normalizeContentType(ct);
  if (!normalized) return true;
  if (TEXT_MIME_EXACT.has(normalized)) return true;
  return TEXT_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function extensionFromMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (normalized === "application/pdf") return ".pdf";
  if (normalized === "application/json") return ".json";
  if (normalized === "text/plain") return ".txt";
  if (normalized === "text/csv" || normalized === "application/csv") return ".csv";
  if (normalized === "application/xml" || normalized === "text/xml") return ".xml";
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "image/svg+xml") return ".svg";
  if (normalized === "image/bmp") return ".bmp";
  if (normalized === "image/png") return ".png";
  return ".bin";
}

function sanitizeFilename(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    const basename = path.basename(parsed.pathname);
    const cleaned = basename.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 80);
    if (cleaned && cleaned !== "-") return cleaned;
  } catch { /* ignore */ }
  return "file";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

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

// ── Firecrawl scrape ────────────────────────────────────────────────────────

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v1/scrape";

type FirecrawlScrapeResult = {
  markdown: string;
  metadata?: { title?: string; description?: string; sourceURL?: string };
};

async function firecrawlScrape(url: string, timeoutMs: number): Promise<FirecrawlScrapeResult | null> {
  const apiKey = (getSecret("FIRECRAWL_API_KEY") ?? "").trim();
  if (!apiKey) return null;

  try {
    const res = await fetch(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        timeout: Math.min(timeoutMs, 30_000),
      }),
      signal: withTimeout(timeoutMs),
    });

    if (!res.ok) {
      // Non-2xx — let caller fall back to native fetch
      void res.body?.cancel();
      return null;
    }

    const json = (await res.json()) as { success?: boolean; data?: FirecrawlScrapeResult };
    if (!json.success || !json.data?.markdown) return null;

    return json.data;
  } catch {
    // Network / timeout / parse error — fall back silently
    return null;
  }
}

export const webFetch = defineTool({
  name: "web_fetch",
  description:
    "Fetch a URL and return extracted text (best-effort). For non-text binary responses (images, PDFs, archives, etc.), " +
    "save the file to disk and return JSON metadata with a local file path. " +
    "Use image_analyze on returned image paths to inspect with a vision model.",
  parameters: z.object({
    url: z.string().url().max(4096),
    maxChars: z.number().int().positive().default(12000),
    timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
    cacheTtlMs: z.number().int().min(0).default(DEFAULT_CACHE_TTL_MS),
    maxRedirects: z.number().int().min(0).max(10).default(DEFAULT_MAX_REDIRECTS),
    userAgent: z.string().max(500).default(DEFAULT_USER_AGENT),
    acceptLanguage: z.string().max(200).default(DEFAULT_ACCEPT_LANGUAGE),
    maxImageBytes: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_MAX_IMAGE_BYTES)
      .describe("Maximum image file size in bytes (only applies to image responses)."),
    maxBinaryBytes: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_MAX_BINARY_BYTES)
      .describe("Maximum non-text binary file size in bytes (PDF, ZIP, etc.)."),
  }),
  execute: async (args, ctx) => {
    const { url, maxChars, timeoutMs, cacheTtlMs, maxRedirects, userAgent, acceptLanguage, maxImageBytes, maxBinaryBytes } = args;
    const cacheKey = normalizeCacheKey(`${url}::${maxChars}::${maxBinaryBytes}`);
    const cached = readCache(FETCH_CACHE, cacheKey);
    if (cached) return cached;

    // ── Try Firecrawl first (clean markdown extraction) ──────────────────
    const scraped = await firecrawlScrape(url, timeoutMs);
    if (scraped) {
      const out = truncateText(scraped.markdown.trim(), maxChars);
      writeCache(FETCH_CACHE, cacheKey, out, cacheTtlMs);
      return out;
    }

    // ── Fallback: native fetch ───────────────────────────────────────────
    const { res, finalUrl } = await fetchWithRedirects({ url, timeoutMs, maxRedirects, userAgent, acceptLanguage });
    if (!res.ok) {
      const detail = await readResponseText(res);
      throw new Error(`web_fetch failed: ${res.status} ${res.statusText}${detail ? ` — ${truncateText(detail, 800)}` : ""}`);
    }

    const ct = res.headers.get("content-type") ?? "";
    const mimeType = normalizeContentType(ct) || "application/octet-stream";

    if (isImageContentType(ct)) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxImageBytes) {
        throw new Error(
          `Image too large: ${formatBytes(buf.length)} (limit: ${formatBytes(maxImageBytes)}). ` +
            "Increase maxImageBytes if needed.",
        );
      }

      const ext = extensionFromMime(mimeType);
      const baseName = sanitizeFilename(finalUrl);
      const stem = path.parse(baseName).ext ? path.parse(baseName).name : baseName;
      const day = new Date().toISOString().slice(0, 10);
      const stamp = Date.now().toString(36);
      const fileName = `${stem}-${stamp}${path.parse(baseName).ext || ext}`;
      const relDir = path.join("fetched-images", day);
      const absDir = path.join(ctx.workspaceDir, relDir);
      await fs.mkdir(absDir, { recursive: true });
      const absPath = path.join(absDir, fileName);
      await fs.writeFile(absPath, buf);

      const out = JSON.stringify(
        {
          type: "image",
          url: finalUrl,
          path: absPath,
          mimeType,
          size: buf.length,
          sizeHuman: formatBytes(buf.length),
        },
        null,
        2,
      );
      writeCache(FETCH_CACHE, cacheKey, out, cacheTtlMs);
      return out;
    }

    if (!isLikelyTextContentType(ct)) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBinaryBytes) {
        throw new Error(
          `Binary file too large: ${formatBytes(buf.length)} (limit: ${formatBytes(maxBinaryBytes)}). ` +
            "Increase maxBinaryBytes if needed.",
        );
      }

      const ext = extensionFromMime(mimeType);
      const baseName = sanitizeFilename(finalUrl);
      const stem = path.parse(baseName).ext ? path.parse(baseName).name : baseName;
      const day = new Date().toISOString().slice(0, 10);
      const stamp = Date.now().toString(36);
      const fileName = `${stem}-${stamp}${path.parse(baseName).ext || ext}`;
      const relDir = path.join("fetched-files", day);
      const absDir = path.join(ctx.workspaceDir, relDir);
      await fs.mkdir(absDir, { recursive: true });
      const absPath = path.join(absDir, fileName);
      await fs.writeFile(absPath, buf);

      const out = JSON.stringify(
        {
          type: "binary",
          url: finalUrl,
          path: absPath,
          mimeType,
          size: buf.length,
          sizeHuman: formatBytes(buf.length),
        },
        null,
        2,
      );
      writeCache(FETCH_CACHE, cacheKey, out, cacheTtlMs);
      return out;
    }

    const body = await res.text();
    const text = ct.toLowerCase().includes("text/html") ? stripHtml(body) : body;
    const out = truncateText(text.trim(), maxChars);
    writeCache(FETCH_CACHE, cacheKey, out, cacheTtlMs);
    return out;
  },
});
