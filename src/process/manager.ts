import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { NexusDatabase } from "../storage/database.js";

type ProcStatus = "running" | "exited" | "stopped";

type LinuxProcMeta = {
  startTicks?: number | null;
  cmdline?: string | null;
};

export type ManagedProcessInfo = {
  id: string;
  command: string;
  cwd: string;
  pid: number | null;
  status: ProcStatus;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  logPath: string;
};

export type ProcessRequestContext = {
  channel: string;
  channelKey: string;
  agentId: string;
  preset?: string;
  sessionId: string;
  runId?: string;
  parentRunId?: string;
};

function randomId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(10);
  let out = "P";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readLinuxProcStatStartTicks(pid: number): Promise<number | null> {
  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, "utf8");
    const closeIdx = stat.lastIndexOf(")");
    if (closeIdx < 0) return null;
    // Fields after the trailing ") " correspond to columns 3..N of /proc/<pid>/stat.
    const after = stat.slice(closeIdx + 2).trim();
    const parts = after.split(/\s+/);
    // starttime is field 22 (1-indexed). We've removed fields 1-2, so it's at index 19 (0-indexed).
    const startStr = parts[19];
    const n = Number(startStr);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function readLinuxProcCmdline(pid: number): Promise<string | null> {
  try {
    const buf = await fsp.readFile(`/proc/${pid}/cmdline`);
    const text = buf.toString("utf8").replace(/\0+/g, " ").trim();
    return text || null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the PID exists but we don't have permission to signal it.
    // Treat as alive for reconciliation purposes.
    if (typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "EPERM") {
      return true;
    }
    return false;
  }
}

export class ProcessManager {
  private readonly procs = new Map<string, { info: ManagedProcessInfo; child: ChildProcessWithoutNullStreams | null }>();

  constructor(
    private readonly cfg: {
      stateDir: string;
      db?: NexusDatabase;
    },
  ) {}

  private get baseDir(): string {
    return path.join(this.cfg.stateDir, "processes");
  }

  private persistMetadataMerge(id: string, patch: Record<string, unknown>): void {
    const db = this.cfg.db;
    if (!db) return;
    const nowMs = Date.now();
    try {
      const row = db.db.prepare("SELECT metadata_json FROM process_runs WHERE id = ?").get(id) as { metadata_json?: unknown } | undefined;
      const prev = typeof row?.metadata_json === "string" ? (safeJsonParse<Record<string, unknown>>(row.metadata_json) ?? {}) : {};
      const next = { ...prev, ...patch };
      db.db.prepare("UPDATE process_runs SET metadata_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), nowMs, id);
    } catch {
      // best-effort persistence
    }
  }

  private async captureAndPersistLinuxProcMeta(id: string, pid: number): Promise<void> {
    if (process.platform !== "linux") return;
    const startTicks = await readLinuxProcStatStartTicks(pid);
    const cmdline = await readLinuxProcCmdline(pid);
    if (startTicks === null && cmdline === null) return;
    this.persistMetadataMerge(id, { linuxProc: { startTicks, cmdline } });
  }

  private persistStart(info: ManagedProcessInfo, request?: ProcessRequestContext, metadataJson: string = "{}"): void {
    const db = this.cfg.db;
    if (!db) return;
    try {
      db.db
        .prepare(
          `
          INSERT INTO process_runs (
            id, backend, status, command, cwd, pid, started_at, ended_at, exit_code, signal, log_path,
            node_id, node_execution_id,
            created_by_job_id, created_by_job_run_id,
            request_channel, request_channel_key, request_agent_id, request_preset, request_session_id, request_run_id, request_parent_run_id,
            metadata_json,
            created_at, updated_at
          ) VALUES (
            ?, 'local_child', ?, ?, ?, ?, ?, ?, ?, ?, ?,
            NULL, NULL,
            NULL, NULL,
            ?, ?, ?, ?, ?, ?, ?,
            ?,
            ?, ?
          )
        `,
        )
        .run(
          info.id,
          info.status,
          info.command,
          info.cwd,
          info.pid,
          info.startedAt,
          info.endedAt,
          info.exitCode,
          info.signal,
          info.logPath,
          request?.channel ?? null,
          request?.channelKey ?? null,
          request?.agentId ?? null,
          request?.preset ?? null,
          request?.sessionId ?? null,
          request?.runId ?? null,
          request?.parentRunId ?? null,
          metadataJson,
          info.startedAt,
          info.startedAt,
        );
    } catch {
      // best-effort persistence
    }
  }

  private persistUpdate(info: ManagedProcessInfo): void {
    const db = this.cfg.db;
    if (!db) return;
    const nowMs = Date.now();
    try {
      db.db
        .prepare(
          `
          UPDATE process_runs
          SET status = ?,
              pid = ?,
              ended_at = ?,
              exit_code = ?,
              signal = ?,
              updated_at = ?
          WHERE id = ?
        `,
        )
        .run(info.status, info.pid, info.endedAt, info.exitCode, info.signal, nowMs, info.id);
    } catch {
      // best-effort persistence
    }
  }

  private rowToInfo(row: any): ManagedProcessInfo {
    return {
      id: String(row.id),
      command: String(row.command),
      cwd: String(row.cwd),
      pid: typeof row.pid === "number" ? row.pid : row.pid === null ? null : Number(row.pid) || null,
      status: (String(row.status) as ProcStatus) || "exited",
      startedAt: typeof row.started_at === "number" ? row.started_at : Number(row.started_at) || 0,
      endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at) || null,
      exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code) || null,
      signal: row.signal ? String(row.signal) : null,
      logPath: String(row.log_path),
    };
  }

  private getRowFromDb(id: string): any | null {
    const db = this.cfg.db;
    if (!db) return null;
    try {
      const row = db.db
        .prepare(
          `
          SELECT id, status, command, cwd, pid, started_at, ended_at, exit_code, signal, log_path, metadata_json
          FROM process_runs
          WHERE id = ?
        `,
        )
        .get(id) as any;
      return row ?? null;
    } catch {
      return null;
    }
  }

  private getLinuxMetaForRow(row: any): LinuxProcMeta | null {
    const meta = typeof row?.metadata_json === "string" ? safeJsonParse<any>(row.metadata_json) : null;
    const linuxProc = meta?.linuxProc;
    if (!linuxProc || typeof linuxProc !== "object") return null;
    const startTicks = linuxProc.startTicks;
    const cmdline = linuxProc.cmdline;
    return {
      startTicks: typeof startTicks === "number" && Number.isFinite(startTicks) ? startTicks : null,
      cmdline: typeof cmdline === "string" ? cmdline : null,
    };
  }

  private listFromDb(limit: number): ManagedProcessInfo[] {
    const db = this.cfg.db;
    if (!db) return [];
    try {
      const rows = db.db
        .prepare(
          `
          SELECT id, status, command, cwd, pid, started_at, ended_at, exit_code, signal, log_path
          FROM process_runs
          ORDER BY started_at DESC
          LIMIT ?
        `,
        )
        .all(limit) as any[];
      return rows.map((r) => this.rowToInfo(r));
    } catch {
      return [];
    }
  }

  async start(params: { command: string; cwd?: string; request?: ProcessRequestContext }): Promise<ManagedProcessInfo> {
    const id = randomId();
    await fsp.mkdir(this.baseDir, { recursive: true });

    const startedAt = Date.now();
    const cwd = path.resolve(params.cwd?.trim() ? params.cwd.trim() : this.cfg.stateDir);
    const logPath = path.join(this.baseDir, `${safeFileName(id)}.log`);

    const outStream = fs.createWriteStream(logPath, { flags: "a" });
    outStream.write(`[nexus] process_start id=${id} startedAt=${startedAt} cwd=${cwd}\n`);
    outStream.write(`[nexus] command: ${params.command}\n`);

    const child = spawn(params.command, {
      cwd,
      shell: true,
      stdio: "pipe",
      env: process.env,
      // New process group (POSIX): the sh wrapper leads it, so stop() can signal
      // the whole tree with a negative pid. Without this, killing the sh orphans
      // the real command — it keeps running with our stdout/stderr pipes open.
      detached: process.platform !== "win32",
    });

    const info: ManagedProcessInfo = {
      id,
      command: params.command,
      cwd,
      pid: child.pid ?? null,
      status: "running",
      startedAt,
      endedAt: null,
      exitCode: null,
      signal: null,
      logPath,
    };

    this.procs.set(id, { info, child });

    // Attach streams immediately to avoid missing early output.
    child.stdout.on("data", (chunk) => outStream.write(chunk));
    child.stderr.on("data", (chunk) => outStream.write(chunk));

    // Important: attach exit/error handlers before any awaited work (process may exit quickly).
    let finalized = false;
    const finalize = (params: { kind: "exit" | "error"; exitCode: number | null; signal: string | null; errorMessage?: string }) => {
      if (finalized) return;
      finalized = true;

      const endedAt = Date.now();
      const rec = this.procs.get(id);
      const base = rec?.info ?? info;
      const status: ProcStatus = base.status === "stopped" ? "stopped" : "exited";

      const next: ManagedProcessInfo = {
        ...base,
        pid: child.pid ?? base.pid,
        status,
        endedAt,
        exitCode: params.exitCode,
        signal: params.signal,
      };
      if (rec) {
        rec.info = next;
        rec.child = null;
      } else {
        this.procs.set(id, { info: next, child: null });
      }
      this.persistUpdate(next);

      if (params.kind === "error") {
        const msg = params.errorMessage ? ` ${params.errorMessage}` : "";
        outStream.write(`\n[nexus] process_error id=${id}${msg}\n`);
      }
      outStream.write(`\n[nexus] process_exit id=${id} code=${next.exitCode ?? "null"} signal=${next.signal ?? "null"} endedAt=${endedAt}\n`);
      outStream.end();
    };

    child.on("exit", (code, signal) =>
      finalize({
        kind: "exit",
        exitCode: typeof code === "number" ? code : null,
        signal: signal ? String(signal) : null,
      }),
    );
    child.on("error", (err) =>
      finalize({
        kind: "error",
        exitCode: null,
        signal: "spawn_error",
        errorMessage: err instanceof Error ? err.message : String(err),
      }),
    );

    this.persistStart(info, params.request, "{}");

    // Best-effort metadata for safe PID-based management across restarts (Linux-only).
    // Stored in DB metadata_json; used to reduce PID reuse risks for stop/reconcile.
    if (process.platform === "linux" && child.pid) {
      void this.captureAndPersistLinuxProcMeta(id, child.pid).catch(() => {});
    }

    return info;
  }

  async reconcileDetachedRunning(params: { limit?: number } = {}): Promise<{ checked: number; updated: number }> {
    const db = this.cfg.db;
    if (!db) return { checked: 0, updated: 0 };
    const limit = Math.max(1, Math.min(200, Math.floor(params.limit ?? 50)));
    let updated = 0;
    let checked = 0;
    let rows: any[] = [];
    try {
      rows = db.db
        .prepare(
          `
          SELECT id, status, command, cwd, pid, started_at, ended_at, exit_code, signal, log_path, metadata_json
          FROM process_runs
          WHERE status = 'running'
          ORDER BY started_at DESC
          LIMIT ?
        `,
        )
        .all(limit) as any[];
    } catch {
      return { checked: 0, updated: 0 };
    }

    for (const row of rows) {
      const id = String(row.id);
      const rec = this.procs.get(id);
      if (rec?.child && rec.info.status === "running") continue; // live-managed
      const pid = typeof row.pid === "number" ? row.pid : row.pid === null ? null : Number(row.pid) || null;
      if (!pid) continue;

      checked += 1;
      if (!isPidAlive(pid)) {
        const nowMs = Date.now();
        try {
          db.db
            .prepare(
              `
              UPDATE process_runs
              SET status = 'exited',
                  ended_at = COALESCE(ended_at, ?),
                  updated_at = ?
              WHERE id = ? AND status = 'running'
            `,
            )
            .run(nowMs, nowMs, id);
          updated += 1;
        } catch {
          // ignore
        }
        continue;
      }

      // PID is alive; if we have a Linux start-ticks fingerprint, verify it still matches.
      const meta = this.getLinuxMetaForRow(row);
      if (process.platform === "linux") {
        const currentTicks = await readLinuxProcStatStartTicks(pid);
        if (meta?.startTicks) {
          if (!currentTicks || currentTicks !== meta.startTicks) {
            const nowMs = Date.now();
            try {
              db.db
                .prepare(
                  `
                  UPDATE process_runs
                  SET status = 'exited',
                      ended_at = COALESCE(ended_at, ?),
                      updated_at = ?
                  WHERE id = ? AND status = 'running'
                `,
                )
                .run(nowMs, nowMs, id);
              updated += 1;
            } catch {
              // ignore
            }
          }
        } else if (currentTicks) {
          // Fill missing fingerprint for older rows (best-effort). This improves stop/reconcile after restarts.
          const cmdline = await readLinuxProcCmdline(pid);
          const command = typeof row.command === "string" ? row.command : String(row.command ?? "");
          const cmdOk = cmdline ? cmdline.includes(command) : false;
          if (cmdOk) {
            const nowMs = Date.now();
            try {
              const prev = typeof row?.metadata_json === "string" ? (safeJsonParse<Record<string, unknown>>(row.metadata_json) ?? {}) : {};
              const next = { ...prev, linuxProc: { startTicks: currentTicks, cmdline } };
              db.db
                .prepare(
                  `
                  UPDATE process_runs
                  SET metadata_json = ?,
                      updated_at = ?
                  WHERE id = ? AND status = 'running'
                `,
                )
                .run(JSON.stringify(next), nowMs, id);
            } catch {
              // ignore
            }
          }
        }
      }
    }

    return { checked, updated };
  }

  list(): ManagedProcessInfo[] {
    const fromDb = this.listFromDb(200);
    const byId = new Map(fromDb.map((p) => [p.id, p]));
    for (const rec of this.procs.values()) byId.set(rec.info.id, rec.info);
    return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): ManagedProcessInfo | null {
    const local = this.procs.get(id)?.info ?? null;
    if (local) return local;
    const db = this.cfg.db;
    if (!db) return null;
    try {
      const row = db.db
        .prepare(
          `
          SELECT id, status, command, cwd, pid, started_at, ended_at, exit_code, signal, log_path
          FROM process_runs
          WHERE id = ?
        `,
        )
        .get(id) as any;
      if (!row) return null;
      return this.rowToInfo(row);
    } catch {
      return null;
    }
  }

  async stop(params: { id: string; signal?: NodeJS.Signals; killAfterMs?: number }): Promise<ManagedProcessInfo> {
    const rec = this.procs.get(params.id);
    if (!rec) {
      const row = this.getRowFromDb(params.id);
      const info = row ? this.rowToInfo(row) : null;
      if (!info) throw new Error(`Unknown process id: ${params.id}`);
      if (info.status !== "running") return info;
      if (!info.pid) throw new Error(`Process ${params.id} is not managed by this instance (missing pid).`);

      if (process.platform !== "linux") {
        throw new Error(`Process ${params.id} is not managed by this instance (no live handle).`);
      }

      const meta = row ? this.getLinuxMetaForRow(row) : null;
      if (!meta?.startTicks) {
        throw new Error(`Refusing to stop process ${params.id}: missing Linux PID fingerprint (start ticks).`);
      }
      const currentTicks = await readLinuxProcStatStartTicks(info.pid);
      if (!currentTicks) {
        throw new Error(`Refusing to stop process ${params.id}: unable to read /proc for pid ${info.pid}.`);
      }
      if (currentTicks !== meta.startTicks) {
        throw new Error(`Refusing to stop process ${params.id}: pid ${info.pid} appears to be reused (fingerprint mismatch).`);
      }

      const signal = params.signal ?? "SIGTERM";
      const killAfterMs = typeof params.killAfterMs === "number" && Number.isFinite(params.killAfterMs) ? params.killAfterMs : 5_000;
      try {
        process.kill(info.pid, signal);
      } catch {
        // ignore
      }
      if (killAfterMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, killAfterMs));
        if (isPidAlive(info.pid)) {
          try {
            process.kill(info.pid, "SIGKILL");
          } catch {
            // ignore
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
        }
      }
      if (isPidAlive(info.pid)) {
        throw new Error(`Unable to stop process ${params.id}: pid ${info.pid} still appears to be running.`);
      }

      const stoppedAt = Date.now();
      const next: ManagedProcessInfo = {
        ...info,
        status: "stopped",
        endedAt: info.endedAt ?? stoppedAt,
        signal: signal ? String(signal) : info.signal,
      };
      this.procs.set(params.id, { info: next, child: null });
      this.persistUpdate(next);
      return next;
    }

    if (!rec.child || rec.info.status !== "running") return rec.info;

    const stoppedAt = Date.now();
    const pid = rec.child.pid ?? rec.info.pid;

    const signal = params.signal ?? "SIGTERM";
    const killAfterMs = typeof params.killAfterMs === "number" && Number.isFinite(params.killAfterMs) ? params.killAfterMs : 5_000;

    const signalTree = (sig: NodeJS.Signals): void => {
      // Spawned detached, the sh wrapper leads its own process group; a negative
      // pid signals every process it spawned. child.kill() alone would hit only
      // the sh and orphan the real command.
      if (pid !== null && pid > 0 && process.platform !== "win32") {
        try {
          process.kill(-pid, sig);
          return;
        } catch {
          // group gone or not permitted — fall through to the direct signal
        }
      }
      try {
        rec.child?.kill(sig);
      } catch {
        // ignore
      }
    };

    signalTree(signal);

    if (killAfterMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, killAfterMs));
      if (rec.child && rec.info.status === "running") {
        signalTree("SIGKILL");
        // Give the exit event a moment to land before judging the outcome.
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      }
    }

    // Mirror the DB-fallback path: refuse to report success while the leader
    // still lives. A false "stopped" hides the leak — and the orphaned command
    // keeps our pipe ends open, hanging the parent event loop.
    if (rec.info.status === "running" && pid !== null && isPidAlive(pid)) {
      throw new Error(`Unable to stop process ${params.id}: pid ${pid} still appears to be running.`);
    }

    // If it hasn't emitted exit yet, mark stopped.
    const next: ManagedProcessInfo = {
      ...rec.info,
      status: rec.info.status === "running" ? "stopped" : rec.info.status,
      endedAt: rec.info.endedAt ?? stoppedAt,
    };
    rec.info = next;
    this.persistUpdate(next);
    return next;
  }

  async tailLogs(params: { id: string; maxChars: number }): Promise<string> {
    const info = this.get(params.id);
    if (!info) throw new Error(`Unknown process id: ${params.id}`);
    const maxChars = Math.max(200, Math.min(50_000, Math.floor(params.maxChars)));
    try {
      const buf = await fsp.readFile(info.logPath);
      const text = buf.toString("utf8");
      if (text.length <= maxChars) return text;
      return text.slice(-maxChars);
    } catch (e) {
      throw new Error(`Unable to read logs: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
