import "../env.js";
import type { ChildProcess } from "node:child_process";

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

export async function startGateway(params: { configPath: string; port?: number; verbose: boolean }): Promise<void> {
  const log = (msg: string) => {
    if (params.verbose) process.stdout.write(`[nexus] ${msg}\n`);
  };

  await ensureConfigExists(params.configPath);
  const config = await loadConfig(params.configPath);
  await bootstrapState(config);
  const paths = await resolveRuntimePaths(config);

  const db = await openDatabase(paths.dbPath);
  initDataIntake();

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

  const http = await startHttpServer({
    port: effectivePort,
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
    }),
    log,
    db,
    processManager,
    agentTracker,
  });

  const tg = await startTelegramBot({ config, agent, configPath: params.configPath, log, db, app: http.app });
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

  const scheduler = startJobScheduler({
    config,
    agent,
    db,
    log,
    getTools: () => registry.list(),
    toolContext,
    workspaceDir: paths.workspaceDir,
  });
  if (!scheduler) log("scheduler: disabled");


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

    scheduler?.stop();
    proactive?.stop();
    await tg?.stop();
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
