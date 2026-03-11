import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { assertCredentialLocality } from "./locality.js";

export type StoredSecret =
  { format: "aes-256-gcm"; ivB64: string; tagB64: string; ciphertextB64: string };

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

const CREDENTIAL_STORE_VERSION = 1 as const;
const CREDENTIAL_STORE_FILE = "credentials.json";
const credentialStoreLocks = new Map<string, Promise<void>>();
const CREDENTIAL_STORE_LOCK_WAIT_MS = 50;
const CREDENTIAL_STORE_LOCK_TIMEOUT_MS = 15_000;
const CREDENTIAL_STORE_LOCK_STALE_MS = 60_000;

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

function resolveCredentialStoreDir(): string {
  const explicitDir = (process.env.NEXUS_CREDENTIALS_STORE_DIR ?? "").trim();
  if (!explicitDir) {
    throw new Error(
      "NEXUS_CREDENTIALS_STORE_DIR is required; legacy state-dir credential storage is no longer supported.",
    );
  }
  if (!path.isAbsolute(explicitDir)) {
    throw new Error("NEXUS_CREDENTIALS_STORE_DIR must be an absolute path.");
  }
  return explicitDir;
}

function resolveCredentialStorePath(stateDir: string): string {
  void stateDir;
  return path.join(resolveCredentialStoreDir(), CREDENTIAL_STORE_FILE);
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

export function getLegacyCredentialStorePath(stateDir: string): string {
  return path.join(stateDir, "secrets", CREDENTIAL_STORE_FILE);
}

function emptyStore(nowMs: number): CredentialStoreFileV1 {
  return {
    version: CREDENTIAL_STORE_VERSION,
    updatedAt: nowMs,
    credentials: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("credential_store_invalid_format");
  }
  return value as Record<string, unknown>;
}

function parseTimestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`credential_store_invalid_${field}`);
  }
  return Math.floor(value);
}

function parseStoredSecret(value: unknown): StoredSecret | undefined {
  if (value === undefined || value === null) return undefined;
  const rec = asRecord(value);
  const format = typeof rec.format === "string" ? rec.format : "";
  if (format === "plain") {
    throw new Error("Plaintext credentials are blocked. Set NEXUS_CREDENTIALS_KEY and rotate this entry.");
  }
  if (format !== "aes-256-gcm") {
    throw new Error("credential_store_invalid_secret_format");
  }
  const ivB64 = typeof rec.ivB64 === "string" ? rec.ivB64 : "";
  const tagB64 = typeof rec.tagB64 === "string" ? rec.tagB64 : "";
  const ciphertextB64 = typeof rec.ciphertextB64 === "string" ? rec.ciphertextB64 : "";
  if (!ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error("credential_store_invalid_secret_payload");
  }
  return { format: "aes-256-gcm", ivB64, tagB64, ciphertextB64 };
}

function parseStoredCredential(value: unknown): StoredCredential {
  const rec = asRecord(value);
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!id) throw new Error("credential_store_invalid_credential_id");
  const username = typeof rec.username === "string" ? rec.username : undefined;
  const note = typeof rec.note === "string" ? rec.note : undefined;
  const createdAt = parseTimestamp(rec.createdAt, "createdAt");
  const updatedAt = parseTimestamp(rec.updatedAt, "updatedAt");
  const password = parseStoredSecret(rec.password);
  return {
    id,
    username,
    password,
    note,
    createdAt,
    updatedAt,
  };
}

function parseStore(raw: string): CredentialStoreFileV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("credential_store_parse_failed");
  }
  const rec = asRecord(parsed);
  if (rec.version !== CREDENTIAL_STORE_VERSION) {
    throw new Error("credential_store_invalid_version");
  }
  if (!Array.isArray(rec.credentials)) {
    throw new Error("credential_store_invalid_credentials_array");
  }
  const updatedAt = parseTimestamp(rec.updatedAt, "updatedAt");
  const credentials = rec.credentials.map(parseStoredCredential);
  return {
    version: CREDENTIAL_STORE_VERSION,
    updatedAt,
    credentials,
  };
}

async function loadStore(stateDir: string): Promise<CredentialStoreFileV1> {
  const p = getCredentialStorePath(stateDir);
  try {
    const raw = await fs.readFile(p, "utf8");
    return parseStore(raw);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "";
    if (code === "ENOENT") {
      return emptyStore(Date.now());
    }
    if (err instanceof Error) throw err;
    throw new Error(`credential_store_read_failed:${String(err)}`);
  }
}

async function saveStore(stateDir: string, store: CredentialStoreFileV1): Promise<void> {
  const p = getCredentialStorePath(stateDir);
  const dir = path.dirname(p);
  await fs.mkdir(dir, { recursive: true });
  const now = Date.now();
  const next = {
    ...store,
    version: CREDENTIAL_STORE_VERSION,
    updatedAt: now,
  };
  const tmpPath = path.join(
    dir,
    `.credentials.${process.pid}.${now}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tmpPath, JSON.stringify(next, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tmpPath, p);
    await fs.chmod(p, 0o600).catch(() => {});
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function acquireStoreFileLock(storePath: string): Promise<Awaited<ReturnType<typeof fs.open>>> {
  const lockPath = `${storePath}.lock`;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + CREDENTIAL_STORE_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          createdAt: Date.now(),
        }) + "\n",
        "utf8",
      ).catch(() => {});
      return handle;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code ?? "";
      if (code !== "EEXIST") {
        if (err instanceof Error) throw err;
        throw new Error(`credential_store_lock_failed:${String(err)}`);
      }

      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > CREDENTIAL_STORE_LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true }).catch(() => {});
          continue;
        }
      } catch (statErr) {
        const statCode = (statErr as NodeJS.ErrnoException)?.code ?? "";
        if (statCode === "ENOENT") continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`credential_store_lock_timeout:${lockPath}`);
      }
      await sleep(CREDENTIAL_STORE_LOCK_WAIT_MS);
    }
  }
}

async function releaseStoreFileLock(storePath: string, handle: Awaited<ReturnType<typeof fs.open>>): Promise<void> {
  const lockPath = `${storePath}.lock`;
  await handle.close().catch(() => {});
  await fs.rm(lockPath, { force: true }).catch(() => {});
}

async function withStoreLock<T>(stateDir: string, fn: () => Promise<T>): Promise<T> {
  const storePath = getCredentialStorePath(stateDir);
  const prev = credentialStoreLocks.get(storePath) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prev.then(() => gate);
  credentialStoreLocks.set(storePath, tail);
  await prev;
  let fileLock: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fileLock = await acquireStoreFileLock(storePath);
    return await fn();
  } finally {
    if (fileLock) {
      await releaseStoreFileLock(storePath, fileLock);
    }
    release();
    if (credentialStoreLocks.get(storePath) === tail) {
      credentialStoreLocks.delete(storePath);
    }
  }
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
  return await withStoreLock(params.stateDir, async () => {
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
  });
}

export async function deleteCredential(params: { stateDir: string; id: string }): Promise<boolean> {
  assertDirectCredentialAccessAllowed("delete");
  assertCredentialLocality({
    credentialId: params.id,
    operation: "delete",
  });
  return await withStoreLock(params.stateDir, async () => {
    const store = await loadStore(params.stateDir);
    const before = store.credentials.length;
    store.credentials = store.credentials.filter((c) => c.id !== params.id);
    if (store.credentials.length === before) return false;
    await saveStore(params.stateDir, store);
    return true;
  });
}

export async function listCredentials(stateDir: string): Promise<Array<{ id: string; hasUsername: boolean; hasPassword: boolean; updatedAt: number; note?: string }>> {
  assertDirectCredentialAccessAllowed("list");
  return await withStoreLock(stateDir, async () => {
    const store = await loadStore(stateDir);
    return store.credentials.map((c) => ({
      id: c.id,
      hasUsername: Boolean(c.username && c.username.trim()),
      hasPassword: Boolean(c.password),
      updatedAt: c.updatedAt,
      note: c.note,
    }));
  });
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
  return await withStoreLock(params.stateDir, async () => {
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
  });
}

export async function validateCredentialStoreReadiness(params: {
  stateDir: string;
}): Promise<{ storePath: string; credentialCount: number; encryptedCredentialCount: number }> {
  assertDirectCredentialAccessAllowed("readiness");
  const store = await loadStore(params.stateDir);
  const key = getVaultKey();
  let encryptedCredentialCount = 0;
  for (const credential of store.credentials) {
    if (!credential.password) continue;
    encryptedCredentialCount += 1;
    decryptSecret(credential.password, key);
  }
  return {
    storePath: getCredentialStorePath(params.stateDir),
    credentialCount: store.credentials.length,
    encryptedCredentialCount,
  };
}
