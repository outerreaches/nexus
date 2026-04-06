/**
 * OpenAI Codex OAuth authentication.
 *
 * Implements the device-code OAuth flow used by OpenAI's Codex CLI,
 * allowing users to leverage their existing ChatGPT subscription
 * (Plus / Team / Enterprise) as an LLM provider — no API key needed.
 *
 * Flow:
 *   1. Request device code from auth.openai.com
 *   2. User opens browser, enters code
 *   3. Poll until authorized → receive access + refresh tokens
 *   4. Tokens stored in {stateDir}/codex-auth.json
 *   5. Access token auto-refreshed before expiry (JWT exp claim)
 */

import fs from "node:fs/promises";
import path from "node:path";

const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_ISSUER = "https://auth.openai.com";
const CODEX_OAUTH_TOKEN_URL = `${CODEX_OAUTH_ISSUER}/oauth/token`;
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/** Seconds before JWT exp to trigger proactive refresh. */
const REFRESH_SKEW_SECONDS = 120;

// ── Types ──────────────────────────────────────────────────────────────────

export type CodexTokens = {
  access_token: string;
  refresh_token: string;
};

type CodexAuthStore = {
  version: 1;
  tokens: CodexTokens;
  lastRefresh: string;
};

export type CodexCredentials = {
  baseUrl: string;
  apiKey: string; // access_token used as bearer
  source: string;
};

// ── Token persistence ──────────────────────────────────────────────────────

function authFilePath(stateDir: string): string {
  return path.join(stateDir, "codex-auth.json");
}

async function readTokens(stateDir: string): Promise<CodexAuthStore | null> {
  try {
    const raw = await fs.readFile(authFilePath(stateDir), "utf-8");
    const parsed = JSON.parse(raw) as CodexAuthStore;
    if (
      parsed?.version === 1 &&
      typeof parsed.tokens?.access_token === "string" &&
      typeof parsed.tokens?.refresh_token === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeTokens(stateDir: string, tokens: CodexTokens): Promise<void> {
  const store: CodexAuthStore = {
    version: 1,
    tokens,
    lastRefresh: new Date().toISOString(),
  };
  const filePath = authFilePath(stateDir);
  const tmp = filePath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

// ── Import from Codex CLI ──────────────────────────────────────────────────

async function importCodexCliTokens(): Promise<CodexTokens | null> {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? ".",
    ".codex",
  );
  const authPath = path.join(codexHome, "auth.json");
  try {
    const raw = await fs.readFile(authPath, "utf-8");
    const data = JSON.parse(raw);
    const tokens = data?.tokens;
    if (
      typeof tokens?.access_token === "string" && tokens.access_token &&
      typeof tokens?.refresh_token === "string" && tokens.refresh_token
    ) {
      return { access_token: tokens.access_token, refresh_token: tokens.refresh_token };
    }
    return null;
  } catch {
    return null;
  }
}

// ── JWT helpers ────────────────────────────────────────────────────────────

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function isTokenExpiring(accessToken: string, skewSeconds = REFRESH_SKEW_SECONDS): boolean {
  const claims = decodeJwtPayload(accessToken);
  if (!claims) return false;
  const exp = claims.exp;
  if (typeof exp !== "number") return false;
  return exp <= Date.now() / 1000 + skewSeconds;
}

// ── Token refresh ──────────────────────────────────────────────────────────

async function refreshTokens(refreshToken: string): Promise<CodexTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CODEX_OAUTH_CLIENT_ID,
  });

  const resp = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(20_000),
  });

  if (!resp.ok) {
    let detail = `status ${resp.status}`;
    try {
      const err = (await resp.json()) as Record<string, string>;
      if (err.error_description) detail = err.error_description;
      else if (err.error) detail = err.error;
    } catch { /* ignore */ }
    throw new Error(`Codex token refresh failed: ${detail}`);
  }

  const data = (await resp.json()) as Record<string, string>;
  if (!data.access_token) {
    throw new Error("Codex token refresh response missing access_token");
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
  };
}

// ── Device code login flow ─────────────────────────────────────────────────

export type DeviceCodeLoginCallbacks = {
  onUserCode: (params: { verificationUrl: string; userCode: string }) => void;
  onPollTick?: () => void;
};

export async function codexDeviceCodeLogin(
  callbacks: DeviceCodeLoginCallbacks,
  opts?: { timeoutMs?: number },
): Promise<CodexTokens> {
  const { userCode, verificationUrl, poll } = await codexDeviceCodeLogin_start(opts);
  callbacks.onUserCode({ verificationUrl, userCode });
  return poll({ onPollTick: callbacks.onPollTick });
}

/** Shared polling logic for device-code auth. */
async function pollDeviceAuth(params: {
  deviceAuthId: string;
  userCode: string;
  pollInterval: number;
  timeoutMs: number;
  onPollTick?: () => void;
}): Promise<CodexTokens> {
  const deadline = Date.now() + params.timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, params.pollInterval));
    params.onPollTick?.();

    const pollResp = await fetch(`${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: params.deviceAuthId, user_code: params.userCode }),
      signal: AbortSignal.timeout(15_000),
    });

    if (pollResp.status === 200) {
      const codeData = (await pollResp.json()) as Record<string, string>;
      const authorizationCode = codeData.authorization_code;
      const codeVerifier = codeData.code_verifier;

      if (!authorizationCode || !codeVerifier) {
        throw new Error("Device auth response missing authorization_code or code_verifier");
      }

      const tokenResp = await fetch(CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authorizationCode,
          redirect_uri: `${CODEX_OAUTH_ISSUER}/deviceauth/callback`,
          client_id: CODEX_OAUTH_CLIENT_ID,
          code_verifier: codeVerifier,
        }).toString(),
        signal: AbortSignal.timeout(15_000),
      });

      if (!tokenResp.ok) {
        throw new Error(`Token exchange failed: status ${tokenResp.status}`);
      }

      const tokens = (await tokenResp.json()) as Record<string, string>;
      if (!tokens.access_token) {
        throw new Error("Token exchange did not return an access_token");
      }

      return {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? "",
      };
    }

    if (pollResp.status === 403 || pollResp.status === 404) {
      continue;
    }

    throw new Error(`Device auth polling returned unexpected status ${pollResp.status}`);
  }

  throw new Error("Login timed out waiting for authorization");
}

// ── Resolve credentials (main entry point) ─────────────────────────────────

export async function resolveCodexCredentials(opts: {
  stateDir: string;
  forceRefresh?: boolean;
  log?: (line: string) => void;
}): Promise<CodexCredentials> {
  let store = await readTokens(opts.stateDir);

  if (!store) {
    // Try importing from Codex CLI (~/.codex/auth.json)
    const cliTokens = await importCodexCliTokens();
    if (cliTokens) {
      opts.log?.("codex: imported credentials from ~/.codex/auth.json");
      await writeTokens(opts.stateDir, cliTokens);
      store = await readTokens(opts.stateDir);
    }
  }

  if (!store) {
    throw new Error(
      "No Codex credentials found. Use /codex login to authenticate with your ChatGPT account.",
    );
  }

  let { tokens } = store;

  // Refresh if expiring or forced
  if (opts.forceRefresh || isTokenExpiring(tokens.access_token)) {
    opts.log?.("codex: refreshing access token");
    try {
      tokens = await refreshTokens(tokens.refresh_token);
      await writeTokens(opts.stateDir, tokens);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      opts.log?.(`codex: token refresh failed: ${msg}`);
      // If refresh fails but token isn't actually expired yet, use it anyway
      if (isTokenExpiring(tokens.access_token, 0)) {
        throw new Error(
          `Codex token refresh failed and token is expired: ${msg}. Run /codex login to re-authenticate.`,
        );
      }
    }
  }

  const baseUrl = process.env.NEXUS_CODEX_BASE_URL?.trim() || DEFAULT_CODEX_BASE_URL;

  return {
    baseUrl,
    apiKey: tokens.access_token,
    source: "codex-oauth",
  };
}

// ── Two-phase login (start → poll in background → finish) ─────────────────

/**
 * Phase 1: request device code from OpenAI. Returns the user code for display
 * and a `poll` function that can be called in the background to await authorization.
 */
export async function codexDeviceCodeLogin_start(
  opts?: { timeoutMs?: number },
): Promise<{
  userCode: string;
  verificationUrl: string;
  poll: (cbs: { onPollTick?: () => void }) => Promise<CodexTokens>;
}> {
  const timeoutMs = opts?.timeoutMs ?? 15 * 60_000;

  const codeResp = await fetch(`${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!codeResp.ok) {
    throw new Error(`Failed to request device code: status ${codeResp.status}`);
  }

  const deviceData = (await codeResp.json()) as Record<string, unknown>;
  const userCode = String(deviceData.user_code ?? "");
  const deviceAuthId = String(deviceData.device_auth_id ?? "");
  const pollInterval = Math.max(3, Number(deviceData.interval ?? 5)) * 1000;

  if (!userCode || !deviceAuthId) {
    throw new Error("Device code response missing required fields");
  }

  const verificationUrl = `${CODEX_OAUTH_ISSUER}/codex/device`;

  return {
    userCode,
    verificationUrl,
    poll: (cbs) => pollDeviceAuth({ deviceAuthId, userCode, pollInterval, timeoutMs, onPollTick: cbs.onPollTick }),
  };
}

/** Phase 2: persist tokens after successful login. */
export async function codexLoginFinish(opts: {
  stateDir: string;
  tokens: CodexTokens;
}): Promise<void> {
  await writeTokens(opts.stateDir, opts.tokens);
}

// ── Legacy combined login (kept for CLI) ──────────────────────────────────

export async function codexLogin(opts: {
  stateDir: string;
  callbacks: DeviceCodeLoginCallbacks;
}): Promise<void> {
  const tokens = await codexDeviceCodeLogin(opts.callbacks);
  await writeTokens(opts.stateDir, tokens);
}

// ── Status check ───────────────────────────────────────────────────────────

export async function getCodexAuthStatus(stateDir: string): Promise<{
  loggedIn: boolean;
  lastRefresh?: string;
  tokenExpiring?: boolean;
  filePath: string;
}> {
  const filePath = authFilePath(stateDir);
  const store = await readTokens(stateDir);
  if (!store) {
    return { loggedIn: false, filePath };
  }
  return {
    loggedIn: true,
    lastRefresh: store.lastRefresh,
    tokenExpiring: isTokenExpiring(store.tokens.access_token),
    filePath,
  };
}

export async function codexLogout(stateDir: string): Promise<boolean> {
  try {
    await fs.unlink(authFilePath(stateDir));
    return true;
  } catch {
    return false;
  }
}
