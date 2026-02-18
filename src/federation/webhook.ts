import crypto, { type KeyObject } from "node:crypto";

export type FederationWebhookEnvelope<TPayload = Record<string, unknown>> = {
  schemaVersion: "1.0";
  eventId: string;
  traceId: string;
  kind: string;
  sourceInstance: string;
  destination: {
    peerId?: string;
    endpointId: string;
  };
  ts: number;
  nonce: string;
  idempotencyKey: string;
  sensitivity: string;
  payload: TPayload;
  meta: {
    attempt: number;
    maxAttempts: number;
    orderingKey: string;
  };
};

export function sha256LowerHex(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex").toLowerCase();
}

export function buildWebhookCanonicalSigningInput(params: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  eventId: string;
  bodyBytes: string | Uint8Array;
}): string {
  return [
    params.method.toUpperCase(),
    params.path,
    params.timestamp,
    params.nonce,
    params.eventId,
    sha256LowerHex(params.bodyBytes),
  ].join("\n");
}

export function signWebhookCanonicalInput(input: string, privateKey: KeyObject): string {
  const signature = crypto.sign(null, Buffer.from(input, "utf8"), privateKey).toString("base64");
  return `ed25519:${signature}`;
}

export function signWebhookCanonicalInputHmac(input: string, sharedSecret: string): string {
  const digest = crypto
    .createHmac("sha256", Buffer.from(sharedSecret, "utf8"))
    .update(input, "utf8")
    .digest("base64");
  return `hmac-sha256:${digest}`;
}

export function verifyWebhookCanonicalInput(params: {
  input: string;
  signatureHeader: string;
  publicKey: KeyObject;
}): boolean {
  const raw = params.signatureHeader.trim();
  if (!raw) return false;
  const [alg, payload] = raw.split(":", 2);
  if (alg !== "ed25519" || !payload) return false;
  let signature: Buffer;
  try {
    signature = Buffer.from(payload, "base64");
  } catch {
    return false;
  }
  return crypto.verify(null, Buffer.from(params.input, "utf8"), params.publicKey, signature);
}

export function verifyWebhookCanonicalInputHmac(params: {
  input: string;
  signatureHeader: string;
  sharedSecret: string;
}): boolean {
  const raw = params.signatureHeader.trim();
  const [alg, payload] = raw.split(":", 2);
  if (alg !== "hmac-sha256" || !payload) return false;
  const expected = signWebhookCanonicalInputHmac(params.input, params.sharedSecret);
  const expectedPayload = expected.split(":", 2)[1] ?? "";
  const actual = Buffer.from(payload, "base64");
  const baseline = Buffer.from(expectedPayload, "base64");
  if (actual.length !== baseline.length) return false;
  return crypto.timingSafeEqual(actual, baseline);
}

export function eventTypeMatchesFilter(eventType: string, filter: string): boolean {
  const eventValue = eventType.trim();
  const filterValue = filter.trim();
  if (!eventValue || !filterValue) return false;
  if (filterValue === "*") return true;
  if (filterValue.endsWith("*")) {
    const prefix = filterValue.slice(0, -1);
    return eventValue.startsWith(prefix);
  }
  return eventValue === filterValue;
}
