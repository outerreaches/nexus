import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

import type { SecretProviderProfileRecord } from "../storage/secrets.js";

export type SecretBrokerResolveInput = {
  profile: SecretProviderProfileRecord;
  stateDir: string;
  secretPath: string;
  field: "username" | "password";
  strictMode: boolean;
  traceId?: string | null;
  firewallSession?: string | null;
  actor?: string | null;
  requestTimeoutMs?: number;
};

export type SecretBrokerResolveResult = {
  value: string;
  secretClass: string;
  leaseId: string | null;
  expiresAt: number | null;
  reason: string;
};

export type SecretBrokerProfileValidationResult = {
  endpointKind: "local" | "unix" | "url";
  endpointScheme: "local" | "unix" | "http" | "https";
  authMode: string;
  strictMode: boolean;
};

const SECRETISH_CONFIG_KEY_PATTERN = /(token|secret|password|api[_-]?key|client[_-]?secret|access[_-]?key)/i;
const DEFAULT_RESOLVE_PATH = "/v1/secrets/resolve";

type ParsedBrokerEndpoint =
  | {
      kind: "unix";
      socketPath: string;
      requestPath: string;
    }
  | {
      kind: "url";
      url: URL;
      requestPath: string;
    };

type BrokerTlsClientMaterial = {
  cert: Buffer;
  key: Buffer;
  ca: Buffer | null;
};

type SecretBrokerRequestInvoker = (params: {
  endpoint: ParsedBrokerEndpoint;
  requestTimeoutMs: number;
  headers: Record<string, string>;
  bodyJson: string;
  tlsClientMaterial: BrokerTlsClientMaterial | null;
}) => Promise<{ statusCode: number; bodyText: string }>;

let secretBrokerRequestInvoker: SecretBrokerRequestInvoker | null = null;

export function setSecretBrokerRequestInvokerForTests(
  invoker: SecretBrokerRequestInvoker | null,
): void {
  secretBrokerRequestInvoker = invoker;
}

function isPrivateOrLoopbackIp(host: string): boolean {
  const kind = net.isIP(host);
  if (kind === 0) return false;
  if (kind === 4) {
    const octets = host.split(".").map((part) => Number(part));
    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 0) return true;
    return false;
  }
  const normalized = host.toLowerCase();
  if (normalized === "::1") return true;
  if (normalized.startsWith("fe80:")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  return false;
}

function isHostPrivateOnly(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  return isPrivateOrLoopbackIp(normalized);
}

function parseRequestPath(config: Record<string, unknown>): string {
  const raw = config.resolvePath;
  if (typeof raw !== "string") return DEFAULT_RESOLVE_PATH;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return DEFAULT_RESOLVE_PATH;
  return trimmed.length > 0 ? trimmed : DEFAULT_RESOLVE_PATH;
}

function parseBrokerEndpoint(profile: SecretProviderProfileRecord): ParsedBrokerEndpoint {
  const raw = (profile.endpointRef ?? "").trim();
  if (!raw) {
    throw new Error(`secret_broker_endpoint_missing:${profile.id}`);
  }
  const requestPath = parseRequestPath(profile.config);
  if (raw.startsWith("unix://")) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`secret_broker_endpoint_invalid:${profile.id}`);
    }
    const socketPath = decodeURIComponent(parsed.pathname || "").trim();
    if (!socketPath || !socketPath.startsWith("/")) {
      throw new Error(`secret_broker_unix_socket_invalid:${profile.id}`);
    }
    return {
      kind: "unix",
      socketPath,
      requestPath,
    };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`secret_broker_endpoint_invalid:${profile.id}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`secret_broker_endpoint_scheme_unsupported:${url.protocol}`);
  }
  return {
    kind: "url",
    url,
    requestPath,
  };
}

function walkConfigForStaticSecrets(value: unknown, parentKey = ""): boolean {
  if (value == null) return false;
  if (typeof value === "string") {
    if (!parentKey) return false;
    return SECRETISH_CONFIG_KEY_PATTERN.test(parentKey) && value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (walkConfigForStaticSecrets(item, parentKey)) return true;
    }
    return false;
  }
  if (typeof value !== "object") return false;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (walkConfigForStaticSecrets(nested, key.trim())) return true;
  }
  return false;
}

async function loadMtlsClientMaterial(): Promise<BrokerTlsClientMaterial> {
  const certPath = (process.env.NEXUS_SECRET_BROKER_CLIENT_CERT_FILE ?? "").trim();
  const keyPath = (process.env.NEXUS_SECRET_BROKER_CLIENT_KEY_FILE ?? "").trim();
  if (!certPath || !keyPath) {
    throw new Error("secret_broker_mtls_material_missing");
  }
  const cert = await fs.readFile(certPath);
  const key = await fs.readFile(keyPath);
  const caPath = (process.env.NEXUS_SECRET_BROKER_CA_FILE ?? "").trim();
  const ca = caPath ? await fs.readFile(caPath) : null;
  return {
    cert,
    key,
    ca,
  };
}

function resolveBearerToken(): string {
  const token = (process.env.NEXUS_SECRET_BROKER_BEARER_TOKEN ?? "").trim();
  if (!token) throw new Error("secret_broker_workload_identity_token_missing");
  return token;
}

async function validateBrokerPolicy(params: {
  profile: SecretProviderProfileRecord;
  endpoint: ParsedBrokerEndpoint;
}): Promise<{ authorizationHeader: string | null; tlsClientMaterial: BrokerTlsClientMaterial | null }> {
  const authMode = params.profile.authMode.trim().toLowerCase();
  if (walkConfigForStaticSecrets(params.profile.config)) {
    throw new Error("secret_provider_static_auth_material_in_config_blocked");
  }

  if (params.endpoint.kind === "url") {
    const host = params.endpoint.url.hostname;
    const isPrivate = isHostPrivateOnly(host);
    if (!isPrivate) {
      throw new Error(`secret_broker_non_private_endpoint_blocked:${host}`);
    }
  }

  const effectiveAuthMode = authMode || "none";
  if (effectiveAuthMode === "none") {
    throw new Error("secret_provider_auth_mode_not_hardened");
  }

  if (effectiveAuthMode === "unix_peer") {
    if (params.endpoint.kind !== "unix") {
      throw new Error("secret_provider_auth_mode_unix_peer_requires_unix_endpoint");
    }
    return {
      authorizationHeader: null,
      tlsClientMaterial: null,
    };
  }

  if (effectiveAuthMode === "mtls") {
    if (params.endpoint.kind !== "url" || params.endpoint.url.protocol !== "https:") {
      throw new Error("secret_provider_auth_mode_mtls_requires_https_endpoint");
    }
    const tlsClientMaterial = await loadMtlsClientMaterial();
    return {
      authorizationHeader: null,
      tlsClientMaterial,
    };
  }

  if (effectiveAuthMode === "workload_identity") {
    if (params.endpoint.kind !== "url") {
      throw new Error("secret_provider_auth_mode_workload_identity_requires_http_endpoint");
    }
    if (params.endpoint.url.protocol !== "https:") {
      throw new Error("secret_provider_auth_mode_workload_identity_requires_https_in_strict_mode");
    }
    return {
      authorizationHeader: `Bearer ${resolveBearerToken()}`,
      tlsClientMaterial: null,
    };
  }

  throw new Error(`secret_provider_auth_mode_unsupported:${effectiveAuthMode}`);
}

async function postJsonViaEndpoint(params: {
  endpoint: ParsedBrokerEndpoint;
  requestTimeoutMs: number;
  headers: Record<string, string>;
  bodyJson: string;
  tlsClientMaterial: BrokerTlsClientMaterial | null;
}): Promise<{ statusCode: number; bodyText: string }> {
  const timeoutMs = Math.max(1_000, params.requestTimeoutMs);
  const endpoint = params.endpoint;
  if (endpoint.kind === "unix") {
    return await new Promise<{ statusCode: number; bodyText: string }>((resolve, reject) => {
      const req = http.request(
        {
          method: "POST",
          socketPath: endpoint.socketPath,
          path: endpoint.requestPath,
          headers: {
            ...params.headers,
            "content-length": Buffer.byteLength(params.bodyJson).toString(),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              bodyText: chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "",
            });
          });
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error("secret_broker_timeout")));
      req.on("error", (err) => reject(err));
      req.write(params.bodyJson);
      req.end();
    });
  }

  const transport = endpoint.url.protocol === "https:" ? https : http;
  return await new Promise<{ statusCode: number; bodyText: string }>((resolve, reject) => {
    const requestOptions: http.RequestOptions | https.RequestOptions = {
      method: "POST",
      protocol: endpoint.url.protocol,
      hostname: endpoint.url.hostname,
      port: endpoint.url.port ? Number(endpoint.url.port) : undefined,
      path: `${endpoint.requestPath}${endpoint.url.search}`,
      headers: {
        ...params.headers,
        "content-length": Buffer.byteLength(params.bodyJson).toString(),
      },
    };
    if (endpoint.url.protocol === "https:") {
      const httpsOptions = requestOptions as https.RequestOptions;
      httpsOptions.rejectUnauthorized = true;
      if (params.tlsClientMaterial) {
        httpsOptions.cert = params.tlsClientMaterial.cert;
        httpsOptions.key = params.tlsClientMaterial.key;
        if (params.tlsClientMaterial.ca) {
          httpsOptions.ca = params.tlsClientMaterial.ca;
        }
      }
    }
    const req = transport.request(
      requestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            bodyText: chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : "",
          });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("secret_broker_timeout")));
    req.on("error", (err) => reject(err));
    req.write(params.bodyJson);
    req.end();
  });
}

async function resolveViaSidecar(params: {
  profile: SecretProviderProfileRecord;
  secretPath: string;
  field: "username" | "password";
  traceId?: string | null;
  firewallSession?: string | null;
  actor?: string | null;
  requestTimeoutMs: number;
}): Promise<SecretBrokerResolveResult> {
  const endpoint = parseBrokerEndpoint(params.profile);
  const policy = await validateBrokerPolicy({
    profile: params.profile,
    endpoint,
  });

  const bodyJson = JSON.stringify({
    providerId: params.profile.id,
    providerKind: params.profile.kind,
    secretPath: params.secretPath,
    field: params.field,
    traceId: params.traceId ?? null,
    firewallSession: params.firewallSession ?? null,
    actor: params.actor ?? null,
  });

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (policy.authorizationHeader) {
    headers.authorization = policy.authorizationHeader;
  }

  const response = await (secretBrokerRequestInvoker ?? postJsonViaEndpoint)({
    endpoint,
    requestTimeoutMs: params.requestTimeoutMs,
    headers,
    bodyJson,
    tlsClientMaterial: policy.tlsClientMaterial,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const body = response.bodyText.trim().slice(0, 240);
    throw new Error(`secret_broker_http_${response.statusCode}:${body}`);
  }

  let json: unknown;
  try {
    json = response.bodyText ? JSON.parse(response.bodyText) : {};
  } catch {
    throw new Error("secret_broker_invalid_json_response");
  }
  const payload = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const value = typeof payload.value === "string" ? payload.value : null;
  if (value == null) {
    throw new Error("secret_broker_missing_value");
  }
  const leaseId = typeof payload.leaseId === "string" && payload.leaseId.trim()
    ? payload.leaseId.trim()
    : null;
  const expiresAt = typeof payload.expiresAt === "number" && Number.isFinite(payload.expiresAt)
    ? Math.max(0, Math.floor(payload.expiresAt))
    : null;
  const secretClass = typeof payload.secretClass === "string" && payload.secretClass.trim()
    ? payload.secretClass.trim()
    : "external";

  return {
    value,
    secretClass,
    leaseId,
    expiresAt,
    reason: `resolved_sidecar:${params.profile.kind}`,
  };
}

export async function resolveSecretThroughBroker(params: SecretBrokerResolveInput): Promise<SecretBrokerResolveResult> {
  if (params.profile.kind === "local_file") {
    throw new Error("secret_provider_local_file_disabled:sidecar_required");
  }

  return await resolveViaSidecar({
    profile: params.profile,
    secretPath: params.secretPath,
    field: params.field,
    traceId: params.traceId,
    firewallSession: params.firewallSession,
    actor: params.actor,
    requestTimeoutMs: Math.max(1_000, params.requestTimeoutMs ?? 5_000),
  });
}

export async function validateSecretBrokerProfile(params: {
  profile: SecretProviderProfileRecord;
  strictMode?: boolean;
}): Promise<SecretBrokerProfileValidationResult> {
  if (params.profile.kind === "local_file") {
    throw new Error("secret_provider_local_file_disabled:sidecar_required");
  }

  const endpoint = parseBrokerEndpoint(params.profile);
  await validateBrokerPolicy({
    profile: params.profile,
    endpoint,
  });
  if (endpoint.kind === "unix") {
    return {
      endpointKind: "unix",
      endpointScheme: "unix",
      authMode: params.profile.authMode,
      strictMode: true,
    };
  }
  const endpointScheme = endpoint.url.protocol === "https:" ? "https" : "http";
  return {
    endpointKind: "url",
    endpointScheme,
    authMode: params.profile.authMode,
    strictMode: true,
  };
}
