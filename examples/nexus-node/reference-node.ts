#!/usr/bin/env tsx
import { exec, spawn as spawnChild, type ChildProcess } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { TLSSocket } from "node:tls";

import { WebSocket } from "ws";

import {
  ReferenceNodeStateStore,
  type PersistedFirewallSessionRecord,
  type PersistedOutboxEntry,
  type PersistedProcessRecord,
  type PersistedReferenceRecord,
} from "./state-store.js";

const ED25519_SPKI_RAW_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_OUTPUT_CHARS = 60_000;
const MAX_PROCESS_LOG_CHARS = 120_000;
const DELIVERED_OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FIREWALL_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CAPABILITIES = [
  "system.run",
  "system.which",
  "process.start",
  "process.status",
  "process.logs",
  "process.cancel",
  "policy.update",
  "symbols.list",
  "audit.query",
];
const DEFAULT_ALLOW_COMMANDS = ["echo", "uname", "whoami", "pwd", "date"];
const DEFAULT_POLICY_DOC = {
  version: 1,
  defaultQuarantine: "none",
  firewallMode: "transparent",
  denyCommands: [],
} as const;
const SYMBOL_TOKEN_PATTERN = /\{\{([a-z]+):([a-zA-Z0-9._-]+)(?::([a-zA-Z0-9._-]+))?\}\}/g;

type ProcessStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
type SymbolKind = "contact" | "account" | "secret" | "user";
type FirewallMode = "transparent" | "audit-only" | "hermes";
const SYMBOL_KINDS: SymbolKind[] = ["contact", "account", "secret", "user"];

type SymbolCatalogEntry = {
  key: string;
  fields: string[];
};

type SymbolCatalog = Record<SymbolKind, SymbolCatalogEntry[]>;

type ResolvedSystemRunInvocation = {
  command: string;
  cwd: string | null;
  env: Record<string, string>;
  symbols: string[];
};
type SymbolStoreCache = Partial<Record<SymbolKind, unknown>>;
type HermesReferenceSummary = {
  refId: string;
  sourceType: string;
  title: string | null;
  safeSummary: string;
  metadata: Record<string, unknown> | null;
};

type ReferenceProcess = {
  processId: string;
  command: string;
  cwd: string | null;
  status: ProcessStatus;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  signal: string | null;
  cancelRequested: boolean;
  timeoutMs: number | null;
  logs: string;
  child: ChildProcess | null;
  timeoutTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  firewallMode: FirewallMode;
  hermesReferences: HermesReferenceSummary[];
  routing: Record<string, unknown> | null;
};

type ResolvedFirewallSession = {
  sessionId: string;
  quarantineState: "none" | "soft" | "hard";
  reused: boolean;
};

type RequestEnvelope = {
  type: "req";
  id: string;
  ts: number;
  sender: string;
  sig: string;
  method: string;
  params?: unknown;
};

type ResponseEnvelope = {
  type: "res";
  id: string | null;
  ts: number;
  sender: string;
  sig: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
};

type EventEnvelope = {
  type: "event";
  ts: number;
  sender: string;
  sig: string;
  event: string;
  payload?: unknown;
};

type AnyEnvelope = RequestEnvelope | ResponseEnvelope | EventEnvelope;

type NodeIdentity = {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyRaw: string;
  fingerprint: string;
  privateKeyPath: string;
  publicKeyPath: string;
};

type ParsedPublicKey = {
  key: KeyObject;
  raw: string;
  fingerprint: string;
};

type Config = {
  gatewayUrl: string;
  gatewayTlsFingerprint: string | null;
  stateDir: string;
  policyRequired: boolean;
  nodeId: string;
  displayName: string;
  capabilities: string[];
  allowCommands: Set<string>;
  runTimeoutMs: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  maxClockSkewMs: number;
  insecureAllowNonLoopbackWs: boolean;
  insecureSkipGatewayProof: boolean;
};

class NodeToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "NodeToolError";
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const config = buildConfig(args.values);
  const identity = await loadOrCreateIdentity(config.stateDir);
  const stateStore = await ReferenceNodeStateStore.open(config.stateDir);
  const client = new ReferenceNodeClient(config, identity, stateStore);

  process.stdout.write(
    `[reference-node] id=${config.nodeId} fingerprint=${identity.fingerprint} gateway=${config.gatewayUrl}\n`,
  );
  process.stdout.write(
    `[reference-node] capabilities=${config.capabilities.join(",")} allow_commands=${[
      ...config.allowCommands,
    ].join(",")}\n`,
  );
  process.stdout.write(`[reference-node] state_db=${stateStore.dbPath}\n`);

  const shutdown = (): void => {
    client.stop("shutdown");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await client.start();
}

class ReferenceNodeClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private readonly processes = new Map<string, ReferenceProcess>();
  private drainingOutbox = false;

  private gatewayPublicKey: KeyObject | null = null;
  private gatewayFingerprint: string | null = null;
  private nodeNonce: string | null = null;
  private gatewayNonce: string | null = null;
  private sessionId: string | null = null;
  private ready = false;
  private policy: Record<string, unknown> = { ...DEFAULT_POLICY_DOC };
  private readonly policyPath: string;
  private readonly symbolStoreDir: string;

  constructor(
    private readonly config: Config,
    private readonly identity: NodeIdentity,
    private readonly stateStore: ReferenceNodeStateStore,
  ) {
    this.policyPath = path.join(this.config.stateDir, "hermes-policy.json");
    this.symbolStoreDir = path.join(this.config.stateDir, "hermes-stores");
  }

  async start(): Promise<void> {
    await this.loadPolicyFromDisk();
    this.bootstrapPersistedState();
    this.connect();
  }

  stop(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.close(1000, truncateOutput(reason, 120));
      } catch {
        // ignore
      }
    }
    this.terminateAllProcesses(reason);
    this.stateStore.close();
  }

  private connect(): void {
    if (this.stopped) return;

    const needsTlsPin = Boolean(this.config.gatewayTlsFingerprint);
    let tlsPinVerified = !needsTlsPin;
    const ws = needsTlsPin ? new WebSocket(this.config.gatewayUrl, { rejectUnauthorized: false }) : new WebSocket(this.config.gatewayUrl);
    this.ws = ws;
    this.ready = false;
    this.nodeNonce = null;
    this.gatewayNonce = null;
    this.sessionId = null;

    ws.on("upgrade", (response: IncomingMessage) => {
      if (!this.config.gatewayTlsFingerprint) return;
      const socket = response.socket as TLSSocket;
      const certificate = socket.getPeerCertificate?.(true);
      const actual = normalizeFingerprint256(certificate?.fingerprint256 ?? certificate?.fingerprint ?? "");
      if (!actual || actual !== this.config.gatewayTlsFingerprint) {
        this.log(
          `gateway TLS fingerprint mismatch expected=${this.config.gatewayTlsFingerprint} actual=${actual ?? "unknown"}`,
        );
        this.closeSocket(4001, "gateway tls fingerprint mismatch");
        return;
      }
      tlsPinVerified = true;
    });

    ws.on("open", () => {
      this.reconnectAttempt = 0;
      if (needsTlsPin && !tlsPinVerified) {
        this.log("gateway TLS fingerprint was not validated before websocket open");
        this.closeSocket(4001, "gateway tls fingerprint missing");
        return;
      }
      this.sendConnectHello();
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.log("received binary frame; closing");
        this.closeSocket(4001, "binary frames unsupported");
        return;
      }
      const text = typeof data === "string" ? data : data.toString("utf8");
      this.handleMessage(text).catch((err) => {
        this.log(`message handling error=${err instanceof Error ? err.message : String(err)}`);
        this.closeSocket(4001, "message handling failed");
      });
    });

    ws.on("error", (err) => {
      this.log(`socket error=${err instanceof Error ? err.message : String(err)}`);
    });

    ws.on("close", (code, reasonRaw) => {
      const reason = String(reasonRaw || "");
      this.log(`socket closed code=${code} reason=${reason || "<none>"}`);
      this.ready = false;
      if (this.stopped) return;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectAttempt += 1;
    const base = this.config.reconnectMinMs;
    const delay = Math.min(
      this.config.reconnectMaxMs,
      Math.max(this.config.reconnectMinMs, base * Math.pow(2, Math.min(8, this.reconnectAttempt - 1))),
    );
    this.log(`reconnect attempt=${this.reconnectAttempt} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    // Keep the process alive while waiting to reconnect. When a node is pending
    // approval, the first socket is intentionally closed by the gateway; if this
    // timer is unref'ed, the process can exit before retrying.
  }

  private bootstrapPersistedState(): void {
    this.stateStore.pruneDeliveredOlderThan(Date.now() - DELIVERED_OUTBOX_TTL_MS);
    const prunedFirewallSessions = this.stateStore.pruneExpiredFirewallSessions(Date.now());
    const persisted = this.stateStore.loadProcesses(1_000);
    const nowMs = Date.now();
    for (const record of persisted) {
      const entry: ReferenceProcess = {
        processId: record.processId,
        command: record.command,
        cwd: record.cwd,
        status: record.status,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        exitCode: record.exitCode,
        signal: record.signal,
        cancelRequested: record.cancelRequested,
        timeoutMs: record.timeoutMs,
        logs: record.logs,
        child: null,
        timeoutTimer: null,
        killTimer: null,
        firewallMode: this.readProcessFirewallMode(record.routing),
        hermesReferences: this.readProcessHermesReferences(record.routing),
        routing: record.routing,
      };
      this.processes.set(entry.processId, entry);

      // Processes that were mid-flight when the node exited cannot continue
      // and must transition to a terminal state before replay.
      if (entry.status === "queued" || entry.status === "running") {
        entry.status = "failed";
        entry.cancelRequested = true;
        entry.endedAt = nowMs;
        entry.exitCode = entry.exitCode ?? 1;
        entry.signal = entry.signal ?? "NODE_RESTART";
        entry.logs = truncateOutput(`${entry.logs}\nprocess recovered after node restart before completion\n`, MAX_PROCESS_LOG_CHARS);
        if (entry.firewallMode !== "transparent") {
          const recoveredReference = this.createHermesReference({
            sourceType: "process.output",
            processId: entry.processId,
            toolName: "system.run",
            title: "process recovered after restart",
            safeSummary: this.buildSafeSummary(entry.logs),
            metadata: {
              mode: entry.firewallMode,
              status: entry.status,
              exitCode: entry.exitCode,
              signal: entry.signal,
            },
          });
          entry.hermesReferences = [recoveredReference];
          const routing = asObject(entry.routing ?? {});
          entry.routing = {
            ...routing,
            firewallMode: entry.firewallMode,
            hermesReferences: entry.hermesReferences,
          };
        }
        this.persistProcess(entry);
        this.queueTerminalProcessUpdate(entry, "recovered_after_restart");
      }
    }
    const pendingOutbox = this.stateStore.countUndelivered();
    this.log(
      `restored processes=${persisted.length} outbox_pending=${pendingOutbox} firewall_sessions_pruned=${prunedFirewallSessions}`,
    );
  }

  private async loadPolicyFromDisk(): Promise<void> {
    const nowMs = Date.now();
    try {
      const raw = await fs.readFile(this.policyPath, "utf8");
      const parsed = asObject(JSON.parse(raw));
      this.policy = this.normalizePolicyDocument(parsed, nowMs);
      this.log(
        `loaded hermes policy path=${this.policyPath} default_quarantine=${this.currentPolicyDefaultQuarantine()}`,
      );
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const missing = code === "ENOENT";
      if (!missing && this.config.policyRequired) {
        throw new Error(
          `Failed to load required Hermes policy at ${this.policyPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      if (!missing) {
        this.log(
          `policy load failed path=${this.policyPath} error=${
            err instanceof Error ? err.message : String(err)
          }; using default policy`,
        );
      } else if (this.config.policyRequired) {
        throw new Error(`Required Hermes policy missing at ${this.policyPath}`);
      } else {
        this.log(`policy file missing path=${this.policyPath}; creating default policy`);
      }
    }

    this.policy = this.normalizePolicyDocument({}, nowMs);
    await this.persistPolicyToDisk(this.policy);
  }

  private normalizePolicyDocument(value: Record<string, unknown>, nowMs: number): Record<string, unknown> {
    const defaultQuarantine = parseQuarantineState(value.defaultQuarantine, "none");
    const firewallMode = parseFirewallMode(asString(value.firewallMode), "transparent");
    const denyCommands = parsePolicyDenyCommands(value.denyCommands) ?? [];
    const updatedAt = asNumber(value.updatedAt) ?? nowMs;
    return {
      ...value,
      version: asNumber(value.version) ?? 1,
      defaultQuarantine,
      firewallMode,
      denyCommands,
      updatedAt,
    };
  }

  private currentPolicyDefaultQuarantine(): "none" | "soft" | "hard" {
    return parseQuarantineState(this.policy.defaultQuarantine, "none");
  }

  private currentPolicyFirewallMode(): FirewallMode {
    return parseFirewallMode(asString(this.policy.firewallMode), "transparent");
  }

  private currentPolicyDenyCommands(): string[] {
    return parsePolicyDenyCommands(this.policy.denyCommands) ?? [];
  }

  private advertisedCapabilities(): string[] {
    const mode = this.currentPolicyFirewallMode();
    const out = new Set<string>(this.config.capabilities);
    out.add("backend.nexus");
    out.add(`hermes.mode.${mode}`);
    if (mode !== "transparent") out.add("hermes.enabled");
    return [...out.values()].sort((a, b) => a.localeCompare(b));
  }

  private async persistPolicyToDisk(policyDoc: Record<string, unknown>): Promise<void> {
    await fs.mkdir(path.dirname(this.policyPath), { recursive: true });
    await fs.writeFile(this.policyPath, `${JSON.stringify(policyDoc, null, 2)}\n`, "utf8");
  }

  private sendConnectHello(): void {
    const ws = this.requireOpenSocket();
    if (!ws) return;
    this.nodeNonce = randomBytes(32).toString("base64url");
    const firewallMode = this.currentPolicyFirewallMode();
    const advertisedCapabilities = this.advertisedCapabilities();
    this.sendSignedEnvelope({
      type: "req",
      id: randomUUID(),
      method: "connect.hello",
      params: {
        role: "node",
        displayName: this.config.displayName,
        version: "0.1.0",
        nodeId: this.config.nodeId,
        backend: "nexus",
        trustLevel: "standard",
        firewallMode,
        nodeNonce: this.nodeNonce,
        caps: advertisedCapabilities,
        capabilities: advertisedCapabilities,
        device: {
          id: this.identity.fingerprint,
          fingerprint: this.identity.fingerprint,
          publicKey: this.identity.publicKeyRaw,
          signedAt: Date.now(),
        },
      },
    });
    this.log("sent connect.hello");
  }

  private async handleMessage(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log("received invalid JSON");
      return;
    }

    const envelope = asObject(parsed);
    const msg = parseEnvelope(envelope);
    if (!msg) {
      this.log("received invalid envelope");
      return;
    }

    if (!this.verifyGatewayEnvelope(msg, envelope)) {
      this.log("gateway envelope verification failed");
      this.closeSocket(4001, "invalid gateway signature");
      return;
    }

    if (msg.type === "event") {
      await this.handleEvent(msg);
      return;
    }
    if (msg.type === "req") {
      await this.handleRequest(msg);
      return;
    }
    await this.handleResponse(msg);
  }

  private verifyGatewayEnvelope(msg: AnyEnvelope, envelope: Record<string, unknown>): boolean {
    if (!msg.sender.startsWith("gateway:")) return false;
    const skew = Math.abs(Date.now() - msg.ts);
    if (skew > this.config.maxClockSkewMs) {
      this.log(`rejecting message with timestamp skew=${skew}ms`);
      return false;
    }

    // Learn gateway public key from connect.challenge payload, then require
    // verification for all signed envelopes afterwards.
    if (!this.gatewayPublicKey) {
      if (msg.type !== "event" || msg.event !== "connect.challenge") return false;
      const payload = asObject(msg.payload);
      const gatewayKeyRaw = asString(payload.gatewayPublicKey);
      if (!gatewayKeyRaw) return false;
      const parsed = parsePublicKey(gatewayKeyRaw);
      if (!parsed) return false;
      const envelopeOk = verifyEnvelopeSignature(envelope, parsed.key);
      if (!envelopeOk) return false;
      this.gatewayPublicKey = parsed.key;
      this.gatewayFingerprint = parsed.fingerprint;
      return true;
    }

    return verifyEnvelopeSignature(envelope, this.gatewayPublicKey);
  }

  private async handleEvent(msg: EventEnvelope): Promise<void> {
    switch (msg.event) {
      case "connect.challenge":
        await this.handleConnectChallenge(msg);
        return;
      case "connect.accept":
        this.ready = true;
        this.log("received connect.accept; session ready");
        this.sendCapsAdvertise();
        this.drainOutbox("connect.accept");
        return;
      default:
        this.log(`event=${msg.event}`);
    }
  }

  private async handleConnectChallenge(msg: EventEnvelope): Promise<void> {
    if (!this.nodeNonce || !this.gatewayPublicKey) {
      this.log("challenge received before hello state was initialized");
      return;
    }

    const payload = asObject(msg.payload);
    const gatewayNonce = asString(payload.gatewayNonce);
    const gatewayProofSig = asString(payload.gatewayProofSig);
    const sessionId = asString(payload.sessionId);
    if (!gatewayNonce || !gatewayProofSig || !sessionId) {
      this.log("challenge payload is missing required fields");
      return;
    }

    const transcript = buildHandshakeTranscript({
      nodeId: this.config.nodeId,
      sessionId,
      nodeNonce: this.nodeNonce,
      gatewayNonce,
    });
    if (!this.config.insecureSkipGatewayProof) {
      const proofOk = verifyDetachedPayload(transcript, gatewayProofSig, this.gatewayPublicKey);
      if (!proofOk) {
        this.log("gateway proof signature validation failed");
        this.closeSocket(4001, "invalid gateway proof");
        return;
      }
    }

    this.sessionId = sessionId;
    this.gatewayNonce = gatewayNonce;
    const nodeProofSig = signDetachedPayload(transcript, this.identity.privateKey);
    this.sendSignedEnvelope({
      type: "req",
      id: randomUUID(),
      method: "connect.prove",
      params: {
        nodeProofSig,
        permissions: {
          "system.run": true,
          "system.which": true,
          "process.start": true,
          "process.status": true,
          "process.logs": true,
          "process.cancel": true,
        },
        nodeNonce: this.nodeNonce,
        gatewayNonce,
      },
    });
    this.log(
      `sent connect.prove session=${sessionId} gateway_fingerprint=${this.gatewayFingerprint ?? "unknown"}`,
    );
  }

  private async handleResponse(msg: ResponseEnvelope): Promise<void> {
    if (msg.ok) {
      const payload = asObject(msg.payload);
      const status = asString(payload.status);
      if (status === "ready") {
        this.ready = true;
        this.log("gateway response status=ready");
        this.sendCapsAdvertise();
        this.drainOutbox("response.ready");
      }
      return;
    }
    const code = asString(asObject(msg.error).code) ?? "ERROR";
    const message = asString(asObject(msg.error).message) ?? "unknown error";
    this.log(`response error code=${code} message=${message}`);
    if (code === "PAIRING_PENDING" || code === "PAIRING_REQUIRED" || code === "AUTH_INVALID") {
      // Wait for operator action rather than tight reconnect loops.
      this.scheduleReconnect();
    }
  }

  private async handleRequest(msg: RequestEnvelope): Promise<void> {
    switch (msg.method) {
      case "ping":
        this.sendSignedEnvelope({
          type: "res",
          id: msg.id,
          ok: true,
          payload: { pong: true, ts: Date.now() },
        });
        return;
      case "tool.execute":
        await this.handleToolExecute(msg);
        return;
      case "process.start":
        await this.handleProcessStart(msg);
        return;
      case "process.status":
        await this.handleProcessStatus(msg);
        return;
      case "process.logs":
        await this.handleProcessLogs(msg);
        return;
      case "process.cancel":
        await this.handleProcessCancel(msg);
        return;
      case "process.ack":
        await this.handleProcessAck(msg);
        return;
      case "policy.update":
        await this.handlePolicyUpdate(msg);
        return;
      case "symbols.list":
        await this.handleSymbolsList(msg);
        return;
      case "audit.query":
        await this.handleAuditQuery(msg);
        return;
      default:
        this.sendRequestError(msg.id, "METHOD_NOT_IMPLEMENTED", `Method ${msg.method} is not implemented by reference node.`, false);
    }
  }

  private async handleToolExecute(msg: RequestEnvelope): Promise<void> {
    const params = asObject(msg.params);
    const tool = asString(params.tool);
    const args = asObject(params.args);
    if (!tool) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "tool.execute requires a tool name", false);
      return;
    }
    try {
      let output = "";
      if (tool === "system.which") {
        output = await this.execSystemWhich(args);
      } else if (tool === "system.run") {
        output = await this.execSystemRun(args);
      } else {
        throw new NodeToolError("CAPABILITY_UNAVAILABLE", `Tool ${tool} is not supported by this reference node.`);
      }
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          output,
        },
      });
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
    }
  }

  private async handleProcessStart(msg: RequestEnvelope): Promise<void> {
    const params = asObject(msg.params);
    const tool = asString(params.tool) ?? "system.run";
    if (tool !== "system.run") {
      this.sendRequestError(msg.id, "CAPABILITY_UNAVAILABLE", `process.start only supports system.run (got ${tool}).`, false);
      return;
    }
    const runArgs = asObject(params.args);
    const command = asString(runArgs.command);
    if (!command) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "process.start requires args.command.", false);
      return;
    }
    const commandValidation = validateAllowlistedCommand(command, this.config.allowCommands);
    if (!commandValidation.ok) {
      this.sendRequestError(msg.id, "PERMISSION_DENIED", commandValidation.message, false);
      return;
    }
    const commandName = commandValidation.commandName;

    const cwd = asString(runArgs.cwd) ?? null;
    const env = asStringMap(runArgs.env);
    const timeoutMs = clampInt(runArgs.timeoutMs ?? runArgs.timeout, 1_000, this.config.runTimeoutMs) ?? null;
    const firewallMode = this.currentPolicyFirewallMode();
    let executionCommand = command;
    let executionCwd = cwd;
    let executionEnv = env;
    let resolvedSymbols: string[] = [];
    if (firewallMode !== "transparent") {
      let resolvedInvocation: ResolvedSystemRunInvocation;
      try {
        resolvedInvocation = await this.resolveSystemRunInvocation({
          command,
          cwd,
          env,
        });
      } catch (err) {
        this.writeAuditEvent({
          type: "symbol.resolve.failed",
          toolName: "process.start",
          details: {
            code: err instanceof NodeToolError ? err.code : "NODE_EXECUTION_FAILED",
            message: err instanceof Error ? err.message : String(err),
          },
        });
        this.sendToolExecutionError(msg.id, err);
        return;
      }
      executionCommand = resolvedInvocation.command;
      executionCwd = resolvedInvocation.cwd;
      executionEnv = resolvedInvocation.env;
      resolvedSymbols = resolvedInvocation.symbols;
    }
    const routingObj = asObject(params.routing);
    const routing: Record<string, unknown> = {
      ...routingObj,
      firewallMode,
    };
    if (firewallMode === "transparent") {
      delete routing.firewallSession;
      delete routing.firewallQuarantine;
    }
    const resolvedFirewallSession = firewallMode === "transparent" ? null : this.resolveFirewallSession(routingObj);
    if (resolvedFirewallSession) {
      routing.firewallSession = resolvedFirewallSession.sessionId;
      routing.firewallQuarantine = resolvedFirewallSession.quarantineState;
    }
    const processId = `proc_${randomUUID().slice(0, 12)}`;
    try {
      this.enforceHermesCommandPolicy({
        toolName: "process.start",
        commandName,
        firewallMode,
        processId,
        firewallSession: resolvedFirewallSession?.sessionId ?? null,
      });
    } catch (err) {
      this.sendToolExecutionError(msg.id, err);
      return;
    }
    const entry: ReferenceProcess = {
      processId,
      command,
      cwd,
      status: "queued",
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      signal: null,
      cancelRequested: false,
      timeoutMs,
      logs: "",
      child: null,
      timeoutTimer: null,
      killTimer: null,
      firewallMode,
      hermesReferences: [],
      routing: Object.keys(routing).length > 0 ? routing : null,
    };
    this.processes.set(processId, entry);
    this.persistProcess(entry);
    this.writeAuditEvent({
      type: "process.start.requested",
      processId,
      firewallSession: resolvedFirewallSession?.sessionId ?? null,
      toolName: "system.run",
      details: {
        commandName,
        symbolCount: resolvedSymbols.length,
        symbols: resolvedSymbols,
        firewallMode,
      },
    });

    try {
      const child = spawnChild(executionCommand, {
        shell: true,
        cwd: executionCwd ?? undefined,
        env: Object.keys(executionEnv).length > 0 ? { ...process.env, ...executionEnv } : process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      entry.child = child;
      entry.status = "running";
      entry.startedAt = Date.now();
      this.persistProcess(entry);
      this.emitProcessUpdate(entry, "running");

      child.stdout?.on("data", (chunk) => {
        this.appendProcessLog(entry, String(chunk), "stdout");
      });
      child.stderr?.on("data", (chunk) => {
        this.appendProcessLog(entry, String(chunk), "stderr");
      });
      child.on("error", (err) => {
        this.appendProcessLog(entry, `process error: ${err instanceof Error ? err.message : String(err)}\n`, "stderr");
      });
      child.on("close", (code, signal) => {
        this.finishProcess(entry, code, signal);
      });

      if (timeoutMs && timeoutMs > 0) {
        entry.timeoutTimer = setTimeout(() => {
          if (entry.status !== "running") return;
          this.appendProcessLog(entry, `process timeout exceeded (${timeoutMs}ms); terminating\n`, "stderr");
          this.cancelProcess(entry, {
            signal: "SIGTERM",
            reason: "timeout",
            killAfterMs: 5_000,
          });
        }, timeoutMs);
        entry.timeoutTimer.unref?.();
      }

      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          processId,
          status: entry.status,
          startedAt: entry.startedAt,
          command,
          firewallMode,
          ...(resolvedFirewallSession
            ? {
                firewallSession: resolvedFirewallSession.sessionId,
                firewallSessionReused: resolvedFirewallSession.reused,
                firewallQuarantine: resolvedFirewallSession.quarantineState,
              }
            : {}),
          ...(firewallMode !== "transparent"
            ? {
                hermes: {
                  mode: firewallMode,
                  sanitized: true,
                  references: [],
                },
              }
            : {}),
        },
      });
    } catch (err) {
      this.processes.delete(processId);
      this.stateStore.removeProcess(processId);
      this.sendToolExecutionError(msg.id, err);
    }
  }

  private async handleProcessStatus(msg: RequestEnvelope): Promise<void> {
    const params = asObject(msg.params);
    const processId = asString(params.processId) ?? asString(params.id);
    if (!processId) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "process.status requires processId.", false);
      return;
    }
    const entry = this.processes.get(processId);
    if (!entry) {
      this.sendRequestError(msg.id, "PROCESS_NOT_FOUND", `Process ${processId} was not found.`, false);
      return;
    }
    this.sendSignedEnvelope({
      type: "res",
      id: msg.id,
      ok: true,
      payload: this.serializeProcess(entry, false),
    });
  }

  private async handleProcessLogs(msg: RequestEnvelope): Promise<void> {
    const params = asObject(msg.params);
    const processId = asString(params.processId) ?? asString(params.id);
    if (!processId) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "process.logs requires processId.", false);
      return;
    }
    const entry = this.processes.get(processId);
    if (!entry) {
      this.sendRequestError(msg.id, "PROCESS_NOT_FOUND", `Process ${processId} was not found.`, false);
      return;
    }
    const maxChars = clampInt(params.maxChars, 200, MAX_OUTPUT_CHARS) ?? 8_000;
    const logs = entry.logs.length > maxChars ? entry.logs.slice(-maxChars) : entry.logs;
    if (entry.firewallMode !== "transparent") {
      const references = this.resolveProcessHermesReferences(entry);
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          processId,
          status: entry.status,
          logs: this.buildSafeSummary(logs),
          totalChars: entry.logs.length,
          truncated: entry.logs.length > maxChars,
          firewallMode: entry.firewallMode,
          firewallSession: asString(asObject(entry.routing ?? {}).firewallSession),
          hermes: {
            mode: entry.firewallMode,
            sanitized: true,
            references,
          },
        },
      });
      return;
    }
    this.sendSignedEnvelope({
      type: "res",
      id: msg.id,
      ok: true,
      payload: {
        processId,
        status: entry.status,
        logs,
        totalChars: entry.logs.length,
        truncated: entry.logs.length > maxChars,
      },
    });
  }

  private async handleProcessCancel(msg: RequestEnvelope): Promise<void> {
    const params = asObject(msg.params);
    const processId = asString(params.processId) ?? asString(params.id);
    if (!processId) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "process.cancel requires processId.", false);
      return;
    }
    const entry = this.processes.get(processId);
    if (!entry) {
      this.sendRequestError(msg.id, "PROCESS_NOT_FOUND", `Process ${processId} was not found.`, false);
      return;
    }
    const signal = normalizeSignal(asString(params.signal)) ?? "SIGTERM";
    const reason = asString(params.reason) ?? "gateway_cancel";
    const killAfterMs = clampInt(params.killAfterMs, 0, 60_000) ?? 5_000;
    this.cancelProcess(entry, { signal, reason, killAfterMs });
    this.sendSignedEnvelope({
      type: "res",
      id: msg.id,
      ok: true,
      payload: {
        processId,
        status: entry.status === "running" ? "cancelling" : entry.status,
        signal,
        reason,
      },
    });
  }

  private async handleProcessAck(msg: RequestEnvelope): Promise<void> {
    const params = asObject(msg.params);
    const deliveryId = asString(params.deliveryId);
    if (!deliveryId) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "process.ack requires deliveryId.", false);
      return;
    }
    const processId = asString(params.processId) ?? undefined;
    const nowMs = Date.now();
    const acknowledged = this.stateStore.markOutboxDelivered(deliveryId, nowMs);
    this.stateStore.pruneDeliveredOlderThan(nowMs - DELIVERED_OUTBOX_TTL_MS);
    this.sendSignedEnvelope({
      type: "res",
      id: msg.id,
      ok: true,
      payload: {
        deliveryId,
        processId: processId ?? null,
        acknowledged,
      },
    });
  }

  private async handlePolicyUpdate(msg: RequestEnvelope): Promise<void> {
    const params = asObject(msg.params);
    const incomingPolicy = asObject(params.policy);
    if (Object.keys(incomingPolicy).length === 0) {
      this.sendRequestError(msg.id, "INVALID_REQUEST", "policy.update requires a non-empty `policy` object.", false);
      return;
    }
    const requestedQuarantine = asString(incomingPolicy.defaultQuarantine);
    if (
      requestedQuarantine &&
      requestedQuarantine !== "none" &&
      requestedQuarantine !== "soft" &&
      requestedQuarantine !== "hard"
    ) {
      this.sendRequestError(
        msg.id,
        "INVALID_REQUEST",
        `policy.update defaultQuarantine must be one of: none, soft, hard (got ${requestedQuarantine}).`,
        false,
      );
      return;
    }
    const requestedFirewallMode = asString(incomingPolicy.firewallMode);
    if (
      requestedFirewallMode &&
      requestedFirewallMode !== "transparent" &&
      requestedFirewallMode !== "audit-only" &&
      requestedFirewallMode !== "hermes"
    ) {
      this.sendRequestError(
        msg.id,
        "INVALID_REQUEST",
        `policy.update firewallMode must be one of: transparent, audit-only, hermes (got ${requestedFirewallMode}).`,
        false,
      );
      return;
    }
    const requestedDenyCommands = parsePolicyDenyCommands(incomingPolicy.denyCommands);
    if (incomingPolicy.denyCommands !== undefined && requestedDenyCommands === null) {
      this.sendRequestError(
        msg.id,
        "INVALID_REQUEST",
        "policy.update denyCommands must be an array of command names.",
        false,
      );
      return;
    }
    const nowMs = Date.now();
    const next = this.normalizePolicyDocument(
      {
        ...this.policy,
        ...incomingPolicy,
      },
      nowMs,
    );
    try {
      await this.persistPolicyToDisk(next);
      this.policy = next;
      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          updatedAt: nowMs,
          defaultQuarantine: this.currentPolicyDefaultQuarantine(),
          firewallMode: this.currentPolicyFirewallMode(),
          denyCommands: this.currentPolicyDenyCommands(),
          policyPath: this.policyPath,
          policy: this.policy,
        },
      });
      this.log(
        `policy.update applied path=${this.policyPath} firewall_mode=${this.currentPolicyFirewallMode()} default_quarantine=${this.currentPolicyDefaultQuarantine()} deny_commands=${this.currentPolicyDenyCommands().join(",") || "-"}`,
      );
      this.writeAuditEvent({
        type: "policy.update",
        details: {
          firewallMode: this.currentPolicyFirewallMode(),
          defaultQuarantine: this.currentPolicyDefaultQuarantine(),
          denyCommands: this.currentPolicyDenyCommands(),
          policyPath: this.policyPath,
        },
      });
      this.sendCapsAdvertise();
    } catch (err) {
      this.sendRequestError(
        msg.id,
        "NODE_POLICY_PERSIST_FAILED",
        `Failed to persist policy update: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  }

  private async handleSymbolsList(msg: RequestEnvelope): Promise<void> {
    const params = asObject(msg.params);
    const requestedKindRaw = asString(params.kind);
    const requestedKind = parseSymbolKind(requestedKindRaw);
    if (requestedKindRaw && !requestedKind) {
      this.sendRequestError(
        msg.id,
        "INVALID_REQUEST",
        `symbols.list kind must be one of: ${SYMBOL_KINDS.join(", ")} (got ${requestedKindRaw}).`,
        false,
      );
      return;
    }
    const includeFields = asBoolean(params.includeFields) ?? true;
    try {
      const catalog = await this.readSymbolCatalog();
      const activeKinds = requestedKind ? [requestedKind] : SYMBOL_KINDS;
      const responseCatalog: Record<string, Array<Record<string, unknown>>> = {
        contact: [],
        account: [],
        secret: [],
        user: [],
      };
      const symbols: string[] = [];
      const countsByKind: Record<SymbolKind, number> = {
        contact: 0,
        account: 0,
        secret: 0,
        user: 0,
      };

      for (const kind of activeKinds) {
        const entries = catalog[kind];
        countsByKind[kind] = entries.length;
        responseCatalog[kind] = entries.map((entry) => {
          const record: Record<string, unknown> = { key: entry.key };
          if (includeFields && entry.fields.length > 0 && kind !== "user") {
            record.fields = [...entry.fields];
          }
          return record;
        });
        for (const entry of entries) {
          symbols.push(`{{${kind}:${entry.key}}}`);
          if (includeFields && kind !== "user") {
            for (const field of entry.fields) {
              symbols.push(`{{${kind}:${entry.key}:${field}}}`);
            }
          }
        }
      }

      this.sendSignedEnvelope({
        type: "res",
        id: msg.id,
        ok: true,
        payload: {
          kind: requestedKind ?? null,
          includeFields,
          generatedAt: Date.now(),
          storeDir: this.symbolStoreDir,
          catalog: responseCatalog,
          counts: {
            byKind: countsByKind,
            keys: countsByKind.contact + countsByKind.account + countsByKind.secret + countsByKind.user,
            symbols: symbols.length,
          },
          symbols,
        },
      });
      this.writeAuditEvent({
        type: "symbols.list",
        details: {
          kind: requestedKind ?? null,
          includeFields,
          keys: countsByKind.contact + countsByKind.account + countsByKind.secret + countsByKind.user,
          symbols: symbols.length,
        },
      });
    } catch (err) {
      this.sendRequestError(
        msg.id,
        "NODE_SYMBOLS_LIST_FAILED",
        `Failed to build symbols catalog: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  }

  private async handleAuditQuery(msg: RequestEnvelope): Promise<void> {
    const params = asObject(msg.params);
    const limit = clampInt(params.limit, 1, 500) ?? 100;
    const cursorCreatedAt = asNumber(params.cursorCreatedAt ?? params.cursor) ?? null;
    const type = asString(params.type);
    const processId = asString(params.processId) ?? asString(params.process);
    const firewallSession = asString(params.firewallSession);
    const actor = asString(params.actor);
    const result = this.stateStore.queryAuditEvents({
      limit,
      cursorCreatedAt,
      type,
      processId,
      firewallSession,
      actor,
    });
    this.sendSignedEnvelope({
      type: "res",
      id: msg.id,
      ok: true,
      payload: {
        count: result.events.length,
        nextCursorCreatedAt: result.nextCursorCreatedAt,
        events: result.events,
      },
    });
  }

  private async readSymbolCatalog(): Promise<SymbolCatalog> {
    const contactsRaw = await this.readJsonUnknown(path.join(this.symbolStoreDir, "contacts.json"));
    const accountsRaw = await this.readJsonUnknown(path.join(this.symbolStoreDir, "accounts.json"));
    const secretsRaw = await this.readJsonUnknown(path.join(this.symbolStoreDir, "secrets.json"));
    const userRaw = await this.readJsonUnknown(path.join(this.symbolStoreDir, "user.json"));

    return {
      contact: this.parseContactsCatalog(contactsRaw),
      account: this.parseKeyedCatalog(accountsRaw),
      secret: this.parseKeyedCatalog(secretsRaw),
      user: this.parseUserCatalog(userRaw),
    };
  }

  private async readJsonUnknown(filePath: string): Promise<unknown> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") return {};
      this.log(
        `symbols store read failed path=${filePath} error=${
          err instanceof Error ? err.message : String(err)
        }; treating as empty`,
      );
      return {};
    }
  }

  private parseContactsCatalog(raw: unknown): SymbolCatalogEntry[] {
    const entries = new Map<string, Set<string>>();
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const row = asObject(item);
        const key = asString(row.key);
        if (!key) continue;
        const fields = new Set<string>();
        for (const [field, value] of Object.entries(row)) {
          if (field === "key" || value === null || value === undefined) continue;
          fields.add(field);
        }
        entries.set(key, fields);
      }
      return this.normalizeCatalogEntries(entries);
    }
    const map = asObject(raw);
    for (const [keyRaw, value] of Object.entries(map)) {
      const key = keyRaw.trim();
      if (!key) continue;
      const fields = new Set<string>();
      const valueObj = asObject(value);
      for (const [field, fieldValue] of Object.entries(valueObj)) {
        if (fieldValue === null || fieldValue === undefined) continue;
        fields.add(field);
      }
      entries.set(key, fields);
    }
    return this.normalizeCatalogEntries(entries);
  }

  private parseKeyedCatalog(raw: unknown): SymbolCatalogEntry[] {
    const map = asObject(raw);
    const entries = new Map<string, Set<string>>();
    for (const [keyRaw, value] of Object.entries(map)) {
      const key = keyRaw.trim();
      if (!key) continue;
      const fields = new Set<string>();
      const valueObj = asObject(value);
      for (const [field, fieldValue] of Object.entries(valueObj)) {
        if (fieldValue === null || fieldValue === undefined) continue;
        fields.add(field);
      }
      entries.set(key, fields);
    }
    return this.normalizeCatalogEntries(entries);
  }

  private parseUserCatalog(raw: unknown): SymbolCatalogEntry[] {
    const map = asObject(raw);
    const entries = new Map<string, Set<string>>();
    for (const keyRaw of Object.keys(map)) {
      const key = keyRaw.trim();
      if (!key) continue;
      entries.set(key, new Set<string>());
    }
    return this.normalizeCatalogEntries(entries);
  }

  private normalizeCatalogEntries(entries: Map<string, Set<string>>): SymbolCatalogEntry[] {
    return [...entries.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, fields]) => ({
        key,
        fields: [...fields].sort((a, b) => a.localeCompare(b)),
      }));
  }

  private sendRequestError(id: string | null, code: string, message: string, retryable: boolean): void {
    this.sendSignedEnvelope({
      type: "res",
      id,
      ok: false,
      error: {
        code,
        message: truncateOutput(message, 2_000),
        retryable,
      },
    });
  }

  private sendToolExecutionError(id: string, err: unknown): void {
    const code =
      err instanceof NodeToolError
        ? err.code
        : err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string"
          ? (err as { code: string }).code
          : "NODE_EXECUTION_FAILED";
    const message = err instanceof Error ? err.message : String(err);
    const retryable = err instanceof NodeToolError ? err.retryable : false;
    this.sendRequestError(id, code, message, retryable);
  }

  private async execSystemWhich(args: Record<string, unknown>): Promise<string> {
    const command = asString(args.command) ?? asString(args.executable) ?? asString(args.name);
    if (!command) {
      throw new NodeToolError("INVALID_REQUEST", "system.which requires `command`.");
    }

    const safe = shellEscape(command);
    const result = await execShell(`command -v ${safe}`, {
      timeoutMs: Math.min(this.config.runTimeoutMs, 10_000),
    });
    if (result.exitCode !== 0) {
      throw new NodeToolError("COMMAND_NOT_FOUND", `Command not found: ${command}`);
    }
    return truncateOutput(result.stdout.trim() || result.stderr.trim() || "(not found)");
  }

  private async execSystemRun(args: Record<string, unknown>): Promise<string> {
    const command = asString(args.command);
    if (!command) throw new NodeToolError("INVALID_REQUEST", "system.run requires `command`.");
    const commandValidation = validateAllowlistedCommand(command, this.config.allowCommands);
    if (!commandValidation.ok) throw new NodeToolError("PERMISSION_DENIED", commandValidation.message);
    const commandName = commandValidation.commandName;

    const firewallMode = this.currentPolicyFirewallMode();
    const timeoutMs = clampInt(args.timeoutMs ?? args.timeout, 1_000, this.config.runTimeoutMs) ?? this.config.runTimeoutMs;
    const cwd = asString(args.cwd) ?? null;
    const env = asStringMap(args.env);
    let executionCommand = command;
    let executionCwd = cwd;
    let executionEnv = env;
    let resolvedSymbols: string[] = [];
    if (firewallMode !== "transparent") {
      let resolvedInvocation: ResolvedSystemRunInvocation;
      try {
        resolvedInvocation = await this.resolveSystemRunInvocation({
          command,
          cwd,
          env,
        });
      } catch (err) {
        this.writeAuditEvent({
          type: "symbol.resolve.failed",
          toolName: "system.run",
          details: {
            code: err instanceof NodeToolError ? err.code : "NODE_EXECUTION_FAILED",
            message: err instanceof Error ? err.message : String(err),
          },
        });
        throw err;
      }
      executionCommand = resolvedInvocation.command;
      executionCwd = resolvedInvocation.cwd;
      executionEnv = resolvedInvocation.env;
      resolvedSymbols = resolvedInvocation.symbols;
    }
    this.writeAuditEvent({
      type: "tool.execute.requested",
      toolName: "system.run",
      details: {
        commandName,
        symbolCount: resolvedSymbols.length,
        symbols: resolvedSymbols,
        firewallMode,
      },
    });
    this.enforceHermesCommandPolicy({
      toolName: "system.run",
      commandName,
      firewallMode,
    });

    const result = await execShell(executionCommand, {
      cwd: executionCwd ?? undefined,
      timeoutMs,
      env: executionEnv,
    });

    const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (firewallMode === "transparent") {
      if (result.timedOut) {
        throw new NodeToolError("EXECUTION_TIMEOUT", `Command timed out after ${timeoutMs}ms.`, true);
      }
      if (result.exitCode !== 0) {
        const signalPart = result.signal ? ` signal=${result.signal}` : "";
        throw new NodeToolError(
          "COMMAND_FAILED",
          truncateOutput(`Command failed (exit=${result.exitCode}${signalPart}).\n${combined}`),
        );
      }
      return truncateOutput(combined || "(no output)");
    }

    const safeSummary = this.buildSafeSummary(combined || "(no output)");
    const reference = this.createHermesReference({
      sourceType: "system.run.output",
      toolName: "system.run",
      title: commandName ? `system.run ${commandName}` : "system.run output",
      safeSummary,
      metadata: {
        mode: firewallMode,
        commandName,
        symbolCount: resolvedSymbols.length,
        symbols: resolvedSymbols,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
      },
    });

    if (result.timedOut) {
      throw new NodeToolError(
        "EXECUTION_TIMEOUT",
        JSON.stringify(
          {
            mode: firewallMode,
            safeSummary,
            references: [reference],
            timedOut: true,
            timeoutMs,
          },
          null,
          2,
        ),
        true,
      );
    }
    if (result.exitCode !== 0) {
      throw new NodeToolError(
        "COMMAND_FAILED",
        JSON.stringify(
          {
            mode: firewallMode,
            safeSummary,
            references: [reference],
            exitCode: result.exitCode,
            signal: result.signal,
          },
          null,
          2,
        ),
      );
    }

    return JSON.stringify(
      {
        mode: firewallMode,
        safeSummary,
        references: [reference],
        exitCode: result.exitCode,
        signal: result.signal,
      },
      null,
      2,
    );
  }

  private async resolveSystemRunInvocation(params: {
    command: string;
    cwd: string | null;
    env: Record<string, string>;
  }): Promise<ResolvedSystemRunInvocation> {
    const storeCache: SymbolStoreCache = {};
    const commandResolved = await this.resolveTemplateSymbols(params.command, {
      shellEscapeValues: true,
      storeCache,
    });
    const cwdResolved = params.cwd
      ? await this.resolveTemplateSymbols(params.cwd, {
          shellEscapeValues: false,
          storeCache,
        })
      : { value: null, symbols: [] as string[] };

    const envResolved: Record<string, string> = {};
    const seenSymbols = new Set<string>([...commandResolved.symbols, ...cwdResolved.symbols]);
    for (const [key, value] of Object.entries(params.env)) {
      const resolved = await this.resolveTemplateSymbols(value, {
        shellEscapeValues: false,
        storeCache,
      });
      envResolved[key] = resolved.value;
      for (const symbol of resolved.symbols) seenSymbols.add(symbol);
    }

    return {
      command: commandResolved.value,
      cwd: cwdResolved.value,
      env: envResolved,
      symbols: [...seenSymbols.values()],
    };
  }

  private async resolveTemplateSymbols(
    input: string,
    opts: { shellEscapeValues: boolean; storeCache: SymbolStoreCache },
  ): Promise<{ value: string; symbols: string[] }> {
    const matcher = new RegExp(SYMBOL_TOKEN_PATTERN);
    let cursor = 0;
    let output = "";
    const symbols: string[] = [];

    while (true) {
      const match = matcher.exec(input);
      if (!match) break;
      const raw = match[0] ?? "";
      const kindRaw = match[1] ?? "";
      const keyRaw = match[2] ?? "";
      const fieldRaw = match[3] ?? null;
      const kind = parseSymbolKind(kindRaw);
      if (!kind) {
        throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `Unsupported symbol kind in token ${raw}.`);
      }
      const resolved = await this.resolveSymbolToken({
        kind,
        key: keyRaw,
        field: fieldRaw,
        storeCache: opts.storeCache,
      });
      output += input.slice(cursor, match.index);
      output += opts.shellEscapeValues ? shellEscape(resolved) : resolved;
      cursor = match.index + raw.length;
      symbols.push(raw);
    }
    if (symbols.length === 0) {
      return {
        value: input,
        symbols: [],
      };
    }
    output += input.slice(cursor);
    return {
      value: output,
      symbols,
    };
  }

  private async resolveSymbolToken(params: {
    kind: SymbolKind;
    key: string;
    field: string | null;
    storeCache: SymbolStoreCache;
  }): Promise<string> {
    const key = params.key.trim();
    if (!key) throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", "Symbol key cannot be empty.");

    if (params.kind === "contact") {
      const contactsRaw = await this.loadSymbolStore("contact", params.storeCache);
      const record = this.lookupContactRecord(contactsRaw, key);
      if (!record) {
        throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `contact symbol "${key}" was not found.`);
      }
      const value = this.pickContactValue(record, params.field);
      if (value === null) {
        const suffix = params.field ? `:${params.field}` : "";
        throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `contact symbol "${key}${suffix}" has no resolvable value.`);
      }
      return value;
    }

    if (params.kind === "user") {
      if (params.field) {
        throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `user symbols do not support field selectors (${params.field}).`);
      }
      const userRaw = await this.loadSymbolStore("user", params.storeCache);
      const userMap = asObject(userRaw);
      const scalar = this.scalarToString(userMap[key]);
      if (scalar === null) {
        throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `user symbol "${key}" was not found.`);
      }
      return scalar;
    }

    const storeKind = params.kind;
    const storeRaw = await this.loadSymbolStore(storeKind, params.storeCache);
    const storeMap = asObject(storeRaw);
    if (!(key in storeMap)) {
      throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `${storeKind} symbol "${key}" was not found.`);
    }
    const entry = storeMap[key];
    if (params.field) {
      const entryObj = asObject(entry);
      const value = this.scalarToString(entryObj[params.field]);
      if (value === null) {
        throw new NodeToolError(
          "SYMBOL_RESOLUTION_FAILED",
          `${storeKind} symbol "${key}:${params.field}" was not found.`,
        );
      }
      return value;
    }

    const direct = this.scalarToString(entry);
    if (direct !== null) return direct;
    const entryObj = asObject(entry);
    const preferred = this.scalarToString(entryObj.value);
    if (preferred !== null) return preferred;
    const scalarEntries = Object.entries(entryObj).flatMap(([field, value]) => {
      const scalar = this.scalarToString(value);
      return scalar === null ? [] : [{ field, value: scalar }];
    });
    if (scalarEntries.length === 1) return scalarEntries[0]!.value;
    if (scalarEntries.length === 0) {
      throw new NodeToolError("SYMBOL_RESOLUTION_FAILED", `${storeKind} symbol "${key}" has no scalar value to resolve.`);
    }
    throw new NodeToolError(
      "SYMBOL_RESOLUTION_FAILED",
      `${storeKind} symbol "${key}" is ambiguous; use an explicit field selector.`,
    );
  }

  private async loadSymbolStore(kind: SymbolKind, cache: SymbolStoreCache): Promise<unknown> {
    if (cache[kind] !== undefined) return cache[kind];
    const fileName = kind === "contact" ? "contacts.json" : kind === "account" ? "accounts.json" : kind === "secret" ? "secrets.json" : "user.json";
    const loaded = await this.readJsonUnknown(path.join(this.symbolStoreDir, fileName));
    cache[kind] = loaded;
    return loaded;
  }

  private lookupContactRecord(raw: unknown, key: string): Record<string, unknown> | null {
    if (Array.isArray(raw)) {
      const row = raw.find((item) => asString(asObject(item).key) === key);
      const obj = asObject(row);
      return Object.keys(obj).length > 0 ? obj : null;
    }
    const map = asObject(raw);
    if (key in map) {
      const obj = asObject(map[key]);
      if (Object.keys(obj).length > 0) return obj;
    }
    return null;
  }

  private pickContactValue(record: Record<string, unknown>, field: string | null): string | null {
    if (field) return this.scalarToString(record[field]);
    const preferredFields = ["name", "email", "phone", "firstName", "lastName"];
    for (const candidate of preferredFields) {
      const value = this.scalarToString(record[candidate]);
      if (value !== null) return value;
    }
    for (const [candidate, value] of Object.entries(record)) {
      if (candidate === "key") continue;
      const scalar = this.scalarToString(value);
      if (scalar !== null) return scalar;
    }
    return null;
  }

  private scalarToString(value: unknown): string | null {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return null;
  }

  private appendProcessLog(entry: ReferenceProcess, chunk: string, stream: "stdout" | "stderr"): void {
    if (!chunk) return;
    const line = chunk;
    entry.logs += line;
    if (entry.logs.length > MAX_PROCESS_LOG_CHARS) {
      entry.logs = entry.logs.slice(entry.logs.length - MAX_PROCESS_LOG_CHARS);
    }
    this.stateStore.updateProcessLogs(entry.processId, entry.logs, Date.now());
    this.sendSignedEnvelope({
      type: "event",
      event: "log.append",
      payload: {
        processId: entry.processId,
        stream,
        chunk: truncateOutput(line, 8_000),
        ts: Date.now(),
      },
    });
  }

  private finishProcess(entry: ReferenceProcess, exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = null;
    }
    if (entry.killTimer) {
      clearTimeout(entry.killTimer);
      entry.killTimer = null;
    }
    entry.child = null;
    entry.exitCode = exitCode;
    entry.signal = signal ? String(signal) : null;
    entry.endedAt = Date.now();
    if (entry.cancelRequested) {
      entry.status = "cancelled";
    } else if ((exitCode ?? 0) === 0) {
      entry.status = "completed";
    } else {
      entry.status = "failed";
    }
    if (entry.firewallMode !== "transparent") {
      const safeSummary = this.buildSafeSummary(entry.logs);
      const commandName = parseCommandName(entry.command);
      const reference = this.createHermesReference({
        sourceType: "process.output",
        processId: entry.processId,
        toolName: "system.run",
        title: commandName ? `process ${commandName}` : "process output",
        safeSummary,
        metadata: {
          mode: entry.firewallMode,
          status: entry.status,
          exitCode: entry.exitCode,
          signal: entry.signal,
        },
      });
      entry.hermesReferences = [reference];
      const routing = asObject(entry.routing ?? {});
      entry.routing = {
        ...routing,
        firewallMode: entry.firewallMode,
        hermesReferences: entry.hermesReferences,
      };
    }
    this.persistProcess(entry);
    this.queueTerminalProcessUpdate(entry, "process_finished");
  }

  private persistProcess(entry: ReferenceProcess): void {
    const record: PersistedProcessRecord = {
      processId: entry.processId,
      status: entry.status,
      command: entry.command,
      cwd: entry.cwd,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      exitCode: entry.exitCode,
      signal: entry.signal,
      cancelRequested: entry.cancelRequested,
      timeoutMs: entry.timeoutMs,
      logs: entry.logs,
      routing: entry.routing,
    };
    this.stateStore.upsertProcess(record, Date.now());
  }

  private resolveFirewallSession(routing: Record<string, unknown>): ResolvedFirewallSession {
    const nowMs = Date.now();
    const requestedSessionId = asString(routing.firewallSession);
    if (requestedSessionId) {
      const existing = this.stateStore.getFirewallSession(requestedSessionId, nowMs);
      if (existing) {
        const touched = this.stateStore.touchFirewallSession(
          requestedSessionId,
          nowMs,
          FIREWALL_SESSION_TTL_MS,
        );
        const current = touched ?? existing;
        return {
          sessionId: current.sessionId,
          quarantineState: current.quarantineState,
          reused: true,
        };
      }
      this.log(`firewall session missing_or_expired id=${requestedSessionId}; creating replacement`);
    }

    const created = this.createFirewallSession(nowMs);
    return {
      sessionId: created.sessionId,
      quarantineState: created.quarantineState,
      reused: false,
    };
  }

  private createFirewallSession(nowMs: number): PersistedFirewallSessionRecord {
    const sessionId = `fw_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const quarantineState = this.currentPolicyDefaultQuarantine();
    const firewallMode = this.currentPolicyFirewallMode();
    return this.stateStore.createFirewallSession({
      sessionId,
      quarantineState,
      nowMs,
      ttlMs: FIREWALL_SESSION_TTL_MS,
      metadata: {
        source: "policy.defaultQuarantine",
        firewallMode,
        policyUpdatedAt: asNumber(this.policy.updatedAt) ?? nowMs,
      },
    });
  }

  private mapReferenceSummary(record: PersistedReferenceRecord): HermesReferenceSummary {
    return {
      refId: record.refId,
      sourceType: record.sourceType,
      title: record.title ?? null,
      safeSummary: record.safeSummary,
      metadata: record.metadata ?? null,
    };
  }

  private createHermesReference(params: {
    sourceType: string;
    processId?: string | null;
    toolName?: string | null;
    title?: string | null;
    safeSummary: string;
    metadata?: Record<string, unknown> | null;
  }): HermesReferenceSummary {
    const nowMs = Date.now();
    const created = this.stateStore.createReference({
      sourceType: params.sourceType,
      processId: params.processId ?? null,
      toolName: params.toolName ?? null,
      title: params.title ?? null,
      safeSummary: params.safeSummary,
      metadata: params.metadata ?? null,
      nowMs,
    });
    return this.mapReferenceSummary(created);
  }

  private buildSafeSummary(value: string): string {
    const normalized = value.replace(/\r/g, "");
    const charCount = normalized.length;
    if (charCount <= 0) {
      return "Sanitized output withheld by firewall mode (no output).";
    }
    const lineCount = normalized.split("\n").length;
    return `Sanitized output withheld by firewall mode (${lineCount} line(s), ${charCount} char(s)).`;
  }

  private enforceHermesCommandPolicy(params: {
    toolName: "system.run" | "process.start";
    commandName: string;
    firewallMode: FirewallMode;
    processId?: string | null;
    firewallSession?: string | null;
  }): void {
    if (params.firewallMode !== "hermes") return;
    const denyCommands = this.currentPolicyDenyCommands();
    if (!denyCommands.includes(params.commandName)) return;
    this.writeAuditEvent({
      type: "policy.deny",
      processId: params.processId ?? null,
      firewallSession: params.firewallSession ?? null,
      toolName: params.toolName,
      details: {
        mode: params.firewallMode,
        reason: "command_denied",
        commandName: params.commandName,
        denyCommands,
      },
    });
    throw new NodeToolError(
      "HERMES_POLICY_DENIED",
      JSON.stringify(
        {
          code: "HERMES_POLICY_DENIED",
          mode: params.firewallMode,
          decision: "deny",
          reason: "command_denied",
          commandName: params.commandName,
          denyCommands,
        },
        null,
        2,
      ),
      false,
    );
  }

  private readProcessFirewallMode(routing: Record<string, unknown> | null): FirewallMode {
    return parseFirewallMode(asString(asObject(routing ?? {}).firewallMode), "transparent");
  }

  private readProcessHermesReferences(routing: Record<string, unknown> | null): HermesReferenceSummary[] {
    const refsRaw = asObject(routing ?? {}).hermesReferences;
    if (!Array.isArray(refsRaw)) return [];
    const out: HermesReferenceSummary[] = [];
    for (const item of refsRaw) {
      const obj = asObject(item);
      const refId = asString(obj.refId);
      const sourceType = asString(obj.sourceType);
      const safeSummary = asString(obj.safeSummary);
      if (!refId || !sourceType || !safeSummary) continue;
      const metadataObj = asObject(obj.metadata);
      out.push({
        refId,
        sourceType,
        title: asString(obj.title) ?? null,
        safeSummary,
        metadata: Object.keys(metadataObj).length > 0 ? metadataObj : null,
      });
    }
    return out;
  }

  private resolveProcessHermesReferences(entry: ReferenceProcess): HermesReferenceSummary[] {
    if (entry.hermesReferences.length > 0) return entry.hermesReferences;
    const refs = this.stateStore.listReferencesByProcessId(entry.processId, 20).map((row) => this.mapReferenceSummary(row));
    if (refs.length > 0) {
      entry.hermesReferences = refs;
    }
    return entry.hermesReferences;
  }

  private writeAuditEvent(params: {
    type: string;
    processId?: string | null;
    firewallSession?: string | null;
    actor?: string | null;
    toolName?: string | null;
    details?: Record<string, unknown> | null;
    createdAt?: number;
  }): void {
    try {
      this.stateStore.appendAuditEvent({
        createdAt: params.createdAt ?? Date.now(),
        type: params.type,
        processId: params.processId ?? null,
        firewallSession: params.firewallSession ?? null,
        actor: params.actor ?? this.senderId,
        toolName: params.toolName ?? null,
        details: params.details ?? null,
      });
    } catch (err) {
      this.log(
        `audit append failed type=${params.type} error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private queueTerminalProcessUpdate(entry: ReferenceProcess, reason: string): void {
    const deliveryId = `dlv_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const hermesEnabled = entry.firewallMode !== "transparent";
    const summary = hermesEnabled ? this.buildSafeSummary(entry.logs) : truncateOutput(entry.logs, 6_000);
    const references = hermesEnabled ? this.resolveProcessHermesReferences(entry) : [];
    const payload: Record<string, unknown> = {
      processId: entry.processId,
      status: entry.status,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      exitCode: entry.exitCode,
      signal: entry.signal,
      summary,
      deliveryId,
      deliveryReason: reason,
      ts: Date.now(),
      firewallMode: entry.firewallMode,
      ...(hermesEnabled
        ? {
            hermes: {
              mode: entry.firewallMode,
              sanitized: true,
              references,
            },
          }
        : {}),
      ...(entry.routing ? { routing: entry.routing } : {}),
    };
    this.stateStore.enqueueOutbox({
      deliveryId,
      processId: entry.processId,
      payload,
      createdAt: Date.now(),
    });
    if (this.ready) this.sendOutboxEntry({ deliveryId, processId: entry.processId, payload, createdAt: Date.now(), delivered: false, deliveredAt: null });
  }

  private sendOutboxEntry(entry: PersistedOutboxEntry): boolean {
    return this.sendSignedEnvelope({
      type: "event",
      event: "process.update",
      payload: entry.payload,
    });
  }

  private drainOutbox(source: string): void {
    if (!this.ready || this.drainingOutbox) return;
    this.drainingOutbox = true;
    try {
      const pending = this.stateStore.listUndelivered(250);
      let sent = 0;
      for (const entry of pending) {
        const ok = this.sendOutboxEntry(entry);
        if (!ok) break;
        sent += 1;
      }
      if (pending.length > 0) {
        this.log(`outbox drain source=${source} pending=${pending.length} sent=${sent}`);
      }
    } finally {
      this.drainingOutbox = false;
    }
  }

  private emitProcessUpdate(entry: ReferenceProcess, status: ProcessStatus): void {
    this.sendSignedEnvelope({
      type: "event",
      event: "process.update",
      payload: {
        processId: entry.processId,
        status,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        exitCode: entry.exitCode,
        signal: entry.signal,
        firewallMode: entry.firewallMode,
        ts: Date.now(),
      },
    });
  }

  private serializeProcess(entry: ReferenceProcess, includeLogs: boolean): Record<string, unknown> {
    const hermesReferences = entry.firewallMode !== "transparent" ? this.resolveProcessHermesReferences(entry) : [];
    return {
      processId: entry.processId,
      command: entry.command,
      cwd: entry.cwd,
      status: entry.status,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      exitCode: entry.exitCode,
      signal: entry.signal,
      cancelRequested: entry.cancelRequested,
      timeoutMs: entry.timeoutMs,
      logChars: entry.logs.length,
      firewallMode: entry.firewallMode,
      ...(includeLogs ? { logs: entry.logs } : {}),
      ...(entry.firewallMode !== "transparent"
        ? {
            hermes: {
              mode: entry.firewallMode,
              sanitized: true,
              references: hermesReferences,
            },
          }
        : {}),
      ...(entry.routing ? { routing: entry.routing } : {}),
    };
  }

  private cancelProcess(
    entry: ReferenceProcess,
    params: {
      signal: NodeJS.Signals;
      reason: string;
      killAfterMs: number;
    },
  ): void {
    entry.cancelRequested = true;
    this.persistProcess(entry);
    if (!entry.child || entry.status !== "running") return;
    try {
      entry.child.kill(params.signal);
    } catch {
      // ignore
    }
    this.appendProcessLog(entry, `cancel requested (${params.reason}) using ${params.signal}\n`, "stderr");
    if (params.signal !== "SIGKILL" && params.killAfterMs > 0) {
      if (entry.killTimer) clearTimeout(entry.killTimer);
      entry.killTimer = setTimeout(() => {
        if (!entry.child || entry.status !== "running") return;
        try {
          entry.child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, params.killAfterMs);
      entry.killTimer.unref?.();
    }
  }

  private terminateAllProcesses(reason: string): void {
    for (const entry of this.processes.values()) {
      if (entry.timeoutTimer) {
        clearTimeout(entry.timeoutTimer);
        entry.timeoutTimer = null;
      }
      if (entry.killTimer) {
        clearTimeout(entry.killTimer);
        entry.killTimer = null;
      }
      if (entry.child && entry.status === "running") {
        this.cancelProcess(entry, {
          signal: "SIGTERM",
          reason: `node shutdown: ${reason}`,
          killAfterMs: 2_000,
        });
        this.appendProcessLog(entry, `node shutdown requested while process was running\n`, "stderr");
        continue;
      }
      if (entry.status === "queued") {
        entry.status = "cancelled";
        entry.cancelRequested = true;
        entry.endedAt = Date.now();
        this.appendProcessLog(entry, `node shutdown before process start: ${reason}\n`, "stderr");
        this.persistProcess(entry);
        this.queueTerminalProcessUpdate(entry, "shutdown_queued");
      }
    }
  }

  private sendCapsAdvertise(): void {
    if (!this.ready) return;
    const firewallMode = this.currentPolicyFirewallMode();
    this.sendSignedEnvelope({
      type: "event",
      event: "caps.advertise",
      payload: {
        capabilities: this.advertisedCapabilities(),
        tags: ["reference-node"],
        firewallMode,
        timestamp: Date.now(),
      },
    });
  }

  private sendSignedEnvelope(
    envelope: Omit<RequestEnvelope, "ts" | "sender" | "sig"> | Omit<ResponseEnvelope, "ts" | "sender" | "sig"> | Omit<EventEnvelope, "ts" | "sender" | "sig">,
  ): boolean {
    const ws = this.requireOpenSocket();
    if (!ws) return false;
    const withMeta = {
      ...envelope,
      ts: Date.now(),
      sender: this.senderId,
    };
    const sig = signEnvelope(withMeta, this.identity.privateKey);
    try {
      ws.send(
        JSON.stringify({
          ...withMeta,
          sig,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  private get senderId(): string {
    return `node:${this.config.nodeId}`;
  }

  private requireOpenSocket(): WebSocket | null {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return null;
    return this.ws;
  }

  private closeSocket(code: number, reason: string): void {
    if (!this.ws) return;
    try {
      this.ws.close(code, truncateOutput(reason, 120));
    } catch {
      try {
        this.ws.terminate();
      } catch {
        // ignore
      }
    }
  }

  private log(line: string): void {
    process.stdout.write(`[reference-node] ${new Date().toISOString()} ${line}\n`);
  }
}

function parseArgs(argv: string[]): {
  help: boolean;
  values: Record<string, string>;
} {
  const values: Record<string, string> = {};
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).trim();
    const next = argv[i + 1];
    if (!key) continue;
    if (!next || next.startsWith("--")) {
      values[key] = "true";
      continue;
    }
    values[key] = next;
    i += 1;
  }
  return { help, values };
}

function buildConfig(values: Record<string, string>): Config {
  const hostId = os.hostname().replace(/[^a-zA-Z0-9_-]/g, "-");
  const nodeId = values["node-id"] ?? process.env.NEXUS_NODE_ID ?? `reference-${hostId}`;
  const displayName = values.name ?? process.env.NEXUS_NODE_NAME ?? "Nexus Reference Node";
  const gatewayUrl =
    values.gateway ?? process.env.NEXUS_NODE_GATEWAY_URL ?? "ws://127.0.0.1:18789/nx/nodes";
  const gatewayTlsFingerprintRaw =
    values["gateway-tls-fingerprint"] ?? process.env.NEXUS_NODE_GATEWAY_TLS_FINGERPRINT ?? "";
  const gatewayTlsFingerprint = normalizeFingerprint256(gatewayTlsFingerprintRaw);
  if (gatewayTlsFingerprintRaw.trim() && !gatewayTlsFingerprint) {
    throw new Error(
      "Invalid gateway TLS fingerprint format. Expected SHA-256 fingerprint with 64 hex chars (with or without ':' separators).",
    );
  }
  const insecureAllowNonLoopbackWs =
    (values["insecure-allow-nonloopback-ws"] ?? process.env.NEXUS_NODE_INSECURE_ALLOW_NONLOOPBACK_WS ?? "").trim() ===
    "1";
  validateGatewayTransportPolicy({
    gatewayUrl,
    gatewayTlsFingerprint,
    insecureAllowNonLoopbackWs,
  });
  const stateDir =
    values["state-dir"] ??
    process.env.NEXUS_NODE_STATE_DIR ??
    path.join(process.cwd(), ".nexus-node");
  const policyRequired =
    (values["policy-required"] ?? process.env.NEXUS_NODE_POLICY_REQUIRED ?? "").trim() === "1";
  const capabilities = splitCsv(values.caps ?? process.env.NEXUS_NODE_CAPS, DEFAULT_CAPABILITIES);
  const allowCommands = new Set(
    splitCsv(values.allow ?? process.env.NEXUS_NODE_ALLOW_COMMANDS, DEFAULT_ALLOW_COMMANDS),
  );
  const runTimeoutMs = clampInt(values["run-timeout-ms"] ?? process.env.NEXUS_NODE_RUN_TIMEOUT_MS, 1_000, 300_000) ?? 60_000;
  const reconnectMinMs =
    clampInt(values["reconnect-min-ms"] ?? process.env.NEXUS_NODE_RECONNECT_MIN_MS, 500, 60_000) ?? 2_000;
  const reconnectMaxMs =
    clampInt(values["reconnect-max-ms"] ?? process.env.NEXUS_NODE_RECONNECT_MAX_MS, reconnectMinMs, 300_000) ?? 30_000;
  const maxClockSkewMs =
    clampInt(values["max-clock-skew-ms"] ?? process.env.NEXUS_NODE_MAX_CLOCK_SKEW_MS, 5_000, 600_000) ?? 120_000;
  const insecureSkipGatewayProof =
    (values["insecure-skip-gateway-proof"] ?? process.env.NEXUS_NODE_INSECURE_SKIP_GATEWAY_PROOF ?? "").trim() === "1";

  return {
    gatewayUrl,
    gatewayTlsFingerprint,
    stateDir: path.resolve(stateDir),
    policyRequired,
    nodeId,
    displayName,
    capabilities,
    allowCommands,
    runTimeoutMs,
    reconnectMinMs,
    reconnectMaxMs,
    maxClockSkewMs,
    insecureAllowNonLoopbackWs,
    insecureSkipGatewayProof,
  };
}

function validateGatewayTransportPolicy(params: {
  gatewayUrl: string;
  gatewayTlsFingerprint: string | null;
  insecureAllowNonLoopbackWs: boolean;
}): void {
  let parsed: URL;
  try {
    parsed = new URL(params.gatewayUrl);
  } catch {
    throw new Error(`Invalid gateway URL: ${params.gatewayUrl}`);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`Gateway URL must use ws:// or wss:// (got ${parsed.protocol}).`);
  }
  const loopback = isLoopbackHost(parsed.hostname);
  if (!loopback && parsed.protocol !== "wss:" && !params.insecureAllowNonLoopbackWs) {
    throw new Error(
      `TLS is required for non-loopback gateway endpoints. Use wss:// for ${parsed.hostname} or set ` +
        "NEXUS_NODE_INSECURE_ALLOW_NONLOOPBACK_WS=1 for debug-only development.",
    );
  }
  if (parsed.protocol === "ws:" && params.gatewayTlsFingerprint) {
    throw new Error("Gateway TLS fingerprint pinning requires a wss:// gateway URL.");
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1") return true;
  if (normalized === "host.docker.internal") return true;
  if (normalized.startsWith("127.")) return true;
  return normalized.endsWith(".localhost");
}

function normalizeFingerprint256(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hex = trimmed.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  if (hex.length !== 64) return null;
  return hex.match(/.{1,2}/g)?.join(":") ?? null;
}

async function loadOrCreateIdentity(stateDir: string): Promise<NodeIdentity> {
  const authDir = path.join(stateDir, "auth");
  const privateKeyPath = path.join(authDir, "node-ed25519-private.pem");
  const publicKeyPath = path.join(authDir, "node-ed25519-public.pem");
  await fs.mkdir(authDir, { recursive: true });

  let privatePem: string | null = null;
  let publicPem: string | null = null;
  try {
    privatePem = await fs.readFile(privateKeyPath, "utf8");
    publicPem = await fs.readFile(publicKeyPath, "utf8");
  } catch {
    const pair = generateKeyPairSync("ed25519");
    privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    publicPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    await fs.writeFile(privateKeyPath, privatePem, { mode: 0o600 });
    await fs.writeFile(publicKeyPath, publicPem, { mode: 0o644 });
  }

  const privateKey = createPrivateKey(privatePem);
  const publicKey = createPublicKey(publicPem);
  const parsed = parsePublicKey(publicPem);
  if (!parsed) throw new Error("Failed to parse generated node public key.");

  return {
    privateKey,
    publicKey,
    publicKeyRaw: parsed.raw,
    fingerprint: parsed.fingerprint,
    privateKeyPath,
    publicKeyPath,
  };
}

function parseEnvelope(value: Record<string, unknown>): AnyEnvelope | null {
  const type = asString(value.type);
  const ts = asNumber(value.ts);
  const sender = asString(value.sender);
  const sig = asString(value.sig);
  if (!type || !ts || !sender || !sig) return null;

  if (type === "req") {
    const id = asString(value.id);
    const method = asString(value.method);
    if (!id || !method) return null;
    return {
      type: "req",
      id,
      ts,
      sender,
      sig,
      method,
      params: value.params,
    };
  }
  if (type === "res") {
    const ok = value.ok;
    if (typeof ok !== "boolean") return null;
    return {
      type: "res",
      id: asString(value.id),
      ts,
      sender,
      sig,
      ok,
      payload: value.payload,
      error: asObject(value.error) as ResponseEnvelope["error"],
    };
  }
  if (type === "event") {
    const event = asString(value.event);
    if (!event) return null;
    return {
      type: "event",
      ts,
      sender,
      sig,
      event,
      payload: value.payload,
    };
  }
  return null;
}

function verifyEnvelopeSignature(envelope: Record<string, unknown>, publicKey: KeyObject): boolean {
  const sig = asString(envelope.sig);
  if (!sig) return false;
  return verifyDetachedPayload(withoutSig(envelope), sig, publicKey);
}

function buildHandshakeTranscript(params: {
  nodeId: string;
  sessionId: string;
  nodeNonce: string;
  gatewayNonce: string;
}): Record<string, unknown> {
  return {
    protocol: "nexus-node-v1",
    kind: "connect-proof",
    nodeId: params.nodeId,
    sessionId: params.sessionId,
    nodeNonce: params.nodeNonce,
    gatewayNonce: params.gatewayNonce,
  };
}

async function execShell(paramsCommand: string, opts: {
  cwd?: string;
  timeoutMs: number;
  env?: Record<string, string>;
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: string | null;
  timedOut: boolean;
}> {
  return await new Promise((resolve) => {
    exec(
      paramsCommand,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({
            stdout,
            stderr,
            exitCode: 0,
            signal: null,
            timedOut: false,
          });
          return;
        }
        const anyErr = err as Error & { code?: number | string; signal?: string; killed?: boolean };
        const timedOut =
          Boolean(anyErr.killed) &&
          (String(anyErr.message).toLowerCase().includes("timed out") ||
            String(anyErr.code ?? "").toUpperCase() === "ETIMEDOUT");
        const exitCode = typeof anyErr.code === "number" ? anyErr.code : 1;
        resolve({
          stdout,
          stderr,
          exitCode,
          signal: anyErr.signal ?? null,
          timedOut,
        });
      },
    );
  });
}

function isAllowedCommand(commandName: string, allowCommands: Set<string>): boolean {
  if (allowCommands.has("*")) return true;
  return allowCommands.has(commandName);
}

function hasDisallowedShellSyntax(command: string): boolean {
  // Keep process/system.run in strict single-command mode so allowlist checks
  // cannot be bypassed via shell chaining, pipes, redirects, or substitutions.
  return /(?:&&|\|\||[;&|`$><\n\r])/.test(command);
}

function validateAllowlistedCommand(
  command: string,
  allowCommands: Set<string>,
): { ok: true; commandName: string } | { ok: false; message: string } {
  if (hasDisallowedShellSyntax(command)) {
    return {
      ok: false,
      message:
        "Shell control operators are not allowed. Use a single allowlisted command without chaining, pipes, redirects, or substitutions.",
    };
  }
  const commandName = parseCommandName(command);
  if (!commandName) {
    return {
      ok: false,
      message: "Unable to parse command name.",
    };
  }
  if (!isAllowedCommand(commandName, allowCommands)) {
    return {
      ok: false,
      message: `Command "${commandName}" is not allowlisted for this node.`,
    };
  }
  return {
    ok: true,
    commandName,
  };
}

function parseCommandName(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^([^\s]+)/);
  return match?.[1] ?? null;
}

function normalizeSignal(value: string | null): NodeJS.Signals | null {
  switch (value) {
    case "SIGTERM":
    case "SIGINT":
    case "SIGKILL":
      return value;
    default:
      return null;
  }
}

function parseQuarantineState(value: unknown, fallback: "none" | "soft" | "hard"): "none" | "soft" | "hard" {
  if (typeof value !== "string") return fallback;
  switch (value.trim()) {
    case "none":
      return "none";
    case "soft":
      return "soft";
    case "hard":
      return "hard";
    default:
      return fallback;
  }
}

function parseFirewallMode(value: string | null, fallback: FirewallMode): FirewallMode {
  if (!value) return fallback;
  switch (value.trim()) {
    case "transparent":
      return "transparent";
    case "audit-only":
      return "audit-only";
    case "hermes":
      return "hermes";
    default:
      return fallback;
  }
}

function parsePolicyDenyCommands(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const commandName = parseCommandName(trimmed) ?? trimmed;
    if (!commandName) continue;
    out.push(commandName);
  }
  return [...new Set(out.values())].sort((a, b) => a.localeCompare(b));
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function splitCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value || !value.trim()) return [...fallback];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function clampInt(value: unknown, min: number, max: number): number | null {
  const str = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  if (!str) return null;
  const num = Number(str);
  if (!Number.isFinite(num)) return null;
  return Math.min(max, Math.max(min, Math.floor(num)));
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asStringMap(value: unknown): Record<string, string> {
  const obj = asObject(value);
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(obj)) {
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

function parseSymbolKind(value: string | null): SymbolKind | null {
  if (!value) return null;
  switch (value) {
    case "contact":
    case "account":
    case "secret":
    case "user":
      return value;
    default:
      return null;
  }
}

function truncateOutput(text: string, maxChars: number = MAX_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const omitted = text.length - maxChars;
  return `${text.slice(0, half)}\n\n[... truncated ${omitted} chars ...]\n\n${text.slice(-half)}`;
}

function toBase64Url(value: Buffer): string {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Loose(value: string): Buffer | null {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized) return null;
  if (/[^A-Za-z0-9+/=]/.test(normalized)) return null;
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    return Buffer.from(padded, "base64");
  } catch {
    return null;
  }
}

function parsePublicKey(value: string): ParsedPublicKey | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let key: KeyObject | null = null;

  if (trimmed.includes("BEGIN PUBLIC KEY")) {
    try {
      key = createPublicKey(trimmed);
    } catch {
      key = null;
    }
  }

  if (!key) {
    const decoded = decodeBase64Loose(trimmed);
    if (decoded) {
      if (decoded.length === 32) {
        try {
          key = createPublicKey({
            key: Buffer.concat([ED25519_SPKI_RAW_PREFIX, decoded]),
            format: "der",
            type: "spki",
          });
        } catch {
          key = null;
        }
      } else {
        try {
          key = createPublicKey({ key: decoded, format: "der", type: "spki" });
        } catch {
          key = null;
        }
      }
    }
  }

  if (!key || key.asymmetricKeyType !== "ed25519") return null;
  const raw = publicKeyRawFromObject(key);
  if (!raw) return null;
  return {
    key,
    raw: toBase64Url(raw),
    fingerprint: createHash("sha256").update(raw).digest("hex"),
  };
}

function publicKeyRawFromObject(publicKey: KeyObject): Buffer | null {
  try {
    const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
    if (der.length !== ED25519_SPKI_RAW_PREFIX.length + 32) return null;
    if (!der.subarray(0, ED25519_SPKI_RAW_PREFIX.length).equals(ED25519_SPKI_RAW_PREFIX)) return null;
    return der.subarray(ED25519_SPKI_RAW_PREFIX.length);
  } catch {
    return null;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const body = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",");
    return `{${body}}`;
  }
  return JSON.stringify(String(value));
}

function withoutSig(value: Record<string, unknown>): Record<string, unknown> {
  const { sig: _sig, ...rest } = value;
  return rest;
}

function signDetachedPayload(payload: unknown, privateKey: KeyObject): string {
  const bytes = Buffer.from(stableStringify(payload), "utf8");
  return toBase64Url(sign(null, bytes, privateKey));
}

function verifyDetachedPayload(payload: unknown, signature: string, publicKey: KeyObject): boolean {
  const sigBytes = decodeBase64Loose(signature);
  if (!sigBytes) return false;
  const bytes = Buffer.from(stableStringify(payload), "utf8");
  try {
    return verify(null, bytes, publicKey, sigBytes);
  } catch {
    return false;
  }
}

function signEnvelope(envelopeWithoutSig: Record<string, unknown>, privateKey: KeyObject): string {
  return signDetachedPayload(envelopeWithoutSig, privateKey);
}

function printHelp(): void {
  process.stdout.write(
    [
      "Reference Nexus node (signed protocol + system.run/system.which + process primitives)",
      "",
      "Usage:",
      "  tsx examples/nexus-node/reference-node.ts [options]",
      "",
      "Options:",
      "  --gateway <url>                 Gateway websocket URL (default ws://127.0.0.1:18789/nx/nodes)",
      "  --gateway-tls-fingerprint <fp>  Pin SHA-256 cert fingerprint for wss:// gateways (self-signed friendly)",
      "  --node-id <id>                  Node ID (sender becomes node:<id>)",
      "  --name <display-name>           Node display name",
      "  --state-dir <dir>               Local state dir for keys (default ./.nexus-node)",
      "  --caps <csv>                    Capability list (default system.run,system.which,process.start,process.status,process.logs,process.cancel,policy.update,symbols.list,audit.query)",
      "  --allow <csv>                   Allowlisted command names for system.run",
      "  --policy-required 1             Fail startup when hermes-policy.json is missing/invalid",
      "  --run-timeout-ms <ms>           Max system.run timeout (default 60000)",
      "  --reconnect-min-ms <ms>         Minimum reconnect delay (default 2000)",
      "  --reconnect-max-ms <ms>         Maximum reconnect delay (default 30000)",
      "  --max-clock-skew-ms <ms>        Max accepted signed message skew (default 120000)",
      "  --insecure-allow-nonloopback-ws 1 Allow ws:// to non-loopback hosts (debug only; insecure)",
      "  --insecure-skip-gateway-proof 1 Skip challenge proof verification (debug only)",
      "  --help                          Show this help",
      "",
      "Examples:",
      "  tsx examples/nexus-node/reference-node.ts --gateway ws://127.0.0.1:18789/nx/nodes",
      "  tsx examples/nexus-node/reference-node.ts --allow \"echo,uname,ls\"",
      "",
    ].join("\n"),
  );
}

void main().catch((err) => {
  process.stderr.write(`[reference-node] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
