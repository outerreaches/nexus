import { Command } from "commander";
import { startGateway } from "../gateway/start.js";
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
    .action(async (opts) => {
      const options = program.opts<{ config: string; verbose: boolean }>();
      await startGateway({
        configPath: options.config,
        port: opts.port,
        verbose: options.verbose,
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
        workspaceDir: paths.workspaceDir,
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
      await runOnboardingIfNeeded(paths.workspaceDir, { interactive: !opts.skipOnboarding });

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

      const needsOnboarding = await shouldRunOnboarding(paths.workspaceDir);
      if (!needsOnboarding && !opts.force) {
        process.stdout.write("Personalization files already exist. Use --force to overwrite.\n");
        return;
      }

      const result = await runOnboarding(paths.workspaceDir);
      if (!result.skipped) {
        await writeOnboardingFiles(paths.workspaceDir, result.identity, result.userProfile);
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
