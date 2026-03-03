import "../env.js";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import { AgentService } from "../core/agent-service.js";
import { AgentTracker } from "../core/agent-tracker.js";
import { startRunReportBroker, type RunReportBroker } from "../core/run-report-broker.js";
import { BrowserManager } from "../browser/manager.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { getPreset } from "../core/presets.js";
import { McpManager } from "../mcp/manager.js";
import { ModelRouter } from "../llm/model-router.js";
import { LlmCircuitBreaker } from "../llm/circuit-breaker.js";
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
import { createNodeProcessDeliveryHandler } from "../nodes/process-delivery.js";
import { createNodeWebhookIngressHandler } from "../nodes/webhook-ingress.js";
import { registerNodeRoutes } from "./routes/nodes.js";
import {
  appendFederationAudit,
  getFederationPeerById,
  getFederationStatusSnapshot,
  getPreferredTransportRouteForPeer,
  upsertFederationSession,
  upsertTransportRoute,
} from "../storage/federation.js";
import { listSecretProviderProfiles } from "../storage/secrets.js";
import { startFederationOutboxWorker, type FederationOutboxWorker } from "../federation/outbox-worker.js";
import { createFederationHttpDispatcher } from "../federation/dispatcher.js";
import { loadOrCreateFederationSigningIdentity } from "../federation/identity.js";
import { deriveFederationFirewallRuntimeState } from "../federation/firewall.js";
import { startWebhookDeliveryWorker, type WebhookDeliveryWorker } from "../federation/webhook-worker.js";
import { createFederationTransportRouter } from "../federation/transport.js";
import { createNodeWsDispatcher } from "../federation/node-dispatcher.js";
import { parseSecretReference, resolveSecretReference, revokeSecretLease } from "../secrets/provider.js";
import { resolveEnvSecrets, getSecret } from "../secrets/resolve-env.js";
import { appendMessage, clearHomeSession, getOrCreateSessionId, setHomeSession } from "../storage/sessions.js";
import { parseDurationToMs, formatDurationMs } from "../control/stop-command.js";
import { parseControlCommandText } from "../control/control-command.js";
import { executeInfoCommand } from "../control/info-command-handler.js";
import { renderHelpText } from "../control/help-command-handler.js";
import { stopLocalInteractiveSessions } from "../tools/shell-interactive.js";

type RuntimeProfile = "standard" | "primary" | "standby" | "monetization" | "service_custom" | "portable" | "execution_node_host";

type IsolatedWorkerOwner = {
  sessionId: string | null;
  runId: string | null;
  channel: string | null;
  channelKey: string | null;
  agentId: string | null;
};

type StopExecutionSummary = {
  cancelledRuns: number;
  terminatedWorkers: number;
  localInteractiveClosed: number;
  localInteractiveFailed: number;
  remoteInteractiveClosed: number;
  localProcessesStopped: number;
  remoteProcessesCancelled: number;
  errors: string[];
};

export async function startGateway(
  params: { configPath: string; port?: number; verbose: boolean; standby?: boolean; profile?: RuntimeProfile },
): Promise<void> {
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
  if (params.profile && params.profile !== config.runtime.profile) {
    config.runtime.profile = params.profile;
  }
  process.env.NEXUS_RUNTIME_PROFILE = config.runtime.profile;
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
  let federationSigningIdentity = config.federation.enabled
    ? await loadOrCreateFederationSigningIdentity({ db, stateDir: paths.stateDir, log })
    : null;
  let federationSigningIdentityLoadedAtMs = Date.now();
  const federationSigningRefreshMs = Math.max(1_000, envInt("NEXUS_FEDERATION_SIGNING_REFRESH_MS") ?? 15_000);
  if (federationSigningIdentity) {
    log(`federation/auth: loaded signing identity kid=${federationSigningIdentity.kid} fingerprint=${federationSigningIdentity.fingerprint}`);
  }
  const refreshFederationSigningIdentity = async (): Promise<typeof federationSigningIdentity> => {
    if (!config.federation.enabled) return null;
    const nowMs = Date.now();
    if (federationSigningIdentity && nowMs - federationSigningIdentityLoadedAtMs < federationSigningRefreshMs) {
      return federationSigningIdentity;
    }
    const previousKid = federationSigningIdentity?.kid ?? null;
    const nextIdentity = await loadOrCreateFederationSigningIdentity({
      db,
      stateDir: paths.stateDir,
      nowMs,
    });
    federationSigningIdentity = nextIdentity;
    federationSigningIdentityLoadedAtMs = nowMs;
    if (previousKid && previousKid !== nextIdentity.kid) {
      log(`federation/auth: hot-reloaded signing kid ${previousKid} -> ${nextIdentity.kid}`);
    }
    return federationSigningIdentity;
  };
  const nodeProcessDelivery = createNodeProcessDeliveryHandler({
    db,
    stateDir: paths.stateDir,
    log,
  });
  const nodeWebhookIngress = createNodeWebhookIngressHandler({
    db,
    log,
    targetAgentId: process.env.NEXUS_NODE_WEBHOOK_TARGET_AGENT_ID,
  });
  // Standby mode tracking is declared early so node transport, status, and HA
  // transitions all share the same source of truth.
  let isStandby = params.standby ?? false;
  let activatedAt: number | null = isStandby ? null : Date.now();
  const nodeWsGateway = new NodeWebSocketGateway({
    identity: nodeGatewayIdentity,
    registry: nodeRegistry,
    isStandby: () => isStandby,
    log,
    gatewaySender: `gateway:${hostId}`,
    onProcessUpdate: nodeProcessDelivery.handleProcessUpdate,
    onLogAppend: nodeProcessDelivery.handleLogAppend,
    onWebhookIngress: async (ctx) => {
      await nodeWebhookIngress.handle(ctx);
    },
  });
  const nodeRouter = new NodeToolRouter({
    registry: nodeRegistry,
    log,
    executeOnNode: async ({ nodeId, toolName, args, ctx }) =>
      nodeWsGateway.executeRoutedCall({
        nodeId,
        remoteName: toolName,
        args,
        ctx,
      }),
  });
  initDataIntake();
  ensureSystemJobs({ db, nowMs: Date.now(), stateDir: paths.stateDir, log });

  // Resolve env-var secrets from config.secrets.env through the sidecar/broker/provider stack.
  // Must happen after DB is ready and before consumer modules read secrets.
  const envSecretKeys = Object.keys(config.secrets?.env ?? {});
  if (envSecretKeys.length > 0) {
    await resolveEnvSecrets({ db, stateDir: paths.stateDir, env: config.secrets.env, log });
  }

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
    const envMatch = value.match(/^\$\{([A-Z0-9_]+)\}$/);
    if (envMatch) return getSecret(envMatch[1]) ?? undefined;
    return value;
  };
  const resolveConfigSecretValue = async (params: {
    value?: string;
    fieldPath: string;
  }): Promise<string | undefined> => {
    const value = params.value;
    if (!value) return value;
    if (/^\$\{[A-Z0-9_]+\}$/.test(value)) {
      const envMatch = value.match(/^\$\{([A-Z0-9_]+)\}$/);
      return envMatch ? getSecret(envMatch[1]) ?? undefined : undefined;
    }
    if (parseSecretReference(value) === null) return value;
    const nowMs = Date.now();
    try {
      const resolved = await resolveSecretReference({
        db,
        stateDir: paths.stateDir,
        reference: value,
        traceId: `gateway-config:${params.fieldPath}:${nowMs}`,
        actor: `gateway:start:config:${params.fieldPath}`,
        nowMs,
      });
      if (resolved.leaseId) {
        revokeSecretLease({
          db,
          leaseId: resolved.leaseId,
          nowMs: nowMs + 1,
        });
      }
      return resolved.value;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`gateway_config_secret_resolution_failed:${params.fieldPath}:${message}`);
    }
  };
  const resolvedDefaultApiKey = await resolveConfigSecretValue({
    value: config.llm.openaiCompat.apiKey,
    fieldPath: "llm.openaiCompat.apiKey",
  });
  const resolvedProviderApiKeys = await Promise.all(
    Object.entries(config.llm.providers).map(async ([providerName, provider]) => {
      const resolvedApiKey = await resolveConfigSecretValue({
        value: provider.apiKey,
        fieldPath: `llm.providers.${providerName}.apiKey`,
      });
      return [providerName, resolvedApiKey] as const;
    }),
  );
  const providerApiKeyByName = new Map<string, string | undefined>(resolvedProviderApiKeys);
  config.channels.telegram.token = await resolveConfigSecretValue({
    value: config.channels.telegram.token,
    fieldPath: "channels.telegram.token",
  });
  config.channels.telegram.webhookSecretToken = await resolveConfigSecretValue({
    value: config.channels.telegram.webhookSecretToken,
    fieldPath: "channels.telegram.webhookSecretToken",
  });
  const defaultLlmConfig = {
    ...config.llm.openaiCompat,
    apiKey: resolveApiKey(resolvedDefaultApiKey),
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
    agentId: "gateway:start",
    preset: "orchestrator",
    mode: "default",
    presetLlm: getPreset("orchestrator")?.llm,
  });
  log(
    `startup: llm route primary=${startupRoute.primaryProvider}/${startupRoute.primary.model} source=${startupRoute.source}`,
  );
  const circuitBreaker = new LlmCircuitBreaker({
    primaryConfig: defaultLlmConfig,
    onStateChange: (from, to, reason) => log(`circuit_breaker ${from} → ${to}: ${reason}`),
    onLog: (line) => log(line),
  });
  const llm = modelRouter.createClient(startupRoute, {
    onLog: (line) => log(line),
  });
  const llmConfig = startupRoute.primary;
  const builtIns = getBuiltInTools();
  const mcp = new McpManager({ db, log, stateDir: paths.stateDir });
  await mcp.init();
  const registry = new ToolRegistry({ builtIns, stateDir: paths.stateDir, mcp });
  await registry.init();

  const processManager = new ProcessManager({ stateDir: paths.stateDir, db });

  const agentTracker = new AgentTracker({ db });

  // Track isolated worker child processes for shutdown cleanup
  const isolatedWorkers = new Set<ChildProcess>();
  const isolatedWorkerOwners = new Map<ChildProcess, IsolatedWorkerOwner>();
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

  const monetizationProfile = config.runtime.profile === "monetization";
  const allowShellExec = !monetizationProfile && (config.permissions.allowShellExec || process.env.NEXUS_ALLOW_SHELL_EXEC === "1");
  const allowCodeEdit = monetizationProfile ? false : config.permissions.allowCodeEdit;
  const allowCodeWrite = !monetizationProfile && (config.permissions.allowCodeWrite || process.env.NEXUS_ALLOW_CODE_WRITE === "1");
  const maxContextTokens = Math.max(0, envInt("NEXUS_MAX_CONTEXT_TOKENS") ?? config.limits.maxContextTokens);
  const proactiveEnabled = envBool("NEXUS_PROACTIVE") ?? config.proactive.enabled;
  const proactiveNotifyTelegram = envBool("NEXUS_PROACTIVE_NOTIFY_TELEGRAM") ?? config.proactive.notifyTelegram;
  const defaultStopAllCooldownMs = Math.max(
    1_000,
    envInt("NEXUS_STOPALL_COOLDOWN_MS")
      ?? parseDurationToMs(process.env.NEXUS_STOPALL_COOLDOWN ?? "")
      ?? 5 * 60_000,
  );
  const telegramAllowAll = process.env.NEXUS_TELEGRAM_ALLOW_ALL === "1";
  const telegramAllowFromCount = config.channels.telegram.allowFrom?.length ?? 0;
  const telegramPairingEnabled = config.channels.telegram.pairing.enabled;

  const toolContext = {
    workspaceDir: paths.workspaceDir,
    stateDir: paths.stateDir,
    codeDir: paths.codeDir,
    llm,
    llmConfig,
    circuitBreaker,
    modelRouter,
    llmToolRouting: config.llm.toolRouting,
    skillsConfig: config.skills,
    modelMode: startupRoute.mode,
    db,
    browser,
    registry,
    processManager,
    mcp,
    agentTracker,
    isolatedWorkers,
    registerIsolatedWorker: (child: ChildProcess, owner: IsolatedWorkerOwner) => {
      isolatedWorkers.add(child);
      isolatedWorkerOwners.set(child, owner);
    },
    unregisterIsolatedWorker: (child: ChildProcess) => {
      isolatedWorkers.delete(child);
      isolatedWorkerOwners.delete(child);
    },
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
  if (monetizationProfile) {
    log("startup: monetization profile active; shell/code mutation capabilities are force-disabled.");
  }
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
    circuitBreaker,
    getTools: () => registry.list(),
    toolContext,
    db,
    stateDir: paths.stateDir,
    agentTracker,
    onRunnerLog: params.verbose ? log : undefined,
    defaultPreset: "orchestrator",
    nudges: config.nudges,
    skillsConfig: config.skills,
    limits: {
      maxMessages: 20,
      anchorRolloverMessages: 40,
      maxToolCalls: config.limits.maxToolCallsPerRun,
      maxIterations: config.limits.maxIterationsPerRun,
      maxConcurrent: config.limits.maxConcurrentAgents,
      maxConcurrentInteractive: config.limits.maxConcurrentAgents,
      maxConcurrentBackground: Math.max(1, config.scheduler.concurrency),
      maxContextTokens,
    },
    transientRetries: config.llm.transientRetries,
  });

  let proactive: ReturnType<typeof startProactiveHeartbeat> | null = null;
  const getProactiveStatus = () => proactive?.getStatus() ?? { enabled: false, lastTickAt: null, nextTickAt: null };
  let runReportBroker: RunReportBroker | null = null;
  let federationOutboxWorker: FederationOutboxWorker | null = null;
  let webhookDeliveryWorker: WebhookDeliveryWorker | null = null;
  let federationGlobalDisabled = false;
  const federationSessionHeartbeatTtlMs = Math.max(
    60_000,
    envInt("NEXUS_FEDERATION_SESSION_HEARTBEAT_TTL_MS") ?? 10 * 60_000,
  );
  const recordTransportRouteObservation = (entry: {
    peerId: string;
    adapter: "federation_http" | "node_ws";
    endpoint: string;
    healthy: boolean;
    error?: string | null;
    nowMs: number;
  }): void => {
    const existing = getPreferredTransportRouteForPeer(db, {
      peerId: entry.peerId,
      adapter: entry.adapter,
    });
    const endpointHash = crypto.createHash("sha256").update(entry.endpoint).digest("hex").slice(0, 16);
    upsertTransportRoute(db, {
      routeId: existing?.routeId ?? `route:${entry.peerId}:${entry.adapter}:${endpointHash}`,
      peerId: entry.peerId,
      adapter: entry.adapter,
      endpoint: entry.endpoint,
      healthy: entry.healthy,
      lastCheckedAt: entry.nowMs,
      lastError: entry.error ?? null,
      metadata: {
        source: "dispatcher_observation",
      },
      nowMs: entry.nowMs,
    });
  };
  const recordFederationSessionObservation = (entry: {
    peerId: string;
    kid: string;
    transportKind: "federation_http";
    direction: "egress";
    envelopeId: string;
    traceId: string | null;
    nowMs: number;
  }): void => {
    const kid = entry.kid.trim();
    if (!kid) return;
    upsertFederationSession(db, {
      id: `session:egress:${entry.peerId}:${kid}`,
      peerId: entry.peerId,
      status: "active",
      establishedAt: entry.nowMs,
      expiresAt: entry.nowMs + federationSessionHeartbeatTtlMs,
      lastHeartbeatAt: entry.nowMs,
      metadata: {
        source: "egress_heartbeat",
        transportKind: entry.transportKind,
        direction: entry.direction,
        envelopeId: entry.envelopeId,
        traceId: entry.traceId,
      },
    });
  };
  const federationDispatcher = (() => {
    if (!config.federation.enabled || !config.federation.outbox.enabled) return null;
    if (!federationSigningIdentity) {
      log("federation/outbox: no local federation signing identity available; worker disabled");
      return null;
    }
    if (config.federation.transport.adapter !== "federation_http") {
      log(`federation/outbox: unsupported adapter=${config.federation.transport.adapter}; worker disabled`);
      return null;
    }
    const federationHttpDispatcher = createFederationHttpDispatcher({
      localInstanceId: config.federation.localInstanceId,
      getSigningMaterial: async () => {
        const signingIdentity = await refreshFederationSigningIdentity();
        if (!signingIdentity) return null;
        return {
          privateKey: signingIdentity.privateKey,
          keyId: signingIdentity.kid,
          publicKeyRaw: signingIdentity.publicKeyRaw,
        };
      },
      getPeerById: (peerId) => getFederationPeerById(db, peerId),
      getRouteForPeer: (peerId, adapter) =>
        getPreferredTransportRouteForPeer(db, {
          peerId,
          adapter,
          requireHealthy: true,
        }),
      requireMtls: config.federation.transport.requireMtls,
      allowInsecureSignedOnlyDev: config.federation.transport.allowInsecureSignedOnlyDev,
      requestTimeoutMs: config.federation.outbox.requestTimeoutMs,
      observeRouteHealth: async (entry) => {
        recordTransportRouteObservation(entry);
      },
      observeSessionHeartbeat: async (entry) => {
        recordFederationSessionObservation(entry);
      },
      audit: async (entry) => {
        appendFederationAudit(db, {
          id: randomId("FDA"),
          peerId: entry.peerId,
          eventType: entry.eventType,
          decision: entry.decision,
          actor: entry.actor,
          traceId: entry.traceId,
          details: entry.details,
          nowMs: Date.now(),
        });
      },
      log,
    });
    const nodeWsDispatcher = createNodeWsDispatcher({
      nodeGateway: nodeWsGateway,
      getRouteForPeer: (peerId, adapter) =>
        getPreferredTransportRouteForPeer(db, {
          peerId,
          adapter,
          requireHealthy: true,
        }),
      observeRouteHealth: async (entry) => {
        recordTransportRouteObservation(entry);
      },
      log,
    });
    return createFederationTransportRouter({
      adapterDispatchers: {
        federation_http: federationHttpDispatcher,
        node_ws: nodeWsDispatcher,
      },
      log,
    });
  })();

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

  let stopAllSuppressedUntilMs = 0;
  const getTickSuppression = (): { suppressed: boolean; reason?: string; retryAfterMs?: number } => {
    const remainingMs = stopAllSuppressedUntilMs - Date.now();
    if (remainingMs <= 0) {
      return { suppressed: false };
    }
    return {
      suppressed: true,
      reason: "stopall_cooldown",
      retryAfterMs: remainingMs,
    };
  };

  const terminateIsolatedWorkers = (sessionId: string | null): number => {
    let terminated = 0;
    for (const child of [...isolatedWorkers]) {
      const owner = isolatedWorkerOwners.get(child);
      if (sessionId && owner?.sessionId !== sessionId) continue;
      isolatedWorkers.delete(child);
      isolatedWorkerOwners.delete(child);
      try {
        child.kill("SIGTERM");
        terminated += 1;
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 1_500).unref?.();
    }
    return terminated;
  };

  type RunningProcessRow = {
    id: string;
    backend: string;
    node_id: string | null;
    node_execution_id: string | null;
  };

  const listRunningProcessRows = (sessionId: string | null): RunningProcessRow[] => {
    if (sessionId) {
      return db.db
        .prepare(
          `SELECT id, backend, node_id, node_execution_id
           FROM process_runs
           WHERE status = 'running' AND request_session_id = ?`,
        )
        .all(sessionId) as RunningProcessRow[];
    }
    return db.db
      .prepare(
        `SELECT id, backend, node_id, node_execution_id
         FROM process_runs
         WHERE status = 'running'`,
      )
      .all() as RunningProcessRow[];
  };

  const stopManagedProcesses = async (
    sessionId: string | null,
    reason: string,
  ): Promise<{ local: number; remote: number; errors: string[] }> => {
    const errors: string[] = [];
    let local = 0;
    let remote = 0;
    const rows = listRunningProcessRows(sessionId);
    const localIds = new Set<string>();
    const remoteTargets = new Map<string, { nodeId: string; processId: string }>();
    for (const row of rows) {
      if (row.node_id && row.node_execution_id) {
        const key = `${row.node_id}::${row.node_execution_id}`;
        if (!remoteTargets.has(key)) {
          remoteTargets.set(key, {
            nodeId: row.node_id,
            processId: row.node_execution_id,
          });
        }
        continue;
      }
      if (row.backend === "local_child") {
        localIds.add(row.id);
      }
    }

    for (const processId of localIds) {
      try {
        await processManager.stop({
          id: processId,
          signal: "SIGTERM",
          killAfterMs: 2_000,
        });
        local += 1;
      } catch (err) {
        errors.push(`local process ${processId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const target of remoteTargets.values()) {
      try {
        const result = await nodeWsGateway.requestTransportOperation({
          nodeId: target.nodeId,
          method: "process.cancel",
          params: {
            processId: target.processId,
            signal: "SIGTERM",
            killAfterMs: 2_000,
            reason,
          },
          timeoutMs: 20_000,
        });
        if (!result.ok) {
          const message = result.error?.message ?? "unknown error";
          errors.push(`remote process ${target.nodeId}/${target.processId}: ${message}`);
          continue;
        }
        remote += 1;
      } catch (err) {
        errors.push(
          `remote process ${target.nodeId}/${target.processId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { local, remote, errors };
  };

  const listOnlineNexusNodeIds = (): string[] => {
    const rows = db.db
      .prepare("SELECT id FROM nodes WHERE backend = 'nexus' AND status = 'online' ORDER BY id ASC")
      .all() as { id: string }[];
    return rows.map((row) => row.id);
  };

  const runShellCtlOnNode = async (nodeId: string, command: string): Promise<string> => {
    const response = await nodeWsGateway.requestTransportOperation({
      nodeId,
      method: "tool.execute",
      params: {
        tool: "system.run",
        args: {
          command,
          timeoutMs: 30_000,
        },
      },
      timeoutMs: 40_000,
    });
    if (!response.ok) {
      throw new Error(response.error?.message ?? "tool.execute failed");
    }
    const payload = response.payload;
    if (typeof payload === "string") {
      return payload;
    }
    if (payload && typeof payload === "object") {
      const output = (payload as Record<string, unknown>).output;
      if (typeof output === "string") return output;
    }
    return typeof payload === "undefined" ? "" : JSON.stringify(payload);
  };

  const stopRemoteInteractiveSessions = async (
    sessionId: string | null,
  ): Promise<{ closed: number; errors: string[] }> => {
    let closed = 0;
    const errors: string[] = [];
    const nodeIds = listOnlineNexusNodeIds();
    for (const nodeId of nodeIds) {
      let listOutput = "";
      try {
        listOutput = await runShellCtlOnNode(nodeId, "nexus-shellctl list");
      } catch (err) {
        errors.push(`remote shell list ${nodeId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      let parsedList: Record<string, unknown> | null = null;
      try {
        parsedList = JSON.parse(listOutput) as Record<string, unknown>;
      } catch {
        if (listOutput.trim() && !listOutput.trimStart().startsWith("ERROR:")) {
          errors.push(`remote shell list ${nodeId}: non-JSON response`);
        }
        continue;
      }
      const sessions = Array.isArray(parsedList.sessions) ? parsedList.sessions : [];
      for (const row of sessions) {
        if (!row || typeof row !== "object") continue;
        const sessionName = String((row as Record<string, unknown>).session ?? "").trim();
        if (!sessionName) continue;
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(sessionName)) {
          errors.push(`remote shell close ${nodeId}: invalid session id "${sessionName}"`);
          continue;
        }
        if (sessionId) {
          const ownerSessionId = String((row as Record<string, unknown>).ownerSessionId ?? "").trim();
          if (!ownerSessionId || ownerSessionId !== sessionId) continue;
        }
        try {
          await runShellCtlOnNode(nodeId, `nexus-shellctl close --session ${sessionName}`);
          closed += 1;
        } catch (err) {
          errors.push(
            `remote shell close ${nodeId}/${sessionName}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    return { closed, errors };
  };

  const executeStop = async (params: {
    scope: "session" | "all";
    sessionId: string | null;
    reason: string;
    cooldownMs?: number;
  }): Promise<StopExecutionSummary> => {
    const sessionId = params.scope === "session" ? params.sessionId : null;
    const cancelledRuns = params.scope === "session" && sessionId
      ? agent.cancelSessionRuns(sessionId, params.reason)
      : agent.cancelAllRuns(params.reason);
    const terminatedWorkers = terminateIsolatedWorkers(sessionId);

    let localInteractiveClosed = 0;
    let localInteractiveFailed = 0;
    const errors: string[] = [];
    try {
      const localInteractive = await stopLocalInteractiveSessions({
        stateDir: paths.stateDir,
        ownerSessionId: sessionId ?? null,
      });
      localInteractiveClosed = localInteractive.closed;
      localInteractiveFailed = localInteractive.failed;
      errors.push(...localInteractive.errors.map((entry) => `local shell ${entry}`));
    } catch (err) {
      errors.push(`local shell cleanup: ${err instanceof Error ? err.message : String(err)}`);
    }

    const remoteInteractive = await stopRemoteInteractiveSessions(sessionId);
    errors.push(...remoteInteractive.errors);

    const processStops = await stopManagedProcesses(sessionId, params.reason);
    errors.push(...processStops.errors);

    if (params.scope === "all" && params.cooldownMs && params.cooldownMs > 0) {
      stopAllSuppressedUntilMs = Math.max(stopAllSuppressedUntilMs, Date.now() + params.cooldownMs);
      log(
        `stopall: scheduler/proactive suppressed for ${formatDurationMs(params.cooldownMs)} until ${new Date(stopAllSuppressedUntilMs).toISOString()}`,
      );
    }

    return {
      cancelledRuns,
      terminatedWorkers,
      localInteractiveClosed,
      localInteractiveFailed,
      remoteInteractiveClosed: remoteInteractive.closed,
      localProcessesStopped: processStops.local,
      remoteProcessesCancelled: processStops.remote,
      errors,
    };
  };

  const summarizeStop = (params: {
    scope: "session" | "all";
    sessionId: string | null;
    cooldownMs?: number;
    result: StopExecutionSummary;
  }): string => {
    const lines: string[] = [];
    if (params.scope === "all") {
      const cooldownText = params.cooldownMs ? formatDurationMs(params.cooldownMs) : formatDurationMs(defaultStopAllCooldownMs);
      lines.push(`STOP ALL executed. Cooldown: ${cooldownText}.`);
    } else {
      lines.push(`STOP executed for session ${params.sessionId ?? "unknown"}.`);
    }
    lines.push(
      [
        `runs=${params.result.cancelledRuns}`,
        `workers=${params.result.terminatedWorkers}`,
        `local_shell=${params.result.localInteractiveClosed}`,
        `remote_shell=${params.result.remoteInteractiveClosed}`,
        `local_process=${params.result.localProcessesStopped}`,
        `remote_process=${params.result.remoteProcessesCancelled}`,
      ].join(" "),
    );
    if (params.result.localInteractiveFailed > 0) {
      lines.push(`local_shell_failures=${params.result.localInteractiveFailed}`);
    }
    if (params.result.errors.length > 0) {
      lines.push(`errors=${params.result.errors.length}`);
      lines.push(...params.result.errors.slice(0, 5).map((entry) => `- ${entry}`));
    }
    return lines.join("\n");
  };

  const handleControlCommand = async (params: {
    channel: string;
    channelKey: string;
    agentId: string;
    sessionId: string;
    text: string;
    actorLabel?: string;
  }): Promise<string | null> => {
    const persistControlTurn = (assistantText: string): string => {
      const nowMs = Date.now();
      try {
        appendMessage({
          db,
          sessionId: params.sessionId,
          message: {
            role: "user",
            content: params.text,
          },
          nowMs,
        });
        appendMessage({
          db,
          sessionId: params.sessionId,
          message: {
            role: "assistant",
            content: assistantText,
          },
          nowMs: nowMs + 1,
        });
      } catch (err) {
        log(
          `stop_control: failed to persist control turn session=${params.sessionId} error=${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return assistantText;
    };

    const parsed = parseControlCommandText(params.text);
    if (!parsed) return null;
    const actor = params.actorLabel ?? `${params.channel}:${params.channelKey}`;
    if (parsed.kind === "help") {
      const helpChannel = params.channel === "telegram" ? "telegram" : "generic";
      return persistControlTurn(renderHelpText(helpChannel));
    }
    if (parsed.kind === "info") {
      const infoText = await executeInfoCommand({
        command: parsed.info,
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
      return persistControlTurn(infoText);
    }
    if (parsed.kind === "home") {
      if (parsed.home.kind === "sethome") {
        setHomeSession({
          db,
          agentId: params.agentId,
          channel: params.channel,
          channelKey: params.channelKey,
          nowMs: Date.now(),
        });
        return persistControlTurn("OK: this session is now the home session for background events.");
      }
      clearHomeSession({
        db,
        agentId: params.agentId,
      });
      return persistControlTurn("OK: home session cleared. Background events will use the latest eligible session.");
    }

    const stopParsed = parsed.stop;
    if (stopParsed.kind === "stop") {
      const result = await executeStop({
        scope: "session",
        sessionId: params.sessionId,
        reason: `stop:${actor}`,
      });
      return persistControlTurn(summarizeStop({
        scope: "session",
        sessionId: params.sessionId,
        result,
      }));
    }

    if (stopParsed.rawCooldown && stopParsed.cooldownMs === undefined) {
      return persistControlTurn(
        `ERROR: invalid cooldown "${stopParsed.rawCooldown}". Use values like 30s, 5m, 1h, or 1d.`,
      );
    }
    const cooldownMs = stopParsed.cooldownMs ?? defaultStopAllCooldownMs;
    const result = await executeStop({
      scope: "all",
      sessionId: null,
      reason: `stopall:${actor}`,
      cooldownMs,
    });
    return persistControlTurn(summarizeStop({
      scope: "all",
      sessionId: null,
      cooldownMs,
      result,
    }));
  };

  const http = await startHttpServer({
    port: effectivePort,
    stateDir: paths.stateDir,
    federationLocalInstanceId: config.federation.localInstanceId,
    federationWebhooksFederatedOnly: config.federation.webhooks.federatedOnly,
    federationWebhooksExternalEnabled: config.federation.webhooks.externalEnabled,
    federationAllowInsecureTransportDev: config.federation.transport.allowInsecureSignedOnlyDev,
    federationAllowInsecureWebhookHttpDev: config.federation.webhooks.allowInsecureHttpDev,
    runtimeProfile: config.runtime.profile,
    isStandby: () => isStandby,
    getActivatedAt: () => activatedAt,
    getFederationBreakglassState: () => ({
      globalDisable: federationGlobalDisabled,
    }),
    setFederationGlobalDisable: (disabled: boolean) => {
      federationGlobalDisabled = disabled;
      log(`federation/breakglass: global_disable=${disabled ? "1" : "0"}`);
      return {
        globalDisable: federationGlobalDisabled,
      };
    },
    getStatus: async () => {
      const nowMs = Date.now();
      const secretsStrictMode = true;
      const secretProviders = listSecretProviderProfiles(db, {
        includeDisabled: true,
        limit: 500,
      });
      const secretProviderEnabled = secretProviders.filter((profile) => profile.enabled);
      const secretProviderKinds = [...new Set(secretProviders.map((profile) => profile.kind))];
      const sidecarUnixProfiles = secretProviderEnabled.filter(
        (profile) => profile.kind === "sidecar_http" && typeof profile.endpointRef === "string" && profile.endpointRef.startsWith("unix://"),
      ).length;
      const sidecarTcpProfiles = secretProviderEnabled.filter(
        (profile) => profile.kind === "sidecar_http" && typeof profile.endpointRef === "string" && !profile.endpointRef.startsWith("unix://"),
      ).length;
      const federationFirewall = deriveFederationFirewallRuntimeState({
        enabled: config.federation.enabled,
        transportAdapter: config.federation.transport.adapter,
        outboxEnabled: config.federation.outbox.enabled,
        dispatcherReady: federationDispatcher !== null,
        requireMtls: config.federation.transport.requireMtls,
        allowInsecureSignedOnlyDev: config.federation.transport.allowInsecureSignedOnlyDev,
        webhooksFederatedOnly: config.federation.webhooks.federatedOnly,
        webhooksExternalEnabled: config.federation.webhooks.externalEnabled,
      });
      const federation = getFederationStatusSnapshot({
        db,
        enabled: config.federation.enabled,
        firewallActive: federationFirewall.active,
        nowMs,
      });
      return {
        ok: true,
        name: "nexus",
        port: effectivePort,
        stateDir: paths.stateDir,
        workspaceDir: paths.workspaceDir,
        codeDir: paths.codeDir,
        dbPath: paths.dbPath,
        runtime: {
          profile: config.runtime.profile,
        },
        federation: {
          localInstanceId: config.federation.localInstanceId,
          signingKid: federationSigningIdentity?.kid ?? null,
          transportAdapter: config.federation.transport.adapter,
          webhookMode: config.federation.webhooks.externalEnabled ? "external_enabled" : "federated_only",
          firewallSignalSource: federationFirewall.signalSource,
          firewallReasons: federationFirewall.reasons,
          firewallIngressReady: federationFirewall.ingressReady,
          firewallEgressReady: federationFirewall.egressReady,
          webhookDelivery: {
            running: webhookDeliveryWorker !== null,
            mode: config.federation.webhooks.externalEnabled ? "external_enabled" : "federated_only",
          },
          breakglass: {
            globalDisable: federationGlobalDisabled,
          },
          outbox: {
            configured: config.federation.outbox.enabled,
            dispatcherReady: federationDispatcher !== null,
            running: federationOutboxWorker !== null,
            adapters: federationDispatcher?.adapters ?? [],
            contract: federationDispatcher?.contract ?? {},
            intervalMs: config.federation.outbox.intervalMs,
            maxBatch: config.federation.outbox.maxBatch,
            requestTimeoutMs: config.federation.outbox.requestTimeoutMs,
          },
          ...federation,
        },
        telegram: {
          enabled: config.channels.telegram.enabled,
          mode: config.channels.telegram.mode,
          pairingEnabled: config.channels.telegram.pairing.enabled,
        },
        llm: {
          modelMode: circuitBreaker.getEffectiveMode(),
          localProvider: config.llm.routing.localProvider,
          localModel: llmProviderConfigs[config.llm.routing.localProvider]?.model ?? null,
        },
        secrets: {
          strictMode: secretsStrictMode,
          providerProfiles: {
            total: secretProviders.length,
            enabled: secretProviderEnabled.length,
            kinds: secretProviderKinds,
            sidecarUnixEnabled: sidecarUnixProfiles,
            sidecarTcpEnabled: sidecarTcpProfiles,
          },
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
        runReports: {
          enabled: runReportBroker !== null,
        },
        proactive: getProactiveStatus(),
        stopControl: {
          stopAllCooldownUntil: stopAllSuppressedUntilMs > Date.now() ? stopAllSuppressedUntilMs : null,
          stopAllCooldownRemainingMs: Math.max(0, stopAllSuppressedUntilMs - Date.now()),
          defaultStopAllCooldownMs,
        },
        mode: getMode(),
        activeLease: {
          key: leaseKey,
          holderId: leaseHolderId,
          held: leaseHeld,
          expiresAt: leaseExpiresAt,
          ttlMs: leaseTtlMs,
          renewMs: leaseRenewMs,
        },
      };
    },
    log,
    db,
    processManager,
    agentTracker,
    nodeGateway: nodeWsGateway,
    mcp,
    dispatchCliMessage: async (params) => {
      const nowMs = Date.now();
      const sessionId = getOrCreateSessionId({
        db,
        channel: params.channel,
        channelKey: params.channelKey,
        agentId: params.agentId,
        nowMs,
      });
      const intercepted = await handleControlCommand({
        channel: params.channel,
        channelKey: params.channelKey,
        agentId: params.agentId,
        sessionId,
        text: params.text,
        actorLabel: `cli:${params.channelKey}`,
      });
      if (intercepted !== null) {
        return {
          runId: null,
          sessionId,
          output: intercepted,
          status: "complete" as const,
          toolCallsUsed: 0,
          iterationsUsed: 0,
        };
      }
      return await agent.handleUserMessage({
        channel: params.channel,
        channelKey: params.channelKey,
        agentId: params.agentId,
        text: params.text,
      });
    },
    getModelMode: () => circuitBreaker.getEffectiveMode(),
    setModelMode: (mode) => {
      if (mode === "default" || mode === "local_only") {
        circuitBreaker.setManualMode(mode);
      } else {
        circuitBreaker.setManualMode(null);
      }
      return circuitBreaker.getEffectiveMode();
    },
    getCircuitBreakerStats: () => circuitBreaker.getStats(),
  });

  registerNodeRoutes(http.app, { isStandby: () => isStandby });

  // Track services (tg and scheduler may be started later if in standby mode)
  let tg: Awaited<ReturnType<typeof startTelegramBot>> = null;
  let scheduler: ReturnType<typeof startJobScheduler> = null;
  let processNotifier: ReturnType<typeof startProcessNotifier> = null;

  const startServices = async () => {
    tg = await startTelegramBot({
      config,
      agent,
      configPath: params.configPath,
      log,
      db,
      app: http.app,
      onPreDispatchCommand: async (command) =>
        await handleControlCommand({
          channel: command.channel,
          channelKey: command.channelKey,
          agentId: command.agentId,
          sessionId: command.sessionId,
          text: command.text,
          actorLabel: `telegram:${command.actorId}`,
        }),
    });
    if (!tg) log("telegram: disabled");
    if (tg) {
      toolContext.telegram = {
        sendOutput: tg.sendOutput,
        sendFile: tg.sendFile,
        allowFrom: config.channels.telegram.allowFrom ?? [],
        allowAll: process.env.NEXUS_TELEGRAM_ALLOW_ALL === "1",
      };
    }

    runReportBroker?.stop();
    runReportBroker = startRunReportBroker({
      db,
      agent,
      log,
    });
    void runReportBroker?.tick().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log(`run_report_broker: initial tick failed: ${message}`);
    });

    // Process lifecycle callbacks (best-effort). Requires db + agent + telegram.
    processNotifier = startProcessNotifier({
      db,
      agent,
      processManager,
      telegram: toolContext.telegram as any,
      log,
    });

    // On-boot: immediately reconcile stale process_runs from previous instance
    // instead of waiting for the first notifier tick (15s).
    processManager.reconcileDetachedRunning({ limit: 80 }).then((r) => {
      if (r.updated > 0) log(`process: reconciled ${r.updated} stale process_run(s) from previous instance`);
    }).catch(() => {});

    proactive = startProactiveHeartbeat({
      config,
      stateDir: paths.stateDir,
      agent,
      db,
      telegram: tg,
      getTickSuppression,
      log,
    });
    if (!proactive) log("proactive: disabled");

    scheduler = startJobScheduler({
      config,
      agent,
      db,
      log,
      getTickSuppression,
      getTools: () => registry.list(),
      toolContext,
      workspaceDir: paths.workspaceDir,
    });
    if (!scheduler) log("scheduler: disabled");

    if (config.federation.enabled && config.federation.outbox.enabled) {
      if (!federationDispatcher) {
        log("federation/outbox: configured but dispatcher unavailable");
      } else {
        federationOutboxWorker?.stop();
        federationOutboxWorker = startFederationOutboxWorker({
          db,
          dispatch: async (item) => {
            if (federationGlobalDisabled) {
              return {
                ok: false,
                retryAt: Date.now() + 10_000,
                error: "federation_globally_disabled",
              };
            }
            return federationDispatcher.dispatch(item);
          },
          log,
          intervalMs: config.federation.outbox.intervalMs,
          maxBatch: config.federation.outbox.maxBatch,
        });
        void federationOutboxWorker.tick().catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          log(`federation/outbox: initial tick failed: ${message}`);
        });
        log(
          "federation/outbox: started " +
          `intervalMs=${config.federation.outbox.intervalMs} ` +
          `maxBatch=${config.federation.outbox.maxBatch} ` +
          `requestTimeoutMs=${config.federation.outbox.requestTimeoutMs}`,
        );
      }
    } else if (config.federation.enabled) {
      log("federation/outbox: disabled by config");
    }

    if (config.federation.enabled) {
      webhookDeliveryWorker?.stop();
      webhookDeliveryWorker = startWebhookDeliveryWorker({
        db,
        stateDir: paths.stateDir,
        localInstanceId: config.federation.localInstanceId,
        getSigningMaterial: async () => {
          const signingIdentity = await refreshFederationSigningIdentity();
          if (!signingIdentity) return null;
          return {
            privateKey: signingIdentity.privateKey,
            keyId: signingIdentity.kid,
          };
        },
        webhooksFederatedOnly: config.federation.webhooks.federatedOnly,
        webhooksExternalEnabled: config.federation.webhooks.externalEnabled,
        isFederationEgressDisabled: () => federationGlobalDisabled,
        allowInsecureHttp: config.federation.webhooks.allowInsecureHttpDev,
        intervalMs: config.federation.outbox.intervalMs,
        maxBatch: config.federation.outbox.maxBatch,
        requestTimeoutMs: config.federation.outbox.requestTimeoutMs,
        connectTimeoutMs: 3_000,
        readTimeoutMs: 8_000,
        maxResponseBytes: 32_768,
        log,
      });
      void webhookDeliveryWorker.tick().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log(`webhook/worker: initial tick failed: ${message}`);
      });
    }
  };

  const deactivateServices = async (reason?: string) => {
    if (reason) log(`standby: ${reason}`);
    if (leaseTimer) {
      clearInterval(leaseTimer);
      leaseTimer = null;
    }
    releaseActiveLease();
    isStandby = true;
    activatedAt = null;
    nodeWsGateway.closeNodeConnections("gateway entering standby");
    federationOutboxWorker?.stop();
    federationOutboxWorker = null;
    webhookDeliveryWorker?.stop();
    webhookDeliveryWorker = null;
    runReportBroker?.stop();
    runReportBroker = null;
    processNotifier?.stop();
    processNotifier = null;
    scheduler?.stop();
    scheduler = null;
    proactive?.stop();
    proactive = null;
    try {
      await browser.stop();
    } catch (err) {
      log(`browser: stop failed during standby transition: ${err instanceof Error ? err.message : String(err)}`);
    }
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
      activatedAt = Date.now();
      log("standby: services activated");
      return { ok: true };
    } catch (err) {
      await deactivateServices("activation failed");
      throw err;
    }
  };
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const restartPeerUrl = normalizeHttpBaseUrl(process.env.NEXUS_HA_PEER_URL ?? "");
  const peerControlPlaneApiKey =
    (
      process.env.NEXUS_HA_API_KEY ??
      process.env.NEXUS_HTTP_API_KEY ??
      ""
    ).trim() || null;
  let restartInProgress = false;

  const fetchText = async (url: string, init: RequestInit, timeoutMs: number): Promise<{ ok: boolean; status: number; text: string }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers(init.headers ?? {});
      if (peerControlPlaneApiKey && !headers.has("authorization")) {
        headers.set("authorization", `Bearer ${peerControlPlaneApiKey}`);
      }
      const res = await fetch(url, { ...init, headers, signal: controller.signal });
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

  const waitPeerTrafficHealthy = async (peerUrl: string, timeoutMs: number, retryMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    while (Date.now() < deadline) {
      attempts += 1;
      const res = await fetchText(`${peerUrl}/health/traffic`, { method: "GET" }, Math.min(8000, retryMs * 4));
      if (res.ok) {
        log(`restart: peer traffic-healthy attempt=${attempts}`);
        return true;
      }
      if (attempts === 1 || attempts % 5 === 0) {
        log(`restart: peer not traffic-healthy attempt=${attempts} status=${res.status}`);
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
        const trafficTimeoutMs = Math.max(
          5_000,
          envInt("NEXUS_HA_RESTART_TRAFFIC_TIMEOUT_MS") ?? envInt("NEXUS_HA_RESTART_READY_TIMEOUT_MS") ?? 45_000,
        );
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
        // ask the peer to activate, (3) verify it is traffic-healthy.
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
          log("restart: peer activated but not reporting active mode; waiting for traffic health");
        }

        const trafficHealthy = await waitPeerTrafficHealthy(restartPeerUrl, trafficTimeoutMs, retryMs);
        if (!trafficHealthy) {
          log("restart: handoff failed (peer traffic health timeout); attempting to re-activate locally");
          const reclaimed = await activateServices();
          if (reclaimed.ok) {
            log("restart: re-activated locally after peer traffic health timeout");
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

  http.app.post("/api/stopall", async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const parsed = await c.req.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // empty or non-JSON body; use defaults
    }

    let cooldownMs = defaultStopAllCooldownMs;
    const cooldownMsRaw = body.cooldownMs;
    const cooldownRaw = typeof body.cooldown === "string" ? body.cooldown.trim() : "";
    if (typeof cooldownMsRaw === "number" && Number.isFinite(cooldownMsRaw) && cooldownMsRaw > 0) {
      cooldownMs = Math.max(1_000, Math.floor(cooldownMsRaw));
    } else if (cooldownRaw) {
      const parsed = parseDurationToMs(cooldownRaw);
      if (parsed === null) {
        return c.json(
          {
            ok: false,
            error: `invalid cooldown value: ${cooldownRaw}`,
            hint: "Use values like 30s, 5m, 1h, or 1d.",
          },
          400,
        );
      }
      cooldownMs = parsed;
    }

    const result = await executeStop({
      scope: "all",
      sessionId: null,
      reason: "api:/api/stopall",
      cooldownMs,
    });
    return c.json({
      ok: true,
      cooldownMs,
      cooldown: formatDurationMs(cooldownMs),
      cooldownUntil: stopAllSuppressedUntilMs,
      result,
      summary: summarizeStop({
        scope: "all",
        sessionId: null,
        cooldownMs,
        result,
      }),
      timestamp: Date.now(),
    });
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
    isolatedWorkerOwners.clear();

    await deactivateServices("shutdown");
    circuitBreaker.dispose();
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
