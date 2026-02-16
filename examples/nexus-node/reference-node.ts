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
  type PersistedOutboxEntry,
  type PersistedProcessRecord,
} from "./state-store.js";

const ED25519_SPKI_RAW_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_OUTPUT_CHARS = 60_000;
const MAX_PROCESS_LOG_CHARS = 120_000;
const DELIVERED_OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CAPABILITIES = [
  "system.run",
  "system.which",
  "process.start",
  "process.status",
  "process.logs",
  "process.cancel",
];
const DEFAULT_ALLOW_COMMANDS = ["echo", "uname", "whoami", "pwd", "date"];

type ProcessStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

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
  routing: Record<string, unknown> | null;
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

  client.start();
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

  constructor(
    private readonly config: Config,
    private readonly identity: NodeIdentity,
    private readonly stateStore: ReferenceNodeStateStore,
  ) {}

  start(): void {
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
        this.persistProcess(entry);
        this.queueTerminalProcessUpdate(entry, "recovered_after_restart");
      }
    }
    const pendingOutbox = this.stateStore.countUndelivered();
    this.log(`restored processes=${persisted.length} outbox_pending=${pendingOutbox}`);
  }

  private sendConnectHello(): void {
    const ws = this.requireOpenSocket();
    if (!ws) return;
    this.nodeNonce = randomBytes(32).toString("base64url");
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
        firewallMode: "transparent",
        nodeNonce: this.nodeNonce,
        caps: this.config.capabilities,
        capabilities: this.config.capabilities,
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

    const cwd = asString(runArgs.cwd) ?? null;
    const env = asStringMap(runArgs.env);
    const timeoutMs = clampInt(runArgs.timeoutMs ?? runArgs.timeout, 1_000, this.config.runTimeoutMs) ?? null;
    const routingObj = asObject(params.routing);
    const processId = `proc_${randomUUID().slice(0, 12)}`;
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
      routing: Object.keys(routingObj).length > 0 ? routingObj : null,
    };
    this.processes.set(processId, entry);
    this.persistProcess(entry);

    try {
      const child = spawnChild(command, {
        shell: true,
        cwd: cwd ?? undefined,
        env: Object.keys(env).length > 0 ? { ...process.env, ...env } : process.env,
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

    const timeoutMs = clampInt(args.timeoutMs ?? args.timeout, 1_000, this.config.runTimeoutMs) ?? this.config.runTimeoutMs;
    const cwd = asString(args.cwd) ?? undefined;
    const env = asStringMap(args.env);

    const result = await execShell(command, {
      cwd,
      timeoutMs,
      env,
    });

    const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
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

  private queueTerminalProcessUpdate(entry: ReferenceProcess, reason: string): void {
    const deliveryId = `dlv_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const payload: Record<string, unknown> = {
      processId: entry.processId,
      status: entry.status,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      exitCode: entry.exitCode,
      signal: entry.signal,
      summary: truncateOutput(entry.logs, 6_000),
      deliveryId,
      deliveryReason: reason,
      ts: Date.now(),
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
        ts: Date.now(),
      },
    });
  }

  private serializeProcess(entry: ReferenceProcess, includeLogs: boolean): Record<string, unknown> {
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
      ...(includeLogs ? { logs: entry.logs } : {}),
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
    this.sendSignedEnvelope({
      type: "event",
      event: "caps.advertise",
      payload: {
        capabilities: this.config.capabilities,
        tags: ["reference-node"],
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
      "  --caps <csv>                    Capability list (default system.run,system.which,process.start,process.status,process.logs,process.cancel)",
      "  --allow <csv>                   Allowlisted command names for system.run",
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
