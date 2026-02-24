import { Command } from "commander";
import { startGateway } from "../gateway/start.js";
import { ProcessManager } from "../process/manager.js";
import { getDefaultConfigPath } from "../state/paths.js";
import { startSecretSidecar } from "../secrets/sidecar.js";
import { getSecret, resolveEnvSecrets } from "../secrets/resolve-env.js";

const RUNTIME_PROFILES = [
  "standard",
  "primary",
  "standby",
  "monetization",
  "service_custom",
  "portable",
  "execution_node_host",
] as const;
type RuntimeProfile = (typeof RUNTIME_PROFILES)[number];

function envInt(name: string): number | null {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command()
    .name("nexus")
    .description("Nexus — lightweight multi-agent assistant (OpenClaw-inspired)")
    .option("--config <path>", "Path to config JSON5", getDefaultConfigPath())
    .option("--verbose", "Verbose logs", false);

  program
    .command("gateway")
    .description("Start the always-on gateway (HTTP + Telegram)")
    .option("--port <port>", "HTTP port (overrides config)", (v) => Number(v))
    .option("--profile <profile>", `Runtime profile (${RUNTIME_PROFILES.join("|")})`)
    .option("--standby", "Start in standby mode (health checks only, no scheduler/proactive)", false)
    .action(async (opts) => {
      const profileRaw = typeof opts.profile === "string" ? opts.profile.trim() : "";
      let profile: RuntimeProfile | undefined;
      if (profileRaw) {
        if (!RUNTIME_PROFILES.includes(profileRaw as RuntimeProfile)) {
          throw new Error(`Invalid --profile value: ${profileRaw}`);
        }
        profile = profileRaw as RuntimeProfile;
      }
      const options = program.opts<{ config: string; verbose: boolean }>();
      await startGateway({
        configPath: options.config,
        port: opts.port,
        verbose: options.verbose,
        standby: opts.standby,
        profile,
      });
    });

  program
    .command("secret-sidecar")
    .description("Start the local secret sidecar API (process-boundary secret resolver)")
    .option("--state-dir <path>", "State directory (defaults to resolved runtime state dir)")
    .option("--bind <host>", "Bind host for TCP mode (ignored when --socket-path is set)")
    .option("--port <port>", "TCP port for sidecar", (v) => Number(v))
    .option("--socket-path <path>", "Unix socket path for sidecar (recommended in strict mode)")
    .option("--max-body-bytes <bytes>", "Maximum request body size in bytes", (v) => Number(v))
    .action(async (opts) => {
      const options = program.opts<{ config: string; verbose: boolean }>();
      const log = (line: string) => {
        if (!options.verbose) return;
        process.stdout.write(`[nexus] ${line}\n`);
      };

      // Sidecar mode is the only process allowed direct credential-file access.
      process.env.NEXUS_SECRETS_PROCESS_ROLE = "sidecar";

      let resolvedStateDir = typeof opts.stateDir === "string" && opts.stateDir.trim().length > 0
        ? opts.stateDir.trim()
        : "";
      if (!resolvedStateDir) {
        const { ensureConfigExists, loadConfig } = await import("../state/config.js");
        const { bootstrapState } = await import("../state/bootstrap.js");
        const { resolveRuntimePaths } = await import("../state/paths.js");
        await ensureConfigExists(options.config);
        const config = await loadConfig(options.config);
        await bootstrapState(config);
        const paths = await resolveRuntimePaths(config);
        resolvedStateDir = paths.stateDir;
      }

      const bearerToken = (process.env.NEXUS_SECRET_SIDECAR_BEARER_TOKEN ?? process.env.NEXUS_SECRET_BROKER_BEARER_TOKEN ?? "").trim();
      const sidecar = await startSecretSidecar({
        stateDir: resolvedStateDir,
        bindHost: typeof opts.bind === "string" && opts.bind.trim().length > 0 ? opts.bind.trim() : process.env.NEXUS_SECRET_SIDECAR_BIND,
        port: Number.isFinite(opts.port) ? opts.port : Number(process.env.NEXUS_SECRET_SIDECAR_PORT ?? 7788),
        socketPath: typeof opts.socketPath === "string" && opts.socketPath.trim().length > 0
          ? opts.socketPath.trim()
          : (process.env.NEXUS_SECRET_SIDECAR_SOCKET_PATH ?? "").trim() || null,
        maxBodyBytes: Number.isFinite(opts.maxBodyBytes)
          ? opts.maxBodyBytes
          : Number(process.env.NEXUS_SECRET_SIDECAR_MAX_BODY_BYTES ?? 32768),
        bearerToken: bearerToken || null,
        log,
      });

      const shutdown = async (signal: string) => {
        log(`secret-sidecar: received ${signal}, shutting down`);
        try {
          await sidecar.stop();
        } finally {
          process.exit(0);
        }
      };
      process.once("SIGINT", () => void shutdown("SIGINT"));
      process.once("SIGTERM", () => void shutdown("SIGTERM"));
      await new Promise<void>(() => {
        // Keep process alive until signal.
      });
    });

  program
    .command("chat")
    .description("Simple CLI chat (stores history in SQLite)")
    .argument("[message]", "Message to send (omit for interactive mode)")
    .option("--agent <id>", "Agent id (maps to workspace/agents/<id>/)", "main")
    .option("--trace", "Show agent events (tool calls, errors, internal logs) in CLI output", false)
    .action(async (message, opts) => {
      const options = program.opts<{ config: string; verbose: boolean }>();
      const traceEnabled = Boolean(opts.trace);
      const log = (line: string) => {
        if (!options.verbose && !traceEnabled) return;
        const out = traceEnabled ? process.stderr : process.stdout;
        out.write(`[nexus] ${line}\n`);
      };

      const { ensureConfigExists, loadConfig } = await import("../state/config.js");
      const { bootstrapState } = await import("../state/bootstrap.js");
      const { resolveRuntimePaths } = await import("../state/paths.js");
      const { getInitializationStatus, getInitializationErrorMessage } = await import("../state/onboarding.js");
      const { openDatabase } = await import("../storage/database.js");
      const { appendMessage, getOrCreateSessionId } = await import("../storage/sessions.js");
      const { ModelRouter } = await import("../llm/model-router.js");
      const { getPreset } = await import("../core/presets.js");
      const { AgentService } = await import("../core/agent-service.js");
      const { BrowserManager } = await import("../browser/manager.js");
      const { ToolRegistry } = await import("../core/tool-registry.js");
      const { getBuiltInTools } = await import("../tools/index.js");
      const { McpManager } = await import("../mcp/manager.js");
      const { parseStopCommandText, formatDurationMs } = await import("../control/stop-command.js");
      const { stopLocalInteractiveSessions } = await import("../tools/shell-interactive.js");

      await ensureConfigExists(options.config);
      const config = await loadConfig(options.config);
      process.env.NEXUS_RUNTIME_PROFILE = config.runtime.profile;
      await bootstrapState(config);
      const paths = await resolveRuntimePaths(config);
      const initStatus = await getInitializationStatus(paths.stateDir);
      if (!initStatus.initialized) {
        process.stderr.write(`ERROR: ${getInitializationErrorMessage(initStatus)}\n`);
        process.exitCode = 1;
        return;
      }
      const db = await openDatabase(paths.dbPath);

      const resolveApiKey = (value?: string): string | undefined => {
        if (!value) return value;
        const envMatch = value.match(/^\$\{([A-Z0-9_]+)\}$/);
        if (envMatch) return getSecret(envMatch[1]) ?? undefined;
        return value;
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
        agentId: String(opts.agent ?? "main"),
        preset: "orchestrator",
        mode: "default",
        presetLlm: getPreset("orchestrator")?.llm,
      });
      const llm = modelRouter.createClient(startupRoute, {
        onLog: (line) => log(line),
      });

      const browserPort = Number(process.env.NEXUS_BROWSER_CDP_PORT ?? config.port + 2);
      const browser = new BrowserManager({
        stateDir: paths.stateDir,
        cdpPort: browserPort,
        remoteCdpUrl: process.env.NEXUS_BROWSER_REMOTE_CDP_URL,
        headless: process.env.NEXUS_BROWSER_HEADLESS === "1",
        noSandbox: process.env.NEXUS_BROWSER_NO_SANDBOX === "1",
      });

      const builtIns = getBuiltInTools();
      const mcp = new McpManager({ db, log, stateDir: paths.stateDir });
      await mcp.init();
      const registry = new ToolRegistry({ builtIns, stateDir: paths.stateDir, mcp });
      await registry.init();

      const processManager = new ProcessManager({ stateDir: paths.stateDir, db });
      const maxContextTokens = Math.max(0, envInt("NEXUS_MAX_CONTEXT_TOKENS") ?? config.limits.maxContextTokens);

      const toolContext = {
        workspaceDir: paths.workspaceDir,
        stateDir: paths.stateDir,
        codeDir: paths.codeDir,
        llm,
        llmConfig: startupRoute.primary,
        modelRouter,
        modelMode: startupRoute.mode,
        db,
        browser,
        registry,
        processManager,
        mcp,
        allowShellExec: config.permissions.allowShellExec || process.env.NEXUS_ALLOW_SHELL_EXEC === "1",
        allowCodeEdit: config.permissions.allowCodeEdit,
        allowCodeWrite: config.permissions.allowCodeWrite || process.env.NEXUS_ALLOW_CODE_WRITE === "1",
        requestRestart: (reason: string, delayMs: number = 2500) => {
          log(`restart: ${reason}`);
          setTimeout(() => process.exit(0), delayMs);
        },
        runtimeLimits: {
          maxToolCalls: config.limits.maxToolCallsPerRun,
          maxIterations: config.limits.maxIterationsPerRun,
          maxContextTokens,
        },
        nowMs: () => Date.now(),
        log,
      };

      const agent = new AgentService({
        llm,
        modelRouter,
        getTools: () => registry.list(),
        toolContext,
        db,
        stateDir: paths.stateDir,
        onRunnerLog: traceEnabled || options.verbose ? log : undefined,
        limits: {
          maxMessages: 20,
          anchorRolloverMessages: 40,
          maxToolCalls: config.limits.maxToolCallsPerRun,
          maxIterations: config.limits.maxIterationsPerRun,
          maxContextTokens,
          maxConcurrent: 1,
        },
      });

      const resolveSessionId = (nowMs: number): string =>
        getOrCreateSessionId({
          db,
          channel: "cli",
          channelKey: "local",
          agentId: String(opts.agent ?? "main"),
          nowMs,
        });

      const stopManagedProcesses = async (sessionId: string | null): Promise<{ stopped: number; errors: string[] }> => {
        const errors: string[] = [];
        let stopped = 0;
        const rows = sessionId
          ? db.db
            .prepare("SELECT id FROM process_runs WHERE status = 'running' AND request_session_id = ? AND backend = 'local_child'")
            .all(sessionId) as { id: string }[]
          : db.db
            .prepare("SELECT id FROM process_runs WHERE status = 'running' AND backend = 'local_child'")
            .all() as { id: string }[];
        for (const row of rows) {
          try {
            await processManager.stop({ id: row.id, signal: "SIGTERM", killAfterMs: 2_000 });
            stopped += 1;
          } catch (err) {
            errors.push(`process ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return { stopped, errors };
      };

      const handleControlCommand = async (text: string): Promise<string | null> => {
        const parsed = parseStopCommandText(text);
        if (!parsed) return null;
        const persistControlTurn = (sessionId: string, assistantText: string): string => {
          const nowMs = Date.now();
          try {
            appendMessage({
              db,
              sessionId,
              message: { role: "user", content: text },
              nowMs,
            });
            appendMessage({
              db,
              sessionId,
              message: { role: "assistant", content: assistantText },
              nowMs: nowMs + 1,
            });
          } catch (err) {
            log(`stop_control: failed to persist control turn: ${err instanceof Error ? err.message : String(err)}`);
          }
          return assistantText;
        };
        const nowMs = Date.now();
        const localSessionId = resolveSessionId(nowMs);
        if (parsed.kind === "stop") {
          const cancelledRuns = agent.cancelSessionRuns(localSessionId, "cli /stop");
          const shellStop = await stopLocalInteractiveSessions({
            stateDir: paths.stateDir,
            ownerSessionId: localSessionId,
          });
          const processStop = await stopManagedProcesses(localSessionId);
          const errors = [...shellStop.errors, ...processStop.errors];
          return persistControlTurn(localSessionId, [
            `STOP executed for session ${localSessionId}.`,
            `runs=${cancelledRuns} local_shell=${shellStop.closed} local_process=${processStop.stopped}`,
            ...(errors.length > 0 ? [`errors=${errors.length}`, ...errors.slice(0, 5).map((entry) => `- ${entry}`)] : []),
          ].join("\n"));
        }

        if (parsed.rawCooldown && parsed.cooldownMs === undefined) {
          return persistControlTurn(
            localSessionId,
            `ERROR: invalid cooldown "${parsed.rawCooldown}". Use values like 30s, 5m, or 1h.`,
          );
        }
        const cancelledRuns = agent.cancelAllRuns("cli /stopall");
        const shellStop = await stopLocalInteractiveSessions({ stateDir: paths.stateDir });
        const processStop = await stopManagedProcesses(null);
        const errors = [...shellStop.errors, ...processStop.errors];
        return persistControlTurn(localSessionId, [
          `STOP ALL executed. Cooldown ignored in local chat mode (${formatDurationMs(parsed.cooldownMs ?? 5 * 60_000)}).`,
          `runs=${cancelledRuns} local_shell=${shellStop.closed} local_process=${processStop.stopped}`,
          ...(errors.length > 0 ? [`errors=${errors.length}`, ...errors.slice(0, 5).map((entry) => `- ${entry}`)] : []),
        ].join("\n"));
      };

      async function send(text: string): Promise<void> {
        const intercepted = await handleControlCommand(text);
        if (intercepted !== null) {
          process.stdout.write(intercepted.trimEnd() + "\n");
          return;
        }
        const res = await agent.handleUserMessage({
          channel: "cli",
          channelKey: "local",
          agentId: String(opts.agent ?? "main"),
          text,
        });
        process.stdout.write(res.output.trimEnd() + "\n");
      }

      try {
        if (typeof message === "string" && message.trim().length > 0) {
          await send(message);
          return;
        }

        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        process.stdout.write('Interactive chat. Type "/exit" to quit.\n');
        let running = true;
        while (running) {
          const line = (await rl.question("> ")).trim();
          if (!line) continue;
          if (line === "/exit" || line === "/quit") {
            running = false;
            continue;
          }
          await send(line);
        }
        rl.close();
      } finally {
        await mcp.close();
        db.close();
      }
    });

  program
    .command("tool")
    .description("Run a single tool and print its output (useful for scripts/automation)")
    .argument("<name>", "Tool name (e.g. query_data)")
    .argument("[argsJson]", "Tool args as JSON (or '-' to read JSON from stdin)", "{}")
    .action(async (name, argsJson) => {
      const options = program.opts<{ config: string; verbose: boolean }>();
      const log = (line: string) => {
        if (!options.verbose) return;
        process.stderr.write(`[nexus] ${line}\n`);
      };

      const { ensureConfigExists, loadConfig } = await import("../state/config.js");
      const { bootstrapState } = await import("../state/bootstrap.js");
      const { resolveRuntimePaths } = await import("../state/paths.js");
      const { getInitializationStatus, getInitializationErrorMessage } = await import("../state/onboarding.js");
      const { openDatabase } = await import("../storage/database.js");
      const { ModelRouter } = await import("../llm/model-router.js");
      const { getPreset } = await import("../core/presets.js");
      const { ToolRegistry } = await import("../core/tool-registry.js");
      const { getBuiltInTools } = await import("../tools/index.js");
      const { McpManager } = await import("../mcp/manager.js");

      await ensureConfigExists(options.config);
      const config = await loadConfig(options.config);
      process.env.NEXUS_RUNTIME_PROFILE = config.runtime.profile;
      await bootstrapState(config);
      const paths = await resolveRuntimePaths(config);
      const initStatus = await getInitializationStatus(paths.stateDir);
      if (!initStatus.initialized) {
        process.stderr.write(`ERROR: ${getInitializationErrorMessage(initStatus)}\n`);
        process.exitCode = 1;
        return;
      }
      const db = await openDatabase(paths.dbPath);
      let mcp: InstanceType<typeof McpManager> | null = null;

      try {
        const resolveApiKey = (value?: string): string | undefined => {
          if (!value) return value;
          const envMatch = value.match(/^\$\{([A-Z0-9_]+)\}$/);
          if (envMatch) return getSecret(envMatch[1]) ?? undefined;
          return value;
        };
        const defaultLlmConfig = {
          ...config.llm.openaiCompat,
          apiKey: resolveApiKey(config.llm.openaiCompat.apiKey),
        };
        const llmProviderConfigs = Object.fromEntries(
          Object.entries(config.llm.providers).map(([providerName, provider]) => [
            providerName,
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
          agentId: "cli:tool",
          preset: "orchestrator",
          mode: "default",
          presetLlm: getPreset("orchestrator")?.llm,
        });
        const llm = modelRouter.createClient(startupRoute, {
          onLog: (line) => log(line),
        });

        const builtIns = getBuiltInTools();
        mcp = new McpManager({ db, log, stateDir: paths.stateDir });
        await mcp.init();
        const registry = new ToolRegistry({ builtIns, stateDir: paths.stateDir, mcp });
        await registry.init();

        let raw = String(argsJson ?? "{}").trim();
        if (raw === "-") {
          raw = await new Promise<string>((resolve) => {
            const chunks: Buffer[] = [];
            process.stdin.on("data", (c) => chunks.push(Buffer.from(c)));
            process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          });
          raw = raw.trim();
        }

        let parsed: unknown = {};
        if (raw.length > 0 && raw !== "{}") {
          try {
            parsed = JSON.parse(raw);
          } catch (e) {
            process.stderr.write(`ERROR: invalid JSON args: ${e instanceof Error ? e.message : String(e)}\n`);
            process.exitCode = 2;
            return;
          }
        }

        const tool = registry.list().find((t) => t.name === String(name));
        if (!tool) {
          process.stderr.write(`ERROR: unknown tool '${String(name)}'\n`);
          process.exitCode = 2;
          return;
        }

        const toolContext = {
          workspaceDir: paths.workspaceDir,
          stateDir: paths.stateDir,
          codeDir: paths.codeDir,
          llm,
          llmConfig: startupRoute.primary,
          modelRouter,
          modelMode: startupRoute.mode,
          db,
          registry,
          mcp,
          allowShellExec: config.permissions.allowShellExec || process.env.NEXUS_ALLOW_SHELL_EXEC === "1",
          allowCodeEdit: config.permissions.allowCodeEdit,
          allowCodeWrite: config.permissions.allowCodeWrite || process.env.NEXUS_ALLOW_CODE_WRITE === "1",
          runtimeLimits: {
            maxToolCalls: config.limits.maxToolCallsPerRun,
            maxIterations: config.limits.maxIterationsPerRun,
            maxContextTokens: Math.max(0, envInt("NEXUS_MAX_CONTEXT_TOKENS") ?? config.limits.maxContextTokens),
          },
          nowMs: () => Date.now(),
          log,
        };

        const result = await tool.execute(parsed, toolContext);
        process.stdout.write(result.trimEnd() + "\n");
        if (result.startsWith("ERROR:")) process.exitCode = 1;
      } finally {
        if (mcp) await mcp.close();
        db.close();
      }
    });

  program
    .command("init")
    .description("Run required onboarding (interactive by default, optional JSON for headless setup)")
    .option("--onboarding-json <path>", "Path to onboarding JSON for headless setup")
    .option("--force", "Re-run initialization and overwrite onboarding files/config values", false)
    .action(async (opts) => {
      const options = program.opts<{ config: string }>();
      const { ensureConfigExists, loadConfig } = await import("../state/config.js");
      const { bootstrapState } = await import("../state/bootstrap.js");
      const { resolveRuntimePaths } = await import("../state/paths.js");
      const {
        runOnboarding,
        writeOnboardingFiles,
        getInitializationStatus,
        getInitializationErrorMessage,
        loadInitOnboardingValuesFromFile,
        applyInitTelegramConfig,
        InitTelegramSchema,
      } = await import("../state/onboarding.js");

      await ensureConfigExists(options.config);
      const config = await loadConfig(options.config);
      await bootstrapState(config);
      const paths = await resolveRuntimePaths(config);

      const initStatus = await getInitializationStatus(paths.stateDir);
      if (initStatus.initialized && !opts.force) {
        process.stdout.write("Already initialized. Use `npm run dev -- init --force` to re-run onboarding.\n");
        return;
      }
      if (!initStatus.initialized) {
        process.stdout.write(`${getInitializationErrorMessage(initStatus)}\n`);
      }

      let onboardingValues;
      if (opts.onboardingJson) {
        onboardingValues = await loadInitOnboardingValuesFromFile(String(opts.onboardingJson));
      } else {
        if (!process.stdin.isTTY) {
          process.stderr.write(
            "ERROR: interactive onboarding requires a TTY. Use --onboarding-json <path> for headless setup.\n",
          );
          process.exitCode = 1;
          return;
        }
        const result = await runOnboarding(paths.stateDir, { includeTelegram: true });
        if (result.skipped) {
          process.stderr.write("ERROR: initialization canceled.\n");
          process.exitCode = 1;
          return;
        }
        onboardingValues = {
          identity: result.identity,
          userProfile: result.userProfile,
          telegram: result.telegram ?? InitTelegramSchema.parse({}),
        };
      }

      await writeOnboardingFiles(paths, onboardingValues.identity, onboardingValues.userProfile, {
        overwriteExisting: Boolean(opts.force),
      });
      await applyInitTelegramConfig(options.config, onboardingValues.telegram);

      process.stdout.write(`OK: initialized using config ${options.config}\n`);
    });

  program
    .command("status")
    .description("Print basic status info (config path, state dir, workspace)")
    .action(async () => {
      const options = program.opts<{ config: string }>();
      // Lazy import to keep CLI startup fast.
      const { ensureConfigExists, loadConfig } = await import("../state/config.js");
      const { resolveRuntimePaths } = await import("../state/paths.js");
      await ensureConfigExists(options.config);
      const config = await loadConfig(options.config);
      const paths = await resolveRuntimePaths(config);
      process.stdout.write(
        JSON.stringify(
          {
            configPath: options.config,
            stateDir: paths.stateDir,
            workspaceDir: paths.workspaceDir,
            codeDir: paths.codeDir,
          },
          null,
          2,
        ) + "\n",
      );
    });

  const gmail = program.command("gmail").description("Gmail API integration (OAuth2)");

  gmail
    .command("auth")
    .description("Authorize Gmail access (stores tokens in state dir)")
    .option("--listen <host>", "Callback listen host (use 0.0.0.0 inside Docker)", "127.0.0.1")
    .option("--port <port>", "Callback listen port", (v) => Number(v), 18790)
    .option("--callback-path <path>", "Callback path", "/oauth2callback")
    .option("--redirect-host <host>", "Host to use in redirect URI", "127.0.0.1")
    .option("--timeout-ms <ms>", "Time to wait for callback", (v) => Number(v), 5 * 60_000)
    .action(async (opts) => {
      const options = program.opts<{ config: string }>();
      const { ensureConfigExists, loadConfig } = await import("../state/config.js");
      const { bootstrapState } = await import("../state/bootstrap.js");
      const { resolveRuntimePaths } = await import("../state/paths.js");
      const { buildGoogleAuthUrl, createOauthState, exchangeCodeForTokens, runLocalhostOauthCallback, saveGmailTokens } =
        await import("../gmail/auth.js");

      await ensureConfigExists(options.config);
      const config = await loadConfig(options.config);
      await bootstrapState(config);
      const paths = await resolveRuntimePaths(config);

      const { openDatabase } = await import("../storage/database.js");
      const db = await openDatabase(paths.dbPath);
      const envSecretKeys = Object.keys(config.secrets?.env ?? {});
      if (envSecretKeys.length > 0) {
        await resolveEnvSecrets({ db, stateDir: paths.stateDir, env: config.secrets.env, log: () => { } });
      }

      const clientId = (getSecret("GOOGLE_CLIENT_ID") ?? "").trim();
      const clientSecret = (getSecret("GOOGLE_CLIENT_SECRET") ?? "").trim();
      if (!clientId || !clientSecret) {
        db.close();
        process.stderr.write("ERROR: missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in config.secrets.env\n");
        process.exitCode = 1;
        return;
      }

      const listenHost = String(opts.listen ?? "127.0.0.1");
      const listenPort = Number(opts.port ?? 18790);
      const callbackPath = String(opts.callbackPath ?? "/oauth2callback");
      const redirectHost = String(opts.redirectHost ?? "localhost");
      const timeoutMs = Number(opts.timeoutMs ?? 5 * 60_000);

      if (!Number.isFinite(listenPort) || listenPort <= 0 || listenPort > 65535) {
        process.stderr.write(`ERROR: invalid port: ${String(opts.port)}\n`);
        process.exitCode = 1;
        return;
      }
      if (!callbackPath.startsWith("/")) {
        process.stderr.write('ERROR: callback-path must start with "/" (e.g. /oauth2callback)\n');
        process.exitCode = 1;
        return;
      }

      const redirectUri = `http://${redirectHost}:${listenPort}${callbackPath}`;
      const oauth = { clientId, clientSecret, redirectUri };
      const state = createOauthState();
      const scopes = [
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.readonly",
      ];

      const waitForCode = runLocalhostOauthCallback({
        listenHost,
        listenPort,
        callbackPath,
        expectedState: state,
        timeoutMs,
        log: (line) => process.stderr.write(`[nexus] ${line}\n`),
      });

      const url = buildGoogleAuthUrl({ oauth, scopes, state });
      process.stdout.write("Open this URL in your browser to authorize Gmail:\n");
      process.stdout.write(url + "\n");
      process.stdout.write(`Redirect URI: ${redirectUri}\n`);

      const code = await waitForCode;
      const tokenSet = await exchangeCodeForTokens({ oauth, code, timeoutMs: 30_000 });
      const expiryDate = typeof tokenSet.expires_in === "number" ? Date.now() + tokenSet.expires_in * 1000 : undefined;
      await saveGmailTokens(paths.stateDir, {
        access_token: tokenSet.access_token,
        refresh_token: tokenSet.refresh_token,
        scope: tokenSet.scope,
        token_type: tokenSet.token_type,
        expiry_date: expiryDate,
      });

      process.stdout.write("OK: Gmail authorized\n");
    });

  gmail
    .command("status")
    .description("Show Gmail auth status (token presence/expiry)")
    .action(async () => {
      const options = program.opts<{ config: string }>();
      const { ensureConfigExists, loadConfig } = await import("../state/config.js");
      const { bootstrapState } = await import("../state/bootstrap.js");
      const { resolveRuntimePaths } = await import("../state/paths.js");
      const { getGmailTokenPath, loadGmailTokens } = await import("../gmail/auth.js");

      await ensureConfigExists(options.config);
      const config = await loadConfig(options.config);
      await bootstrapState(config);
      const paths = await resolveRuntimePaths(config);

      const tokens = await loadGmailTokens(paths.stateDir);
      if (!tokens) {
        process.stdout.write("Gmail: not authorized (run `nexus gmail auth`)\n");
        return;
      }

      const expiryIso =
        typeof tokens.expiry_date === "number" && tokens.expiry_date > 0 ? new Date(tokens.expiry_date).toISOString() : null;

      process.stdout.write(
        JSON.stringify(
          {
            tokenPath: getGmailTokenPath(paths.stateDir),
            hasRefreshToken: Boolean(tokens.refresh_token),
            scope: tokens.scope ?? null,
            tokenType: tokens.token_type ?? null,
            expiryDate: tokens.expiry_date ?? null,
            expiryIso,
            updatedAt: tokens.updated_at ?? null,
          },
          null,
          2,
        ) + "\n",
      );
    });

  const pairing = program.command("pairing").description("Manage pairing requests (OpenClaw-style)");

  pairing
    .command("list")
    .description("List pending pairing requests for a channel")
    .argument("<channel>", "Channel name (e.g. telegram)")
    .action(async (channel) => {
      const options = program.opts<{ config: string }>();
      const { ensureConfigExists, loadConfig } = await import("../state/config.js");
      const { resolveRuntimePaths } = await import("../state/paths.js");
      const { openDatabase } = await import("../storage/database.js");
      const { listPairingRequests } = await import("../gateway/telegram-store.js");
      await ensureConfigExists(options.config);
      const config = await loadConfig(options.config);
      const paths = await resolveRuntimePaths(config);
      const db = await openDatabase(paths.dbPath);
      try {
        const rows = listPairingRequests(db, { channel, nowMs: Date.now() });
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      } finally {
        db.close();
      }
    });

  const actions = program.command("actions").description("Human action queue (OTP/MFA/CAPTCHA handoff)");

  actions
    .command("list")
    .description("List recent human actions")
    .option("--status <status>", "pending|fulfilled|canceled|expired", "pending")
    .option("--limit <n>", "Max entries", (v) => Number(v), 50)
    .action(async (opts) => {
      const options = program.opts<{ config: string }>();
      const { ensureConfigExists, loadConfig } = await import("../state/config.js");
      const { resolveRuntimePaths } = await import("../state/paths.js");
      const { openDatabase } = await import("../storage/database.js");
      const { listHumanActions } = await import("../storage/human-actions.js");
      await ensureConfigExists(options.config);
      const config = await loadConfig(options.config);
      const paths = await resolveRuntimePaths(config);
      const db = await openDatabase(paths.dbPath);
      try {
        const status = String(opts.status ?? "pending") as any;
        const rows = listHumanActions(db, { nowMs: Date.now(), status, limit: Number(opts.limit ?? 50) });
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      } finally {
        db.close();
      }
    });

  actions
    .command("respond")
    .description("Respond to a pending human action")
    .argument("<id>", "Action id")
    .argument("<response...>", "Response text")
    .action(async (id, responseParts) => {
      const options = program.opts<{ config: string }>();
      const { ensureConfigExists, loadConfig } = await import("../state/config.js");
      const { resolveRuntimePaths } = await import("../state/paths.js");
      const { openDatabase } = await import("../storage/database.js");
      const { fulfillHumanAction } = await import("../storage/human-actions.js");
      await ensureConfigExists(options.config);
      const config = await loadConfig(options.config);
      const paths = await resolveRuntimePaths(config);
      const db = await openDatabase(paths.dbPath);
      try {
        const response = Array.isArray(responseParts) ? responseParts.join(" ").trim() : String(responseParts ?? "").trim();
        const res = fulfillHumanAction(db, { id: String(id), responseText: response, respondedByChannel: "cli", respondedByKey: "local", nowMs: Date.now() });
        if (!res.ok) {
          process.stderr.write(`ERROR: unable to record action (${res.error ?? "unknown"})\n`);
          process.exitCode = 1;
          return;
        }
        process.stdout.write("OK\n");
      } finally {
        db.close();
      }
    });

  actions
    .command("cancel")
    .description("Cancel a pending human action")
    .argument("<id>", "Action id")
    .action(async (id) => {
      const options = program.opts<{ config: string }>();
      const { ensureConfigExists, loadConfig } = await import("../state/config.js");
      const { resolveRuntimePaths } = await import("../state/paths.js");
      const { openDatabase } = await import("../storage/database.js");
      const { cancelHumanAction } = await import("../storage/human-actions.js");
      await ensureConfigExists(options.config);
      const config = await loadConfig(options.config);
      const paths = await resolveRuntimePaths(config);
      const db = await openDatabase(paths.dbPath);
      try {
        const res = cancelHumanAction(db, { id: String(id), nowMs: Date.now() });
        if (!res.ok) {
          process.stderr.write("ERROR: not found or not pending\n");
          process.exitCode = 1;
          return;
        }
        process.stdout.write("OK\n");
      } finally {
        db.close();
      }
    });

  pairing
    .command("approve")
    .description("Approve a pairing code and allowlist the sender")
    .argument("<channel>", "Channel name (e.g. telegram)")
    .argument("<code>", "Pairing code")
    .action(async (channel, code) => {
      const options = program.opts<{ config: string }>();
      const { ensureConfigExists, loadConfig } = await import("../state/config.js");
      const { resolveRuntimePaths } = await import("../state/paths.js");
      const { openDatabase } = await import("../storage/database.js");
      const { approveTelegramPairingRequestAndAllowUser } = await import("../gateway/telegram-store.js");
      await ensureConfigExists(options.config);
      const config = await loadConfig(options.config);
      const paths = await resolveRuntimePaths(config);
      const db = await openDatabase(paths.dbPath);
      try {
        const normalizedChannel = String(channel).trim().toLowerCase();
        const normalizedCode = String(code).trim().toUpperCase();
        if (normalizedChannel !== "telegram") {
          process.stderr.write(`ERROR: approve is only implemented for telegram currently (got ${channel})\n`);
          process.exitCode = 1;
          return;
        }

        const nowMs = Date.now();
        const approved = approveTelegramPairingRequestAndAllowUser(db, {
          code: normalizedCode,
          nowMs,
          note: `paired via code ${normalizedCode}`,
        });
        if (!approved.ok) {
          if (approved.error === "sender_not_numeric") {
            process.stderr.write("ERROR: pairing sender key is not a numeric Telegram user id\n");
            process.exitCode = 1;
            return;
          }
          process.stderr.write("ERROR: invalid or expired pairing code\n");
          process.exitCode = 1;
          return;
        }

        process.stdout.write(`OK: allowlisted telegram user ${approved.userId}\n`);
      } finally {
        db.close();
      }
    });

  await program.parseAsync(argv);
}
