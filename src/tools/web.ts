import dns from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { CacheEntry } from "./web-shared.js";
import { normalizeCacheKey, readCache, readResponseText, truncateText, withTimeout, writeCache } from "./web-shared.js";

const FETCH_CACHE = new Map<string, CacheEntry<string>>();

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_MIME_PREFIXES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "image/bmp"];

function isImageContentType(ct: string): boolean {
  const normalized = ct.toLowerCase().split(";")[0]?.trim() ?? "";
  return IMAGE_MIME_PREFIXES.some((prefix) => normalized === prefix) || normalized.startsWith("image/");
}

function extensionFromMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
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
  return "image";
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

export const webFetch = defineTool({
  name: "web_fetch",
  description:
    "Fetch a URL and return extracted text (best-effort), or save images to disk when the response is an image. " +
    "For image responses, returns JSON with the local file path, mime type, and size. " +
    "Use image_analyze on the returned path to inspect the image with a vision model.",
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
  }),
  execute: async (args, ctx) => {
    const { url, maxChars, timeoutMs, cacheTtlMs, maxRedirects, userAgent, acceptLanguage, maxImageBytes } = args;
    const cacheKey = normalizeCacheKey(`${url}::${maxChars}`);
    const cached = readCache(FETCH_CACHE, cacheKey);
    if (cached) return cached;

    const { res, finalUrl } = await fetchWithRedirects({ url, timeoutMs, maxRedirects, userAgent, acceptLanguage });
    if (!res.ok) {
      const detail = await readResponseText(res);
      throw new Error(`web_fetch failed: ${res.status} ${res.statusText}${detail ? ` — ${truncateText(detail, 800)}` : ""}`);
    }

    const ct = res.headers.get("content-type") ?? "";

    if (isImageContentType(ct)) {
      const mimeType = ct.toLowerCase().split(";")[0]?.trim() ?? "image/png";
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

    const body = await res.text();
    const text = ct.toLowerCase().includes("text/html") ? stripHtml(body) : body;
    const out = truncateText(text.trim(), maxChars);
    writeCache(FETCH_CACHE, cacheKey, out, cacheTtlMs);
    return out;
  },
});
