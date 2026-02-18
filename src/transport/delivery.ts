export type DeliveryDecision = "ack" | "retry" | "dead_letter";

export function parseRetryAfterHeaderMs(headerValue: string | null, nowMs: number): number | null {
  if (!headerValue) return null;
  const raw = headerValue.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return nowMs + Math.floor(seconds * 1000);
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs) && dateMs > nowMs) return dateMs;
  return null;
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function classifyHttpDelivery(params: {
  status: number;
  nowMs: number;
  attempts: number;
  maxAttempts: number;
  retryAfterHeader: string | null;
  defaultRetryAt: number;
}): { decision: DeliveryDecision; retryAt: number | null } {
  if ((params.status >= 200 && params.status < 300) || params.status === 409) {
    return { decision: "ack", retryAt: null };
  }
  if (!isRetryableHttpStatus(params.status)) {
    return { decision: "dead_letter", retryAt: null };
  }
  if (params.attempts >= params.maxAttempts) {
    return { decision: "dead_letter", retryAt: null };
  }
  const retryAt = parseRetryAfterHeaderMs(params.retryAfterHeader, params.nowMs) ?? params.defaultRetryAt;
  return {
    decision: "retry",
    retryAt,
  };
}
