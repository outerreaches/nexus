export type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  insertedAt: number;
};

const DEFAULT_CACHE_MAX_ENTRIES = 200;

export function normalizeCacheKey(key: string): string {
  return key.trim().toLowerCase();
}

export function readCache<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

export function writeCache<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
  if (ttlMs <= 0) return;
  if (cache.size >= DEFAULT_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { value, expiresAt: Date.now() + ttlMs, insertedAt: Date.now() });
}

export function withTimeout(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (parent) {
    parent.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        controller.abort();
      },
      { once: true },
    );
  }
  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
    },
    { once: true },
  );
  return controller.signal;
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated]`;
}

export async function readResponseText(res: Response, maxChars: number = 4000): Promise<string> {
  try {
    const text = await res.text();
    if (text.length > maxChars) return text.slice(0, maxChars);
    return text;
  } catch {
    return "";
  }
}

