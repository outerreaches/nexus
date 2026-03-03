import { Command } from "commander";
import { startGateway } from "../gateway/start.js";
import { ProcessManager } from "../process/manager.js";
import { getDefaultConfigPath } from "../state/paths.js";
import { startSecretSidecar } from "../secrets/sidecar.js";
import { resolveEnvSecrets, getSecret } from "../secrets/resolve-env.js";
import { parseSecretReference, resolveSecretReference, revokeSecretLease } from "../secrets/provider.js";
import type { NexusDatabase } from "../storage/database.js";
import type { NexusConfig } from "../state/config.js";

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

function resolveApiKey(value?: string): string | undefined {
  if (!value) return value;
  const envMatch = value.match(/^\$\{([A-Z0-9_]+)\}$/);
  if (envMatch) return getSecret(envMatch[1]) ?? undefined;
  return value;
}

function isLikelyLocalBaseUrl(baseUrl: string): boolean {
  const raw = (baseUrl ?? "").trim();
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

async function resolveConfigSecretValue(params: {
  db: NexusDatabase;
  stateDir: string;
  value?: string;
  fieldPath: string;
  actorPrefix: string;
}): Promise<string | undefined> {
  const value = params.value;
  if (!value) return value;
  const envMatch = value.match(/^\$\{([A-Z0-9_]+)\}$/);
  if (envMatch) return getSecret(envMatch[1]) ?? undefined;
  if (parseSecretReference(value) === null) return value;

  const nowMs = Date.now();
  try {
    const resolved = await resolveSecretReference({
      db: params.db,
      stateDir: params.stateDir,
      reference: value,
      traceId: `${params.actorPrefix}:${params.fieldPath}:${nowMs}`,
      actor: `${params.actorPrefix}:${params.fieldPath}`,
      nowMs,
    });
    if (resolved.leaseId) {
      revokeSecretLease({
        db: params.db,
        leaseId: resolved.leaseId,
        nowMs: nowMs + 1,
      });
    }
    return resolved.value;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`cli_config_secret_resolution_failed:${params.fieldPath}:${message}`);
  }
}

async function resolveCliLlmConfigSecrets(params: {
  db: NexusDatabase;
  stateDir: string;
  config: NexusConfig;
  log: (line: string) => void;
  actorPrefix: string;
}): Promise<{ defaultApiKey: string | undefined; providerApiKeyByName: Map<string, string | undefined> }> {
  await resolveEnvSecrets({
    db: params.db,
    stateDir: params.stateDir,
    env: params.config.secrets.env,
    log: params.log,
  });

  const defaultApiKey = await resolveConfigSecretValue({
    db: params.db,
    stateDir: params.stateDir,
    value: params.config.llm.openaiCompat.apiKey,
    fieldPath: "llm.openaiCompat.apiKey",
    actorPrefix: params.actorPrefix,
  });

  const resolvedProviderApiKeys = await Promise.all(
    Object.entries(params.config.llm.providers).map(async ([providerName, provider]) => {
      const resolvedApiKey = await resolveConfigSecretValue({
        db: params.db,
        stateDir: params.stateDir,
        value: provider.apiKey,
        fieldPath: `llm.providers.${providerName}.apiKey`,
        actorPrefix: params.actorPrefix,
      });
      return [providerName, resolvedApiKey] as const;
    }),
  );

  return {
    defaultApiKey,
    providerApiKeyByName: new Map<string, string | undefined>(resolvedProviderApiKeys),
  };
}

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command()
    .name("nexus")
    .description("Nexus — lightweight multi-agent assistant")
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
      const { getOrCreateSessionId, setHomeSession, clearHomeSession } = await import("../storage/sessions.js");
      const { ModelRouter } = await import("../llm/model-router.js");
      const { getPreset } = await import("../core/presets.js");
      const { AgentService } = await import("../core/agent-service.js");
      const { AgentTracker } = await import("../core/agent-tracker.js");
      const { BrowserManager } = await import("../browser/manager.js");
      const { ToolRegistry } = await import("../core/tool-registry.js");
      const { getBuiltInTools } = await import("../tools/index.js");
      const { McpManager } = await import("../mcp/manager.js");
      const { parseTerminalCommandText } = await import("../control/terminal-command.js");
      const { executeInfoCommand } = await import("../control/info-command-handler.js");
      const { renderHelpText } = await import("../control/help-command-handler.js");
      const { formatDurationMs } = await import("../control/stop-command.js");
      const {
        formatThemeList,
        loadTerminalThemePreference,
        resolveTerminalThemeId,
        saveTerminalThemePreference,
      } = await import("./terminal-theme.js");
      const { createSharedTui } = await import("./tui.js");
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
      let activeThemeId = await loadTerminalThemePreference(paths.stateDir);
      const colorEnabled = Boolean(process.stdout.isTTY);
      const tui = createSharedTui({ themeId: activeThemeId, colorEnabled });

      const { defaultApiKey, providerApiKeyByName } = await resolveCliLlmConfigSecrets({
        db,
        stateDir: paths.stateDir,
        config,
        log,
        actorPrefix: "cli:chat:config",
      });
      const defaultLlmConfig = {
        ...config.llm.openaiCompat,
        apiKey: resolveApiKey(defaultApiKey),
      };
      const llmProviderConfigs = Object.fromEntries(
        Object.entries(config.llm.providers).map(([name, provider]) => [
          name,
          {
            ...provider,
            apiKey: resolveApiKey(providerApiKeyByName.get(name)),
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
      const startupApiKeyPresent = Boolean(startupRoute.primary.apiKey && startupRoute.primary.apiKey.trim().length > 0);
      log(
        `cli: llm route primary=${startupRoute.primaryProvider}/${startupRoute.primary.model} source=${startupRoute.source} api_key=${startupApiKeyPresent ? "set" : "missing"}`,
      );
      if (!startupApiKeyPresent && !isLikelyLocalBaseUrl(startupRoute.primary.baseUrl)) {
        log(
          `cli: WARN selected provider ${startupRoute.primaryProvider} uses non-local baseUrl ${startupRoute.primary.baseUrl} but api_key is missing`,
        );
      }
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
      const agentTracker = new AgentTracker({ db });

      const processManager = new ProcessManager({ stateDir: paths.stateDir, db });
      const maxContextTokens = Math.max(0, envInt("NEXUS_MAX_CONTEXT_TOKENS") ?? config.limits.maxContextTokens);

      const toolContext = {
        workspaceDir: paths.workspaceDir,
        stateDir: paths.stateDir,
        codeDir: paths.codeDir,
        llm,
        llmConfig: startupRoute.primary,
        modelRouter,
        skillsConfig: config.skills,
        modelMode: startupRoute.mode,
        db,
        browser,
        registry,
        processManager,
        mcp,
        agentTracker,
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
        agentTracker,
        onRunnerLog: traceEnabled || options.verbose ? log : undefined,
        nudges: config.nudges,
        skillsConfig: config.skills,
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

      const agentLabel = `Nexus (${String(opts.agent ?? "main")})`;

      const toPanelLines = (text: string): string[] => {
        const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
        if (!normalized) return [""];
        return normalized.split("\n");
      };

      const renderSystemMessage = (text: string): void => {
        process.stdout.write(
          tui.panel("System", toPanelLines(text), {
            borderRole: "system",
            titleRole: "system",
            bodyRole: "system",
          }) + "\n",
        );
      };

      const renderUserMessage = (text: string): void => {
        process.stdout.write(
          tui.panel("You", toPanelLines(text), {
            borderRole: "prompt",
            titleRole: "prompt",
            bodyRole: "prompt",
          }) + "\n",
        );
      };

      const renderAgentMessage = (text: string): void => {
        process.stdout.write(
          tui.panel(agentLabel, toPanelLines(text), {
            borderRole: "assistant",
            titleRole: "assistant",
            bodyRole: "assistant",
          }) + "\n",
        );
      };

      const renderToolMessage = (line: string): void => {
        process.stdout.write(tui.paint("dim", line) + "\n");
      };

      const createTypingIndicator = (label: string): { pause: () => void; resume: () => void; stop: () => void } => {
        if (!process.stdout.isTTY) {
          return {
            pause: () => {},
            resume: () => {},
            stop: () => {},
          };
        }

        const frames = ["typing   ", "typing.  ", "typing.. ", "typing..."];
        let frameIndex = 0;
        let timer: NodeJS.Timeout | null = null;
        let active = false;

        const render = () => {
          const frame = frames[frameIndex % frames.length] ?? "typing...";
          frameIndex += 1;
          process.stdout.write(`\r${tui.paint("dim", `${label} ${frame}`)}\x1b[K`);
        };

        const pause = () => {
          if (!active) return;
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
          active = false;
          process.stdout.write("\r\x1b[2K");
        };

        const resume = () => {
          if (active) return;
          active = true;
          render();
          timer = setInterval(render, 220);
          timer.unref?.();
        };

        const stop = () => {
          pause();
        };

        resume();
        return { pause, resume, stop };
      };

      const readInteractiveInput = async (): Promise<string | null> => {
        if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
          const { createInterface } = await import("node:readline/promises");
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return await rl.question(tui.promptString());
          } finally {
            rl.close();
          }
        }

        const { clearScreenDown, cursorTo, moveCursor } = await import("node:readline");
        const previousRawMode = process.stdin.isRaw;

        return await new Promise<string | null>((resolve, reject) => {
          let value = "";
          let renderedLines = 0;
          let escaped = false;
          let inCsi = false;
          let closed = false;

          const cleanup = () => {
            if (closed) return;
            closed = true;
            process.stdin.off("data", onData);
            if (!previousRawMode) {
              process.stdin.setRawMode(false);
            }
            process.stdin.pause();
          };

          const done = (result: string | null) => {
            cleanup();
            process.stdout.write("\n");
            resolve(result);
          };

          const fail = (err: unknown) => {
            cleanup();
            reject(err instanceof Error ? err : new Error(String(err)));
          };

          const render = () => {
            const lines = value.split("\n");
            if (renderedLines > 0) {
              if (renderedLines > 1) moveCursor(process.stdout, 0, -(renderedLines - 1));
              cursorTo(process.stdout, 0);
              clearScreenDown(process.stdout);
            }
            process.stdout.write(lines.map((line) => `${tui.promptString()}${line}`).join("\n"));
            renderedLines = lines.length;
          };

          const onData = (chunk: Buffer | string) => {
            try {
              const raw = chunk.toString("utf8");
              const input = raw.length > 1 ? raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n") : raw;
              let dirty = false;
              for (const ch of input) {
                if (inCsi) {
                  const code = ch.codePointAt(0) ?? 0;
                  if (code >= 0x40 && code <= 0x7e) inCsi = false;
                  continue;
                }
                if (escaped) {
                  escaped = false;
                  if (ch === "[") {
                    inCsi = true;
                    continue;
                  }
                  if (ch === "\n" || ch === "\r") {
                    value += "\n";
                    dirty = true;
                    continue;
                  }
                  const code = ch.codePointAt(0) ?? 0;
                  if (code >= 0x20 && code !== 0x7f) {
                    value += ch;
                    dirty = true;
                  }
                  continue;
                }

                if (ch === "\u001b") {
                  escaped = true;
                  continue;
                }
                if (ch === "\u0003") {
                  done(null);
                  return;
                }
                if (ch === "\u0004") {
                  if (!value) {
                    done(null);
                    return;
                  }
                  continue;
                }
                if (ch === "\r") {
                  done(value);
                  return;
                }
                if (ch === "\n") {
                  value += "\n";
                  dirty = true;
                  continue;
                }
                if (ch === "\u007f" || ch === "\b") {
                  if (value) {
                    value = value.slice(0, -1);
                    dirty = true;
                  }
                  continue;
                }

                const code = ch.codePointAt(0) ?? 0;
                if (ch === "\t" || code >= 0x20) {
                  value += ch;
                  dirty = true;
                }
              }
              if (dirty) render();
            } catch (err) {
              fail(err);
            }
          };

          try {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on("data", onData);
            render();
          } catch (err) {
            fail(err);
          }
        });
      };

      const handleControlCommand = async (text: string): Promise<string | null> => {
        const parsed = parseTerminalCommandText(text);
        if (!parsed) return null;
        const nowMs = Date.now();
        const localSessionId = resolveSessionId(nowMs);
        if (parsed.kind === "theme") {
          const requested = parsed.theme.requestedTheme;
          if (!requested) {
            return formatThemeList(activeThemeId);
          }
          const resolved = resolveTerminalThemeId(requested);
          if (!resolved) {
            return `ERROR: unknown theme "${requested}".\n\n${formatThemeList(activeThemeId)}`;
          }
          activeThemeId = resolved;
          tui.setTheme(activeThemeId);
          try {
            await saveTerminalThemePreference(paths.stateDir, activeThemeId);
          } catch (err) {
            log(`terminal_theme: failed to persist preference: ${err instanceof Error ? err.message : String(err)}`);
          }
          return `Theme changed to ${activeThemeId}.\n\n${formatThemeList(activeThemeId)}`;
        }

        const controlParsed = parsed.control;
        if (controlParsed.kind === "help") {
          return renderHelpText("terminal");
        }
        if (controlParsed.kind === "info") {
          const infoText = await executeInfoCommand({
            command: controlParsed.info,
            deps: {
              db,
              processManager,
              agentTracker,
              mcp,
              listTools: () => registry.list(),
              nowMs: () => Date.now(),
              federationEnabled: config.federation.enabled,
            },
          });
          return infoText;
        }
        if (controlParsed.kind === "home") {
          const agentId = String(opts.agent ?? "main");
          if (controlParsed.home.kind === "sethome") {
            setHomeSession({
              db,
              agentId,
              channel: "cli",
              channelKey: "local",
              nowMs,
            });
            return `OK: this CLI chat is now the home session for agent ${agentId}.`;
          }
          clearHomeSession({ db, agentId });
          return `OK: home session cleared for agent ${agentId}.`;
        }

        const stopParsed = controlParsed.stop;
        if (stopParsed.kind === "stop") {
          const cancelledRuns = agent.cancelSessionRuns(localSessionId, "cli /stop");
          const shellStop = await stopLocalInteractiveSessions({
            stateDir: paths.stateDir,
            ownerSessionId: localSessionId,
          });
          const processStop = await stopManagedProcesses(localSessionId);
          const errors = [...shellStop.errors, ...processStop.errors];
          return [
            `STOP executed for session ${localSessionId}.`,
            `runs=${cancelledRuns} local_shell=${shellStop.closed} local_process=${processStop.stopped}`,
            ...(errors.length > 0 ? [`errors=${errors.length}`, ...errors.slice(0, 5).map((entry) => `- ${entry}`)] : []),
          ].join("\n");
        }

        if (stopParsed.rawCooldown && stopParsed.cooldownMs === undefined) {
          return `ERROR: invalid cooldown "${stopParsed.rawCooldown}". Use values like 30s, 5m, or 1h.`;
        }
        const cancelledRuns = agent.cancelAllRuns("cli /stopall");
        const shellStop = await stopLocalInteractiveSessions({ stateDir: paths.stateDir });
        const processStop = await stopManagedProcesses(null);
        const errors = [...shellStop.errors, ...processStop.errors];
        return [
          `STOP ALL executed. Cooldown ignored in local chat mode (${formatDurationMs(stopParsed.cooldownMs ?? 5 * 60_000)}).`,
          `runs=${cancelledRuns} local_shell=${shellStop.closed} local_process=${processStop.stopped}`,
          ...(errors.length > 0 ? [`errors=${errors.length}`, ...errors.slice(0, 5).map((entry) => `- ${entry}`)] : []),
        ].join("\n");
      };

      async function send(text: string, sendOptions: { interactive: boolean }): Promise<void> {
        const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const intercepted = normalized.includes("\n") ? null : await handleControlCommand(normalized);
        if (intercepted !== null) {
          if (sendOptions.interactive) {
            renderSystemMessage(intercepted);
          } else {
            process.stdout.write(tui.paint("system", intercepted.trimEnd()) + "\n");
          }
          return;
        }

        if (!sendOptions.interactive) {
          const res = await agent.handleUserMessage({
            channel: "cli",
            channelKey: "local",
            agentId: String(opts.agent ?? "main"),
            text: normalized,
          });
          process.stdout.write(tui.paint("assistant", res.output.trimEnd()) + "\n");
          return;
        }

        renderUserMessage(normalized);
        const typing = createTypingIndicator(agentLabel);
        try {
          const res = await agent.handleUserMessage({
            channel: "cli",
            channelKey: "local",
            agentId: String(opts.agent ?? "main"),
            text: normalized,
            onToolStart: (name, preview) => {
              typing.pause();
              const suffix = preview.trim().length > 0 ? ` :: ${preview}` : "";
              renderToolMessage(`[tool:start] ${name}${suffix}`);
              typing.resume();
            },
            onToolEnd: (name) => {
              typing.pause();
              renderToolMessage(`[tool:done] ${name}`);
              typing.resume();
            },
          });
          typing.stop();
          renderAgentMessage(res.output);
        } catch (err) {
          typing.stop();
          throw err;
        }
      }

      try {
        if (typeof message === "string" && message.trim().length > 0) {
          await send(message, { interactive: false });
          return;
        }

        const intro = [
          tui.logoPanel(
            "Nexus CLI",
            "Interactive chat ready. Ask anything, or run slash commands below.",
          ),
          tui.panel("Quick Commands", [
            "Enter send | Alt+Enter/Ctrl+J newline",
            "/help",
            "/tools [limit]",
            "/sethome | /unsethome",
            "/theme [name]",
            "/stop | /stopall",
            "/exit",
          ]),
        ].join("\n");
        process.stdout.write(
          `${intro}\n`,
        );
        let running = true;
        while (running) {
          const line = await readInteractiveInput();
          if (line === null) {
            running = false;
            continue;
          }
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed === "/exit" || trimmed === "/quit") {
            running = false;
            continue;
          }
          await send(line, { interactive: true });
        }
      } finally {
        if (colorEnabled) process.stdout.write("\x1b[0m");
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
        const { defaultApiKey, providerApiKeyByName } = await resolveCliLlmConfigSecrets({
          db,
          stateDir: paths.stateDir,
          config,
          log,
          actorPrefix: "cli:tool:config",
        });
        const defaultLlmConfig = {
          ...config.llm.openaiCompat,
          apiKey: resolveApiKey(defaultApiKey),
        };
        const llmProviderConfigs = Object.fromEntries(
          Object.entries(config.llm.providers).map(([providerName, provider]) => [
            providerName,
            {
              ...provider,
              apiKey: resolveApiKey(providerApiKeyByName.get(providerName)),
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
        const startupApiKeyPresent = Boolean(startupRoute.primary.apiKey && startupRoute.primary.apiKey.trim().length > 0);
        log(
          `cli: llm route primary=${startupRoute.primaryProvider}/${startupRoute.primary.model} source=${startupRoute.source} api_key=${startupApiKeyPresent ? "set" : "missing"}`,
        );
        if (!startupApiKeyPresent && !isLikelyLocalBaseUrl(startupRoute.primary.baseUrl)) {
          log(
            `cli: WARN selected provider ${startupRoute.primaryProvider} uses non-local baseUrl ${startupRoute.primary.baseUrl} but api_key is missing`,
          );
        }
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
          skillsConfig: config.skills,
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
    .command("setup")
    .description("Run interactive instance setup wizard (green themed)")
    .option("--root <path>", "Install root directory (default: ~/.nexus)")
    .option("--code-dir <path>", "Code checkout path (default: <root>/code)")
    .option("--repo-url <url>", "Git repository URL (used when code directory is missing)")
    .option("--yes", "Accept defaults / confirmations", false)
    .option("--non-interactive", "Run with defaults without prompts", false)
    .option("--dry-run", "Print actions without executing shell commands", false)
    .action(async (opts) => {
      const { runSetupWizard } = await import("./setup-wizard.js");
      await runSetupWizard({
        root: opts.root,
        codeDir: opts.codeDir,
        repoUrl: opts.repoUrl,
        yes: Boolean(opts.yes),
        nonInteractive: Boolean(opts.nonInteractive),
        dryRun: Boolean(opts.dryRun),
      });
    });

  program
    .command("uninstall")
    .description("Remove Nexus host autostart integration for ha-deployer (systemd/launchd)")
    .option("--yes", "Proceed without confirmation prompt", false)
    .option("--non-interactive", "Do not prompt (requires --yes)", false)
    .option("--dry-run", "Print actions without executing shell commands", false)
    .action(async (opts) => {
      const { runUninstall } = await import("./uninstall.js");
      await runUninstall({
        yes: Boolean(opts.yes),
        nonInteractive: Boolean(opts.nonInteractive),
        dryRun: Boolean(opts.dryRun),
      });
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

  const normalizedArgv = argv.length <= 2 ? [...argv, "chat"] : argv;
  await program.parseAsync(normalizedArgv);
}
