// llama.cpp slot save/restore manager.
//
// Background: llama.cpp's server has a fixed pool of N slots (--np N), each
// holding its own KV cache. With --slot-save-path set, the server can persist
// a slot's KV cache to disk and restore it later. This module multiplexes
// multiple logical sessions (e.g. telegram:CHAT:interactive:orchestrator,
// heartbeat:gateway:background:orchestrator) onto a small physical slot pool,
// transparently swapping state in/out as logical owners rotate.
//
// Strategy: LRU. Each call acquires the slot for a given slotKey under a per-
// slot mutex. If the slot already belongs to that key, we just use it. If it
// belongs to a different key, we save the old owner to disk and try to
// restore the new owner. Save-to-disk only happens on eviction; the hot path
// (same-key reuse) is mutex acquire/release, no I/O.

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalizedBase).toString();
}

/** Strip any path/query/fragment from `baseUrl` and return the server origin
 *  (`scheme://host[:port]`). llama.cpp registers slot save/restore handlers at
 *  the server ROOT (`/slots/{id_slot}`), not under the OpenAI-compat `/v1/`
 *  prefix, so we must hit the origin directly — otherwise every save/restore
 *  POST 404s with llama.cpp's generic "route not registered" body. */
export function deriveSlotEndpointBaseUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return baseUrl;
  }
}

export type SlotCacheManagerOptions = {
  /** Base URL of the llama.cpp server (same as OpenAICompatConfig.baseUrl).
   *  Used to derive the slot endpoint root (path stripped) unless
   *  `slotEndpointBaseUrl` overrides it. */
  baseUrl: string;
  /** Optional explicit override for the slot save/restore endpoint root.
   *  Use this when the server lives behind a reverse proxy / path prefix
   *  (e.g. `https://gateway/llama`). Defaults to `baseUrl` with its path
   *  stripped, which is correct for raw `llama-server` deployments. */
  slotEndpointBaseUrl?: string;
  /** Bearer token if the server requires auth. */
  apiKey?: string;
  /** Slot count, must match the server's -np flag. */
  slotCount: number;
  /** Per-call save/restore HTTP timeout. */
  requestTimeoutMs?: number;
  /** Logger. */
  log?: (line: string) => void;
};

/** Public handle returned by acquire(). Caller must invoke release() in finally. */
export type SlotLease = {
  slotId: number;
  slotKey: string;
  /** Were we able to restore prior state for this key from disk? */
  restored: boolean;
  /** Release the per-slot lock so other callers can use it. */
  release: () => void;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

type SlotState = {
  /** Currently-owning logical key, or null if the slot has never been used. */
  owner: string | null;
  /** Monotonic counter used for LRU ordering. Higher = more recent. */
  lastUsedTick: number;
  /** FIFO queue of waiters when the slot is locked. */
  queue: Array<() => void>;
  /** True while a caller holds the slot. */
  locked: boolean;
};

/** Sanitize a slotKey into a safe filename: keep [A-Za-z0-9._-], replace the
 *  rest with underscores. Falls back to a sha1-style hash for very long keys.
 *  llama.cpp resolves filenames relative to --slot-save-path so no traversal. */
export function sanitizeSlotFilename(slotKey: string): string {
  const cleaned = slotKey.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (cleaned.length > 0 && cleaned.length <= 200) return `${cleaned}.bin`;
  // Pathological key: bucket into a short hash. Use a simple FNV-1a 32-bit
  // hash to keep this dep-free (slot keys are short and non-adversarial).
  let hash = 0x811c9dc5;
  for (let i = 0; i < slotKey.length; i++) {
    hash ^= slotKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `slot_${hex}.bin`;
}

export class SlotCacheManager {
  private readonly slots: SlotState[];
  private readonly ownerToSlot = new Map<string, number>();
  private readonly opts: SlotCacheManagerOptions;
  private readonly slotEndpointBaseUrl: string;
  private tick = 0;

  constructor(opts: SlotCacheManagerOptions) {
    if (!Number.isInteger(opts.slotCount) || opts.slotCount < 1) {
      throw new Error(`SlotCacheManager: slotCount must be >= 1 (got ${opts.slotCount})`);
    }
    this.opts = opts;
    this.slotEndpointBaseUrl = opts.slotEndpointBaseUrl ?? deriveSlotEndpointBaseUrl(opts.baseUrl);
    this.slots = Array.from({ length: opts.slotCount }, () => ({
      owner: null,
      lastUsedTick: 0,
      queue: [],
      locked: false,
    }));
    opts.log?.(`slot_cache_init slots=${opts.slotCount} endpoint=${this.slotEndpointBaseUrl}/slots/{N}`);
  }

  /** Acquire the slot for a logical key. Serializes concurrent acquires for
   *  the same physical slot. May save the previous owner's state to disk and
   *  restore the new owner's state if a saved file exists. */
  async acquire(slotKey: string): Promise<SlotLease> {
    if (!slotKey) throw new Error("SlotCacheManager.acquire: slotKey must be non-empty");

    // Step 1: figure out which physical slot this key should land on, without
    // holding any locks. The decision may shift between iterations if other
    // callers reshuffle ownership, so we re-check inside the loop.
    for (;;) {
      const existing = this.ownerToSlot.get(slotKey);
      if (existing !== undefined) {
        // Key already has a slot assignment; wait for that slot's lock.
        await this.waitForSlot(existing);
        // Re-verify ownership after waking up — another caller could have
        // evicted us between assignment and lock acquisition.
        if (this.ownerToSlot.get(slotKey) !== existing) {
          this.unlock(existing);
          continue;
        }
        this.touch(existing);
        return this.makeLease(slotKey, existing, false);
      }

      // Step 2: no existing assignment. Find an unowned slot first; otherwise
      // pick the LRU owned slot to evict. We lock the candidate before doing
      // any I/O so the eviction is atomic from the caller's perspective.
      const unowned = this.slots.findIndex((s) => s.owner === null);
      const candidate = unowned >= 0 ? unowned : this.pickLruIndex();

      await this.waitForSlot(candidate);

      // Re-check: someone else may have acquired this key while we were
      // waiting. If so, drop the lock and start over (now we'll find the
      // existing assignment).
      if (this.ownerToSlot.has(slotKey)) {
        this.unlock(candidate);
        continue;
      }
      // Re-check that this slot is still a good eviction target. If its owner
      // changed under us (very rare race in single-process Nexus, but cheap
      // to guard), pick again.
      const stateNow = this.slots[candidate]!;
      const prevOwner = stateNow.owner;

      // Perform eviction if needed, then attempt restore.
      //
      // Save/restore HTTP failures are intentionally soft-failed here. As
      // long as we end up returning a lease, the caller pins `id_slot` on
      // the request, so cross-session KV thrash from llama.cpp's LCP picker
      // is impossible. What we lose on failure is the persistence layer
      // (cache state doesn't survive eviction), which is a graceful
      // degradation — far better than blocking the user's request because
      // the admin API hiccupped.
      let restored = false;
      if (prevOwner && prevOwner !== slotKey) {
        try {
          await this.saveSlot(candidate, prevOwner);
        } catch (err) {
          this.opts.log?.(
            `slot_cache_save_failed slot=${candidate} key=${prevOwner} err=${
              err instanceof Error ? err.message : String(err)
            } — proceeding without persisting prior state`,
          );
        }
        this.ownerToSlot.delete(prevOwner);
      }
      try {
        // Try restore; if no file exists this is a cheap no-op (404).
        restored = await this.restoreSlot(candidate, slotKey);
      } catch (err) {
        this.opts.log?.(
          `slot_cache_restore_failed slot=${candidate} key=${slotKey} err=${
            err instanceof Error ? err.message : String(err)
          } — proceeding with fresh slot state`,
        );
        // Clear any partial KV state so the request starts from a known
        // empty slot instead of inheriting whatever survived the failed
        // restore attempt.
        try { await this.eraseSlot(candidate); } catch { /* best-effort */ }
        restored = false;
      }
      stateNow.owner = slotKey;
      this.ownerToSlot.set(slotKey, candidate);
      this.touch(candidate);
      return this.makeLease(slotKey, candidate, restored);
    }
  }

  /** Save every currently-owned slot's state to disk. Call from graceful
   *  shutdown handlers when you want crash-safe persistence beyond the
   *  eviction-only default. */
  async flushAll(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < this.slots.length; i++) {
      const state = this.slots[i]!;
      if (state.owner) tasks.push(this.saveSlot(i, state.owner));
    }
    await Promise.allSettled(tasks);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private touch(slotId: number): void {
    this.tick += 1;
    this.slots[slotId]!.lastUsedTick = this.tick;
  }

  private pickLruIndex(): number {
    let lru = 0;
    let lruTick = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.slots.length; i++) {
      const t = this.slots[i]!.lastUsedTick;
      if (t < lruTick) {
        lru = i;
        lruTick = t;
      }
    }
    return lru;
  }

  private waitForSlot(slotId: number): Promise<void> {
    const state = this.slots[slotId]!;
    if (!state.locked) {
      state.locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      state.queue.push(resolve);
    });
  }

  private unlock(slotId: number): void {
    const state = this.slots[slotId]!;
    const next = state.queue.shift();
    if (next) {
      // Stay locked; hand off to the next waiter.
      next();
    } else {
      state.locked = false;
    }
  }

  private makeLease(slotKey: string, slotId: number, restored: boolean): SlotLease {
    let released = false;
    return {
      slotKey,
      slotId,
      restored,
      release: () => {
        if (released) return;
        released = true;
        this.unlock(slotId);
      },
    };
  }

  private async saveSlot(slotId: number, slotKey: string): Promise<void> {
    const filename = sanitizeSlotFilename(slotKey);
    this.opts.log?.(`slot_cache_save slot=${slotId} key=${slotKey} file=${filename}`);
    const { res, url } = await this.slotRequest(slotId, "save", { filename });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(this.formatSlotEndpointError("save", res.status, res.statusText, body, url));
    }
  }

  private async restoreSlot(slotId: number, slotKey: string): Promise<boolean> {
    const filename = sanitizeSlotFilename(slotKey);
    const { res, url } = await this.slotRequest(slotId, "restore", { filename });
    if (res.ok) {
      this.opts.log?.(`slot_cache_restore slot=${slotId} key=${slotKey} file=${filename} status=ok`);
      return true;
    }
    // 404 / "file not found" is the expected first-call path — not an error.
    if (res.status === 404) {
      this.opts.log?.(`slot_cache_restore slot=${slotId} key=${slotKey} status=not_found`);
      return false;
    }
    const body = await res.text().catch(() => "");
    if (/file (?:does )?not (?:exist|found)/i.test(body)) {
      this.opts.log?.(`slot_cache_restore slot=${slotId} key=${slotKey} status=not_found`);
      return false;
    }
    throw new Error(this.formatSlotEndpointError("restore", res.status, res.statusText, body, url));
  }

  private async eraseSlot(slotId: number): Promise<void> {
    this.opts.log?.(`slot_cache_erase slot=${slotId}`);
    await this.slotRequest(slotId, "erase", {});
  }

  private async slotRequest(
    slotId: number,
    action: "save" | "restore" | "erase",
    body: Record<string, unknown>,
  ): Promise<{ res: Response; url: string }> {
    const url = `${joinUrl(this.slotEndpointBaseUrl, `slots/${slotId}`)}?action=${action}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { res, url };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Format a slot endpoint error with the URL we hit + a hint about the two
   *  common llama.cpp misconfigurations (wrong path or `--slot-save-path`
   *  unset). Operators reading the log get an actionable message instead of
   *  a generic 404. */
  private formatSlotEndpointError(
    action: "save" | "restore",
    status: number,
    statusText: string,
    body: string,
    url: string,
  ): string {
    const tail = body ? ` — ${body}` : "";
    if (status === 404) {
      return (
        `slot ${action} failed: 404 ${statusText} at ${url}${tail}. ` +
        `llama.cpp returns 404 here when (a) the slot endpoint URL is wrong ` +
        `(must be POST <server_root>/slots/{N}, not under /v1) or (b) the ` +
        `server was started without --slot-save-path. Verify both.`
      );
    }
    return `slot ${action} failed: ${status} ${statusText} at ${url}${tail}`;
  }
}
