import { Command } from "commander";
import { startGateway } from "../gateway/start.js";
import { ProcessManager } from "../process/manager.js";
import { getDefaultConfigPath } from "../state/paths.js";

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
    .option("--standby", "Start in standby mode (health checks only, no scheduler/proactive)", false)
    .action(async (opts) => {
      const options = program.opts<{ config: string; verbose: boolean }>();
      await startGateway({
        configPath: options.config,
        port: opts.port,
        verbose: options.verbose,
        standby: opts.standby,
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
      const { openDatabase } = await import("../storage/database.js");
      const { OpenAICompatClient } = await import("../llm/openai-compat.js");
      const { AgentService } = await import("../core/agent-service.js");
      const { BrowserManager } = await import("../browser/manager.js");
      const { ToolRegistry } = await import("../core/tool-registry.js");
      const { getBuiltInTools } = await import("../tools/index.js");

      await ensureConfigExists(options.config);
      const config = await loadConfig(options.config);
      await bootstrapState(config);
      const paths = await resolveRuntimePaths(config);
      const db = await openDatabase(paths.dbPath);

      const apiKey =
        config.llm.openaiCompat.apiKey && /^\$\{[A-Z0-9_]+\}$/.test(config.llm.openaiCompat.apiKey)
          ? undefined
          : config.llm.openaiCompat.apiKey;
      const llm = new OpenAICompatClient({ ...config.llm.openaiCompat, apiKey });

      const browserPort = Number(process.env.NEXUS_BROWSER_CDP_PORT ?? config.port + 2);
      const browser = new BrowserManager({
        stateDir: paths.stateDir,
        cdpPort: browserPort,
        remoteCdpUrl: process.env.NEXUS_BROWSER_REMOTE_CDP_URL,
        headless: process.env.NEXUS_BROWSER_HEADLESS === "1",
        noSandbox: process.env.NEXUS_BROWSER_NO_SANDBOX === "1",
      });

      const builtIns = getBuiltInTools();
      const registry = new ToolRegistry({ builtIns, stateDir: paths.stateDir });
      await registry.init();

      const processManager = new ProcessManager({ stateDir: paths.stateDir });

      const toolContext = {
        workspaceDir: paths.workspaceDir,
        stateDir: paths.stateDir,
        codeDir: paths.codeDir,
        llm,
        db,
        browser,
        registry,
        processManager,
        allowShellExec: config.permissions.allowShellExec || process.env.NEXUS_ALLOW_SHELL_EXEC === "1",
        allowCodeEdit: config.permissions.allowCodeEdit,
        allowCodeWrite: config.permissions.allowCodeWrite || process.env.NEXUS_ALLOW_CODE_WRITE === "1",
        requestRestart: (reason: string, delayMs: number = 2500) => {
          log(`restart: ${reason}`);
          setTimeout(() => process.exit(0), delayMs);
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
        onRunnerLog: traceEnabled || options.verbose ? log : undefined,
        limits: {
          maxMessages: 80,
          maxToolCalls: config.limits.maxToolCallsPerRun,
          maxIterations: config.limits.maxIterationsPerRun,
          maxConcurrent: 1,
        },
      });

      async function send(text: string): Promise<void> {
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
        while (true) {
          const line = (await rl.question("> ")).trim();
          if (!line) continue;
          if (line === "/exit" || line === "/quit") break;
          await send(line);
        }
        rl.close();
      } finally {
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
      const { openDatabase } = await import("../storage/database.js");
      const { ToolRegistry } = await import("../core/tool-registry.js");
      const { getBuiltInTools } = await import("../tools/index.js");

      await ensureConfigExists(options.config);
      const config = await loadConfig(options.config);
      await bootstrapState(config);
      const paths = await resolveRuntimePaths(config);
      const db = await openDatabase(paths.dbPath);

      try {
        const builtIns = getBuiltInTools();
        const registry = new ToolRegistry({ builtIns, stateDir: paths.stateDir });
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
          db,
          registry,
          allowShellExec: config.permissions.allowShellExec || process.env.NEXUS_ALLOW_SHELL_EXEC === "1",
          allowCodeEdit: config.permissions.allowCodeEdit,
          allowCodeWrite: config.permissions.allowCodeWrite || process.env.NEXUS_ALLOW_CODE_WRITE === "1",
          nowMs: () => Date.now(),
          log,
        };

        const result = await tool.execute(parsed, toolContext);
        process.stdout.write(result.trimEnd() + "\n");
        if (result.startsWith("ERROR:")) process.exitCode = 1;
      } finally {
        db.close();
      }
    });

  program
    .command("init")
    .description("Create config and bootstrap the Nexus state/workspace")
    .option("--skip-onboarding", "Skip interactive onboarding prompts", false)
    .action(async (opts) => {
      const options = program.opts<{ config: string }>();
      const { ensureConfigExists, loadConfig } = await import("../state/config.js");
      const { bootstrapState } = await import("../state/bootstrap.js");
      const { resolveRuntimePaths } = await import("../state/paths.js");
      const { runOnboardingIfNeeded } = await import("../state/onboarding.js");

      await ensureConfigExists(options.config);
      const config = await loadConfig(options.config);
      await bootstrapState(config);
      const paths = await resolveRuntimePaths(config);

      // Run interactive onboarding if this is first time
      await runOnboardingIfNeeded(paths.stateDir, { interactive: !opts.skipOnboarding });

      process.stdout.write(`OK: initialized using config ${options.config}\n`);
    });

  program
    .command("onboard")
    .description("Run the interactive onboarding wizard to personalize your agent")
    .option("--force", "Run onboarding even if files already exist", false)
    .action(async (opts) => {
      const options = program.opts<{ config: string }>();
      const { ensureConfigExists, loadConfig } = await import("../state/config.js");
      const { bootstrapState } = await import("../state/bootstrap.js");
      const { resolveRuntimePaths } = await import("../state/paths.js");
      const { runOnboarding, writeOnboardingFiles, shouldRunOnboarding } = await import("../state/onboarding.js");

      await ensureConfigExists(options.config);
      const config = await loadConfig(options.config);
      await bootstrapState(config);
      const paths = await resolveRuntimePaths(config);

      const needsOnboarding = await shouldRunOnboarding(paths.stateDir);
      if (!needsOnboarding && !opts.force) {
        process.stdout.write("Personalization files already exist. Use --force to overwrite.\n");
        return;
      }

      const result = await runOnboarding(paths.stateDir);
      if (!result.skipped) {
        await writeOnboardingFiles(paths.stateDir, result.identity, result.userProfile);
      }
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

      const clientId = (process.env.GOOGLE_CLIENT_ID ?? "").trim();
      const clientSecret = (process.env.GOOGLE_CLIENT_SECRET ?? "").trim();
      if (!clientId || !clientSecret) {
        process.stderr.write("ERROR: missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET\n");
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
      const { allowTelegramUser, approvePairingRequest } = await import("../gateway/telegram-store.js");
      await ensureConfigExists(options.config);
      const config = await loadConfig(options.config);
      const paths = await resolveRuntimePaths(config);
      const db = await openDatabase(paths.dbPath);
      try {
        const res = approvePairingRequest(db, { channel, code, nowMs: Date.now() });
        if (!res.ok || !res.senderKey) {
          process.stderr.write("ERROR: invalid or expired pairing code\n");
          process.exitCode = 1;
          return;
        }

        if (channel !== "telegram") {
          process.stderr.write(`ERROR: approve is only implemented for telegram currently (got ${channel})\n`);
          process.exitCode = 1;
          return;
        }

        const userId = Number(res.senderKey);
        if (!Number.isFinite(userId)) {
          process.stderr.write(`ERROR: pairing senderKey is not numeric: ${res.senderKey}\n`);
          process.exitCode = 1;
          return;
        }
        allowTelegramUser(db, { userId, nowMs: Date.now(), note: `paired via code ${code}` });
        process.stdout.write(`OK: allowlisted telegram user ${userId}\n`);
      } finally {
        db.close();
      }
    });

  await program.parseAsync(argv);
}
