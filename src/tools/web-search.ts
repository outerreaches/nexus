import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import { getSecret } from "../secrets/resolve-env.js";
import { firecrawlBaseUrl, firecrawlConfigured, firecrawlHeaders, firecrawlUrl } from "./firecrawl.js";
import type { CacheEntry } from "./web-shared.js";
import { normalizeCacheKey, readCache, readResponseText, truncateText, withTimeout, writeCache } from "./web-shared.js";

const SEARCH_CACHE = new Map<string, CacheEntry<{ provider: string; payload: string }>>();

const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30_000;

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
// Firecrawl endpoints (cloud or self-hosted) are resolved via ./firecrawl.js.
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";

type SearchProvider = "brave" | "perplexity" | "firecrawl";

function resolveProvider(preferred: "auto" | "brave" | "perplexity" | "firecrawl"): SearchProvider | null {
  if (preferred === "brave") return "brave";
  if (preferred === "perplexity") return "perplexity";
  if (preferred === "firecrawl") return "firecrawl";
  const hasFirecrawl = firecrawlConfigured();
  const hasBrave = Boolean((getSecret("BRAVE_API_KEY") ?? "").trim());
  const hasPerplexityKey = Boolean((getSecret("PERPLEXITY_API_KEY") ?? "").trim());
  // Prefer Firecrawl (returns page content); fall back to Brave (structured), then Perplexity (LLM).
  if (hasFirecrawl) return "firecrawl";
  if (hasBrave) return "brave";
  if (hasPerplexityKey) return "perplexity";
  return null;
}

function clampCount(n: number | undefined): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : 5;
  return Math.max(1, Math.min(10, v));
}

function isPplxKey(key: string): boolean {
  return key.toLowerCase().startsWith("pplx-");
}

function isOpenRouterKey(key: string): boolean {
  return key.toLowerCase().startsWith("sk-or-");
}

function resolvePerplexityAuth(): { apiKey: string | null; baseUrl: string } {
  const pplx = (getSecret("PERPLEXITY_API_KEY") ?? "").trim();
  if (pplx) {
    return { apiKey: pplx, baseUrl: isPplxKey(pplx) ? PERPLEXITY_DIRECT_BASE_URL : OPENROUTER_BASE_URL };
  }
  const or = (getSecret("OPENROUTER_API_KEY") ?? "").trim();
  if (or) {
    return { apiKey: or, baseUrl: isOpenRouterKey(or) ? OPENROUTER_BASE_URL : OPENROUTER_BASE_URL };
  }
  return { apiKey: null, baseUrl: OPENROUTER_BASE_URL };
}

async function braveSearchWithRetry(url: string, apiKey: string, timeoutMs: number, maxRetries = 2): Promise<any> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
      signal: withTimeout(timeoutMs),
    });
    if (res.status === 429 && attempt < maxRetries) {
      await readResponseText(res);
      continue;
    }
    if (!res.ok) {
      const detail = await readResponseText(res);
      throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
    }
    return await res.json();
  }
  throw new Error("Brave Search API rate limited (429) after retries");
}

async function braveSearch(params: {
  query: string;
  count: number;
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  timeoutMs: number;
}): Promise<Record<string, unknown>> {
  const apiKey = (getSecret("BRAVE_API_KEY") ?? "").trim();
  if (!apiKey) {
    throw new Error("Missing BRAVE_API_KEY (required for web_search provider=brave).");
  }

  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(params.count));
  if (params.country) url.searchParams.set("country", params.country);
  if (params.search_lang) url.searchParams.set("search_lang", params.search_lang);
  if (params.ui_lang) url.searchParams.set("ui_lang", params.ui_lang);
  if (params.freshness) url.searchParams.set("freshness", params.freshness);

  const start = Date.now();
  const json = await braveSearchWithRetry(url.toString(), apiKey, params.timeoutMs);
  const resultsRaw = Array.isArray(json?.web?.results) ? json.web.results : [];
  const results = resultsRaw.slice(0, params.count).map((r: any) => ({
    title: String(r?.title ?? ""),
    url: String(r?.url ?? ""),
    snippet: String(r?.description ?? ""),
    published: r?.age ? String(r.age) : undefined,
  }));
  return {
    provider: "brave",
    query: params.query,
    count: results.length,
    tookMs: Date.now() - start,
    results,
  };
}

async function perplexitySearch(params: {
  query: string;
  model: string;
  timeoutMs: number;
}): Promise<Record<string, unknown>> {
  const auth = resolvePerplexityAuth();
  if (!auth.apiKey) {
    throw new Error("Missing PERPLEXITY_API_KEY or OPENROUTER_API_KEY (required for web_search provider=perplexity).");
  }
  const endpoint = `${auth.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const start = Date.now();
  const now = new Date();
  const datePrefix = `[Current date: ${now.toISOString().split("T")[0]}, year ${now.getFullYear()}] `;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.apiKey}`,
      "HTTP-Referer": "https://github.com/outerreaches/nexus",
      "X-Title": "Nexus web_search",
    },
    body: JSON.stringify({
      model: params.model,
      messages: [{ role: "user", content: datePrefix + params.query }],
      temperature: 0.2,
    }),
    signal: withTimeout(params.timeoutMs),
  });
  if (!res.ok) {
    const detail = await readResponseText(res);
    throw new Error(`Perplexity/OpenRouter error (${res.status}): ${detail || res.statusText}`);
  }
  const json = (await res.json()) as any;
  const content = String(json?.choices?.[0]?.message?.content ?? "");
  const citations = Array.isArray(json?.citations) ? json.citations.map((c: any) => String(c)) : [];
  return {
    provider: "perplexity",
    query: params.query,
    model: params.model,
    tookMs: Date.now() - start,
    content,
    citations,
  };
}

// ── Firecrawl search ────────────────────────────────────────────────────────

type FirecrawlHit = {
  url?: string;
  title?: string;
  description?: string;
  markdown?: string;
};

/**
 * Save full markdown content for each search result to workspace files.
 * Returns an array of absolute paths (one per result that had content).
 */
async function saveSearchContent(
  workspaceDir: string,
  query: string,
  hits: FirecrawlHit[],
): Promise<(string | null)[]> {
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40)
    .replace(/^-|-$/g, "");
  const hash = crypto.createHash("sha256").update(query).digest("hex").slice(0, 8);
  const dirName = `${slug}-${hash}`;
  const absDir = path.join(workspaceDir, "web-search-results", dirName);

  const paths: (string | null)[] = [];
  let needsDir = true;

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    if (!hit.markdown || hit.markdown.length < 50) {
      paths.push(null);
      continue;
    }

    if (needsDir) {
      await fs.mkdir(absDir, { recursive: true });
      needsDir = false;
    }

    const fileName = `result-${i + 1}.md`;
    const absPath = path.join(absDir, fileName);
    const header = `# ${hit.title ?? "Untitled"}\n\nSource: ${hit.url ?? "unknown"}\n\n---\n\n`;
    await fs.writeFile(absPath, header + hit.markdown, "utf-8");
    paths.push(absPath);
  }

  return paths;
}

async function firecrawlSearch(params: {
  query: string;
  count: number;
  timeoutMs: number;
  workspaceDir: string;
}): Promise<Record<string, unknown>> {
  if (!firecrawlConfigured()) {
    throw new Error(
      "Missing FIRECRAWL_API_KEY or FIRECRAWL_API_URL (required for web_search provider=firecrawl).",
    );
  }

  const start = Date.now();
  const res = await fetch(firecrawlUrl("search"), {
    method: "POST",
    headers: firecrawlHeaders(),
    body: JSON.stringify({
      query: params.query,
      limit: params.count,
      scrapeOptions: {
        formats: ["markdown"],
        onlyMainContent: true,
      },
    }),
    signal: withTimeout(params.timeoutMs),
  });

  if (!res.ok) {
    const detail = await readResponseText(res);
    throw new Error(`Firecrawl Search API error (${res.status}): ${detail || res.statusText}`);
  }

  const json = (await res.json()) as { success?: boolean; data?: FirecrawlHit[] };
  if (!json.success || !Array.isArray(json.data)) {
    throw new Error("Firecrawl Search returned unexpected response format.");
  }

  const hits = json.data.slice(0, params.count);

  // Save full page content to workspace files for on-demand reading
  const contentPaths = await saveSearchContent(params.workspaceDir, params.query, hits);

  const results = hits.map((hit, i) => ({
    title: hit.title ?? "",
    url: hit.url ?? "",
    snippet: hit.description ?? "",
    hasContent: Boolean(contentPaths[i]),
    contentPath: contentPaths[i] ?? undefined,
  }));

  return {
    provider: "firecrawl",
    query: params.query,
    count: results.length,
    tookMs: Date.now() - start,
    results,
    note: results.some((r) => r.hasContent)
      ? "Full page content saved to contentPath files. Use file_read to access."
      : undefined,
  };
}

export const webSearch = defineTool({
  name: "web_search",
  description:
    "Search the web with caching + timeouts. The backend is auto-selected from your " +
    "configured providers (Firecrawl, Brave, or Perplexity) — leave `provider` at its " +
    "default ('auto') unless you have a specific reason to override. Returns title + " +
    "URL + snippet per hit; when the resolved provider supports it, full page markdown " +
    "is also saved to local files for follow-up reading via file_read.",
  parameters: z.object({
    query: z.string().min(1).max(600),
    provider: z
      .enum(["auto", "brave", "perplexity", "firecrawl"])
      .default("auto")
      .describe("Search backend. Leave 'auto' unless you specifically need a particular backend."),
    count: z.number().int().min(1).max(10).optional(),
    country: z.string().max(8).optional(),
    search_lang: z.string().max(16).optional(),
    ui_lang: z.string().max(16).optional(),
    freshness: z.string().max(64).optional().describe("Brave-only (e.g. pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD)."),
    model: z.string().max(120).default("perplexity/sonar-pro").describe("Perplexity-only (OpenRouter model)."),
    timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
    cacheTtlMs: z.number().int().min(0).default(DEFAULT_CACHE_TTL_MS),
    maxChars: z.number().int().positive().default(12000),
  }),
  execute: async (args, ctx) => {
    const provider = resolveProvider(args.provider);
    if (!provider) {
      return [
        "ERROR: web_search is not configured.",
        "Set FIRECRAWL_API_KEY or FIRECRAWL_API_URL (Firecrawl — cloud or self-hosted, recommended), " +
          "BRAVE_API_KEY (Brave Search), or PERPLEXITY_API_KEY / OPENROUTER_API_KEY (Perplexity Sonar).",
      ].join("\n");
    }

    const count = clampCount(args.count);
    const cacheKey = normalizeCacheKey(
      provider === "firecrawl"
        ? `firecrawl:${firecrawlBaseUrl()}:${args.query}:${count}`
        : provider === "brave"
          ? `brave:${args.query}:${count}:${args.country ?? "default"}:${args.search_lang ?? "default"}:${args.ui_lang ?? "default"}:${args.freshness ?? "default"}`
          : `perplexity:${args.query}:${args.model}`,
    );

    const cached = readCache(SEARCH_CACHE, cacheKey);
    if (cached) return cached.payload;

    let result: Record<string, unknown>;

    if (provider === "firecrawl") {
      result = await firecrawlSearch({
        query: args.query,
        count,
        timeoutMs: args.timeoutMs,
        workspaceDir: ctx.workspaceDir,
      });
    } else if (provider === "brave") {
      result = await braveSearch({
        query: args.query,
        count,
        country: args.country,
        search_lang: args.search_lang,
        ui_lang: args.ui_lang,
        freshness: args.freshness,
        timeoutMs: args.timeoutMs,
      });
    } else {
      result = await perplexitySearch({
        query: args.query,
        model: args.model,
        timeoutMs: args.timeoutMs,
      });
    }

    const payload = truncateText(JSON.stringify(result), args.maxChars);
    writeCache(SEARCH_CACHE, cacheKey, { provider, payload }, args.cacheTtlMs);
    return payload;
  },
});
