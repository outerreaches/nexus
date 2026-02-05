import "../env.js";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import { AgentService } from "../core/agent-service.js";
import { AgentTracker } from "../core/agent-tracker.js";
import { BrowserManager } from "../browser/manager.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { OpenAICompatClient } from "../llm/openai-compat.js";
import { openDatabase } from "../storage/database.js";
import { ensureConfigExists, loadConfig } from "../state/config.js";
import { bootstrapState } from "../state/bootstrap.js";
import { resolveRuntimePaths } from "../state/paths.js";
import { getBuiltInTools } from "../tools/index.js";
import { ProcessManager } from "../process/manager.js";
import { startJobScheduler } from "../scheduler/job-scheduler.js";
import { startHttpServer } from "./http.js";
import { startTelegramBot } from "./telegram.js";
import { startProactiveHeartbeat } from "./proactive.js";
import { initDataIntake } from "../data-intake/index.js";
import { ensureSystemJobs } from "../maintenance/system-jobs.js";

export async function startGateway(params: { configPath: string; port?: number; verbose: boolean; standby?: boolean }): Promise<void> {
  let logStream: fs.WriteStream | null = null;
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  let teeInstalled = false;
  const log = (msg: string) => {
    const line = `[nexus] ${msg}\n`;
    if (params.verbose) {
      process.stdout.write(line);
      return;
    }
    if (logStream) logStream.write(line);
  };

  await ensureConfigExists(params.configPath);
  const config = await loadConfig(params.configPath);
  await bootstrapState(config);
  const paths = await resolveRuntimePaths(config);
  try {
    await fsp.mkdir(paths.stateDir, { recursive: true });
    logStream = fs.createWriteStream(path.join(paths.stateDir, "gateway.log"), { flags: "a" });
    if (!teeInstalled) {
      const makeTee = (baseWrite: typeof process.stdout.write) =>
        ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
          if (logStream) logStream.write(chunk as string | Uint8Array);
          return (baseWrite as any)(chunk, encoding, cb);
        }) as typeof process.stdout.write;
      process.stdout.write = makeTee(stdoutWrite);
      process.stderr.write = makeTee(stderrWrite);
      teeInstalled = true;
    }
  } catch (err) {
    if (params.verbose) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`[nexus] log file error: ${msg}\n`);
    }
  }

  const db = await openDatabase(paths.dbPath);
  initDataIntake();
  ensureSystemJobs({ db, nowMs: Date.now(), log });

  const effectivePort = params.port ?? config.port;
  const cdpPort = Number(process.env.NEXUS_BROWSER_CDP_PORT ?? effectivePort + 2);
  const browser = new BrowserManager({
    stateDir: paths.stateDir,
    cdpPort,
    remoteCdpUrl: process.env.NEXUS_BROWSER_REMOTE_CDP_URL,
    headless: process.env.NEXUS_BROWSER_HEADLESS === "1",
    noSandbox: process.env.NEXUS_BROWSER_NO_SANDBOX === "1",
  });

  const apiKey =
    config.llm.openaiCompat.apiKey && /^\$\{[A-Z0-9_]+\}$/.test(config.llm.openaiCompat.apiKey)
      ? undefined
      : config.llm.openaiCompat.apiKey;
  const llmConfig = { ...config.llm.openaiCompat, apiKey };
  const llm = new OpenAICompatClient(llmConfig);
  const builtIns = getBuiltInTools();
  const registry = new ToolRegistry({ builtIns, stateDir: paths.stateDir });
  await registry.init();

  const processManager = new ProcessManager({ stateDir: paths.stateDir });

  const agentTracker = new AgentTracker({ db });

  // Track isolated worker child processes for shutdown cleanup
  const isolatedWorkers = new Set<ChildProcess>();

  const toolContext = {
    workspaceDir: paths.workspaceDir,
    stateDir: paths.stateDir,
    codeDir: paths.codeDir,
    llm,
    llmConfig,
    db,
    browser,
    registry,
    processManager,
    agentTracker,
    isolatedWorkers,
    telegram: undefined as unknown,
    allowShellExec: config.permissions.allowShellExec || process.env.NEXUS_ALLOW_SHELL_EXEC === "1",
    allowCodeEdit: config.permissions.allowCodeEdit,
    requestRestart: (reason: string, delayMs: number = 2500) => {
      log(`restart: ${reason}`);
      setTimeout(() => {
        try {
          process.kill(process.pid, "SIGTERM");
        } catch (err) {
          log(`restart: failed to signal SIGTERM: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(0);
        }
      }, delayMs);
    },
    nowMs: () => Date.now(),
    log,
  };

  const agent = new AgentService({
    llm,
    getTools: () => registry.list(),
    toolContext,
    db,
    stateDir: paths.stateDir,
    agentTracker,
    onRunnerLog: params.verbose ? log : undefined,
    defaultPreset: "orchestrator",
    limits: {
      maxMessages: 80,
      maxToolCalls: config.limits.maxToolCallsPerRun,
      maxIterations: config.limits.maxIterationsPerRun,
      maxConcurrent: config.limits.maxConcurrentAgents,
      maxContextTokens: config.limits.maxContextTokens,
    },
  });

  let proactive: ReturnType<typeof startProactiveHeartbeat> | null = null;
  const getProactiveStatus = () => proactive?.getStatus() ?? { enabled: false, lastTickAt: null, nextTickAt: null };

  // Standby mode tracking (declared early so getStatus can reference it)
  let isStandby = params.standby ?? false;
  const getMode = () => (isStandby ? "standby" : "active");

  // Active lease (prevents dual-active containers)
  const leaseKey = "gateway_active";
  const leaseHolderId = `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  const leaseTtlMs = Math.max(10_000, envInt("NEXUS_ACTIVE_LEASE_TTL_MS") ?? 45_000);
  const leaseRenewMs = Math.max(5_000, Math.floor(leaseTtlMs / 3));
  let leaseHeld = false;
  let leaseExpiresAt: number | null = null;
  let leaseTimer: NodeJS.Timeout | null = null;

  const acquireActiveLease = (nowMs: number): { ok: boolean; holderId?: string; expiresAt?: number } => {
    const expiresAt = nowMs + leaseTtlMs;
    const tx = db.db.transaction(() => {
      const row = db.db.prepare("SELECT holder_id, expires_at FROM gateway_leases WHERE key = ?").get(leaseKey) as
        | { holder_id: string; expires_at: number }
        | undefined;
      if (!row) {
        db.db
          .prepare(
            "INSERT INTO gateway_leases (key, holder_id, created_at, renewed_at, expires_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(leaseKey, leaseHolderId, nowMs, nowMs, expiresAt);
        return { ok: true, holderId: leaseHolderId, expiresAt };
      }
      if (row.expires_at <= nowMs || row.holder_id === leaseHolderId) {
        db.db
          .prepare("UPDATE gateway_leases SET holder_id = ?, renewed_at = ?, expires_at = ? WHERE key = ?")
          .run(leaseHolderId, nowMs, expiresAt, leaseKey);
        return { ok: true, holderId: leaseHolderId, expiresAt };
      }
      return { ok: false, holderId: row.holder_id, expiresAt: row.expires_at };
    });
    return tx();
  };

  const renewActiveLease = (nowMs: number): boolean => {
    const res = db.db
      .prepare("UPDATE gateway_leases SET renewed_at = ?, expires_at = ? WHERE key = ? AND holder_id = ?")
      .run(nowMs, nowMs + leaseTtlMs, leaseKey, leaseHolderId);
    if (res.changes > 0) {
      leaseHeld = true;
      leaseExpiresAt = nowMs + leaseTtlMs;
      return true;
    }
    return false;
  };

  const releaseActiveLease = () => {
    try {
      db.db.prepare("DELETE FROM gateway_leases WHERE key = ? AND holder_id = ?").run(leaseKey, leaseHolderId);
    } catch {
      // ignore
    }
    leaseHeld = false;
    leaseExpiresAt = null;
  };

  const startLeaseRenewal = (deactivate: (reason?: string) => Promise<void>) => {
    if (leaseTimer) clearInterval(leaseTimer);
    leaseTimer = setInterval(() => {
      if (!leaseHeld) return;
      const ok = renewActiveLease(Date.now());
      if (!ok) {
        leaseHeld = false;
        leaseExpiresAt = null;
        void deactivate("lost active lease");
      }
    }, leaseRenewMs);
  };

  const ensureActiveLease = (
    deactivate: (reason?: string) => Promise<void>,
  ): { ok: boolean; holderId?: string; expiresAt?: number } => {
    const res = acquireActiveLease(Date.now());
    if (res.ok) {
      leaseHeld = true;
      leaseExpiresAt = res.expiresAt ?? null;
      startLeaseRenewal(deactivate);
    }
    return res;
  };

  const http = await startHttpServer({
    port: effectivePort,
    stateDir: paths.stateDir,
    getStatus: async () => ({
      ok: true,
      name: "nexus",
      port: effectivePort,
      stateDir: paths.stateDir,
      workspaceDir: paths.workspaceDir,
      codeDir: paths.codeDir,
      dbPath: paths.dbPath,
      telegram: {
        enabled: config.channels.telegram.enabled,
        mode: config.channels.telegram.mode,
        pairingEnabled: config.channels.telegram.pairing.enabled,
      },
      browser: {
        cdpPort,
        headless: process.env.NEXUS_BROWSER_HEADLESS === "1",
        remoteCdpUrl: process.env.NEXUS_BROWSER_REMOTE_CDP_URL ?? null,
      },
      permissions: {
        allowShellExec: toolContext.allowShellExec,
        allowCodeEdit: toolContext.allowCodeEdit,
      },
      scheduler: {
        enabled: config.scheduler.enabled,
        tickIntervalMs: config.scheduler.tickIntervalMs,
        maxRunsPerTick: config.scheduler.maxRunsPerTick,
        leaseTtlMs: config.scheduler.leaseTtlMs,
        maxConsecutiveFailures: config.scheduler.maxConsecutiveFailures,
        notifyAgentOnFailure: config.scheduler.notifyAgentOnFailure,
        notifyCooldownMs: config.scheduler.notifyCooldownMs,
      },
      proactive: getProactiveStatus(),
      mode: getMode(),
      activeLease: {
        key: leaseKey,
        holderId: leaseHolderId,
        held: leaseHeld,
        expiresAt: leaseExpiresAt,
        ttlMs: leaseTtlMs,
        renewMs: leaseRenewMs,
      },
    }),
    log,
    db,
    processManager,
    agentTracker,
  });

  // Track services (tg and scheduler may be started later if in standby mode)
  let tg: Awaited<ReturnType<typeof startTelegramBot>> = null;
  let scheduler: ReturnType<typeof startJobScheduler> = null;

  const startServices = async () => {
    tg = await startTelegramBot({ config, agent, configPath: params.configPath, log, db, app: http.app });
    if (!tg) log("telegram: disabled");
    if (tg) {
      toolContext.telegram = {
        sendOutput: tg.sendOutput,
        allowFrom: config.channels.telegram.allowFrom ?? [],
        allowAll: process.env.NEXUS_TELEGRAM_ALLOW_ALL === "1",
      };
    }

    proactive = startProactiveHeartbeat({
      config,
      stateDir: paths.stateDir,
      agent,
      db,
      telegram: tg,
      log,
    });
    if (!proactive) log("proactive: disabled");

    scheduler = startJobScheduler({
      config,
      agent,
      db,
      log,
      getTools: () => registry.list(),
      toolContext,
      workspaceDir: paths.workspaceDir,
    });
    if (!scheduler) log("scheduler: disabled");
  };

  const deactivateServices = async (reason?: string) => {
    if (reason) log(`standby: ${reason}`);
    if (leaseTimer) {
      clearInterval(leaseTimer);
      leaseTimer = null;
    }
    releaseActiveLease();
    scheduler?.stop();
    scheduler = null;
    proactive?.stop();
    proactive = null;
    await tg?.stop();
    tg = null;
    toolContext.telegram = undefined as unknown;
    isStandby = true;
  };

  const activateServices = async (): Promise<{ ok: boolean; holderId?: string; expiresAt?: number; already?: boolean }> => {
    if (!isStandby) return { ok: true, already: true };
    const lease = ensureActiveLease(deactivateServices);
    if (!lease.ok) return { ok: false, holderId: lease.holderId, expiresAt: lease.expiresAt };
    isStandby = false;
    log("standby: activating services");
    try {
      await startServices();
      log("standby: services activated");
      return { ok: true };
    } catch (err) {
      await deactivateServices("activation failed");
      throw err;
    }
  };

  // Start services immediately if not in standby mode
  if (!isStandby) {
    const lease = ensureActiveLease(deactivateServices);
    if (!lease.ok) {
      isStandby = true;
      log(`standby: active lease held by ${lease.holderId ?? "unknown"}; staying standby`);
    } else {
      try {
        await startServices();
        log("standby: services activated");
      } catch (err) {
        await deactivateServices("activation failed");
        throw err;
      }
    }
  } else {
    log("standby: started in standby mode (health checks only)");
  }

  // Activation endpoint for failover
  http.app.post("/api/activate", async (c) => {
    try {
      const res = await activateServices();
      if (res.ok) {
        return c.json({ ok: true, message: res.already ? "already active" : "activated" });
      }
      return c.json(
        {
          ok: false,
          error: "active lease already held",
          holderId: res.holderId ?? null,
          expiresAt: res.expiresAt ?? null,
        },
        409,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: msg }, 500);
    }
  });

  http.app.get("/api/mode", (c) => {
    return c.json({ mode: isStandby ? "standby" : "active" });
  });

  http.app.post("/api/proactive/pause", (c) => {
    if (proactive) {
      proactive.pause();
      return c.json({ ok: true, paused: true });
    }
    return c.json({ ok: false, error: "proactive not enabled" }, 400);
  });
  http.app.post("/api/proactive/resume", (c) => {
    if (proactive) {
      proactive.resume();
      return c.json({ ok: true, paused: false });
    }
    return c.json({ ok: false, error: "proactive not enabled" }, 400);
  });

  const stop = async () => {
    // Kill any active isolated worker processes
    for (const child of isolatedWorkers) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore errors (process may have already exited)
      }
    }
    isolatedWorkers.clear();

    await deactivateServices("shutdown");
    await http.stop();
    db.close();
  };

  process.on("SIGINT", async () => {
    log("shutdown: SIGINT");
    await stop();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    log("shutdown: SIGTERM");
    await stop();
    process.exit(0);
  });

  log("gateway: started");
}

function envInt(key: string): number | null {
  const raw = process.env[key];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : null;
}
