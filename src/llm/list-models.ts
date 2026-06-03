import type { NexusConfig } from "../state/config.js";

/**
 * Enumerates candidate models for a provider so the CLI `/model` picker has
 * something to scroll through. Two sources:
 *
 *  - {@link listProviderModels} — a live `GET {baseUrl}/models` call against the
 *    OpenAI-compatible provider. Accurate and complete, but requires the
 *    provider to expose the endpoint and to be reachable.
 *  - {@link collectConfiguredModels} — the union of models already referenced in
 *    nexus.json for that provider. Always available offline; used as a fallback
 *    when the live call fails or isn't supported (e.g. dynamic-credential
 *    providers like codex, or air-gapped local endpoints).
 */

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalizedBase).toString();
}

export type ListProviderModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; error: string };

const DEFAULT_TIMEOUT_MS = 6_000;

/**
 * Fetch the model catalogue from an OpenAI-compatible provider. Never throws —
 * failures (timeout, non-2xx, malformed body, missing endpoint) come back as
 * `{ ok: false, error }` so the caller can fall back gracefully.
 */
export async function listProviderModels(params: {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<ListProviderModelsResult> {
  const baseUrl = (params.baseUrl ?? "").trim();
  if (!baseUrl || baseUrl === "dynamic") {
    return { ok: false, error: "provider has no static base URL" };
  }
  let url: string;
  try {
    url = joinUrl(baseUrl, "models");
  } catch {
    return { ok: false, error: `invalid base URL: ${baseUrl}` };
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        ...(params.apiKey ? { Authorization: `Bearer ${params.apiKey}` } : {}),
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}`.trim() };
    }
    const body = await res.json().catch(() => null);
    const models = parseModelIds(body);
    if (models.length === 0) return { ok: false, error: "no models returned" };
    return { ok: true, models };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: controller.signal.aborted ? "request timed out" : msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract model ids from an OpenAI-compatible `/models` response. Tolerates the
 * `{ data: [...] }` envelope, a bare array, and entries that are either strings
 * or `{ id }` / `{ name }` objects.
 */
export function parseModelIds(body: unknown): string[] {
  const arr = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
      ? ((body as { data: unknown[] }).data)
      : [];
  const ids: string[] = [];
  for (const entry of arr) {
    if (typeof entry === "string") {
      if (entry.trim()) ids.push(entry.trim());
      continue;
    }
    if (entry && typeof entry === "object") {
      const raw = (entry as { id?: unknown }).id ?? (entry as { name?: unknown }).name;
      if (typeof raw === "string" && raw.trim()) ids.push(raw.trim());
    }
  }
  return dedupeSorted(ids);
}

/**
 * Collect the models referenced for `providerName` across nexus.json: the
 * provider's own default model, plus any routing/tool-routing entries that
 * target that provider. Used as the offline fallback for the picker.
 */
export function collectConfiguredModels(config: NexusConfig, providerName: string): string[] {
  const out: string[] = [];
  const push = (model: string | undefined | null): void => {
    if (typeof model === "string" && model.trim()) out.push(model.trim());
  };

  if (providerName === "default") push(config.llm.openaiCompat.model);
  else push(config.llm.providers[providerName]?.model);

  const routing = config.llm.routing;
  const considerRoute = (route?: {
    primary?: { provider: string; model?: string };
    fallback?: { provider: string; model?: string };
  }): void => {
    for (const target of [route?.primary, route?.fallback]) {
      if (target && target.provider === providerName) push(target.model);
    }
  };
  considerRoute(routing.default);
  for (const route of Object.values(routing.byPreset ?? {})) considerRoute(route);
  for (const route of Object.values(routing.byAgent ?? {})) considerRoute(route);

  const considerTool = (entry?: { provider?: string; model?: string }): void => {
    if (entry && entry.provider === providerName) push(entry.model);
  };
  for (const entry of Object.values(config.llm.toolRouting.default ?? {})) considerTool(entry);
  for (const preset of Object.values(config.llm.toolRouting.byPreset ?? {})) {
    for (const entry of Object.values(preset ?? {})) considerTool(entry);
  }
  for (const agent of Object.values(config.llm.toolRouting.byAgent ?? {})) {
    for (const entry of Object.values(agent ?? {})) considerTool(entry);
  }

  return dedupeSorted(out);
}

/** Merge live + configured model lists into one sorted, de-duplicated list. */
export function mergeModelLists(...lists: string[][]): string[] {
  return dedupeSorted(lists.flat());
}

function dedupeSorted(items: string[]): string[] {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}
