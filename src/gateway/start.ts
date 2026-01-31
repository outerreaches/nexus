import { AgentService } from "../core/agent-service.js";
import { BrowserManager } from "../browser/manager.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { OpenAICompatClient } from "../llm/openai-compat.js";
import { openDatabase } from "../storage/database.js";
import { ensureConfigExists, loadConfig } from "../state/config.js";
import { bootstrapState } from "../state/bootstrap.js";
import { resolveRuntimePaths } from "../state/paths.js";
import { getBuiltInTools } from "../tools/index.js";
import { startHttpServer } from "./http.js";
import { startTelegramBot } from "./telegram.js";

export async function startGateway(params: { configPath: string; port?: number; verbose: boolean }): Promise<void> {
  const log = (msg: string) => {
    if (params.verbose) process.stdout.write(`[nexus] ${msg}\n`);
  };

  await ensureConfigExists(params.configPath);
  const config = await loadConfig(params.configPath);
  await bootstrapState(config);
  const paths = await resolveRuntimePaths(config);

  const db = await openDatabase(paths.dbPath);

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
  const llm = new OpenAICompatClient({ ...config.llm.openaiCompat, apiKey });
  const builtIns = getBuiltInTools();
  const registry = new ToolRegistry({ builtIns, stateDir: paths.stateDir });
  await registry.init();

  const toolContext = {
    workspaceDir: paths.workspaceDir,
    stateDir: paths.stateDir,
    codeDir: paths.codeDir,
    db,
    browser,
    registry,
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
    workspaceDir: paths.workspaceDir,
    limits: {
      maxMessages: 80,
      maxToolCalls: config.limits.maxToolCallsPerRun,
      maxIterations: config.limits.maxIterationsPerRun,
      maxConcurrent: config.limits.maxConcurrentAgents,
    },
  });

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
    }),
    log,
  });

  const tg = await startTelegramBot({ config, agent, configPath: params.configPath, log, db, app: http.app });

  const stop = async () => {
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
