import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { assertCredentialLocality } from "./locality.js";

export type StoredSecret =
  | { format: "plain"; value: string }
  | { format: "aes-256-gcm"; ivB64: string; tagB64: string; ciphertextB64: string };

export type StoredCredential = {
  id: string;
  username?: string;
  password?: StoredSecret;
  note?: string;
  createdAt: number;
  updatedAt: number;
};

type CredentialStoreFileV1 = {
  version: 1;
  updatedAt: number;
  credentials: StoredCredential[];
};

function getSecretsProcessRole(): string {
  return (process.env.NEXUS_SECRETS_PROCESS_ROLE ?? "gateway").trim().toLowerCase();
}

function assertDirectCredentialAccessAllowed(operation: string): void {
  if (getSecretsProcessRole() === "sidecar") return;
  throw new Error(`secret_sidecar_only_direct_credential_access_blocked:${operation}`);
}

function getVaultKey(): Buffer | null {
  const raw = (process.env.NEXUS_CREDENTIALS_KEY ?? "").trim();
  if (!raw) return null;
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

function resolveCredentialStorePath(stateDir: string): string {
  const explicitFile = (process.env.NEXUS_CREDENTIALS_STORE_PATH ?? "").trim();
  if (explicitFile) {
    if (!path.isAbsolute(explicitFile)) {
      throw new Error("NEXUS_CREDENTIALS_STORE_PATH must be an absolute path.");
    }
    return explicitFile;
  }

  const explicitDir = (process.env.NEXUS_CREDENTIALS_STORE_DIR ?? "").trim();
  if (explicitDir) {
    if (!path.isAbsolute(explicitDir)) {
      throw new Error("NEXUS_CREDENTIALS_STORE_DIR must be an absolute path.");
    }
    return path.join(explicitDir, "credentials.json");
  }

  return path.join(stateDir, "secrets", "credentials.json");
}

function encryptSecret(value: string, key: Buffer): StoredSecret {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    format: "aes-256-gcm",
    ivB64: iv.toString("base64"),
    tagB64: tag.toString("base64"),
    ciphertextB64: ciphertext.toString("base64"),
  };
}

function decryptSecret(secret: StoredSecret, key: Buffer | null): string {
  if (secret.format === "plain") {
    throw new Error("Plaintext credentials are blocked. Set NEXUS_CREDENTIALS_KEY and rotate this entry.");
  }
  if (!key) {
    throw new Error("Credential is encrypted but NEXUS_CREDENTIALS_KEY is not set.");
  }
  const iv = Buffer.from(secret.ivB64, "base64");
  const tag = Buffer.from(secret.tagB64, "base64");
  const ciphertext = Buffer.from(secret.ciphertextB64, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

export function getCredentialStorePath(stateDir: string): string {
  return resolveCredentialStorePath(stateDir);
}

async function loadStore(stateDir: string): Promise<CredentialStoreFileV1> {
  const p = getCredentialStorePath(stateDir);
  try {
    const raw = await fs.readFile(p, "utf8");
    const json = JSON.parse(raw) as CredentialStoreFileV1;
    if (!json || typeof json !== "object" || json.version !== 1 || !Array.isArray(json.credentials)) {
      return { version: 1, updatedAt: Date.now(), credentials: [] };
    }
    return json;
  } catch {
    return { version: 1, updatedAt: Date.now(), credentials: [] };
  }
}

async function saveStore(stateDir: string, store: CredentialStoreFileV1): Promise<void> {
  const p = getCredentialStorePath(stateDir);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const next = { ...store, version: 1 as const, updatedAt: Date.now() };
  await fs.writeFile(p, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

export async function upsertCredential(params: {
  stateDir: string;
  id: string;
  username?: string;
  password?: string;
  note?: string;
  overwrite?: boolean;
}): Promise<{ credential: StoredCredential; passwordEncrypted: boolean }> {
  assertDirectCredentialAccessAllowed("upsert");
  assertCredentialLocality({
    credentialId: params.id,
    operation: "upsert",
  });
  const store = await loadStore(params.stateDir);
  const now = Date.now();
  const existing = store.credentials.find((c) => c.id === params.id) ?? null;

  const vaultKey = getVaultKey();
  if (params.password !== undefined && !vaultKey) {
    throw new Error("Credential writes require NEXUS_CREDENTIALS_KEY to be set.");
  }
  const passwordEncrypted = Boolean(params.password !== undefined && vaultKey);
  const passwordStored: StoredSecret | undefined =
    params.password === undefined ? undefined : encryptSecret(params.password, vaultKey!);

  const next: StoredCredential = params.overwrite
    ? {
        id: params.id,
        username: params.username,
        password: passwordStored,
        note: params.note,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
    : {
        id: params.id,
        username: params.username ?? existing?.username,
        password: passwordStored ?? existing?.password,
        note: params.note ?? existing?.note,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

  const filtered = store.credentials.filter((c) => c.id !== params.id);
  store.credentials = [...filtered, next].sort((a, b) => a.id.localeCompare(b.id));
  await saveStore(params.stateDir, store);

  return { credential: next, passwordEncrypted };
}

export async function deleteCredential(params: { stateDir: string; id: string }): Promise<boolean> {
  assertDirectCredentialAccessAllowed("delete");
  assertCredentialLocality({
    credentialId: params.id,
    operation: "delete",
  });
  const store = await loadStore(params.stateDir);
  const before = store.credentials.length;
  store.credentials = store.credentials.filter((c) => c.id !== params.id);
  if (store.credentials.length === before) return false;
  await saveStore(params.stateDir, store);
  return true;
}

export async function listCredentials(stateDir: string): Promise<Array<{ id: string; hasUsername: boolean; hasPassword: boolean; updatedAt: number; note?: string }>> {
  assertDirectCredentialAccessAllowed("list");
  const store = await loadStore(stateDir);
  return store.credentials.map((c) => ({
    id: c.id,
    hasUsername: Boolean(c.username && c.username.trim()),
    hasPassword: Boolean(c.password),
    updatedAt: c.updatedAt,
    note: c.note,
  }));
}

export async function getCredentialField(params: {
  stateDir: string;
  id: string;
  field: "username" | "password";
}): Promise<string> {
  assertDirectCredentialAccessAllowed("read");
  assertCredentialLocality({
    credentialId: params.id,
    operation: "read",
  });
  const store = await loadStore(params.stateDir);
  const c = store.credentials.find((x) => x.id === params.id);
  if (!c) throw new Error(`Unknown credential id: ${params.id}`);

  if (params.field === "username") {
    const v = (c.username ?? "").trim();
    if (!v) throw new Error(`Credential ${params.id} has no username.`);
    return v;
  }

  if (!c.password) throw new Error(`Credential ${params.id} has no password.`);
  return decryptSecret(c.password, getVaultKey());
}
