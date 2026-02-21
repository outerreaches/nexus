import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { defineTool, type Tool, type ToolContext } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";
import { getNodeById } from "../storage/nodes.js";
import { resolveWithinRoots } from "./path-utils.js";
import { truncateShellOutput } from "./system.js";

const execFileAsync = promisify(execFile);

const ALLOWED_PRESETS = new Set(["orchestrator", "coder"]);
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const POLL_INTERVAL_MS = 60;
const MAX_READ_BYTES = 128_000;

type SessionMeta = {
  sessionId: string;
  tmuxSession: string;
  cwd: string;
  logPath: string;
  createdAt: number;
  updatedAt: number;
};

type TmuxResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  rawCode: string | number | undefined;
  errorMessage: string | null;
};

const nodeShellRoutingTool: Tool = {
  name: "shell_exec",
  description: "Internal routing shim for node shell_interactive via system.run.",
  jsonSchema: {},
  execute: async () => "ERROR: shell_interactive should be routed via node transport.",
};

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function truncateDetail(value: string): string {
  return truncateShellOutput(value, 400);
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function hashToken(input: string): string {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

function normalizeSessionId(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!SESSION_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function tmuxSessionName(sessionId: string): string {
  const base = sessionId.length <= 44 ? sessionId : `${sessionId.slice(0, 36)}_${hashToken(sessionId)}`;
  return `nxsh_${base}`;
}

function shellStateRoot(stateDir: string): string {
  return path.join(stateDir, "interactive-shell");
}

function shellMetaDir(stateDir: string): string {
  return path.join(shellStateRoot(stateDir), "sessions");
}

function shellLogDir(stateDir: string): string {
  return path.join(shellStateRoot(stateDir), "logs");
}

function shellMetaPath(stateDir: string, sessionId: string): string {
  return path.join(shellMetaDir(stateDir), `${sessionId}.json`);
}

function shellLogPath(stateDir: string, sessionId: string): string {
  return path.join(shellLogDir(stateDir), `${sessionId}.log`);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function requireAllowedPreset(ctx: ToolContext): string | null {
  const preset = ctx.request?.preset?.trim() ?? "";
  if (!ALLOWED_PRESETS.has(preset)) {
    return "ERROR: shell_interactive is only available to orchestrator and coder presets.";
  }
  return null;
}

function allowedRoots(ctx: ToolContext): string[] {
  return [ctx.workspaceDir, ctx.stateDir, ...(ctx.allowCodeEdit ? [ctx.codeDir] : [])];
}

function resolveShellCwd(requestedCwd: string | undefined, ctx: ToolContext): string {
  const inputPath = typeof requestedCwd === "string" && requestedCwd.trim() ? requestedCwd.trim() : ctx.workspaceDir;
  return resolveWithinRoots({
    inputPath,
    roots: allowedRoots(ctx),
    defaultRoot: ctx.workspaceDir,
  });
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function ensureFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, "", { mode: 0o600 });
  }
}

async function fileSize(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return 0;
    return stat.size;
  } catch {
    return 0;
  }
}

async function readFileRange(filePath: string, start: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readSessionMeta(stateDir: string, sessionId: string): Promise<SessionMeta | null> {
  const filePath = shellMetaPath(stateDir, sessionId);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = parseJsonObject(raw);
    if (!parsed) return null;
    const session = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
    const tmuxSession = typeof parsed.tmuxSession === "string" ? parsed.tmuxSession : "";
    const cwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
    const logPath = typeof parsed.logPath === "string" ? parsed.logPath : "";
    const createdAt = typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now();
    const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now();
    if (!session || !tmuxSession || !cwd || !logPath) return null;
    return {
      sessionId: session,
      tmuxSession,
      cwd,
      logPath,
      createdAt,
      updatedAt,
    };
  } catch {
    return null;
  }
}

async function writeSessionMeta(stateDir: string, meta: SessionMeta): Promise<void> {
  await fs.mkdir(shellMetaDir(stateDir), { recursive: true });
  await fs.writeFile(shellMetaPath(stateDir, meta.sessionId), formatJson(meta), { mode: 0o600 });
}

async function deleteSessionMeta(stateDir: string, sessionId: string): Promise<void> {
  try {
    await fs.rm(shellMetaPath(stateDir, sessionId), { force: true });
  } catch {
    // ignore
  }
}

async function runTmux(args: string[]): Promise<TmuxResult> {
  try {
    const { stdout, stderr } = await execFileAsync("tmux", args, {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return {
      ok: true,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      rawCode: 0,
      errorMessage: null,
    };
  } catch (err) {
    const anyErr = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    return {
      ok: false,
      stdout: anyErr.stdout ?? "",
      stderr: anyErr.stderr ?? "",
      rawCode: anyErr.code,
      errorMessage: anyErr.message ?? String(err),
    };
  }
}

async function ensureTmuxAvailable(): Promise<string | null> {
  const probe = await runTmux(["-V"]);
  if (probe.ok) return null;
  if (probe.rawCode === "ENOENT") {
    return "ERROR: tmux is not installed in this runtime.";
  }
  const detail = [probe.errorMessage, probe.stderr].filter(Boolean).join(" | ");
  return `ERROR: tmux probe failed: ${truncateDetail(detail || "unknown error")}`;
}

async function tmuxHasSession(tmuxSession: string): Promise<boolean> {
  const res = await runTmux(["has-session", "-t", tmuxSession]);
  return res.ok;
}

async function readTimedOutput(params: {
  logPath: string;
  cursor: number;
  waitMs: number;
  idleMs: number;
  maxChars: number;
}): Promise<{
  output: string;
  nextCursor: number;
  totalBytes: number;
  truncated: boolean;
  resetCursor: boolean;
}> {
  await ensureFile(params.logPath);

  let startCursor = Math.max(0, Math.floor(params.cursor));
  const initialSize = await fileSize(params.logPath);
  let resetCursor = false;
  if (startCursor > initialSize) {
    startCursor = 0;
    resetCursor = true;
  }

  const deadline = Date.now() + Math.max(0, params.waitMs);
  let observedSize = await fileSize(params.logPath);
  let hasNewOutput = observedSize > startCursor;

  while (!hasNewOutput && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    observedSize = await fileSize(params.logPath);
    hasNewOutput = observedSize > startCursor;
  }

  let finalSize = observedSize;
  if (hasNewOutput && params.idleMs > 0) {
    let quietUntil = Date.now() + params.idleMs;
    while (Date.now() < deadline && Date.now() < quietUntil) {
      await sleep(POLL_INTERVAL_MS);
      const nextSize = await fileSize(params.logPath);
      if (nextSize > finalSize) {
        finalSize = nextSize;
        quietUntil = Date.now() + params.idleMs;
      }
    }
  }

  const bytesAvailable = Math.max(0, finalSize - startCursor);
  const bytesToRead = Math.min(bytesAvailable, MAX_READ_BYTES);
  const nextCursor = startCursor + bytesToRead;
  const chunk = bytesToRead > 0 ? await readFileRange(params.logPath, startCursor, bytesToRead) : Buffer.alloc(0);
  const decoded = chunk.toString("utf8");
  const output = truncateShellOutput(decoded, params.maxChars);

  return {
    output,
    nextCursor,
    totalBytes: finalSize,
    truncated: nextCursor < finalSize || decoded.length > params.maxChars,
    resetCursor,
  };
}

async function openLocalSession(params: {
  sessionId: string;
  cwd: string | undefined;
  ctx: ToolContext;
}): Promise<string> {
  const tmuxError = await ensureTmuxAvailable();
  if (tmuxError) return tmuxError;

  const tmuxSession = tmuxSessionName(params.sessionId);
  const resolvedCwd = (() => {
    try {
      return resolveShellCwd(params.cwd, params.ctx);
    } catch (err) {
      return `ERROR:${err instanceof Error ? err.message : String(err)}`;
    }
  })();
  if (resolvedCwd.startsWith("ERROR:")) return resolvedCwd;

  const logPath = shellLogPath(params.ctx.stateDir, params.sessionId);
  await fs.mkdir(shellMetaDir(params.ctx.stateDir), { recursive: true });
  await fs.mkdir(shellLogDir(params.ctx.stateDir), { recursive: true });
  await ensureFile(logPath);

  const existingMeta = await readSessionMeta(params.ctx.stateDir, params.sessionId);
  if (existingMeta && (await tmuxHasSession(existingMeta.tmuxSession))) {
    return formatJson({
      ok: true,
      target: "local",
      action: "open",
      session: params.sessionId,
      existed: true,
      cwd: existingMeta.cwd,
      cursor: await fileSize(existingMeta.logPath),
    });
  }

  await deleteSessionMeta(params.ctx.stateDir, params.sessionId);
  await fs.writeFile(logPath, "", { mode: 0o600 });

  const createRes = await runTmux(["new-session", "-d", "-s", tmuxSession, "-c", resolvedCwd]);
  if (!createRes.ok) {
    const detail = [createRes.errorMessage, createRes.stderr].filter(Boolean).join(" | ");
    return `ERROR: failed to open tmux session: ${truncateDetail(detail || "unknown error")}`;
  }

  await runTmux(["set-option", "-t", tmuxSession, "history-limit", "200000"]);
  const pipeCommand = `cat >> ${shellEscape(logPath)}`;
  const pipeRes = await runTmux(["pipe-pane", "-o", "-t", `${tmuxSession}:0.0`, pipeCommand]);
  if (!pipeRes.ok) {
    await runTmux(["kill-session", "-t", tmuxSession]);
    const detail = [pipeRes.errorMessage, pipeRes.stderr].filter(Boolean).join(" | ");
    return `ERROR: failed to attach tmux output pipe: ${truncateDetail(detail || "unknown error")}`;
  }

  const now = Date.now();
  const meta: SessionMeta = {
    sessionId: params.sessionId,
    tmuxSession,
    cwd: resolvedCwd,
    logPath,
    createdAt: now,
    updatedAt: now,
  };
  await writeSessionMeta(params.ctx.stateDir, meta);

  return formatJson({
    ok: true,
    target: "local",
    action: "open",
    session: params.sessionId,
    existed: false,
    cwd: resolvedCwd,
    cursor: 0,
  });
}

async function sendLocalInput(params: {
  sessionId: string;
  input: string;
  enter: boolean;
  ctx: ToolContext;
}): Promise<string> {
  const tmuxError = await ensureTmuxAvailable();
  if (tmuxError) return tmuxError;

  const meta = await readSessionMeta(params.ctx.stateDir, params.sessionId);
  if (!meta) return `ERROR: interactive session not found: ${params.sessionId}`;
  const target = `${meta.tmuxSession}:0.0`;
  if (!(await tmuxHasSession(meta.tmuxSession))) {
    return `ERROR: interactive session is not running: ${params.sessionId}`;
  }

  const sendRes = await runTmux(["send-keys", "-t", target, "-l", params.input]);
  if (!sendRes.ok) {
    const detail = [sendRes.errorMessage, sendRes.stderr].filter(Boolean).join(" | ");
    return `ERROR: failed to send tmux input: ${truncateDetail(detail || "unknown error")}`;
  }

  if (params.enter) {
    const enterRes = await runTmux(["send-keys", "-t", target, "Enter"]);
    if (!enterRes.ok) {
      const detail = [enterRes.errorMessage, enterRes.stderr].filter(Boolean).join(" | ");
      return `ERROR: failed to send Enter key: ${truncateDetail(detail || "unknown error")}`;
    }
  }

  meta.updatedAt = Date.now();
  await writeSessionMeta(params.ctx.stateDir, meta);

  return formatJson({
    ok: true,
    target: "local",
    action: "send",
    session: params.sessionId,
    enter: params.enter,
    cursor: await fileSize(meta.logPath),
  });
}

async function readLocalOutput(params: {
  sessionId: string;
  cursor: number;
  waitMs: number;
  idleMs: number;
  maxChars: number;
  ctx: ToolContext;
}): Promise<string> {
  const meta = await readSessionMeta(params.ctx.stateDir, params.sessionId);
  if (!meta) return `ERROR: interactive session not found: ${params.sessionId}`;

  const read = await readTimedOutput({
    logPath: meta.logPath,
    cursor: params.cursor,
    waitMs: params.waitMs,
    idleMs: params.idleMs,
    maxChars: params.maxChars,
  });
  const running = await tmuxHasSession(meta.tmuxSession);
  meta.updatedAt = Date.now();
  await writeSessionMeta(params.ctx.stateDir, meta);

  return formatJson({
    ok: true,
    target: "local",
    action: "read",
    session: params.sessionId,
    output: read.output,
    nextCursor: read.nextCursor,
    totalBytes: read.totalBytes,
    truncated: read.truncated,
    resetCursor: read.resetCursor,
    running,
  });
}

async function interruptLocalSession(params: { sessionId: string; ctx: ToolContext }): Promise<string> {
  const tmuxError = await ensureTmuxAvailable();
  if (tmuxError) return tmuxError;
  const meta = await readSessionMeta(params.ctx.stateDir, params.sessionId);
  if (!meta) return `ERROR: interactive session not found: ${params.sessionId}`;
  if (!(await tmuxHasSession(meta.tmuxSession))) {
    return `ERROR: interactive session is not running: ${params.sessionId}`;
  }
  const res = await runTmux(["send-keys", "-t", `${meta.tmuxSession}:0.0`, "C-c"]);
  if (!res.ok) {
    const detail = [res.errorMessage, res.stderr].filter(Boolean).join(" | ");
    return `ERROR: failed to interrupt session: ${truncateDetail(detail || "unknown error")}`;
  }
  meta.updatedAt = Date.now();
  await writeSessionMeta(params.ctx.stateDir, meta);
  return formatJson({
    ok: true,
    target: "local",
    action: "interrupt",
    session: params.sessionId,
  });
}

async function closeLocalSession(params: { sessionId: string; ctx: ToolContext }): Promise<string> {
  const tmuxError = await ensureTmuxAvailable();
  if (tmuxError) return tmuxError;
  const meta = await readSessionMeta(params.ctx.stateDir, params.sessionId);
  if (!meta) {
    return formatJson({
      ok: true,
      target: "local",
      action: "close",
      session: params.sessionId,
      alreadyClosed: true,
    });
  }

  const running = await tmuxHasSession(meta.tmuxSession);
  if (running) {
    await runTmux(["kill-session", "-t", meta.tmuxSession]);
  }
  await deleteSessionMeta(params.ctx.stateDir, params.sessionId);
  try {
    await fs.rm(meta.logPath, { force: true });
  } catch {
    // ignore — log file may already be gone
  }

  return formatJson({
    ok: true,
    target: "local",
    action: "close",
    session: params.sessionId,
    wasRunning: running,
  });
}

async function listLocalSessions(ctx: ToolContext): Promise<string> {
  await fs.mkdir(shellMetaDir(ctx.stateDir), { recursive: true });
  const names = await fs.readdir(shellMetaDir(ctx.stateDir));
  const sessions: Array<Record<string, unknown>> = [];
  for (const entry of names.sort((a, b) => a.localeCompare(b))) {
    if (!entry.endsWith(".json")) continue;
    const sessionId = entry.slice(0, -5);
    const meta = await readSessionMeta(ctx.stateDir, sessionId);
    if (!meta) continue;
    sessions.push({
      session: sessionId,
      cwd: meta.cwd,
      running: await tmuxHasSession(meta.tmuxSession),
      logBytes: await fileSize(meta.logPath),
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    });
  }
  return formatJson({
    ok: true,
    target: "local",
    action: "list",
    count: sessions.length,
    sessions,
  });
}

export async function reapStaleSessions(stateDir: string): Promise<{ reaped: string[]; orphanLogs: string[] }> {
  const metaDir = shellMetaDir(stateDir);
  const logDir = shellLogDir(stateDir);
  await fs.mkdir(metaDir, { recursive: true });
  await fs.mkdir(logDir, { recursive: true });

  const reaped: string[] = [];
  const activeLogFiles = new Set<string>();

  // Pass 1: check meta files, reap sessions where tmux is dead
  const metaEntries = await fs.readdir(metaDir);
  for (const entry of metaEntries) {
    if (!entry.endsWith(".json")) continue;
    const sessionId = entry.slice(0, -5);
    const meta = await readSessionMeta(stateDir, sessionId);
    if (!meta) {
      // Corrupt meta — remove it
      try { await fs.rm(path.join(metaDir, entry), { force: true }); } catch { /* ignore */ }
      continue;
    }
    if (await tmuxHasSession(meta.tmuxSession)) {
      // Still alive — track its log file as active
      activeLogFiles.add(path.basename(meta.logPath));
      continue;
    }
    // Dead tmux session — clean up meta + log
    await deleteSessionMeta(stateDir, sessionId);
    try { await fs.rm(meta.logPath, { force: true }); } catch { /* ignore */ }
    reaped.push(sessionId);
  }

  // Pass 2: find orphan log files with no corresponding meta
  const orphanLogs: string[] = [];
  const logEntries = await fs.readdir(logDir);
  for (const entry of logEntries) {
    if (!entry.endsWith(".log")) continue;
    if (activeLogFiles.has(entry)) continue;
    const sessionId = entry.slice(0, -4);
    const meta = await readSessionMeta(stateDir, sessionId);
    if (meta) continue; // meta still exists (shouldn't happen after pass 1, but be safe)
    try { await fs.rm(path.join(logDir, entry), { force: true }); } catch { /* ignore */ }
    orphanLogs.push(entry);
  }

  return { reaped, orphanLogs };
}

function encodeBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function buildNodeShellCommand(params: {
  action: "open" | "send" | "read" | "list" | "close" | "interrupt";
  sessionId: string | null;
  cwd?: string;
  input?: string;
  enter: boolean;
  cursor: number;
  waitMs: number;
  idleMs: number;
  maxChars: number;
}): { command?: string; error?: string } {
  const { action } = params;
  const sessionId = params.sessionId;
  if (action !== "list" && !sessionId) {
    return { error: "session is required for this action." };
  }

  const tokens: string[] = ["nexus-shellctl", action];
  if (sessionId) {
    tokens.push("--session", sessionId);
  }

  if (action === "open" && typeof params.cwd === "string" && params.cwd.trim()) {
    tokens.push("--cwd-b64", encodeBase64(params.cwd));
  }
  if (action === "send") {
    if (typeof params.input !== "string" || params.input.length === 0) {
      return { error: "input is required for send action." };
    }
    tokens.push("--payload-b64", encodeBase64(params.input));
    tokens.push("--enter", params.enter ? "1" : "0");
  }
  if (action === "read") {
    tokens.push("--cursor", String(Math.max(0, Math.floor(params.cursor))));
    tokens.push("--wait-ms", String(Math.max(0, Math.floor(params.waitMs))));
    tokens.push("--idle-ms", String(Math.max(50, Math.floor(params.idleMs))));
    tokens.push("--max-chars", String(Math.max(128, Math.floor(params.maxChars))));
  }

  return { command: tokens.join(" ") };
}

async function executeOnNode(params: {
  action: "open" | "send" | "read" | "list" | "close" | "interrupt";
  sessionId: string | null;
  nodeId: string;
  cwd?: string;
  input?: string;
  enter: boolean;
  cursor: number;
  waitMs: number;
  idleMs: number;
  maxChars: number;
  timeoutMs: number;
  ctx: ToolContext;
}): Promise<string> {
  const db = params.ctx.db as NexusDatabase | undefined;
  if (!db) return "ERROR: database is not available";
  const node = getNodeById(db, params.nodeId);
  if (!node) return "ERROR: node not found";
  if (node.backend !== "nexus") return `ERROR: node backend ${node.backend} does not support interactive shell`;
  if (!params.ctx.nodeRouter) return "ERROR: node routing transport is not available";

  const built = buildNodeShellCommand({
    action: params.action,
    sessionId: params.sessionId,
    cwd: params.cwd,
    input: params.input,
    enter: params.enter,
    cursor: params.cursor,
    waitMs: params.waitMs,
    idleMs: params.idleMs,
    maxChars: params.maxChars,
  });
  if (built.error) return `ERROR: ${built.error}`;
  const command = built.command ?? "";

  const timeoutMs =
    params.action === "read"
      ? Math.max(params.timeoutMs, Math.min(120_000, params.waitMs + params.idleMs + 5_000))
      : params.timeoutMs;

  try {
    const raw = await params.ctx.nodeRouter.routeToolExecution(
      nodeShellRoutingTool,
      {
        command,
        timeoutMs,
        security: {
          requireNexusBackend: true,
        },
      },
      {
        ...params.ctx,
        executionNode: params.nodeId,
        executionMode: "remote",
      },
    );
    const parsed = parseJsonObject(raw);
    if (!parsed) {
      return `ERROR: node shell response is not JSON (raw=${truncateShellOutput(raw, 260)}).`;
    }
    if (typeof parsed.action !== "string" || typeof parsed.ok !== "boolean") {
      const mode = typeof parsed.mode === "string" ? parsed.mode : "";
      if (mode && mode !== "transparent") {
        return "ERROR: node shell response is sanitized by firewall mode; interactive read requires transparent mode.";
      }
      return `ERROR: unexpected node shell response shape (raw=${truncateShellOutput(raw, 260)}).`;
    }
    return formatJson(parsed);
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const shellInteractive = defineTool({
  name: "shell_interactive",
  description: [
    "Manage interactive tmux shell sessions with timed output reads.",
    "Workflow: open → send+read cycles → close.",
    "IMPORTANT: send only pushes input; it does NOT return output. You MUST call read after every send to observe the result. Never chain multiple sends without reading in between.",
    "read returns output since the given cursor; pass the nextCursor from the previous read/send response. Use waitMs to block until output appears.",
    "Use target=node for remote Nexus nodes (requires nexus-shellctl allowlisted and firewallMode=transparent).",
  ].join(" "),
  parameters: z.object({
    action: z.enum(["open", "send", "read", "list", "close", "interrupt"]),
    target: z.enum(["local", "node"]).default("local"),
    nodeId: z.string().min(1).max(128).optional(),
    session: z.string().min(1).max(64).optional().describe("Session name [A-Za-z0-9._-], required except action=list."),
    cwd: z.string().max(2000).optional(),
    input: z.string().max(20_000).optional(),
    enter: z.boolean().default(true),
    cursor: z.number().int().min(0).default(0),
    waitMs: z.number().int().min(0).max(5_000).default(1_500),
    idleMs: z.number().int().min(50).max(1_000).default(200),
    maxChars: z.number().int().min(128).max(12_000).default(4_000),
    timeoutMs: z.number().int().positive().max(120_000).default(30_000),
  }),
  execute: async (args, ctx) => {
    const presetError = requireAllowedPreset(ctx);
    if (presetError) return presetError;

    const action = args.action;
    const sessionId = normalizeSessionId(args.session);
    if (action !== "list" && !sessionId) {
      return "ERROR: session is required for this action and must match [A-Za-z0-9._-] (max 64 chars).";
    }
    if (action === "send" && (!args.input || args.input.length === 0)) {
      return "ERROR: input is required for send action.";
    }

    if (args.target === "node") {
      const nodeId = typeof args.nodeId === "string" ? args.nodeId.trim() : "";
      if (!nodeId) return "ERROR: nodeId is required when target=node.";
      return await executeOnNode({
        action,
        sessionId,
        nodeId,
        cwd: args.cwd,
        input: args.input,
        enter: args.enter,
        cursor: args.cursor,
        waitMs: args.waitMs,
        idleMs: args.idleMs,
        maxChars: args.maxChars,
        timeoutMs: args.timeoutMs,
        ctx,
      });
    }

    switch (action) {
      case "open":
        return await openLocalSession({ sessionId: sessionId!, cwd: args.cwd, ctx });
      case "send":
        return await sendLocalInput({
          sessionId: sessionId!,
          input: args.input ?? "",
          enter: args.enter,
          ctx,
        });
      case "read":
        return await readLocalOutput({
          sessionId: sessionId!,
          cursor: args.cursor,
          waitMs: args.waitMs,
          idleMs: args.idleMs,
          maxChars: args.maxChars,
          ctx,
        });
      case "interrupt":
        return await interruptLocalSession({ sessionId: sessionId!, ctx });
      case "close":
        return await closeLocalSession({ sessionId: sessionId!, ctx });
      case "list":
        return await listLocalSessions(ctx);
      default:
        return `ERROR: unsupported action ${action}`;
    }
  },
});
