import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { withTimeout } from "../tools/web-shared.js";

export type GmailOauthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type GmailTokenSet = {
  access_token: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  expiry_date?: number;
};

export type GmailStoredTokens = {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
  updated_at?: number;
};

const GOOGLE_AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export function getGmailTokenPath(stateDir: string): string {
  return path.join(stateDir, "gmail", "oauth.json");
}

export async function loadGmailTokens(stateDir: string): Promise<GmailStoredTokens | null> {
  const p = getGmailTokenPath(stateDir);
  try {
    const raw = await fs.readFile(p, "utf8");
    const json = JSON.parse(raw) as GmailStoredTokens;
    if (!json || typeof json !== "object" || typeof json.access_token !== "string") return null;
    return json;
  } catch {
    return null;
  }
}

export async function saveGmailTokens(stateDir: string, tokens: GmailStoredTokens): Promise<void> {
  const p = getGmailTokenPath(stateDir);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify({ ...tokens, updated_at: Date.now() }, null, 2) + "\n", "utf8");
}

export function buildGoogleAuthUrl(params: {
  oauth: GmailOauthConfig;
  scopes: string[];
  state: string;
}): string {
  const url = new URL(GOOGLE_AUTH_BASE);
  url.searchParams.set("client_id", params.oauth.clientId);
  url.searchParams.set("redirect_uri", params.oauth.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("state", params.state);
  return url.toString();
}

export async function exchangeCodeForTokens(params: {
  oauth: GmailOauthConfig;
  code: string;
  timeoutMs: number;
}): Promise<GmailTokenSet> {
  const body = new URLSearchParams();
  body.set("code", params.code);
  body.set("client_id", params.oauth.clientId);
  body.set("client_secret", params.oauth.clientSecret);
  body.set("redirect_uri", params.oauth.redirectUri);
  body.set("grant_type", "authorization_code");

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: withTimeout(params.timeoutMs),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${text || res.statusText}`);
  return JSON.parse(text) as GmailTokenSet;
}

export async function refreshAccessToken(params: {
  oauth: GmailOauthConfig;
  refreshToken: string;
  timeoutMs: number;
}): Promise<GmailTokenSet> {
  const body = new URLSearchParams();
  body.set("client_id", params.oauth.clientId);
  body.set("client_secret", params.oauth.clientSecret);
  body.set("refresh_token", params.refreshToken);
  body.set("grant_type", "refresh_token");

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: withTimeout(params.timeoutMs),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Token refresh failed (${res.status}): ${text || res.statusText}`);
  return JSON.parse(text) as GmailTokenSet;
}

export async function getValidGmailAccessToken(params: {
  stateDir: string;
  oauth: GmailOauthConfig;
  timeoutMs: number;
}): Promise<{ accessToken: string; tokens: GmailStoredTokens }> {
  const tokens = await loadGmailTokens(params.stateDir);
  if (!tokens) throw new Error(`Gmail is not authorized. Run \`nexus gmail auth\` to connect your account.`);

  const now = Date.now();
  const expiry = typeof tokens.expiry_date === "number" ? tokens.expiry_date : 0;
  if (tokens.access_token && expiry > now + 60_000) {
    return { accessToken: tokens.access_token, tokens };
  }

  if (!tokens.refresh_token) {
    throw new Error("Gmail token is expired and no refresh token is available. Re-run `nexus gmail auth`.");
  }

  const refreshed = await refreshAccessToken({
    oauth: params.oauth,
    refreshToken: tokens.refresh_token,
    timeoutMs: params.timeoutMs,
  });

  const expiryDate = typeof refreshed.expires_in === "number" ? Date.now() + refreshed.expires_in * 1000 : undefined;
  const next: GmailStoredTokens = {
    access_token: refreshed.access_token,
    refresh_token: tokens.refresh_token,
    scope: refreshed.scope ?? tokens.scope,
    token_type: refreshed.token_type ?? tokens.token_type,
    expiry_date: expiryDate ?? tokens.expiry_date,
  };
  await saveGmailTokens(params.stateDir, next);
  return { accessToken: next.access_token, tokens: next };
}

export async function runLocalhostOauthCallback(params: {
  listenHost: string;
  listenPort: number;
  callbackPath: string;
  expectedState: string;
  timeoutMs: number;
  log: (line: string) => void;
}): Promise<string> {
  return await new Promise((resolve, reject) => {
    let finished = false;
    const done = (fn: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      fn();
    };

    const server = http.createServer((req, res) => {
      try {
        const method = req.method ?? "GET";
        if (method !== "GET") {
          res.statusCode = 405;
          res.end("Method Not Allowed");
          return;
        }

        const url = new URL(req.url ?? "/", `http://${params.listenHost}:${params.listenPort}`);
        if (url.pathname !== params.callbackPath) {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }

        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code") ?? "";
        const err = url.searchParams.get("error") ?? "";

        if (err) {
          res.statusCode = 400;
          res.end(`Authorization error: ${err}`);
          done(() => {
            server.close();
            reject(new Error(`Authorization error: ${err}`));
          });
          return;
        }

        if (!code) {
          res.statusCode = 400;
          res.end("Missing code");
          return;
        }

        if (state !== params.expectedState) {
          res.statusCode = 400;
          res.end("Invalid state");
          done(() => {
            server.close();
            reject(new Error("Invalid OAuth state"));
          });
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("OK. You can close this tab and return to Nexus.");

        done(() => {
          server.close();
          resolve(code);
        });
      } catch (e) {
        res.statusCode = 500;
        res.end("Internal error");
        done(() => {
          server.close();
          reject(e instanceof Error ? e : new Error(String(e)));
        });
      }
    });

    server.on("error", (err) => {
      done(() => reject(err));
    });

    server.listen(params.listenPort, params.listenHost, () => {
      params.log(`gmail: oauth callback listening on http://${params.listenHost}:${params.listenPort}${params.callbackPath}`);
    });

    const timer = setTimeout(() => {
      done(() => {
        server.close();
        reject(new Error("Timed out waiting for OAuth callback"));
      });
    }, params.timeoutMs);
  });
}

export function createOauthState(): string {
  return crypto.randomUUID();
}

