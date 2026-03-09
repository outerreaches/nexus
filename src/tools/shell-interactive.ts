import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { defineTool, type Tool, type ToolContext } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";
import { getNodeById } from "../storage/nodes.js";
import { resolveWithinRoots } from "./path-utils.js";
import { isMutatingGitOnCodeDir, isPathUnderRoot, truncateShellOutput } from "./system.js";

const execFileAsync = promisify(execFile);

const ALLOWED_PRESETS = new Set(["orchestrator", "coder", "security-researcher"]);
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const POLL_INTERVAL_MS = 60;
const MAX_READ_BYTES = 128_000;

type SessionMeta = {
  sessionId: string;
  tmuxSession: string;
  cwd: string;
  logPath: string;
  lastReadCursor: number;
  createdAt: number;
  updatedAt: number;
  ownerSessionId?: string | null;
  ownerRunId?: string | null;
  ownerChannel?: string | null;
  ownerChannelKey?: string | null;
  ownerAgentId?: string | null;
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

const ESC_CHAR = String.fromCharCode(27);
const BEL_CHAR = String.fromCharCode(7);
const ANSI_ESCAPE_RE = new RegExp(`${ESC_CHAR}\\[[0-?]*[ -/]*[@-~]`, "g");
const ANSI_OSC_RE = new RegExp(`${ESC_CHAR}\\][^${BEL_CHAR}]*(?:${BEL_CHAR}|${ESC_CHAR}\\\\)`, "g");

function formatJson(value: unknown): string {
  return JSON.stringify(value);
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

function stripShellProgressFormatting(input: string): string {
  const sanitized = input
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_ESCAPE_RE, "")
    .replace(/\r/g, "");
  let out = "";
  for (let i = 0; i < sanitized.length; i += 1) {
    const code = sanitized.charCodeAt(i);
    if ((code >= 0 && code <= 8) || (code >= 11 && code <= 31) || code === 127) continue;
    out += sanitized[i]!;
  }
  return out.trim();
}

export function compactProgressOutput(output: string): {
  output: string;
  compacted: boolean;
  suppressedFrames: number;
  originalChars?: number;
} {
  if (!output.includes("\r")) {
    return { output, compacted: false, suppressedFrames: 0 };
  }

  const hadTrailingNewline = output.endsWith("\n");
  const segments = output.split("\n");
  let compacted = false;
  let suppressedFrames = 0;
  const rebuilt = segments.map((segment) => {
    if (!segment.includes("\r")) return segment;
    const frames = segment.split("\r").filter((part) => part.length > 0);
    if (frames.length < 3) return segment;

    compacted = true;
    suppressedFrames += frames.length - 1;
    const latest = stripShellProgressFormatting(frames[frames.length - 1] ?? "");
    const latestSummary = truncateShellOutput(latest || "(no visible text)", 240).replace(/\r?\n/g, " ");
    const suffix = frames.length - 1 === 1 ? "" : "s";
    return `[progress updates compacted: ${frames.length - 1} frame${suffix}; latest: ${latestSummary}]`;
  });

  if (!compacted) {
    return { output, compacted: false, suppressedFrames: 0 };
  }

  let compactedOutput = rebuilt.join("\n");
  if (hadTrailingNewline && !compactedOutput.endsWith("\n")) compactedOutput += "\n";
  return {
    output: compactedOutput,
    compacted: true,
    suppressedFrames,
    originalChars: output.length,
  };
}

export function compactShellReadPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.action !== "read" || typeof payload.output !== "string") return payload;
  const compacted = compactProgressOutput(payload.output);
  if (!compacted.compacted) return payload;
  return {
    ...payload,
    output: compacted.output,
    progressCompacted: true,
    suppressedFrames: compacted.suppressedFrames,
    outputOriginalChars: compacted.originalChars,
  };
}

function requireAllowedPreset(ctx: ToolContext): string | null {
  const preset = ctx.request?.preset?.trim() ?? "";
  if (!ALLOWED_PRESETS.has(preset)) {
    return "ERROR: shell_interactive is only available to orchestrator, coder, and security-researcher presets.";
  }
  return null;
}

function requireShellExecEnabled(ctx: ToolContext): string | null {
  if (!ctx.allowShellExec) {
    return "ERROR: shell_interactive is disabled by policy";
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

export function orchestratorCodeShellPolicyError(ctx: ToolContext, cwd: string): string | null {
  if (ctx.request?.preset !== "orchestrator") return null;
  if (!isPathUnderRoot(cwd, ctx.codeDir)) return null;
  return (
    "ERROR: orchestrator must not use shell_interactive inside the repository code root. " +
    "Spawn a coder worker for code inspection, edits, or deploy workflow tests."
  );
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
    const lastReadCursor = typeof parsed.lastReadCursor === "number" && Number.isFinite(parsed.lastReadCursor)
      ? Math.max(0, Math.floor(parsed.lastReadCursor))
      : 0;
    const createdAt = typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now();
    const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now();
    const ownerSessionId = typeof parsed.ownerSessionId === "string" ? parsed.ownerSessionId : null;
    const ownerRunId = typeof parsed.ownerRunId === "string" ? parsed.ownerRunId : null;
    const ownerChannel = typeof parsed.ownerChannel === "string" ? parsed.ownerChannel : null;
    const ownerChannelKey = typeof parsed.ownerChannelKey === "string" ? parsed.ownerChannelKey : null;
    const ownerAgentId = typeof parsed.ownerAgentId === "string" ? parsed.ownerAgentId : null;
    if (!session || !tmuxSession || !cwd || !logPath) return null;
    return {
      sessionId: session,
      tmuxSession,
      cwd,
      logPath,
      lastReadCursor,
      createdAt,
      updatedAt,
      ownerSessionId,
      ownerRunId,
      ownerChannel,
      ownerChannelKey,
      ownerAgentId,
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

async function tmuxPaneCurrentPath(tmuxSession: string): Promise<string | null> {
  const res = await runTmux(["display-message", "-p", "-t", `${tmuxSession}:0.0`, "#{pane_current_path}"]);
  if (!res.ok) return null;
  const value = res.stdout.trim();
  return value.length > 0 ? value : null;
}

export function paginateUtf8Chunk(buffer: Buffer, maxChars: number): {
  output: string;
  consumedBytes: number;
  truncatedByChars: boolean;
} {
  // Important: consumedBytes tracks exactly what we return so callers can
  // paginate without skipping unseen output.
  if (buffer.length === 0 || maxChars <= 0) {
    return { output: "", consumedBytes: 0, truncatedByChars: false };
  }

  let offset = 0;
  let chars = 0;
  while (offset < buffer.length && chars < maxChars) {
    const byte = buffer[offset];
    let width = 1;
    if ((byte & 0b1000_0000) === 0) {
      width = 1;
    } else if ((byte & 0b1110_0000) === 0b1100_0000) {
      width = 2;
    } else if ((byte & 0b1111_0000) === 0b1110_0000) {
      width = 3;
    } else if ((byte & 0b1111_1000) === 0b1111_0000) {
      width = 4;
    } else {
      width = 1;
    }

    if (offset + width > buffer.length) break;
    let valid = true;
    for (let i = 1; i < width; i += 1) {
      if ((buffer[offset + i]! & 0b1100_0000) !== 0b1000_0000) {
        valid = false;
        break;
      }
    }
    offset += valid ? width : 1;
    chars += 1;
  }

  if (offset === 0 && buffer.length > 0) {
    offset = 1;
  }

  return {
    output: buffer.subarray(0, offset).toString("utf8"),
    consumedBytes: offset,
    truncatedByChars: offset < buffer.length,
  };
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
  const chunk = bytesToRead > 0 ? await readFileRange(params.logPath, startCursor, bytesToRead) : Buffer.alloc(0);
  const paged = paginateUtf8Chunk(chunk, params.maxChars);
  const nextCursor = startCursor + paged.consumedBytes;

  return {
    output: paged.output,
    nextCursor,
    totalBytes: finalSize,
    truncated: nextCursor < finalSize || paged.truncatedByChars,
    resetCursor,
  };
}

async function listOtherSessions(stateDir: string, excludeSessionId: string): Promise<Array<{ session: string; cwd: string; running: boolean }>> {
  try {
    const names = await fs.readdir(shellMetaDir(stateDir));
    const others: Array<{ session: string; cwd: string; running: boolean }> = [];
    for (const entry of names) {
      if (!entry.endsWith(".json")) continue;
      const sid = entry.slice(0, -5);
      if (sid === excludeSessionId) continue;
      const meta = await readSessionMeta(stateDir, sid);
      if (!meta) continue;
      others.push({ session: sid, cwd: meta.cwd, running: await tmuxHasSession(meta.tmuxSession) });
    }
    return others;
  } catch {
    return [];
  }
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
  const shellPolicyError = orchestratorCodeShellPolicyError(params.ctx, resolvedCwd);
  if (shellPolicyError) return shellPolicyError;

  const logPath = shellLogPath(params.ctx.stateDir, params.sessionId);
  await fs.mkdir(shellMetaDir(params.ctx.stateDir), { recursive: true });
  await fs.mkdir(shellLogDir(params.ctx.stateDir), { recursive: true });
  await ensureFile(logPath);

  const existingMeta = await readSessionMeta(params.ctx.stateDir, params.sessionId);
  if (existingMeta && (await tmuxHasSession(existingMeta.tmuxSession))) {
    const cursor = await fileSize(existingMeta.logPath);
    existingMeta.lastReadCursor = cursor;
    existingMeta.updatedAt = Date.now();
    await writeSessionMeta(params.ctx.stateDir, existingMeta);
    const otherSessions = await listOtherSessions(params.ctx.stateDir, params.sessionId);
    return formatJson({
      ok: true,
      target: "local",
      action: "open",
      session: params.sessionId,
      existed: true,
      cwd: existingMeta.cwd,
      cursor,
      ...(otherSessions.length > 0 ? { otherSessions } : {}),
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
    lastReadCursor: 0,
    createdAt: now,
    updatedAt: now,
    ownerSessionId: params.ctx.request?.sessionId ?? null,
    ownerRunId: params.ctx.request?.runId ?? null,
    ownerChannel: params.ctx.request?.channel ?? null,
    ownerChannelKey: params.ctx.request?.channelKey ?? null,
    ownerAgentId: params.ctx.request?.agentId ?? null,
  };
  await writeSessionMeta(params.ctx.stateDir, meta);

  const otherSessions = await listOtherSessions(params.ctx.stateDir, params.sessionId);
  return formatJson({
    ok: true,
    target: "local",
    action: "open",
    session: params.sessionId,
    existed: false,
    cwd: resolvedCwd,
    cursor: 0,
    ...(otherSessions.length > 0 ? { otherSessions } : {}),
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

  const liveCwd = await tmuxPaneCurrentPath(meta.tmuxSession);
  const cwdForPolicy = liveCwd ?? meta.cwd;
  if (liveCwd) {
    meta.cwd = liveCwd;
  }
  const shellPolicyError = orchestratorCodeShellPolicyError(params.ctx, cwdForPolicy);
  if (shellPolicyError) return shellPolicyError;

  if (params.enter && isMutatingGitOnCodeDir(params.input, params.ctx.codeDir, { cwd: cwdForPolicy })) {
    return "ERROR: Mutating git commands on the code repository are not allowed from agents. Use ha_deploy to queue a deploy.";
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

  // Cursor remains stable across send; read() advances it based on returned bytes.
  meta.updatedAt = Date.now();
  await writeSessionMeta(params.ctx.stateDir, meta);

  return formatJson({
    ok: true,
    target: "local",
    action: "send",
    session: params.sessionId,
    enter: params.enter,
    cursor: meta.lastReadCursor,
  });
}

async function readLocalOutput(params: {
  sessionId: string;
  cursor?: number;
  waitMs: number;
  idleMs: number;
  maxChars: number;
  ctx: ToolContext;
}): Promise<string> {
  const meta = await readSessionMeta(params.ctx.stateDir, params.sessionId);
  if (!meta) return `ERROR: interactive session not found: ${params.sessionId}`;
  const cursor = typeof params.cursor === "number" && Number.isFinite(params.cursor)
    ? Math.max(0, Math.floor(params.cursor))
    : meta.lastReadCursor;

  const read = await readTimedOutput({
    logPath: meta.logPath,
    cursor,
    waitMs: params.waitMs,
    idleMs: params.idleMs,
    maxChars: params.maxChars,
  });
  const running = await tmuxHasSession(meta.tmuxSession);
  const liveCwd = running ? await tmuxPaneCurrentPath(meta.tmuxSession) : null;
  if (liveCwd) {
    meta.cwd = liveCwd;
  }
  meta.lastReadCursor = read.nextCursor;
  meta.updatedAt = Date.now();
  await writeSessionMeta(params.ctx.stateDir, meta);

  const payload = compactShellReadPayload({
    ok: true,
    target: "local",
    action: "read",
    session: params.sessionId,
    cursorUsed: cursor,
    output: read.output,
    nextCursor: read.nextCursor,
    totalBytes: read.totalBytes,
    truncated: read.truncated,
    resetCursor: read.resetCursor,
    running,
  });
  return formatJson(payload);
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
      ownerSessionId: meta.ownerSessionId ?? null,
      ownerRunId: meta.ownerRunId ?? null,
      ownerChannel: meta.ownerChannel ?? null,
      ownerChannelKey: meta.ownerChannelKey ?? null,
      ownerAgentId: meta.ownerAgentId ?? null,
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

export async function stopLocalInteractiveSessions(params: {
  stateDir: string;
  ownerSessionId?: string | null;
}): Promise<{
  closed: number;
  skipped: number;
  failed: number;
  closedSessions: string[];
  errors: string[];
}> {
  await fs.mkdir(shellMetaDir(params.stateDir), { recursive: true });
  const entries = await fs.readdir(shellMetaDir(params.stateDir));
  const targetOwner = typeof params.ownerSessionId === "string" ? params.ownerSessionId.trim() : "";
  const filterByOwner = targetOwner.length > 0;
  let closed = 0;
  let skipped = 0;
  let failed = 0;
  const closedSessions: string[] = [];
  const errors: string[] = [];

  const candidates: { sessionId: string; meta: Awaited<ReturnType<typeof readSessionMeta>> }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const sessionId = entry.slice(0, -5);
    const meta = await readSessionMeta(params.stateDir, sessionId);
    if (!meta) continue;
    if (filterByOwner && (meta.ownerSessionId ?? "") !== targetOwner) {
      skipped += 1;
      continue;
    }
    candidates.push({ sessionId, meta });
  }

  const results = await Promise.allSettled(
    candidates.map(async ({ sessionId, meta }) => {
      const running = await tmuxHasSession(meta!.tmuxSession);
      if (running) {
        await runTmux(["kill-session", "-t", meta!.tmuxSession]);
      }
      await deleteSessionMeta(params.stateDir, sessionId);
      try {
        await fs.rm(meta!.logPath, { force: true });
      } catch {
        // ignore
      }
      return sessionId;
    }),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      closed += 1;
      closedSessions.push(result.value);
    } else {
      failed += 1;
      errors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    }
  }

  return {
    closed,
    skipped,
    failed,
    closedSessions,
    errors,
  };
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
  cursor?: number;
  waitMs: number;
  idleMs: number;
  maxChars: number;
  ownerSessionId?: string | null;
  ownerRunId?: string | null;
  ownerChannel?: string | null;
  ownerChannelKey?: string | null;
  ownerAgentId?: string | null;
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
  if (action === "open") {
    if (params.ownerSessionId && params.ownerSessionId.trim()) {
      tokens.push("--owner-session", params.ownerSessionId.trim());
    }
    if (params.ownerRunId && params.ownerRunId.trim()) {
      tokens.push("--owner-run", params.ownerRunId.trim());
    }
    if (params.ownerChannel && params.ownerChannel.trim()) {
      tokens.push("--owner-channel", params.ownerChannel.trim());
    }
    if (params.ownerChannelKey && params.ownerChannelKey.trim()) {
      tokens.push("--owner-channel-key", params.ownerChannelKey.trim());
    }
    if (params.ownerAgentId && params.ownerAgentId.trim()) {
      tokens.push("--owner-agent", params.ownerAgentId.trim());
    }
  }
  if (action === "send") {
    if (typeof params.input !== "string" || params.input.length === 0) {
      return { error: "input is required for send action." };
    }
    tokens.push("--payload-b64", encodeBase64(params.input));
    tokens.push("--enter", params.enter ? "1" : "0");
  }
  if (action === "read") {
    if (typeof params.cursor === "number" && Number.isFinite(params.cursor)) {
      tokens.push("--cursor", String(Math.max(0, Math.floor(params.cursor))));
    }
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
  cursor?: number;
  waitMs: number;
  idleMs: number;
  maxChars: number;
  timeoutMs: number;
  ctx: ToolContext;
  ownerSessionId?: string | null;
  ownerRunId?: string | null;
  ownerChannel?: string | null;
  ownerChannelKey?: string | null;
  ownerAgentId?: string | null;
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
    ownerSessionId: params.ownerSessionId,
    ownerRunId: params.ownerRunId,
    ownerChannel: params.ownerChannel,
    ownerChannelKey: params.ownerChannelKey,
    ownerAgentId: params.ownerAgentId,
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
    return formatJson(compactShellReadPayload(parsed));
  } catch (err) {
    return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const shellInteractive = defineTool({
  name: "shell_interactive",
  description: [
    "Manage interactive tmux shell sessions locally or on connected Nexus nodes.",
    "Workflow: open → send+read cycles → close. Use action=list to see all existing sessions before opening a new one (avoids duplicates).",
    "open returns an otherSessions array when other sessions exist, showing their name, cwd, and running status — prefer reusing a relevant session over creating a new one.",
    "IMPORTANT: send only pushes input; it does NOT return output. You MUST call read after every send to observe the result. Never chain multiple sends without reading in between.",
    "Do not use sleep commands as a waiting strategy. For long-running/background tasks, use `process_manage` instead of blocking an interactive foreground shell.",
    "read returns output since the given cursor; pass nextCursor from the previous read/send response. If cursor is omitted, it resumes from the session's last read cursor.",
    "Defaults to local (target=local). Use target=node only when the task specifically requires running on a remote node (e.g. node-local files, GPU, node-specific services). Node shells require nodeId, nexus-shellctl allowlisted, and firewallMode=transparent.",
  ].join(" "),
  parameters: z.object({
    action: z.enum(["open", "send", "read", "list", "close", "interrupt"]),
    target: z.enum(["local", "node"]).default("local"),
    nodeId: z.string().min(1).max(128).optional(),
    session: z.string().min(1).max(64).optional().describe("Session name [A-Za-z0-9._-], required except action=list."),
    cwd: z.string().max(2000).optional(),
    input: z.string().max(20_000).optional(),
    enter: z.boolean().default(true),
    cursor: z.number().int().min(0).optional(),
    waitMs: z.number().int().min(0).max(5_000).default(1_500),
    idleMs: z.number().int().min(50).max(1_000).default(200),
    maxChars: z.number().int().min(128).max(4_000).default(1_500),
    timeoutMs: z.number().int().positive().max(120_000).default(30_000),
  }),
  execute: async (args, ctx) => {
    const shellPolicyError = requireShellExecEnabled(ctx);
    if (shellPolicyError) return shellPolicyError;

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
        ownerSessionId: ctx.request?.sessionId ?? null,
        ownerRunId: ctx.request?.runId ?? null,
        ownerChannel: ctx.request?.channel ?? null,
        ownerChannelKey: ctx.request?.channelKey ?? null,
        ownerAgentId: ctx.request?.agentId ?? null,
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
