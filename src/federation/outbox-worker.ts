import type { NexusDatabase } from "../storage/database.js";
import {
  listFederationOutbox,
  updateFederationOutboxStatus,
  type FederationOutboxRecord,
} from "../storage/federation.js";

export type FederationOutboxDispatchResult = {
  ok: boolean;
  terminal?: boolean;
  retryAt?: number;
  error?: string;
};

export type FederationOutboxDispatcher = (item: FederationOutboxRecord) => Promise<FederationOutboxDispatchResult>;

export type FederationOutboxWorker = {
  /** Stops the timer and resolves once any in-flight tick has settled. */
  stop: () => Promise<void>;
  tick: () => Promise<number>;
};

export function startFederationOutboxWorker(params: {
  db: NexusDatabase;
  dispatch: FederationOutboxDispatcher;
  log?: (msg: string) => void;
  intervalMs?: number;
  maxBatch?: number;
}): FederationOutboxWorker {
  const log = params.log ?? (() => {});
  const intervalMs = Math.max(1_000, params.intervalMs ?? 5_000);
  const maxBatch = Math.max(1, params.maxBatch ?? 20);
  let closed = false;
  let inFlight = false;
  let lastTickPromise: Promise<unknown> | null = null;

  const tick = async (): Promise<number> => {
    if (closed || inFlight) return 0;
    inFlight = true;
    try {
      const nowMs = Date.now();
      const candidates = listFederationOutbox(params.db, {
        limit: maxBatch * 3,
      }).filter(
        (item) =>
          (item.status === "pending" || item.status === "failed") &&
          (item.nextAttemptAt == null || item.nextAttemptAt <= nowMs),
      ).slice(0, maxBatch);
      let processed = 0;

      for (const item of candidates) {
        const attempts = item.attempts + 1;
        updateFederationOutboxStatus(params.db, {
          id: item.id,
          status: "sending",
          attempts,
          lastAttemptAt: nowMs,
          nowMs,
        });

        try {
          const result = await params.dispatch(item);
          if (result.ok) {
            updateFederationOutboxStatus(params.db, {
              id: item.id,
              status: "sent",
              attempts,
              lastAttemptAt: nowMs,
              nextAttemptAt: null,
              lastError: null,
              nowMs,
            });
          } else {
            if (result.terminal) {
              updateFederationOutboxStatus(params.db, {
                id: item.id,
                status: "dead_letter",
                attempts,
                lastAttemptAt: nowMs,
                nextAttemptAt: null,
                lastError: result.error ?? "dispatch_terminal_failure",
                nowMs,
              });
              processed += 1;
              continue;
            }
            const retryAt = result.retryAt ?? (nowMs + Math.min(60_000, attempts * 5_000));
            updateFederationOutboxStatus(params.db, {
              id: item.id,
              status: "failed",
              attempts,
              lastAttemptAt: nowMs,
              nextAttemptAt: retryAt,
              lastError: result.error ?? "dispatch_failed",
              nowMs,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const retryAt = nowMs + Math.min(60_000, attempts * 5_000);
          updateFederationOutboxStatus(params.db, {
            id: item.id,
            status: "failed",
            attempts,
            lastAttemptAt: nowMs,
            nextAttemptAt: retryAt,
            lastError: message,
            nowMs,
          });
        }
        processed += 1;
      }

      if (processed > 0) {
        log(`federation/outbox: processed=${processed}`);
      }
      return processed;
    } finally {
      inFlight = false;
    }
  };

  const trackedTick = (): Promise<number> => {
    const p = tick();
    lastTickPromise = p.catch(() => undefined);
    return p;
  };

  const timer = setInterval(() => {
    void trackedTick().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log(`federation/outbox: tick_failed err=${message}`);
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop: async () => {
      closed = true;
      clearInterval(timer);
      if (lastTickPromise) await lastTickPromise;
    },
    tick: trackedTick,
  };
}
