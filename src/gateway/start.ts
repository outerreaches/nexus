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
import { getPreset } from "../core/presets.js";
import { McpManager } from "../mcp/manager.js";
import { ModelRouter } from "../llm/model-router.js";
import { openDatabase } from "../storage/database.js";
import { ensureConfigExists, loadConfig } from "../state/config.js";
import { bootstrapState } from "../state/bootstrap.js";
import { resolveRuntimePaths } from "../state/paths.js";
import { getInitializationStatus, getInitializationErrorMessage } from "../state/onboarding.js";
import { getBuiltInTools } from "../tools/index.js";
import { ProcessManager } from "../process/manager.js";
import { startProcessNotifier } from "../process/notifier.js";
import { startJobScheduler } from "../scheduler/job-scheduler.js";
import { startHttpServer } from "./http.js";
import { startTelegramBot } from "./telegram.js";
import { startProactiveHeartbeat } from "./proactive.js";
import { initDataIntake } from "../data-intake/index.js";
import { ensureSystemJobs } from "../maintenance/system-jobs.js";
import { runBackup } from "../maintenance/db-backup.js";
import { sendHANotification } from "./ha-notifications.js";
import { randomId } from "../data-intake/utils.js";
import { NodeRegistry, NodeToolRouter, NodeWebSocketGateway } from "../nodes/index.js";
import { loadOrCreateGatewayIdentity } from "../nodes/auth.js";
import { registerNodeRoutes } from "./routes/nodes.js";

export async function startGateway(params: { configPath: string; port?: number; verbose: boolean; standby?: boolean }): Promise<void> {
  let logStream: fs.WriteStream | null = null;
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  let teeInstalled = false;
  const hostId = os.hostname().slice(0, 12);
  let logMode: () => string = () => params.standby ? "standby" : "active";
  const log = (msg: string) => {
    const line = `[nexus] ${new Date().toISOString()} [${hostId}/${logMode()}] ${msg}\n`;
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
  const initStatus = await getInitializationStatus(paths.stateDir);
  if (!initStatus.initialized) {
    throw new Error(`Gateway startup blocked. ${getInitializationErrorMessage(initStatus)}`);
  }
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
  log(`paths: state=${paths.stateDir} workspace=${paths.workspaceDir} code=${paths.codeDir}`);
  const envCodeDir = process.env.NEXUS_CODE_DIR;
  if (envCodeDir) {
    const resolvedEnvCodeDir = path.resolve(envCodeDir);
    if (resolvedEnvCodeDir !== paths.codeDir) {
      log(`paths: WARN codeDir mismatch env=${resolvedEnvCodeDir} resolved=${paths.codeDir}`);
    }
  }

  const db = await openDatabase(paths.dbPath);
  const nodeRegistry = new NodeRegistry({ db, log });
  const nodeGatewayIdentity = await loadOrCreateGatewayIdentity(paths.stateDir);
  log(`nodes/auth: loaded gateway ed25519 identity fingerprint=${nodeGatewayIdentity.fingerprint}`);
  // Standby mode tracking is declared early so node transport, status, and HA
  // transitions all share the same source of truth.
  let isStandby = params.standby ?? false;
  const nodeWsGateway = new NodeWebSocketGateway({
    identity: nodeGatewayIdentity,
    registry: nodeRegistry,
    isStandby: () => isStandby,
    log,
    gatewaySender: `gateway:${hostId}`,
  });
  const nodeRouter = new NodeToolRouter({
    registry: nodeRegistry,
    log,
    executeOnNode: async ({ nodeId, toolName, args }) =>
      nodeWsGateway.executeTool({
        nodeId,
        tool: toolName,
        args,
      }),
  });
  initDataIntake();
  ensureSystemJobs({ db, nowMs: Date.now(), stateDir: paths.stateDir, log });

  const effectivePort = params.port ?? config.port;
  const cdpPort = Number(process.env.NEXUS_BROWSER_CDP_PORT ?? effectivePort + 2);
  const browser = new BrowserManager({
    stateDir: paths.stateDir,
    cdpPort,
    remoteCdpUrl: process.env.NEXUS_BROWSER_REMOTE_CDP_URL,
    headless: process.env.NEXUS_BROWSER_HEADLESS === "1",
    noSandbox: process.env.NEXUS_BROWSER_NO_SANDBOX === "1",
  });

  const resolveApiKey = (value?: string): string | undefined => {
    if (!value) return value;
    return /^\$\{[A-Z0-9_]+\}$/.test(value) ? undefined : value;
  };
  const defaultLlmConfig = {
    ...config.llm.openaiCompat,
    apiKey: resolveApiKey(config.llm.openaiCompat.apiKey),
  };
  const llmProviderConfigs = Object.fromEntries(
    Object.entries(config.llm.providers).map(([name, provider]) => [
      name,
      {
        ...provider,
        apiKey: resolveApiKey(provider.apiKey),
      },
    ]),
  );
  const modelRouter = new ModelRouter({
    defaultProvider: defaultLlmConfig,
    providers: llmProviderConfigs,
    routing: config.llm.routing,
  });
  const startupRoute = modelRouter.resolve({
    agentId: "gateway:start",
    preset: "orchestrator",
    mode: "default",
    presetLlm: getPreset("orchestrator")?.llm,
  });
  const fallbackLabel = startupRoute.fallbackProvider && startupRoute.fallback
    ? ` fallback=${startupRoute.fallbackProvider}/${startupRoute.fallback.model}`
    : "";
  log(
    `startup: llm route primary=${startupRoute.primaryProvider}/${startupRoute.primary.model}${fallbackLabel} source=${startupRoute.source}`,
  );
  const llm = modelRouter.createClient(startupRoute, {
    onFallback: (line) => log(line),
  });
  const llmConfig = startupRoute.primary;
  const fallbackLlmConfig = startupRoute.fallback;
  const builtIns = getBuiltInTools();
  const mcp = new McpManager({ db, log });
  await mcp.init();
  const registry = new ToolRegistry({ builtIns, stateDir: paths.stateDir, mcp });
  await registry.init();

  const processManager = new ProcessManager({ stateDir: paths.stateDir, db });

  const agentTracker = new AgentTracker({ db });

  // Track isolated worker child processes for shutdown cleanup
  const isolatedWorkers = new Set<ChildProcess>();
  const scheduleProcessRestart = (reason: string, delayMs: number = 2500) => {
    log(`restart: ${reason}`);
    setTimeout(() => {
      try {
        process.kill(process.pid, "SIGTERM");
      } catch (err) {
        log(`restart: failed to signal SIGTERM: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(0);
      }
    }, delayMs);
  };
  let requestRestartImpl = (reason: string, delayMs: number = 2500) => {
    scheduleProcessRestart(reason, delayMs);
  };

  const allowShellExec = config.permissions.allowShellExec || process.env.NEXUS_ALLOW_SHELL_EXEC === "1";
  const allowCodeEdit = config.permissions.allowCodeEdit;
  const allowCodeWrite = config.permissions.allowCodeWrite || process.env.NEXUS_ALLOW_CODE_WRITE === "1";
  const maxContextTokens = Math.max(0, envInt("NEXUS_MAX_CONTEXT_TOKENS") ?? config.limits.maxContextTokens);
  const proactiveEnabled = envBool("NEXUS_PROACTIVE") ?? config.proactive.enabled;
  const proactiveNotifyTelegram = envBool("NEXUS_PROACTIVE_NOTIFY_TELEGRAM") ?? config.proactive.notifyTelegram;
  const telegramAllowAll = process.env.NEXUS_TELEGRAM_ALLOW_ALL === "1";
  const telegramAllowFromCount = config.channels.telegram.allowFrom?.length ?? 0;
  const telegramPairingEnabled = config.channels.telegram.pairing.enabled;

  const toolContext = {
    workspaceDir: paths.workspaceDir,
    stateDir: paths.stateDir,
    codeDir: paths.codeDir,
    llm,
    llmConfig,
    fallbackLlmConfig,
    modelRouter,
    modelMode: startupRoute.mode,
    db,
    browser,
    registry,
    processManager,
    mcp,
    agentTracker,
    isolatedWorkers,
    telegram: undefined as unknown,
    allowShellExec,
    allowCodeEdit,
    allowCodeWrite,
    requestRestart: (reason: string, delayMs: number = 2500) => {
      requestRestartImpl(reason, delayMs);
    },
    nodeRouter,
    runtimeLimits: {
      maxToolCalls: config.limits.maxToolCallsPerRun,
      maxIterations: config.limits.maxIterationsPerRun,
      maxContextTokens,
    },
    nowMs: () => Date.now(),
    log,
  };

  log(
    "startup: capabilities " +
      `shell_exec=${allowShellExec} ` +
      `code_edit=${allowCodeEdit} ` +
      `code_write=${allowCodeWrite} ` +
      `proactive=${proactiveEnabled} ` +
      `proactive_notify_telegram=${proactiveNotifyTelegram}`,
  );
  if (allowShellExec || allowCodeWrite || proactiveEnabled) {
    log(
      "startup: WARN autonomous and mutating capabilities are enabled; run only on trusted hosts/repositories and keep backups.",
    );
  }
  if (config.channels.telegram.enabled) {
    log(
      "startup: telegram " +
        `allow_all=${telegramAllowAll} ` +
        `allow_from_count=${telegramAllowFromCount} ` +
        `pairing_enabled=${telegramPairingEnabled}`,
    );
    if (telegramAllowAll) {
      log("startup: WARN NEXUS_TELEGRAM_ALLOW_ALL=1 allows any Telegram user to message this bot.");
    }
    if (telegramAllowFromCount === 0 && !telegramPairingEnabled && !telegramAllowAll) {
      log("startup: WARN telegram is enabled but no users can be admitted (allowFrom empty, pairing disabled).");
    }
    if ((allowShellExec || allowCodeWrite) && (telegramAllowAll || telegramPairingEnabled)) {
      log(
        "startup: WARN telegram-authenticated users can reach shell/code-mutation flows; keep allowlist/pair approvals tightly controlled.",
      );
    }
  }

  const agent = new AgentService({
    llm,
    modelRouter,
    getTools: () => registry.list(),
    toolContext,
    db,
    stateDir: paths.stateDir,
    agentTracker,
    onRunnerLog: params.verbose ? log : undefined,
    defaultPreset: "orchestrator",
    limits: {
      maxMessages: 40,
      maxToolCalls: config.limits.maxToolCallsPerRun,
      maxIterations: config.limits.maxIterationsPerRun,
      maxConcurrent: config.limits.maxConcurrentAgents,
      maxConcurrentInteractive: config.limits.maxConcurrentAgents,
      maxConcurrentBackground: Math.max(1, config.scheduler.concurrency),
      maxContextTokens,
    },
  });

  let proactive: ReturnType<typeof startProactiveHeartbeat> | null = null;
  const getProactiveStatus = () => proactive?.getStatus() ?? { enabled: false, lastTickAt: null, nextTickAt: null };

  const getMode = () => (isStandby ? "standby" : "active");
  logMode = getMode;

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
        concurrency: config.scheduler.concurrency,
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

  registerNodeRoutes(http.app, { isStandby: () => isStandby });

  // Track services (tg and scheduler may be started later if in standby mode)
  let tg: Awaited<ReturnType<typeof startTelegramBot>> = null;
  let scheduler: ReturnType<typeof startJobScheduler> = null;
  let processNotifier: ReturnType<typeof startProcessNotifier> = null;

  const startServices = async () => {
    tg = await startTelegramBot({ config, agent, configPath: params.configPath, log, db, app: http.app });
    if (!tg) log("telegram: disabled");
    if (tg) {
      toolContext.telegram = {
        sendOutput: tg.sendOutput,
        sendFile: tg.sendFile,
        allowFrom: config.channels.telegram.allowFrom ?? [],
        allowAll: process.env.NEXUS_TELEGRAM_ALLOW_ALL === "1",
      };
    }

    // Process lifecycle callbacks (best-effort). Requires db + agent + telegram.
    processNotifier = startProcessNotifier({
      db,
      agent,
      processManager,
      telegram: toolContext.telegram as any,
      log,
    });

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
    isStandby = true;
    nodeWsGateway.closeNodeConnections("gateway entering standby");
    processNotifier?.stop();
    processNotifier = null;
    scheduler?.stop();
    scheduler = null;
    proactive?.stop();
    proactive = null;
    await tg?.stop();
    tg = null;
    toolContext.telegram = undefined as unknown;
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
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const restartPeerUrl = normalizeHttpBaseUrl(process.env.NEXUS_HA_PEER_URL ?? "");
  let restartInProgress = false;

  const fetchText = async (url: string, init: RequestInit, timeoutMs: number): Promise<{ ok: boolean; status: number; text: string }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text };
    } catch (err) {
      return { ok: false, status: 0, text: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  };

  const tryActivatePeer = async (peerUrl: string, timeoutMs: number, retryMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts += 1;
      const res = await fetchText(`${peerUrl}/api/activate`, { method: "POST" }, Math.min(8000, retryMs * 4));
      if (res.ok) {
        log(`restart: peer activate ok attempt=${attempts}`);
        return true;
      }
      if (attempts === 1 || attempts % 5 === 0) {
        log(`restart: peer activate pending attempt=${attempts} status=${res.status} detail=${truncateLine(res.text)}`);
      }
      await sleep(retryMs);
    }
    return false;
  };

  const waitPeerReady = async (peerUrl: string, timeoutMs: number, retryMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts += 1;
      const res = await fetchText(`${peerUrl}/health/ready`, { method: "GET" }, Math.min(8000, retryMs * 4));
      if (res.ok) {
        log(`restart: peer ready attempt=${attempts}`);
        return true;
      }
      if (attempts === 1 || attempts % 5 === 0) {
        log(`restart: peer not ready attempt=${attempts} status=${res.status}`);
      }
      await sleep(retryMs);
    }
    return false;
  };

  requestRestartImpl = (reason: string, delayMs: number = 2500) => {
    if (restartInProgress) {
      log(`restart: already in progress; ignoring duplicate request (${reason})`);
      return;
    }
    restartInProgress = true;
    void (async () => {
      try {
        if (!restartPeerUrl) {
          scheduleProcessRestart(reason, delayMs);
          return;
        }

        const handoffDelayMs = Math.max(0, delayMs);
        const activateTimeoutMs = Math.max(5_000, envInt("NEXUS_HA_RESTART_ACTIVATE_TIMEOUT_MS") ?? 30_000);
        const readyTimeoutMs = Math.max(5_000, envInt("NEXUS_HA_RESTART_READY_TIMEOUT_MS") ?? 45_000);
        const retryMs = Math.max(250, envInt("NEXUS_HA_RESTART_RETRY_MS") ?? 1000);

        log(`restart: handoff begin reason=${reason} peer=${restartPeerUrl}`);
        if (handoffDelayMs > 0) {
          await sleep(handoffDelayMs);
        }

        const peerLive = await fetchText(`${restartPeerUrl}/health/live`, { method: "GET" }, Math.min(8000, retryMs * 4));
        if (!peerLive.ok) {
          log(`restart: peer not reachable for handoff; using local restart status=${peerLive.status}`);
          scheduleProcessRestart(reason, 250);
          return;
        }

        // Activate peer BEFORE releasing our lease to avoid a window where
        // neither instance is active.  The peer's /api/activate will acquire
        // the lease only once we release it (or it expires), so we deactivate
        // first only if the peer is already confirmed live above.  To keep the
        // window as short as possible we: (1) release our lease, (2) immediately
        // ask the peer to activate, (3) verify it actually became ready.
        if (!isStandby) {
          await deactivateServices(`restart handoff (${reason})`);
        } else {
          log("restart: instance already standby before handoff");
        }

        const activated = await tryActivatePeer(restartPeerUrl, activateTimeoutMs, retryMs);
        if (!activated) {
          log("restart: handoff failed (peer activation timeout); attempting to re-activate locally");
          // Try to reclaim our own lease before falling back to a bare restart.
          const reclaimed = await activateServices();
          if (reclaimed.ok) {
            log("restart: re-activated locally after peer timeout");
          } else {
            log("restart: local re-activation also failed; restarting process");
          }
          scheduleProcessRestart(reason, 250);
          return;
        }

        // Verify peer is actually serving traffic (mode=active), not just HTTP up.
        const peerMode = await fetchText(`${restartPeerUrl}/api/mode`, { method: "GET" }, 5000);
        const peerIsActive = peerMode.ok && peerMode.text.includes('"mode":"active"');
        if (!peerIsActive) {
          log("restart: peer activated but not reporting active mode; waiting for readiness");
        }

        const ready = await waitPeerReady(restartPeerUrl, readyTimeoutMs, retryMs);
        if (!ready) {
          log("restart: handoff failed (peer readiness timeout); attempting to re-activate locally");
          const reclaimed = await activateServices();
          if (reclaimed.ok) {
            log("restart: re-activated locally after peer readiness timeout");
          } else {
            log("restart: local re-activation also failed; restarting process");
          }
          scheduleProcessRestart(reason, 250);
          return;
        }

        log("restart: handoff complete; terminating local process");
        scheduleProcessRestart(reason, 250);
      } catch (err) {
        log(`restart: handoff error: ${err instanceof Error ? err.message : String(err)}`);
        scheduleProcessRestart(reason, 250);
      } finally {
        setTimeout(() => {
          restartInProgress = false;
        }, 1000);
      }
    })();
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

  // Deactivation endpoint for graceful shutdown
  http.app.post("/api/deactivate", async (c) => {
    try {
      if (isStandby) {
        return c.json({ ok: true, message: "already standby" });
      }

      const nowMs = Date.now();
      const instanceId = leaseHolderId;

      await deactivateServices("requested via /api/deactivate");

      // Record HA event
      db.db
        .prepare(
          "INSERT INTO ha_events (id, event_type, source, from_instance, to_instance, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(randomId("HA"), "deactivate", "api", instanceId, null, JSON.stringify({ reason: "manual" }), nowMs);

      return c.json({ ok: true, message: "deactivated" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: msg }, 500);
    }
  });

  // Manual backup endpoint
  http.app.post("/api/backup", async (c) => {
    try {
      const nowMs = Date.now();
      const result = await runBackup({
        db,
        stateDir: paths.stateDir,
        backupType: "manual",
        nowMs,
        log,
      });

      if (result.status === "failed") {
        // Send notification on failure
        await sendHANotification(
          { config, db, telegram: tg, log },
          { type: "backup_failure", details: { error: result.error, backupId: result.id } },
        );
      }

      return c.json({ ok: result.status === "completed", backup: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: msg }, 500);
    }
  });

  // HA event endpoint (called by watchdog)
  http.app.post("/api/ha/event", async (c) => {
    try {
      const body = (await c.req.json()) as { event: string; from?: string; to?: string; reason?: string; details?: unknown };
      const nowMs = Date.now();

      // Record event in database
      const eventId = randomId("HA");
      db.db
        .prepare(
          "INSERT INTO ha_events (id, event_type, source, from_instance, to_instance, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(eventId, body.event, "watchdog", body.from ?? null, body.to ?? null, JSON.stringify({ reason: body.reason, ...((body.details as object) ?? {}) }), nowMs);

      // Send Telegram notification
      if (tg) {
        await sendHANotification(
          { config, db, telegram: tg, log },
          {
            type: body.event as "failover" | "failback",
            details: { from: body.from, to: body.to, reason: body.reason, ...((body.details as object) ?? {}) },
          },
        );
      }

      return c.json({ ok: true, eventId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: msg }, 500);
    }
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
    nodeWsGateway.close();
    await http.stop();
    await mcp.close();
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

  // Start accepting HTTP requests only after all routes are registered.
  // Hono's SmartRouter finalises on first request, so no routes can be
  // added after the first health-check arrives.
  const rawServer = http.listen();
  nodeWsGateway.attach(rawServer as unknown as Parameters<NodeWebSocketGateway["attach"]>[0]);

  log("gateway: started");
}

function envInt(key: string): number | null {
  const raw = process.env[key];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

function envBool(key: string): boolean | null {
  const raw = (process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "y") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "n") return false;
  return null;
}

function normalizeHttpBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function truncateLine(value: string, maxLen: number = 140): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen)}...`;
}
