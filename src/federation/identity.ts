import { createPrivateKey, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { parseNodePublicKey } from "../nodes/auth.js";
import type { NexusDatabase } from "../storage/database.js";
import { getPreferredIdentityKeyForScope, upsertIdentityKey, type IdentityKeyRecord } from "../storage/federation.js";

const FEDERATION_KEY_SCOPE = "federation";

export type FederationSigningIdentity = {
  kid: string;
  privateKey: KeyObject;
  publicKeyRaw: string;
  fingerprint: string;
  privateKeyRef: string;
  loadedFrom: "keyring" | "generated";
};

function parseFilePrivateKeyRef(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("file:")) return null;
  const filePath = trimmed.slice("file:".length).trim();
  return filePath || null;
}

async function tryLoadIdentityFromKeyringRecord(record: IdentityKeyRecord): Promise<FederationSigningIdentity | null> {
  const privateKeyPath = parseFilePrivateKeyRef(record.privateKeyRef);
  if (!privateKeyPath) return null;
  const parsedPublic = parseNodePublicKey(record.publicKey);
  if (!parsedPublic) return null;
  try {
    const privatePem = await fs.readFile(privateKeyPath, "utf8");
    const privateKey = createPrivateKey(privatePem);
    return {
      kid: record.kid,
      privateKey,
      publicKeyRaw: parsedPublic.raw,
      fingerprint: parsedPublic.fingerprint,
      privateKeyRef: `file:${privateKeyPath}`,
      loadedFrom: "keyring",
    };
  } catch {
    return null;
  }
}

async function generateFederationSigningIdentity(params: {
  db: NexusDatabase;
  stateDir: string;
  nowMs: number;
}): Promise<FederationSigningIdentity> {
  const keyPair = generateKeyPairSync("ed25519");
  const privatePem = keyPair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicPem = keyPair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const parsedPublic = parseNodePublicKey(publicPem);
  if (!parsedPublic) {
    throw new Error("failed to parse generated federation public key");
  }

  const kid = `fed-${params.nowMs.toString(36)}-${randomUUID().slice(0, 8)}`;
  const authDir = path.join(params.stateDir, "federation", "auth");
  await fs.mkdir(authDir, { recursive: true });
  const privateKeyPath = path.join(authDir, `${kid}-private.pem`);
  const publicKeyPath = path.join(authDir, `${kid}-public.pem`);
  await fs.writeFile(privateKeyPath, privatePem, { mode: 0o600 });
  await fs.writeFile(publicKeyPath, publicPem, { mode: 0o644 });

  upsertIdentityKey(params.db, {
    scope: FEDERATION_KEY_SCOPE,
    kid,
    publicKey: parsedPublic.raw,
    privateKeyRef: `file:${privateKeyPath}`,
    status: "active",
    notBefore: params.nowMs,
    metadata: {
      algorithm: "ed25519",
      managed: true,
      publicKeyPath,
    },
    nowMs: params.nowMs,
  });

  return {
    kid,
    privateKey: keyPair.privateKey,
    publicKeyRaw: parsedPublic.raw,
    fingerprint: parsedPublic.fingerprint,
    privateKeyRef: `file:${privateKeyPath}`,
    loadedFrom: "generated",
  };
}

export async function loadOrCreateFederationSigningIdentity(params: {
  db: NexusDatabase;
  stateDir: string;
  nowMs?: number;
  log?: (msg: string) => void;
}): Promise<FederationSigningIdentity> {
  const nowMs = params.nowMs ?? Date.now();
  const log = params.log ?? (() => {});

  const preferred = getPreferredIdentityKeyForScope(params.db, {
    scope: FEDERATION_KEY_SCOPE,
    nowMs,
  });
  if (preferred) {
    const loaded = await tryLoadIdentityFromKeyringRecord(preferred);
    if (loaded) return loaded;
    log(`federation/auth: identity kid=${preferred.kid} could not be loaded from private_key_ref; generating replacement`);
  }

  const generated = await generateFederationSigningIdentity({
    db: params.db,
    stateDir: params.stateDir,
    nowMs,
  });
  log(`federation/auth: generated signing identity kid=${generated.kid}`);
  return generated;
}

