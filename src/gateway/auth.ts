import crypto from "node:crypto";

import type { Context, Hono, MiddlewareHandler } from "hono";

import type { GatewayHttpDeps } from "./http.js";
import {
  createHttpAuthSession,
  getHttpAuthSessionByToken,
  purgeHttpAuthSessions,
  revokeHttpAuthSession,
  touchHttpAuthSession,
} from "../storage/auth.js";

const AUTH_CONTEXT_KEY = "gateway.requestAuth";
const CSRF_FIELD_NAME = "csrfToken";
const DEFAULT_SESSION_COOKIE = "nexus_dashboard_session";
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_SESSION_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_CSRF_BODY_BYTES = 64 * 1024;
const LOGIN_FAILURE_THRESHOLD = 5;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BACKOFF_BASE_MS = 30 * 1000;
const LOGIN_BACKOFF_MAX_MS = 15 * 60 * 1000;
const LOGIN_LIMITER_MAX_ENTRIES = 10_000;

type GatewayAuthMode = "api_key" | "session";

export type GatewayRequestAuth = {
  mode: GatewayAuthMode;
  csrfToken: string | null;
};

type GatewaySessionAuth = GatewayRequestAuth & {
  mode: "session";
  csrfToken: string;
  sessionToken: string;
};

type GatewayHttpAuthSettings = {
  enabled: boolean;
  apiKey: string | null;
  dashboardPassword: string | null;
  dashboardUsername: string;
  sessionTtlMs: number;
  sessionCookieName: string;
  forceSecureCookies: boolean | null;
  sessionCleanupIntervalMs: number;
};

export function getGatewayRequestAuth(c: Context): GatewayRequestAuth | null {
  const auth = c.get(AUTH_CONTEXT_KEY) as GatewayRequestAuth | undefined;
  return auth ?? null;
}

type LoginLimiterEntry = {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
};

/** In-memory failed-login limiter keyed by client identity. After
 *  LOGIN_FAILURE_THRESHOLD failures inside the window, each further attempt is
 *  blocked with exponential backoff. Successful login clears the entry. */
export class LoginRateLimiter {
  private entries = new Map<string, LoginLimiterEntry>();

  /** Returns remaining block ms when the key is currently blocked, else 0. */
  blockedForMs(key: string, nowMs: number): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    if (nowMs - entry.firstFailureAt > LOGIN_FAILURE_WINDOW_MS && nowMs >= entry.blockedUntil) {
      this.entries.delete(key);
      return 0;
    }
    return Math.max(0, entry.blockedUntil - nowMs);
  }

  recordFailure(key: string, nowMs: number): void {
    const entry = this.entries.get(key);
    if (!entry || (nowMs - entry.firstFailureAt > LOGIN_FAILURE_WINDOW_MS && nowMs >= entry.blockedUntil)) {
      this.entries.set(key, { failures: 1, firstFailureAt: nowMs, blockedUntil: 0 });
      this.pruneIfNeeded(nowMs);
      return;
    }
    entry.failures += 1;
    if (entry.failures >= LOGIN_FAILURE_THRESHOLD) {
      const excess = entry.failures - LOGIN_FAILURE_THRESHOLD;
      const backoff = Math.min(LOGIN_BACKOFF_MAX_MS, LOGIN_BACKOFF_BASE_MS * 2 ** excess);
      entry.blockedUntil = nowMs + backoff;
    }
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }

  private pruneIfNeeded(nowMs: number): void {
    if (this.entries.size <= LOGIN_LIMITER_MAX_ENTRIES) return;
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.firstFailureAt > LOGIN_FAILURE_WINDOW_MS && nowMs >= entry.blockedUntil) {
        this.entries.delete(key);
      }
    }
    // Still over the cap (active attack from many keys): drop oldest entries.
    if (this.entries.size > LOGIN_LIMITER_MAX_ENTRIES) {
      const overflow = this.entries.size - LOGIN_LIMITER_MAX_ENTRIES;
      let dropped = 0;
      for (const key of this.entries.keys()) {
        if (dropped >= overflow) break;
        this.entries.delete(key);
        dropped += 1;
      }
    }
  }
}

function loginLimiterKey(c: Context): string {
  const forwarded = (c.req.header("x-forwarded-for") ?? "").split(",")[0]?.trim();
  if (forwarded) return forwarded;
  const realIp = (c.req.header("x-real-ip") ?? "").trim();
  if (realIp) return realIp;
  return "local";
}

export function registerGatewayAuth(app: Hono, deps: GatewayHttpDeps): { enabled: boolean } {
  const settings = resolveGatewayHttpAuthSettings();
  if (!settings.enabled) {
    if (envBool("NEXUS_HTTP_AUTH_ALLOW_INSECURE") === true) {
      deps.log(
        "WARNING: HTTP auth disabled by NEXUS_HTTP_AUTH_ALLOW_INSECURE=1 - /api and /dashboard are unauthenticated",
      );
      return { enabled: false };
    }
    deps.log(
      "ERROR: HTTP auth credentials missing (set NEXUS_HTTP_API_KEY and NEXUS_DASHBOARD_PASSWORD); " +
      "refusing requests to protected routes. Set NEXUS_HTTP_AUTH_ALLOW_INSECURE=1 to bypass (dev only).",
    );
    const lockdown: MiddlewareHandler = async (c, next) => {
      const path = requestPath(c);
      if (isDashboardPath(path) || isApiPath(path) || isLoginPath(path) || path.startsWith("/auth/")) {
        // /api/mode and federation inbox endpoints stay reachable: they are
        // public by design and required by HA tooling even without auth.
        // Login routes are excluded — they are not registered in this mode,
        // and a 503 with guidance beats a bare 404.
        if (isPublicPath(path) && !isLoginPath(path) && path !== "/auth/login") {
          await next();
          return;
        }
        return c.json(
          { error: "http auth is not configured; set NEXUS_HTTP_API_KEY and NEXUS_DASHBOARD_PASSWORD" },
          503,
        );
      }
      await next();
    };
    app.use("*", lockdown);
    return { enabled: false };
  }

  let lastSessionCleanupAt = 0;
  const maybePurgeSessions = (nowMs: number): void => {
    if (!deps.db) return;
    if (nowMs - lastSessionCleanupAt < settings.sessionCleanupIntervalMs) return;
    purgeHttpAuthSessions({ db: deps.db, nowMs });
    lastSessionCleanupAt = nowMs;
  };

  const middleware: MiddlewareHandler = async (c, next) => {
    const path = requestPath(c);
    if (isPublicPath(path)) {
      await next();
      return;
    }
    const dashboardPath = isDashboardPath(path);
    const apiPath = isApiPath(path);
    const logoutPath = path === "/auth/logout";
    if (!dashboardPath && !apiPath && !logoutPath) {
      await next();
      return;
    }

    const nowMs = Date.now();
    maybePurgeSessions(nowMs);

    if (apiPath) {
      const apiAuth = resolveApiKeyAuth(c, settings);
      if (apiAuth) {
        c.set(AUTH_CONTEXT_KEY, apiAuth);
        await next();
        return;
      }
    }

    const sessionAuth = resolveSessionAuth(c, deps, settings, nowMs);
    if (sessionAuth) {
      c.set(AUTH_CONTEXT_KEY, sessionAuth);
      if (isMutatingMethod(c.req.method)) {
        const csrfToken = await readCsrfToken(c);
        if (!csrfToken || !safeTokenEquals(csrfToken, sessionAuth.csrfToken)) {
          if (apiPath) return c.json({ error: "csrf validation failed" }, 403);
          return c.text("CSRF validation failed", 403);
        }
      }
      await next();
      return;
    }

    if (dashboardPath || logoutPath || prefersHtml(c)) {
      return c.redirect(buildLoginPath(c.req.url), 302);
    }
    return c.json({ error: "unauthorized" }, 401);
  };

  app.use("*", middleware);

  app.get("/login", async (c) => {
    const nowMs = Date.now();
    maybePurgeSessions(nowMs);
    const existing = resolveSessionAuth(c, deps, settings, nowMs);
    if (existing) {
      const nextPath = sanitizeLoginNext(c.req.query("next"));
      return c.redirect(nextPath || "/dashboard", 302);
    }
    const nextPath = sanitizeLoginNext(c.req.query("next")) || "/dashboard";
    const html = renderLoginPage({
      nextPath,
      username: settings.dashboardUsername,
      errorMessage: null,
    });
    return c.html(html);
  });

  const loginLimiter = new LoginRateLimiter();

  app.post("/auth/login", async (c) => {
    if (!deps.db) return c.text("database is required for dashboard sessions", 503);
    const limiterKey = loginLimiterKey(c);
    const blockedMs = loginLimiter.blockedForMs(limiterKey, Date.now());
    if (blockedMs > 0) {
      const retrySeconds = Math.ceil(blockedMs / 1000);
      deps.log(`http/auth: login throttled key=${limiterKey} retry_in=${retrySeconds}s`);
      c.header("retry-after", String(retrySeconds));
      const html = renderLoginPage({
        nextPath: "/dashboard",
        username: settings.dashboardUsername,
        errorMessage: `Too many failed attempts. Try again in ${retrySeconds}s.`,
      });
      return c.html(html, 429);
    }
    const body = await c.req.parseBody();
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    const nextPath = sanitizeLoginNext(String(body.next ?? ""));
    const validUser = safeTokenEquals(username, settings.dashboardUsername);
    const validPassword = settings.dashboardPassword
      ? safeTokenEquals(password, settings.dashboardPassword)
      : false;
    if (!validUser || !validPassword) {
      loginLimiter.recordFailure(limiterKey, Date.now());
      const html = renderLoginPage({
        nextPath: nextPath || "/dashboard",
        username: settings.dashboardUsername,
        errorMessage: "Invalid username or password.",
      });
      return c.html(html, 401);
    }
    loginLimiter.recordSuccess(limiterKey);

    const nowMs = Date.now();
    maybePurgeSessions(nowMs);
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    createHttpAuthSession({
      db: deps.db,
      sessionToken,
      csrfToken,
      userLabel: settings.dashboardUsername,
      nowMs,
      ttlMs: settings.sessionTtlMs,
    });
    appendSessionCookie(c, settings, sessionToken, c.req.url);
    const redirectTarget = nextPath || "/dashboard";
    return c.redirect(redirectTarget, 303);
  });

  app.post("/auth/logout", async (c) => {
    const sessionToken = readCookie(c.req.header("cookie"), settings.sessionCookieName);
    if (sessionToken && deps.db) {
      revokeHttpAuthSession({
        db: deps.db,
        sessionToken,
        nowMs: Date.now(),
      });
    }
    clearSessionCookie(c, settings, c.req.url);
    return c.redirect("/login", 303);
  });

  deps.log("http/auth: enabled for /api and /dashboard routes");
  return { enabled: true };
}

function resolveSessionAuth(
  c: Context,
  deps: GatewayHttpDeps,
  settings: GatewayHttpAuthSettings,
  nowMs: number,
): GatewaySessionAuth | null {
  if (!deps.db) return null;
  const sessionToken = readCookie(c.req.header("cookie"), settings.sessionCookieName);
  if (!sessionToken) return null;
  const session = getHttpAuthSessionByToken({
    db: deps.db,
    sessionToken,
    nowMs,
  });
  if (!session) return null;
  if (nowMs - session.lastSeenAt >= 60_000) {
    touchHttpAuthSession({ db: deps.db, sessionToken, nowMs });
  }
  return {
    mode: "session",
    csrfToken: session.csrfToken,
    sessionToken,
  };
}

function resolveApiKeyAuth(c: Context, settings: GatewayHttpAuthSettings): GatewayRequestAuth | null {
  const expected = settings.apiKey;
  if (!expected) return null;
  const bearer = parseBearerToken(c.req.header("authorization"));
  if (bearer && safeTokenEquals(bearer, expected)) {
    return { mode: "api_key", csrfToken: null };
  }
  const headerKey = c.req.header("x-nexus-api-key") ?? c.req.header("x-api-key");
  if (headerKey && safeTokenEquals(headerKey.trim(), expected)) {
    return { mode: "api_key", csrfToken: null };
  }
  return null;
}

function parseBearerToken(raw: string | undefined): string | null {
  if (!raw) return null;
  const match = raw.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : null;
}

function resolveGatewayHttpAuthSettings(): GatewayHttpAuthSettings {
  const apiKey = readEnvTrimmed("NEXUS_HTTP_API_KEY");
  const dashboardPassword = readEnvTrimmed("NEXUS_DASHBOARD_PASSWORD");
  const dashboardUsername = readEnvTrimmed("NEXUS_DASHBOARD_USERNAME") ?? "admin";
  const enabledBySecrets = Boolean(apiKey && dashboardPassword);
  const enabled = enabledBySecrets;
  return {
    enabled,
    apiKey: apiKey ?? null,
    dashboardPassword: dashboardPassword ?? null,
    dashboardUsername,
    sessionTtlMs: Math.max(60_000, envInt("NEXUS_HTTP_AUTH_SESSION_TTL_MS") ?? DEFAULT_SESSION_TTL_MS),
    sessionCookieName: readEnvTrimmed("NEXUS_HTTP_AUTH_COOKIE_NAME") ?? DEFAULT_SESSION_COOKIE,
    forceSecureCookies: envBool("NEXUS_HTTP_AUTH_COOKIE_SECURE"),
    sessionCleanupIntervalMs: Math.max(
      30_000,
      envInt("NEXUS_HTTP_AUTH_SESSION_CLEANUP_INTERVAL_MS") ?? DEFAULT_SESSION_CLEANUP_INTERVAL_MS,
    ),
  };
}

function buildLoginPath(rawUrl: string): string {
  let pathname = "/dashboard";
  let search = "";
  try {
    const url = new URL(rawUrl);
    pathname = url.pathname;
    search = url.search;
  } catch {
    // fallback path retained
  }
  const next = sanitizeLoginNext(`${pathname}${search}`) || "/dashboard";
  return `/login?next=${encodeURIComponent(next)}`;
}

function sanitizeLoginNext(raw: string | null | undefined): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("/")) return null;
  if (trimmed.startsWith("//")) return null;
  if (trimmed.startsWith("/login")) return "/dashboard";
  if (trimmed.startsWith("/auth/login")) return "/dashboard";
  if (trimmed.startsWith("/auth/logout")) return "/dashboard";
  return trimmed;
}

function isPublicPath(path: string): boolean {
  if (isHealthPath(path)) return true;
  if (isLoginPath(path)) return true;
  if (path === "/auth/login") return true;
  if (path === "/federation-webhook") return true;
  if (path === "/api/federation/inbox") return true;
  if (path === "/api/mode") return true;
  return false;
}

function isHealthPath(path: string): boolean {
  if (path === "/status") return true;
  if (path === "/healthz") return true;
  if (path === "/health/live") return true;
  if (path === "/health/traffic") return true;
  if (path === "/health/ready") return true;
  return false;
}

function isLoginPath(path: string): boolean {
  return path === "/login";
}

function isDashboardPath(path: string): boolean {
  return path === "/dashboard" || path.startsWith("/dashboard/");
}

function isApiPath(path: string): boolean {
  return path.startsWith("/api/");
}

function requestPath(c: Context): string {
  try {
    return new URL(c.req.url).pathname;
  } catch {
    return "/";
  }
}

function prefersHtml(c: Context): boolean {
  const accept = (c.req.header("accept") ?? "").toLowerCase();
  return accept.includes("text/html");
}

function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function safeTokenEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function readCsrfToken(c: Context): Promise<string | null> {
  const header = readHeaderToken(c.req.header("x-csrf-token"));
  if (header) return header;
  // Note: query-param tokens are intentionally not accepted — they leak into
  // proxy/access logs and browser history.
  const lengthRaw = c.req.header("content-length");
  if (lengthRaw) {
    const contentLength = Number(lengthRaw);
    if (Number.isFinite(contentLength) && contentLength > MAX_CSRF_BODY_BYTES) {
      return null;
    }
  }
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    try {
      const form = await c.req.raw.clone().formData();
      const rawValue = form.get(CSRF_FIELD_NAME);
      if (typeof rawValue === "string") return readHeaderToken(rawValue);
    } catch {
      return null;
    }
  }
  if (contentType.includes("application/json")) {
    try {
      const body = await c.req.raw.clone().json() as unknown;
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const token = readHeaderToken((body as Record<string, unknown>)[CSRF_FIELD_NAME]);
        if (token) return token;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function readHeaderToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const token = raw.trim();
  if (!token) return null;
  if (token.length > 512) return token.slice(0, 512);
  return token;
}

function isMutatingMethod(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized === "POST" || normalized === "PUT" || normalized === "PATCH" || normalized === "DELETE";
}

function readCookie(rawCookie: string | undefined, name: string): string | null {
  if (!rawCookie) return null;
  const parts = rawCookie.split(";");
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    const value = part.slice(separator + 1).trim();
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function appendSessionCookie(c: Context, settings: GatewayHttpAuthSettings, sessionToken: string, requestUrl: string): void {
  const maxAgeSeconds = Math.max(1, Math.floor(settings.sessionTtlMs / 1000));
  const secure = shouldUseSecureCookies(settings, c, requestUrl);
  c.header("set-cookie", buildSetCookieValue({
    name: settings.sessionCookieName,
    value: encodeURIComponent(sessionToken),
    maxAgeSeconds,
    secure,
  }));
}

function clearSessionCookie(c: Context, settings: GatewayHttpAuthSettings, requestUrl: string): void {
  const secure = shouldUseSecureCookies(settings, c, requestUrl);
  c.header("set-cookie", buildSetCookieValue({
    name: settings.sessionCookieName,
    value: "",
    maxAgeSeconds: 0,
    secure,
  }));
}

function shouldUseSecureCookies(settings: GatewayHttpAuthSettings, c: Context, requestUrl: string): boolean {
  if (settings.forceSecureCookies !== null) return settings.forceSecureCookies;
  const forwardedProto = (c.req.header("x-forwarded-proto") ?? "").split(",")[0]?.trim().toLowerCase();
  if (forwardedProto === "https") return true;
  try {
    return new URL(requestUrl).protocol === "https:";
  } catch {
    return false;
  }
}

function buildSetCookieValue(params: {
  name: string;
  value: string;
  maxAgeSeconds: number;
  secure: boolean;
}): string {
  const parts = [
    `${params.name}=${params.value}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(params.maxAgeSeconds))}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (params.secure) parts.push("Secure");
  return parts.join("; ");
}

function renderLoginPage(params: {
  nextPath: string;
  username: string;
  errorMessage: string | null;
}): string {
  const safeNext = escapeHtml(params.nextPath);
  const safeUsername = escapeHtml(params.username);
  const errorBanner = params.errorMessage
    ? `<div style="margin-bottom:12px;color:#b91c1c;background:#fee2e2;border:1px solid #fecaca;padding:8px 10px;border-radius:8px;">${escapeHtml(
      params.errorMessage,
    )}</div>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Nexus Login</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #f3f4f6; color: #111827; }
      .card { width: min(420px, 92vw); margin: 10vh auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 18px; box-shadow: 0 8px 24px rgba(0,0,0,0.07); }
      h1 { font-size: 18px; margin: 0 0 12px; }
      label { display: block; font-size: 12px; color: #4b5563; margin-bottom: 4px; }
      input { width: 100%; box-sizing: border-box; margin-bottom: 10px; border: 1px solid #d1d5db; border-radius: 8px; padding: 10px; font-size: 14px; }
      button { width: 100%; border: 0; border-radius: 8px; padding: 10px; font-size: 14px; font-weight: 600; cursor: pointer; background: #111827; color: #fff; }
      .meta { margin-top: 10px; font-size: 12px; color: #6b7280; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Nexus Login</h1>
      ${errorBanner}
      <form method="post" action="/auth/login">
        <input type="hidden" name="next" value="${safeNext}" />
        <label for="username">Username</label>
        <input id="username" name="username" autocomplete="username" value="${safeUsername}" />
        <label for="password">Password</label>
        <input id="password" type="password" name="password" autocomplete="current-password" required />
        <button type="submit">Sign in</button>
      </form>
      <div class="meta">Use credentials configured via environment variables.</div>
    </div>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function envBool(name: string): boolean | null {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "y") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "n") return false;
  return null;
}

function envInt(name: string): number | null {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.trunc(value);
}

function readEnvTrimmed(name: string): string | null {
  const value = (process.env[name] ?? "").trim();
  return value.length > 0 ? value : null;
}
