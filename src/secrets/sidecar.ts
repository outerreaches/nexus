import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import fs from "node:fs/promises";

import { getCredentialField, validateCredentialStoreReadiness } from "./credentials.js";

export type SecretSidecarOptions = {
  stateDir: string;
  bindHost?: string;
  port?: number;
  socketPath?: string | null;
  socketMode?: number | null;
  socketGid?: number | null;
  maxBodyBytes?: number;
  bearerToken?: string | null;
  strictMode?: boolean;
  log?: (msg: string) => void;
};

export type SecretSidecarHandle = {
  stop: () => Promise<void>;
  endpoint: {
    kind: "unix" | "tcp";
    socketPath: string | null;
    host: string | null;
    port: number | null;
    resolvePath: string;
    healthPath: string;
    readyPath: string;
  };
};

const DEFAULT_MAX_BODY_BYTES = 32 * 1024;
const RESOLVE_PATHS = new Set(["/v1/secrets/resolve", "/resolve"]);
const HEALTH_PATH = "/health";
const READY_PATH = "/ready";
const DEFAULT_SOCKET_MODE = 0o666;

function parseSocketMode(raw: string | undefined): number | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  let normalized = value;
  if (normalized.startsWith("0o")) normalized = normalized.slice(2);
  if (normalized.length > 1 && normalized.startsWith("0")) normalized = normalized.slice(1);
  if (!/^[0-7]{3,4}$/.test(normalized)) return null;
  return Number.parseInt(normalized, 8);
}

function parseNonNegativeInt(raw: string | undefined): number | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const intValue = Math.floor(parsed);
  return intValue >= 0 ? intValue : null;
}

function safeTokenEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function extractBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice(7).trim();
  return token.length > 0 ? token : null;
}

async function readBody(req: http.IncomingMessage, maxBodyBytes: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer | string) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += next.length;
      if (total > maxBodyBytes) {
        reject(new Error("request_body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(next);
    });
    req.on("end", () => {
      resolve(chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "");
    });
    req.on("error", (err) => reject(err));
  });
}

function writeJson(res: http.ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(payload).toString());
  res.end(payload);
}

function parseResolveRequest(payload: unknown): {
  secretPath: string;
  field: "username" | "password";
  providerKind: string | null;
} | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const rawPath = typeof record.secretPath === "string" ? record.secretPath.trim() : "";
  if (!rawPath) return null;
  const rawField = typeof record.field === "string" ? record.field.trim().toLowerCase() : "password";
  const field = rawField === "username" ? "username" : "password";
  const providerKind = typeof record.providerKind === "string" ? record.providerKind.trim().toLowerCase() : null;
  return {
    secretPath: rawPath,
    field,
    providerKind: providerKind && providerKind.length > 0 ? providerKind : null,
  };
}

function mapResolveErrorStatus(errorMessage: string): 400 | 404 | 409 | 500 {
  if (errorMessage.includes("request_body_too_large")) return 400;
  if (errorMessage.includes("Unknown credential id")) return 404;
  if (errorMessage.includes("has no username") || errorMessage.includes("has no password")) return 409;
  if (errorMessage.includes("Plaintext credentials are blocked")) return 409;
  if (errorMessage.includes("Credential is encrypted but NEXUS_CREDENTIALS_KEY is not set")) return 409;
  if (errorMessage.includes("blocked by locality policy")) return 409;
  return 500;
}

export async function startSecretSidecar(options: SecretSidecarOptions): Promise<SecretSidecarHandle> {
  const log = options.log ?? (() => {});
  const strictMode = true;
  const socketPath = options.socketPath?.trim() ? options.socketPath.trim() : null;
  const socketMode = options.socketMode ?? parseSocketMode(process.env.NEXUS_SECRET_SIDECAR_SOCKET_MODE) ?? DEFAULT_SOCKET_MODE;
  const socketGid = options.socketGid ?? parseNonNegativeInt(process.env.NEXUS_SECRET_SIDECAR_SOCKET_GID);
  const bindHost = (options.bindHost ?? "127.0.0.1").trim();
  const requestedPortRaw = options.port ?? 7788;
  const requestedPort = Number.isFinite(requestedPortRaw) ? Math.floor(requestedPortRaw) : 7788;
  const port = requestedPort >= 0 ? requestedPort : 7788;
  const maxBodyBytes =
    Number.isFinite(options.maxBodyBytes ?? NaN) && (options.maxBodyBytes ?? 0) > 0
      ? Math.floor(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)
      : DEFAULT_MAX_BODY_BYTES;
  const bearerToken = (options.bearerToken ?? "").trim();

  if (!socketPath && strictMode && !bearerToken) {
    throw new Error("secret_sidecar_strict_mode_requires_bearer_token_for_tcp");
  }

  if (socketPath) {
    try {
      await fs.unlink(socketPath);
    } catch {
      // ignore stale socket cleanup failures
    }
  }

  const startupReadiness = await validateCredentialStoreReadiness({
    stateDir: options.stateDir,
  });
  log(
    `secret-sidecar: credential store ready path=${startupReadiness.storePath} credentials=${startupReadiness.credentialCount} encrypted=${startupReadiness.encryptedCredentialCount}`,
  );

  const server = http.createServer(async (req, res) => {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://localhost");
    if (method === "GET" && url.pathname === HEALTH_PATH) {
      writeJson(res, 200, {
        ok: true,
        service: "secret-sidecar",
        strictMode,
        socketPath,
        bindHost: socketPath ? null : bindHost,
        port: socketPath ? null : port,
        timestamp: Date.now(),
      });
      return;
    }
    if (method === "GET" && url.pathname === READY_PATH) {
      try {
        const readiness = await validateCredentialStoreReadiness({
          stateDir: options.stateDir,
        });
        writeJson(res, 200, {
          ok: true,
          service: "secret-sidecar",
          strictMode,
          storePath: readiness.storePath,
          credentialCount: readiness.credentialCount,
          encryptedCredentialCount: readiness.encryptedCredentialCount,
          timestamp: Date.now(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeJson(res, 503, {
          ok: false,
          service: "secret-sidecar",
          strictMode,
          error: message.slice(0, 240),
          timestamp: Date.now(),
        });
      }
      return;
    }

    if (method !== "POST" || !RESOLVE_PATHS.has(url.pathname)) {
      writeJson(res, 404, { error: "not found" });
      return;
    }

    if (bearerToken) {
      const provided = extractBearerToken(req.headers.authorization);
      if (!provided || !safeTokenEquals(provided, bearerToken)) {
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
    }

    try {
      const bodyText = await readBody(req, maxBodyBytes);
      let parsedBody: unknown;
      try {
        parsedBody = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        writeJson(res, 400, { error: "invalid JSON body" });
        return;
      }
      const resolveRequest = parseResolveRequest(parsedBody);
      if (!resolveRequest) {
        writeJson(res, 400, { error: "secretPath is required" });
        return;
      }
      if (
        resolveRequest.providerKind &&
        resolveRequest.providerKind !== "local_file" &&
        resolveRequest.providerKind !== "sidecar_http"
      ) {
        writeJson(res, 409, { error: `providerKind ${resolveRequest.providerKind} is not supported by built-in sidecar` });
        return;
      }

      const value = await getCredentialField({
        stateDir: options.stateDir,
        id: resolveRequest.secretPath,
        field: resolveRequest.field,
      });
      writeJson(res, 200, {
        value,
        secretClass: "credential",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = mapResolveErrorStatus(message);
      writeJson(res, status, {
        error: message.slice(0, 240),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (socketPath) {
      server.listen(socketPath, () => resolve());
    } else {
      server.listen(port, bindHost, () => resolve());
    }
  });

  let effectivePort: number | null = null;
  if (socketPath) {
    if (socketGid !== null && typeof process.getuid === "function" && typeof process.getgid === "function") {
      try {
        await fs.chown(socketPath, process.getuid(), socketGid);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`secret_sidecar_socket_chown_failed:${detail}`);
      }
    }
    try {
      await fs.chmod(socketPath, socketMode);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`secret_sidecar_socket_chmod_failed:${detail}`);
    }
    log(`secret-sidecar: listening on unix://${socketPath}`);
  } else {
    const address = server.address();
    if (address && typeof address === "object") {
      effectivePort = address.port;
    } else {
      effectivePort = port;
    }
    log(`secret-sidecar: listening on http://${bindHost}:${effectivePort}`);
  }

  const stop = async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (socketPath) {
      try {
        await fs.unlink(socketPath);
      } catch {
        // ignore cleanup failures
      }
    }
  };

  return {
    stop,
    endpoint: {
      kind: socketPath ? "unix" : "tcp",
      socketPath,
      host: socketPath ? null : bindHost,
      port: socketPath ? null : effectivePort,
      resolvePath: "/v1/secrets/resolve",
      healthPath: HEALTH_PATH,
      readyPath: READY_PATH,
    },
  };
}
