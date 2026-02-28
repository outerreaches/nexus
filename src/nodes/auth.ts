import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const ED25519_SPKI_RAW_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type GatewayNodeIdentity = {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyPem: string;
  publicKeyRaw: string;
  fingerprint: string;
  privateKeyPath: string;
  publicKeyPath: string;
};

type ParsedNodePublicKey = {
  key: KeyObject;
  raw: string;
  fingerprint: string;
};

function toBase64Url(value: Buffer): string {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function decodeBase64Loose(value: string): Buffer | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  if (/[^A-Za-z0-9+/=]/.test(normalized)) return null;
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Buffer.from(padded, "base64");
  } catch {
    return null;
  }
}

function isEd25519PublicKey(key: KeyObject): boolean {
  return key.type === "public" && key.asymmetricKeyType === "ed25519";
}

function rawFromPublicKey(key: KeyObject): Buffer | null {
  if (!isEd25519PublicKey(key)) return null;
  try {
    const der = key.export({ format: "der", type: "spki" }) as Buffer;
    if (der.length === ED25519_SPKI_RAW_PREFIX.length + 32 && der.subarray(0, ED25519_SPKI_RAW_PREFIX.length).equals(ED25519_SPKI_RAW_PREFIX)) {
      return der.subarray(ED25519_SPKI_RAW_PREFIX.length);
    }
  } catch {
    // ignore
  }
  return null;
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
  const der = Buffer.concat([ED25519_SPKI_RAW_PREFIX, raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

function parsePublicKeyCandidate(value: string): KeyObject | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.includes("BEGIN PUBLIC KEY")) {
    try {
      const key = createPublicKey(trimmed);
      return isEd25519PublicKey(key) ? key : null;
    } catch {
      return null;
    }
  }

  const decoded = decodeBase64Loose(trimmed);
  if (!decoded) return null;

  if (decoded.length === 32) {
    try {
      return publicKeyFromRaw(decoded);
    } catch {
      // ignore
    }
  }

  try {
    const key = createPublicKey({ key: decoded, format: "der", type: "spki" });
    return isEd25519PublicKey(key) ? key : null;
  } catch {
    return null;
  }
}

export function parseNodePublicKey(value: string): ParsedNodePublicKey | null {
  const key = parsePublicKeyCandidate(value);
  if (!key) return null;
  const raw = rawFromPublicKey(key);
  if (!raw) return null;
  return {
    key,
    raw: toBase64Url(raw),
    fingerprint: createHash("sha256").update(raw).digest("hex"),
  };
}

function exportPublicKeyPem(publicKey: KeyObject): string {
  return publicKey.export({ format: "pem", type: "spki" }).toString();
}

export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function withoutSig(value: Record<string, unknown>): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { sig: _sig, ...rest } = value;
  return rest;
}

export function signDetachedPayload(payload: unknown, privateKey: KeyObject): string {
  const bytes = Buffer.from(stableStringify(payload), "utf8");
  const signature = sign(null, bytes, privateKey);
  return toBase64Url(signature);
}

export function verifyDetachedPayload(payload: unknown, signature: string, publicKey: KeyObject): boolean {
  const sigBytes = decodeBase64Loose(signature);
  if (!sigBytes) return false;
  const bytes = Buffer.from(stableStringify(payload), "utf8");
  try {
    return verify(null, bytes, publicKey, sigBytes);
  } catch {
    return false;
  }
}

export function signProtocolEnvelope(envelopeWithoutSig: Record<string, unknown>, privateKey: KeyObject): string {
  return signDetachedPayload(envelopeWithoutSig, privateKey);
}

export function verifyProtocolEnvelope(envelopeWithSig: Record<string, unknown>, publicKey: KeyObject): boolean {
  const sig = typeof envelopeWithSig.sig === "string" ? envelopeWithSig.sig : null;
  if (!sig) return false;
  return verifyDetachedPayload(withoutSig(envelopeWithSig), sig, publicKey);
}

export async function loadOrCreateGatewayIdentity(stateDir: string): Promise<GatewayNodeIdentity> {
  const authDir = path.join(stateDir, "nodes", "auth");
  const privateKeyPath = path.join(authDir, "gateway-ed25519-private.pem");
  const publicKeyPath = path.join(authDir, "gateway-ed25519-public.pem");

  await fs.mkdir(authDir, { recursive: true });

  let privatePem: string | null = null;
  let publicPem: string | null = null;
  try {
    privatePem = await fs.readFile(privateKeyPath, "utf8");
    publicPem = await fs.readFile(publicKeyPath, "utf8");
  } catch {
    const pair = generateKeyPairSync("ed25519");
    privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    publicPem = exportPublicKeyPem(pair.publicKey);
    await fs.writeFile(privateKeyPath, privatePem, { mode: 0o600 });
    await fs.writeFile(publicKeyPath, publicPem, { mode: 0o644 });
  }

  const privateKey = createPrivateKey(privatePem);
  const publicKey = createPublicKey(publicPem);
  const parsedPublic = parseNodePublicKey(publicPem);
  if (!parsedPublic) {
    throw new Error("Failed to parse generated gateway Ed25519 public key.");
  }

  return {
    privateKey,
    publicKey,
    publicKeyPem: publicPem,
    publicKeyRaw: parsedPublic.raw,
    fingerprint: parsedPublic.fingerprint,
    privateKeyPath,
    publicKeyPath,
  };
}
