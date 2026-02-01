import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type ProcStatus = "running" | "exited" | "stopped";

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

export class ProcessManager {
  private readonly procs = new Map<string, { info: ManagedProcessInfo; child: ChildProcessWithoutNullStreams | null }>();

  constructor(
    private readonly cfg: {
      stateDir: string;
    },
  ) {}

  private get baseDir(): string {
    return path.join(this.cfg.stateDir, "processes");
  }

  async start(params: { command: string; cwd?: string }): Promise<ManagedProcessInfo> {
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

    child.stdout.on("data", (chunk) => outStream.write(chunk));
    child.stderr.on("data", (chunk) => outStream.write(chunk));
    child.on("exit", (code, signal) => {
      const endedAt = Date.now();
      const next: ManagedProcessInfo = {
        ...info,
        pid: child.pid ?? info.pid,
        status: "exited",
        endedAt,
        exitCode: typeof code === "number" ? code : null,
        signal: signal ? String(signal) : null,
      };
      const rec = this.procs.get(id);
      if (rec) {
        rec.info = next;
        rec.child = null;
      } else {
        this.procs.set(id, { info: next, child: null });
      }
      outStream.write(`\n[nexus] process_exit id=${id} code=${next.exitCode ?? "null"} signal=${next.signal ?? "null"} endedAt=${endedAt}\n`);
      outStream.end();
    });

    this.procs.set(id, { info, child });
    return info;
  }

  list(): ManagedProcessInfo[] {
    return [...this.procs.values()].map((p) => p.info).sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): ManagedProcessInfo | null {
    return this.procs.get(id)?.info ?? null;
  }

  async stop(params: { id: string; signal?: NodeJS.Signals; killAfterMs?: number }): Promise<ManagedProcessInfo> {
    const rec = this.procs.get(params.id);
    if (!rec) throw new Error(`Unknown process id: ${params.id}`);

    if (!rec.child || rec.info.status !== "running") return rec.info;

    const stoppedAt = Date.now();

    const signal = params.signal ?? "SIGTERM";
    const killAfterMs = typeof params.killAfterMs === "number" && Number.isFinite(params.killAfterMs) ? params.killAfterMs : 5_000;

    try {
      rec.child.kill(signal);
    } catch {
      // ignore
    }

    if (killAfterMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, killAfterMs));
      if (rec.child && rec.info.status === "running") {
        try {
          rec.child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }

    // If it hasn't emitted exit yet, mark stopped.
    const next: ManagedProcessInfo = {
      ...rec.info,
      status: rec.info.status === "running" ? "stopped" : rec.info.status,
      endedAt: rec.info.endedAt ?? stoppedAt,
    };
    rec.info = next;
    return next;
  }

  async tailLogs(params: { id: string; maxChars: number }): Promise<string> {
    const rec = this.procs.get(params.id);
    if (!rec) throw new Error(`Unknown process id: ${params.id}`);
    const maxChars = Math.max(200, Math.min(50_000, Math.floor(params.maxChars)));
    try {
      const buf = await fsp.readFile(rec.info.logPath);
      const text = buf.toString("utf8");
      if (text.length <= maxChars) return text;
      return text.slice(-maxChars);
    } catch (e) {
      throw new Error(`Unable to read logs: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
