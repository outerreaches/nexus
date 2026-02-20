import { z } from "zod";

import { defineTool } from "../core/tools.js";
import { getSecret } from "../secrets/resolve-env.js";
import type { CacheEntry } from "./web-shared.js";
import { normalizeCacheKey, readCache, readResponseText, truncateText, withTimeout, writeCache } from "./web-shared.js";

const SEARCH_CACHE = new Map<string, CacheEntry<{ provider: string; payload: string }>>();

const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30_000;

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";

function resolveProvider(preferred: "auto" | "brave" | "perplexity"): "brave" | "perplexity" | null {
  if (preferred === "brave") return "brave";
  if (preferred === "perplexity") return "perplexity";
  const hasBrave = Boolean((getSecret("BRAVE_API_KEY") ?? "").trim());
  const hasPerplexityKey = Boolean((getSecret("PERPLEXITY_API_KEY") ?? "").trim());
  // OpenClaw-style default: prefer Brave; if key is missing, ask the operator to configure,
  // rather than silently falling back to a paid LLM search provider.
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

export const webSearch = defineTool({
  name: "web_search",
  description: "Search the web (Brave structured results or Perplexity Sonar via OpenRouter) with caching + timeouts.",
  parameters: z.object({
    query: z.string().min(1).max(600),
    provider: z.enum(["auto", "brave", "perplexity"]).default("auto"),
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
  execute: async (args) => {
    const provider = resolveProvider(args.provider);
    if (!provider) {
      return [
        "ERROR: web_search is not configured.",
        "By default, web_search expects BRAVE_API_KEY (Brave Search API).",
        'If you prefer Perplexity Sonar, call web_search with provider="perplexity" and set PERPLEXITY_API_KEY (direct) or OPENROUTER_API_KEY (via OpenRouter).',
      ].join("\n");
    }

    const count = clampCount(args.count);
    const cacheKey = normalizeCacheKey(
      provider === "brave"
        ? `brave:${args.query}:${count}:${args.country ?? "default"}:${args.search_lang ?? "default"}:${args.ui_lang ?? "default"}:${args.freshness ?? "default"}`
        : `perplexity:${args.query}:${args.model}`,
    );

    const cached = readCache(SEARCH_CACHE, cacheKey);
    if (cached) return cached.payload;

    const result =
      provider === "brave"
        ? await braveSearch({
          query: args.query,
          count,
          country: args.country,
          search_lang: args.search_lang,
          ui_lang: args.ui_lang,
          freshness: args.freshness,
          timeoutMs: args.timeoutMs,
        })
        : await perplexitySearch({
          query: args.query,
          model: args.model,
          timeoutMs: args.timeoutMs,
        });

    const payload = truncateText(JSON.stringify(result, null, 2), args.maxChars);
    writeCache(SEARCH_CACHE, cacheKey, { provider, payload }, args.cacheTtlMs);
    return payload;
  },
});
