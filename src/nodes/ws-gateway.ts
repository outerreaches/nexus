import { createHash, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import type { ToolContext } from "../core/tools.js";
import {
  parseNodePublicKey,
  signDetachedPayload,
  signProtocolEnvelope,
  verifyDetachedPayload,
  verifyProtocolEnvelope,
  type GatewayNodeIdentity,
} from "./auth.js";
import { NodeRegistry } from "./registry.js";
import { NodeRoutingError, type NodeDrainResult, type NodeUpdateResult } from "./types.js";
import type { NodeBackend, NodeFirewallMode, NodeStatus, NodeTrustLevel } from "../storage/nodes.js";

type HandshakeChallenge = {
  nodeNonce: string;
  gatewayNonce: string;
  issuedAt: number;
};

type NodeSocketSession = {
  sessionId: string;
  nodeId: string | null;
  nodeSender: string | null;
  nodePublicKey: KeyObject | null;
  nodePublicKeyRaw: string | null;
  nodeFingerprint: string | null;
  authState: "connected" | "challenged" | "authenticated";
  pendingChallenge: HandshakeChallenge | null;
  openedAt: number;
  lastSeenAt: number;
  heartbeatTimer: NodeJS.Timeout | null;
  request: IncomingMessage;
};

type UpgradeCapableServer = {
  on(event: "upgrade", listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
  off(event: "upgrade", listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
};

type ProtocolRequest = {
  type: "req";
  id: string;
  ts: number;
  sender: string;
  sig: string;
  method: string;
  params?: unknown;
};

type ProtocolResponse = {
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

type ProtocolEvent = {
  type: "event";
  ts: number;
  sender: string;
  sig: string;
  event: string;
  payload?: unknown;
};

type ProtocolMessage = ProtocolRequest | ProtocolResponse | ProtocolEvent;

export type NodeTransportOperationResult = {
  ok: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
};

type PendingGatewayRequest = {
  id: string;
  nodeId: string;
  sessionId: string;
  method: string;
  createdAt: number;
  timeout: NodeJS.Timeout;
  onSettle?: () => void;
  resolve: (response: ProtocolResponse) => void;
  reject: (error: NodeRoutingError) => void;
};

type NodeProcessEventContext = {
  nodeId: string;
  sessionId: string;
  payload: Record<string, unknown>;
  receivedAt: number;
};

export type NodeWebhookEventContext = {
  nodeId: string;
  sessionId: string;
  event: string;
  payload: Record<string, unknown>;
  receivedAt: number;
};

type SymbolCatalogCache = {
  fetchedAt: number;
  generatedAt: number | null;
  counts: {
    keys: number;
    symbols: number;
  };
  catalog: Record<string, unknown>;
  symbols: string[];
};

// Wire-protocol version range this gateway speaks. Raise MAX (and add handling)
// when the protocol changes; raise MIN to drop support for old node builds. Nodes
// that predate the explicit `protocolVersion` field are treated as v1.
export const MIN_SUPPORTED_NODE_PROTOCOL = 1;
export const MAX_SUPPORTED_NODE_PROTOCOL = 1;
export const GATEWAY_NODE_PROTOCOL = 1;

export class NodeWebSocketGateway {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sessions = new Map<WebSocket, NodeSocketSession>();
  private readonly activeNodeSessions = new Map<string, string>();
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxMessageSkewMs: number;
  private readonly challengeTtlMs: number;
  private readonly symbolCatalogRefreshMinIntervalMs: number;
  private readonly pendingGatewayRequests = new Map<string, PendingGatewayRequest>();
  private readonly symbolCatalogRefreshInFlight = new Set<string>();
  private readonly symbolCatalogRefreshLastAt = new Map<string, number>();
  private readonly identity: GatewayNodeIdentity;
  private readonly requireMessageSignatures: boolean;
  private readonly gatewaySender: string;
  private server: UpgradeCapableServer | null = null;

  constructor(
    private readonly deps: {
      identity: GatewayNodeIdentity;
      registry: NodeRegistry;
      isStandby: () => boolean;
      log: (line: string) => void;
      heartbeatIntervalMs?: number;
      heartbeatTimeoutMs?: number;
      requestTimeoutMs?: number;
      maxMessageSkewMs?: number;
      challengeTtlMs?: number;
      symbolCatalogRefreshMinIntervalMs?: number;
      requireMessageSignatures?: boolean;
      gatewaySender?: string;
      onProcessUpdate?: (ctx: NodeProcessEventContext) => Promise<boolean>;
      onLogAppend?: (ctx: NodeProcessEventContext) => Promise<void>;
      onWebhookIngress?: (ctx: NodeWebhookEventContext) => Promise<void>;
    },
  ) {
    this.identity = deps.identity;
    this.heartbeatIntervalMs = Math.max(5_000, deps.heartbeatIntervalMs ?? 30_000);
    this.heartbeatTimeoutMs = Math.max(this.heartbeatIntervalMs * 2, deps.heartbeatTimeoutMs ?? 95_000);
    this.requestTimeoutMs = Math.max(2_000, deps.requestTimeoutMs ?? 60_000);
    this.maxMessageSkewMs = Math.max(5_000, deps.maxMessageSkewMs ?? 120_000);
    this.challengeTtlMs = Math.max(5_000, deps.challengeTtlMs ?? 30_000);
    this.symbolCatalogRefreshMinIntervalMs = Math.max(5_000, deps.symbolCatalogRefreshMinIntervalMs ?? 15_000);
    this.requireMessageSignatures = deps.requireMessageSignatures ?? true;
    this.gatewaySender = deps.gatewaySender ?? "gateway:primary";
  }

  attach(server: UpgradeCapableServer): void {
    if (this.server) return;
    this.server = server;
    server.on("upgrade", this.handleUpgrade);
    this.wss.on("connection", this.handleConnection);
    this.deps.log("nodes/ws: upgrade handler attached");
  }

  close(): void {
    if (this.server) {
      this.server.off("upgrade", this.handleUpgrade);
      this.server = null;
    }
    this.rejectAllPendingRequests("gateway shutdown");
    this.closeNodeConnections("gateway shutdown");
    this.wss.removeAllListeners();
    try {
      this.wss.close();
    } catch {
      // ignore
    }
  }

  closeNodeConnections(reason: string): void {
    for (const [ws, session] of this.sessions) {
      this.clearHeartbeat(session);
      try {
        ws.close(1012, truncateReason(reason));
      } catch {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
      }
    }
  }

  async executeTool(params: {
    nodeId: string;
    tool: string;
    args: unknown;
    ctx?: ToolContext;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  }): Promise<string> {
    const routing: Record<string, unknown> = {};
    if (params.ctx?.firewallSession) {
      routing.firewallSession = params.ctx.firewallSession;
    }
    if (params.ctx?.request) {
      routing.runId = params.ctx.request.runId ?? randomUUID();
      routing.parentRunId = params.ctx.request.parentRunId ?? null;
      routing.sessionId = params.ctx.request.sessionId;
      routing.channel = params.ctx.request.channel;
      routing.channelKey = params.ctx.request.channelKey;
    }
    const response = await this.requestNode({
      nodeId: params.nodeId,
      method: "tool.execute",
      params: {
        tool: params.tool,
        args: params.args,
        ...(Object.keys(routing).length > 0 ? { routing } : {}),
      },
      timeoutMs: params.timeoutMs,
      abortSignal: params.abortSignal ?? params.ctx?.abortSignal,
    });
    this.throwOnRemoteError(response, {
      code: "NODE_EXECUTION_FAILED",
      message: `Node ${params.nodeId} failed to execute ${params.tool}.`,
    });
    return this.normalizeToolResult(response.payload);
  }

  /** Drain handshake. Prefers the node-side node.drain method (authoritative — it
   *  accounts for background processes); falls back to the gateway's own pending
   *  request count for nodes that don't implement node.drain. Does not change the
   *  node's registry status (the caller owns that); this only reports progress. */
  async awaitNodeDrained(params: { nodeId: string; deadlineMs?: number }): Promise<NodeDrainResult> {
    const deadlineMs = Math.max(0, Math.min(600_000, params.deadlineMs ?? 60_000));
    const target = this.resolveActiveNodeSocket(params.nodeId);
    if (!target) {
      // No live session — nothing in flight on the gateway side to wait for.
      return { drained: true, remaining: 0, nodeAcked: false };
    }
    const sessionId = target.session.sessionId;

    // Authoritative path: ask the node. It refuses new work, lets in-flight work
    // finish, and replies { drained, remaining } at completion or its own deadline.
    try {
      const response = await this.requestNode({
        nodeId: params.nodeId,
        method: "node.drain",
        params: { deadlineMs },
        timeoutMs: deadlineMs + 10_000,
      });
      if (response.ok) {
        const payload = this.asObject(response.payload);
        const remaining = typeof payload.remaining === "number" && payload.remaining >= 0 ? payload.remaining : 0;
        const drained = payload.drained === true || remaining === 0;
        return { drained, remaining, nodeAcked: true };
      }
      this.deps.log(
        `nodes/ws: node.drain not honored by ${params.nodeId} (code=${response.error?.code ?? "?"}); using pending-request fallback`,
      );
    } catch (err) {
      this.deps.log(
        `nodes/ws: node.drain handshake failed for ${params.nodeId} (${err instanceof Error ? err.message : String(err)}); using pending-request fallback`,
      );
    }

    // Fallback: wait until no synchronous gateway->node requests remain for this
    // session, or the deadline elapses. Misses node-local background processes,
    // but is the best we can do without node cooperation.
    const countPending = (): number => {
      let n = 0;
      for (const pending of this.pendingGatewayRequests.values()) {
        if (pending.sessionId === sessionId && pending.method !== "node.drain") n += 1;
      }
      return n;
    };
    const startedAt = Date.now();
    while (countPending() > 0 && Date.now() - startedAt < deadlineMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
    const remaining = countPending();
    return { drained: remaining === 0, remaining, nodeAcked: false };
  }

  /** Coordinated update: drain in place → node.update → await reconnect → verify.
   *  The caller (node_manage) owns the draining status flip; this orchestrates the
   *  handshake and the reconnect/verify wait. */
  async updateNode(params: {
    nodeId: string;
    strategy?: string;
    ref?: string;
    deadlineMs?: number;
    drainDeadlineMs?: number;
  }): Promise<NodeUpdateResult> {
    const strategy = params.strategy ?? "local";
    const node = this.deps.registry.get(params.nodeId);
    if (!node) {
      return { ok: false, stage: "preflight", strategy, message: `Node ${params.nodeId} is not registered.` };
    }
    const target = this.resolveActiveNodeSocket(params.nodeId);
    if (!target) {
      return { ok: false, stage: "preflight", strategy, message: `Node ${params.nodeId} has no active session.` };
    }
    if (!node.capabilities.includes(`update.${strategy}`)) {
      return {
        ok: false,
        stage: "preflight",
        strategy,
        message:
          `Node ${params.nodeId} does not advertise update.${strategy}. Enable NEXUS_NODE_ALLOW_UPDATE on the node ` +
          `and include '${strategy}' in its update strategies.`,
      };
    }
    const preSessionId = target.session.sessionId;

    // 1) Drain in place (also flips registry status via the caller; here we just
    //    wait for in-flight work to settle).
    const drain = await this.awaitNodeDrained({
      nodeId: params.nodeId,
      ...(params.drainDeadlineMs !== undefined ? { deadlineMs: params.drainDeadlineMs } : {}),
    });

    // 2) Send node.update. The node acks, then restarts (which disconnects it).
    let accepted = false;
    try {
      const resp = await this.requestNode({
        nodeId: params.nodeId,
        method: "node.update",
        params: { strategy, ...(params.ref ? { ref: params.ref } : {}) },
        timeoutMs: 15_000,
      });
      if (!resp.ok) {
        return { ok: false, stage: "update", strategy, drain, message: resp.error?.message ?? "Node refused the update." };
      }
      accepted = this.asObject(resp.payload).accepted === true;
    } catch (err) {
      return {
        ok: false,
        stage: "update",
        strategy,
        drain,
        message: `node.update request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!accepted) {
      return { ok: false, stage: "update", strategy, drain, accepted: false, message: "Node did not accept the update." };
    }

    // 3) Await reconnect: a fresh session for this node, online, within the deadline.
    const deadlineMs = Math.max(10_000, Math.min(600_000, params.deadlineMs ?? 180_000));
    const startedAt = Date.now();
    let reconnected = false;
    while (Date.now() - startedAt < deadlineMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      const sid = this.activeNodeSessions.get(params.nodeId);
      const current = this.deps.registry.get(params.nodeId);
      if (sid && sid !== preSessionId && current?.status === "online") {
        reconnected = true;
        break;
      }
    }
    if (!reconnected) {
      return {
        ok: false,
        stage: "reconnect",
        strategy,
        drain,
        accepted: true,
        message: `Node did not reconnect online within ${deadlineMs}ms after the update (it may be down — check the node host).`,
      };
    }

    // 4) Report the post-update version recorded from the new hello.
    const after = this.deps.registry.get(params.nodeId);
    const meta = this.asObject(after?.metadata);
    const protocolVersion = typeof meta.protocolVersion === "number" ? meta.protocolVersion : null;
    const appVersion = typeof meta.appVersion === "string" ? meta.appVersion : null;
    return {
      ok: true,
      stage: "complete",
      strategy,
      drain,
      accepted: true,
      reconnected: true,
      protocolVersion,
      appVersion,
      message:
        `Node ${params.nodeId} updated and reconnected online ` +
        `(protocol v${protocolVersion ?? "?"}${appVersion ? `, app ${appVersion}` : ""}).`,
    };
  }

  async executeRoutedCall(params: {
    nodeId: string;
    remoteName: string;
    args: unknown;
    ctx: ToolContext;
    timeoutMs?: number;
  }): Promise<string> {
    switch (params.remoteName) {
      case "system.run":
        return this.requestSystemRun(params);
      case "process.start":
        return this.requestProcessStart(params);
      case "process.status":
        return this.requestProcessStatus(params);
      case "process.logs":
        return this.requestProcessLogs(params);
      case "process.cancel":
        return this.requestProcessCancel(params);
      case "symbols.list":
        return this.requestSymbolsList(params);
      case "audit.query":
        return this.requestAuditQuery(params);
      case "mcp.list":
        return this.requestMcpList(params);
      case "mcp.call":
        return this.requestMcpCall(params);
      case "mcp.resources":
        return this.requestMcpResources(params);
      case "file.pull":
        return this.requestFilePull(params);
      case "file.push":
        return this.requestFilePush(params);
      default:
        return this.executeTool({
          nodeId: params.nodeId,
          tool: params.remoteName,
          args: params.args,
          ctx: params.ctx,
          timeoutMs: params.timeoutMs,
          abortSignal: params.ctx.abortSignal,
        });
    }
  }

  async requestTransportOperation(params: {
    nodeId: string;
    method: string;
    params?: unknown;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  }): Promise<NodeTransportOperationResult> {
    const response = await this.requestNode({
      nodeId: params.nodeId,
      method: params.method,
      params: params.params,
      timeoutMs: params.timeoutMs,
      abortSignal: params.abortSignal,
    });
    if (response.ok) {
      return {
        ok: true,
        payload: response.payload,
      };
    }
    return {
      ok: false,
      error: {
        code: response.error?.code ?? "NODE_EXECUTION_FAILED",
        message: response.error?.message ?? "node transport request failed",
        retryable: response.error?.retryable,
      },
    };
  }

  private async requestNode(params: {
    nodeId: string;
    method: string;
    params?: unknown;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  }): Promise<ProtocolResponse> {
    const target = this.resolveActiveNodeSocket(params.nodeId);
    if (!target) {
      throw new NodeRoutingError("NODE_SOCKET_UNAVAILABLE", `Node ${params.nodeId} does not have an active websocket session.`);
    }

    const requestId = randomUUID();
    const timeoutMs = Math.max(2_000, params.timeoutMs ?? this.requestTimeoutMs);
    return await new Promise<ProtocolResponse>((resolve, reject) => {
      if (params.abortSignal?.aborted) {
        reject(new NodeRoutingError("NODE_REQUEST_ABORTED", `Request aborted before send (${params.method}).`));
        return;
      }
      const timeout = setTimeout(() => {
        this.pendingGatewayRequests.delete(requestId);
        reject(
          new NodeRoutingError(
            "NODE_RESPONSE_TIMEOUT",
            `Timed out waiting for ${params.method} response from node ${params.nodeId} after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);
      timeout.unref?.();

      let aborted = false;
      let removeAbortListener: (() => void) | undefined;
      const onAbort = () => {
        if (aborted) return;
        aborted = true;
        const pending = this.pendingGatewayRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingGatewayRequests.delete(requestId);
          pending.onSettle?.();
        }
        reject(new NodeRoutingError("NODE_REQUEST_ABORTED", `Request aborted (${params.method}).`));
      };
      if (params.abortSignal) {
        params.abortSignal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => params.abortSignal?.removeEventListener("abort", onAbort);
      }

      this.pendingGatewayRequests.set(requestId, {
        id: requestId,
        nodeId: params.nodeId,
        sessionId: target.session.sessionId,
        method: params.method,
        createdAt: Date.now(),
        timeout,
        onSettle: removeAbortListener,
        resolve,
        reject,
      });

      const sent = this.sendSignedEnvelope(target.ws, {
        type: "req",
        id: requestId,
        method: params.method,
        params: params.params,
      });
      if (!sent) {
        const pending = this.pendingGatewayRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingGatewayRequests.delete(requestId);
          pending.onSettle?.();
        }
        reject(
          new NodeRoutingError(
            "NODE_SOCKET_UNAVAILABLE",
            `Failed to send ${params.method} request to node ${params.nodeId}; websocket is not writable.`,
          ),
        );
      }
    });
  }

  private throwOnRemoteError(
    response: ProtocolResponse,
    fallback: {
      code: string;
      message: string;
    },
  ): void {
    if (response.ok) return;
    const code = response.error?.code ?? fallback.code;
    const message = response.error?.message ?? fallback.message;
    const err = new Error(message) as Error & { code: string };
    err.name = "NodeRemoteExecutionError";
    err.code = code;
    throw err;
  }

  private buildProcessStartRequest(params: {
    argsObj: Record<string, unknown>;
    ctx: ToolContext;
  }): {
    requestParams: Record<string, unknown>;
    command: string;
    timeoutMs: number | undefined;
  } {
    const command = this.asString(params.argsObj.command);
    if (!command) {
      throw new NodeRoutingError("NODE_PROTOCOL_ERROR", "process_start requires a non-empty `command`.");
    }
    const cwd = this.asString(params.argsObj.cwd) ?? undefined;
    const timeout = this.asNumber(params.argsObj.timeoutMs ?? params.argsObj.timeout) ?? undefined;
    const notifyObj = this.asObject(params.argsObj.notify);
    const notifyMode = this.asString(notifyObj.mode);
    const notifyChatId = this.asNumber(notifyObj.chatId);
    const notifyPreset = this.asString(notifyObj.preset);
    const routing: Record<string, unknown> = {};
    if (params.ctx.firewallSession) {
      routing.firewallSession = params.ctx.firewallSession;
    }
    if (params.ctx.request) {
      routing.runId = params.ctx.request.runId ?? randomUUID();
      routing.parentRunId = params.ctx.request.parentRunId ?? null;
      routing.sessionId = params.ctx.request.sessionId;
      routing.channel = params.ctx.request.channel;
      routing.channelKey = params.ctx.request.channelKey;
    }
    if (notifyMode || notifyChatId || notifyPreset) {
      routing.notify = {
        ...(notifyMode ? { mode: notifyMode } : {}),
        ...(notifyChatId ? { chatId: notifyChatId } : {}),
        ...(notifyPreset ? { preset: notifyPreset } : {}),
      };
    }
    const requestParams: Record<string, unknown> = {
      tool: "system.run",
      args: {
        command,
        ...(cwd ? { cwd } : {}),
        ...(timeout ? { timeoutMs: timeout } : {}),
      },
    };
    if (Object.keys(routing).length > 0) {
      requestParams.routing = routing;
    }
    return {
      requestParams,
      command,
      timeoutMs: timeout,
    };
  }

  private async requestSystemRun(params: {
    nodeId: string;
    args: unknown;
    ctx: ToolContext;
    timeoutMs?: number;
  }): Promise<string> {
    const argsObj = this.asObject(params.args);
    const startRequest = this.buildProcessStartRequest({
      argsObj,
      ctx: params.ctx,
    });
    const startResponse = await this.requestNode({
      nodeId: params.nodeId,
      method: "process.start",
      params: startRequest.requestParams,
      timeoutMs: params.timeoutMs,
      abortSignal: params.ctx.abortSignal,
    });
    this.throwOnRemoteError(startResponse, {
      code: "NODE_EXECUTION_FAILED",
      message: `Node ${params.nodeId} failed to start remote process.`,
    });
    const startPayload = this.asObject(startResponse.payload);
    const processId = this.asString(startPayload.processId) ?? this.asString(startPayload.id);
    if (!processId) {
      throw new NodeRoutingError("NODE_PROTOCOL_ERROR", `Node ${params.nodeId} process.start response missing processId.`);
    }

    let finalStatusPayload: Record<string, unknown> | null = null;
    for (;;) {
      if (params.ctx.abortSignal?.aborted) {
        await this.cancelRemoteProcessBestEffort({
          nodeId: params.nodeId,
          processId,
          reason: "run_cancelled",
        });
        throw new NodeRoutingError("NODE_REQUEST_ABORTED", "Remote system.run cancelled by run stop.");
      }

      const statusResponse = await this.requestNode({
        nodeId: params.nodeId,
        method: "process.status",
        params: { processId },
        timeoutMs: params.timeoutMs,
        abortSignal: params.ctx.abortSignal,
      });
      this.throwOnRemoteError(statusResponse, {
        code: "NODE_EXECUTION_FAILED",
        message: `Node ${params.nodeId} failed to fetch process status.`,
      });
      finalStatusPayload = this.asObject(statusResponse.payload);
      const status = this.asString(finalStatusPayload.status) ?? "";
      if (status === "completed" || status === "failed" || status === "cancelled") break;
      await this.waitForAbortableDelay(250, params.ctx.abortSignal);
    }

    const logsResponse = await this.requestNode({
      nodeId: params.nodeId,
      method: "process.logs",
      params: { processId, maxChars: 50_000 },
      timeoutMs: params.timeoutMs,
      abortSignal: params.ctx.abortSignal,
    });
    this.throwOnRemoteError(logsResponse, {
      code: "NODE_EXECUTION_FAILED",
      message: `Node ${params.nodeId} failed to fetch process logs.`,
    });
    const logsPayload = this.asObject(logsResponse.payload);
    const logs = this.asString(logsPayload.logs) ?? this.normalizeStructuredResult(logsResponse.payload);

    const finalStatus = this.asString(finalStatusPayload?.status) ?? "";
    const exitCode = this.asNumber(finalStatusPayload?.exitCode);
    const signal = this.asString(finalStatusPayload?.signal);
    if (finalStatus === "completed" && (exitCode === null || exitCode === 0)) {
      return logs;
    }
    if (finalStatus === "cancelled") {
      return `ERROR: command cancelled (process=${processId})\n\n${logs}`;
    }
    const exitSummary = exitCode === null ? "exit=unknown" : `exit=${Math.floor(exitCode)}`;
    const signalSummary = signal ? ` signal=${signal}` : "";
    return `ERROR: command failed (${exitSummary}${signalSummary})\n\n${logs}`;
  }

  private async cancelRemoteProcessBestEffort(params: {
    nodeId: string;
    processId: string;
    reason: string;
  }): Promise<void> {
    try {
      await this.requestNode({
        nodeId: params.nodeId,
        method: "process.cancel",
        params: {
          processId: params.processId,
          signal: "SIGTERM",
          killAfterMs: 2_000,
          reason: params.reason,
        },
        timeoutMs: 10_000,
      });
    } catch {
      // Best-effort cancellation
    }
  }

  private async waitForAbortableDelay(ms: number, abortSignal?: AbortSignal): Promise<void> {
    if (!abortSignal) {
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
      return;
    }
    if (abortSignal.aborted) {
      throw new NodeRoutingError("NODE_REQUEST_ABORTED", "Request cancelled.");
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      timer.unref?.();
      const onAbort = () => {
        clearTimeout(timer);
        reject(new NodeRoutingError("NODE_REQUEST_ABORTED", "Request cancelled."));
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async requestProcessStart(params: {
    nodeId: string;
    args: unknown;
    ctx: ToolContext;
    timeoutMs?: number;
  }): Promise<string> {
    const argsObj = this.asObject(params.args);
    const request = this.buildProcessStartRequest({
      argsObj,
      ctx: params.ctx,
    });
    const response = await this.requestNode({
      nodeId: params.nodeId,
      method: "process.start",
      params: request.requestParams,
      timeoutMs: params.timeoutMs,
      abortSignal: params.ctx.abortSignal,
    });
    this.throwOnRemoteError(response, {
      code: "NODE_EXECUTION_FAILED",
      message: `Node ${params.nodeId} failed to start remote process.`,
    });
    return this.normalizeStructuredResult(response.payload);
  }

  private async requestProcessStatus(params: {
    nodeId: string;
    args: unknown;
    ctx: ToolContext;
    timeoutMs?: number;
  }): Promise<string> {
    const argsObj = this.asObject(params.args);
    const processId = this.extractProcessId(argsObj);
    if (!processId) {
      throw new NodeRoutingError("NODE_PROTOCOL_ERROR", "process_status requires process `id`.");
    }
    const response = await this.requestNode({
      nodeId: params.nodeId,
      method: "process.status",
      params: { processId },
      timeoutMs: params.timeoutMs,
      abortSignal: params.ctx.abortSignal,
    });
    this.throwOnRemoteError(response, {
      code: "NODE_EXECUTION_FAILED",
      message: `Node ${params.nodeId} failed to fetch process status.`,
    });
    return this.normalizeStructuredResult(response.payload);
  }

  private async requestProcessLogs(params: {
    nodeId: string;
    args: unknown;
    ctx: ToolContext;
    timeoutMs?: number;
  }): Promise<string> {
    const argsObj = this.asObject(params.args);
    const processId = this.extractProcessId(argsObj);
    if (!processId) {
      throw new NodeRoutingError("NODE_PROTOCOL_ERROR", "process_logs requires process `id`.");
    }
    const maxChars = this.asNumber(argsObj.maxChars) ?? undefined;
    const response = await this.requestNode({
      nodeId: params.nodeId,
      method: "process.logs",
      params: {
        processId,
        ...(maxChars ? { maxChars } : {}),
      },
      timeoutMs: params.timeoutMs,
      abortSignal: params.ctx.abortSignal,
    });
    this.throwOnRemoteError(response, {
      code: "NODE_EXECUTION_FAILED",
      message: `Node ${params.nodeId} failed to fetch process logs.`,
    });
    const payloadObj = this.asObject(response.payload);
    if (typeof payloadObj.logs === "string") return payloadObj.logs;
    return this.normalizeStructuredResult(response.payload);
  }

  private async requestProcessCancel(params: {
    nodeId: string;
    args: unknown;
    ctx: ToolContext;
    timeoutMs?: number;
  }): Promise<string> {
    const argsObj = this.asObject(params.args);
    const processId = this.extractProcessId(argsObj);
    if (!processId) {
      throw new NodeRoutingError("NODE_PROTOCOL_ERROR", "process_stop requires process `id`.");
    }
    const signal = this.asString(argsObj.signal) ?? undefined;
    const killAfterMs = this.asNumber(argsObj.killAfterMs) ?? undefined;
    const reason = this.asString(argsObj.reason) ?? signal ?? "gateway_cancel";
    const response = await this.requestNode({
      nodeId: params.nodeId,
      method: "process.cancel",
      params: {
        processId,
        ...(signal ? { signal } : {}),
        ...(killAfterMs ? { killAfterMs } : {}),
        reason,
      },
      timeoutMs: params.timeoutMs,
      abortSignal: params.ctx.abortSignal,
    });
    this.throwOnRemoteError(response, {
      code: "NODE_EXECUTION_FAILED",
      message: `Node ${params.nodeId} failed to cancel process.`,
    });
    return this.normalizeStructuredResult(response.payload);
  }

  private async requestSymbolsList(params: {
    nodeId: string;
    args: unknown;
    timeoutMs?: number;
  }): Promise<string> {
    const argsObj = this.asObject(params.args);
    const kind = this.asString(argsObj.kind);
    const includeFields = this.asBoolean(argsObj.includeFields);
    if (kind && kind !== "contact" && kind !== "account" && kind !== "secret" && kind !== "user") {
      throw new NodeRoutingError(
        "NODE_PROTOCOL_ERROR",
        `node_symbols_list kind must be one of: contact, account, secret, user (got ${kind}).`,
      );
    }
    const requestParams: Record<string, unknown> = {};
    if (kind) requestParams.kind = kind;
    if (includeFields !== null) requestParams.includeFields = includeFields;
    const response = await this.requestNode({
      nodeId: params.nodeId,
      method: "symbols.list",
      params: requestParams,
      timeoutMs: params.timeoutMs,
    });
    this.throwOnRemoteError(response, {
      code: "NODE_EXECUTION_FAILED",
      message: `Node ${params.nodeId} failed to list symbols catalog.`,
    });
    return this.normalizeStructuredResult(response.payload);
  }

  private async requestAuditQuery(params: {
    nodeId: string;
    args: unknown;
    timeoutMs?: number;
  }): Promise<string> {
    const argsObj = this.asObject(params.args);
    const limitRaw = this.asNumber(argsObj.limit);
    const requestParams: Record<string, unknown> = {
      limit: limitRaw !== null ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 100,
    };
    const cursorCreatedAt = this.asNumber(argsObj.cursorCreatedAt ?? argsObj.cursor);
    const type = this.asString(argsObj.type);
    const processId = this.asString(argsObj.processId) ?? this.asString(argsObj.process);
    const firewallSession = this.asString(argsObj.firewallSession);
    const actor = this.asString(argsObj.actor);
    if (cursorCreatedAt !== null) requestParams.cursorCreatedAt = cursorCreatedAt;
    if (type) requestParams.type = type;
    if (processId) requestParams.processId = processId;
    if (firewallSession) requestParams.firewallSession = firewallSession;
    if (actor) requestParams.actor = actor;
    const response = await this.requestNode({
      nodeId: params.nodeId,
      method: "audit.query",
      params: requestParams,
      timeoutMs: params.timeoutMs,
    });
    this.throwOnRemoteError(response, {
      code: "NODE_EXECUTION_FAILED",
      message: `Node ${params.nodeId} failed to query audit events.`,
    });
    return this.normalizeStructuredResult(response.payload);
  }

  private async requestMcpList(params: {
    nodeId: string;
    args: unknown;
    timeoutMs?: number;
  }): Promise<string> {
    const argsObj = this.asObject(params.args);
    const timeout = this.asNumber(argsObj.timeoutMs) ?? undefined;
    const includeTools = this.asBoolean(argsObj.includeTools);
    const includeResources = this.asBoolean(argsObj.includeResources);
    const serverId = this.asString(argsObj.serverId) ?? this.asString(argsObj.server);
    const requestParams: Record<string, unknown> = {};
    if (serverId) requestParams.serverId = serverId;
    if (includeTools !== null) requestParams.includeTools = includeTools;
    if (includeResources !== null) requestParams.includeResources = includeResources;
    const response = await this.requestNode({
      nodeId: params.nodeId,
      method: "mcp.list",
      params: requestParams,
      timeoutMs: timeout ?? params.timeoutMs,
    });
    this.throwOnRemoteError(response, {
      code: "NODE_EXECUTION_FAILED",
      message: `Node ${params.nodeId} failed to list MCP bridge targets.`,
    });
    return this.normalizeStructuredResult(response.payload);
  }

  private async requestMcpCall(params: {
    nodeId: string;
    args: unknown;
    timeoutMs?: number;
  }): Promise<string> {
    const argsObj = this.asObject(params.args);
    const timeout = this.asNumber(argsObj.timeoutMs) ?? undefined;
    const serverId = this.asString(argsObj.serverId) ?? this.asString(argsObj.server);
    const tool = this.asString(argsObj.tool) ?? this.asString(argsObj.name);
    const callArgs = this.asObject(argsObj.arguments ?? argsObj.args);
    if (!serverId) {
      throw new NodeRoutingError("NODE_PROTOCOL_ERROR", "node_mcp_call requires `serverId`.");
    }
    if (!tool) {
      throw new NodeRoutingError("NODE_PROTOCOL_ERROR", "node_mcp_call requires `tool`.");
    }
    const response = await this.requestNode({
      nodeId: params.nodeId,
      method: "mcp.call",
      params: {
        serverId,
        tool,
        arguments: callArgs,
      },
      timeoutMs: timeout ?? params.timeoutMs,
    });
    this.throwOnRemoteError(response, {
      code: "NODE_EXECUTION_FAILED",
      message: `Node ${params.nodeId} failed MCP tool call ${tool}.`,
    });
    return this.normalizeStructuredResult(response.payload);
  }

  private async requestMcpResources(params: {
    nodeId: string;
    args: unknown;
    timeoutMs?: number;
  }): Promise<string> {
    const argsObj = this.asObject(params.args);
    const timeout = this.asNumber(argsObj.timeoutMs) ?? undefined;
    const serverId = this.asString(argsObj.serverId) ?? this.asString(argsObj.server);
    if (!serverId) {
      throw new NodeRoutingError("NODE_PROTOCOL_ERROR", "node_mcp_resources requires `serverId`.");
    }
    const action = this.asString(argsObj.action) ?? (this.asString(argsObj.uri) ? "read" : "list");
    if (action !== "list" && action !== "read") {
      throw new NodeRoutingError("NODE_PROTOCOL_ERROR", "node_mcp_resources action must be `list` or `read`.");
    }
    const uri = this.asString(argsObj.uri);
    if (action === "read" && !uri) {
      throw new NodeRoutingError("NODE_PROTOCOL_ERROR", "node_mcp_resources read action requires `uri`.");
    }
    const limit = this.asNumber(argsObj.limit);
    const cursor = this.asString(argsObj.cursor);
    const requestParams: Record<string, unknown> = {
      serverId,
      action,
    };
    if (uri) requestParams.uri = uri;
    if (cursor) requestParams.cursor = cursor;
    if (limit !== null) requestParams.limit = Math.max(1, Math.min(500, Math.floor(limit)));
    const response = await this.requestNode({
      nodeId: params.nodeId,
      method: "mcp.resources",
      params: requestParams,
      timeoutMs: timeout ?? params.timeoutMs,
    });
    this.throwOnRemoteError(response, {
      code: "NODE_EXECUTION_FAILED",
      message: `Node ${params.nodeId} failed MCP resources request.`,
    });
    return this.normalizeStructuredResult(response.payload);
  }

  private async requestFilePull(params: {
    nodeId: string;
    args: unknown;
    ctx: ToolContext;
    timeoutMs?: number;
  }): Promise<string> {
    const argsObj = this.asObject(params.args);
    const remotePath = this.asString(argsObj.remotePath) ?? this.asString(argsObj.path);
    if (!remotePath) {
      throw new NodeRoutingError("NODE_PROTOCOL_ERROR", "node_file_pull requires `remotePath`.");
    }
    const overwrite = this.asBoolean(argsObj.overwrite) ?? false;
    const localPathArg = this.asString(argsObj.localPath) ?? this.asString(argsObj.savePath);
    const maxBytesRaw = this.asNumber(argsObj.maxBytes);
    const maxBytes = maxBytesRaw !== null ? Math.max(1_024, Math.min(50 * 1024 * 1024, Math.floor(maxBytesRaw))) : 5 * 1024 * 1024;
    const timeout = this.asNumber(argsObj.timeoutMs) ?? undefined;
    const response = await this.requestNode({
      nodeId: params.nodeId,
      method: "file.pull",
      params: {
        path: remotePath,
        maxBytes,
      },
      timeoutMs: timeout ?? params.timeoutMs,
    });
    this.throwOnRemoteError(response, {
      code: "NODE_EXECUTION_FAILED",
      message: `Node ${params.nodeId} failed file.pull for ${remotePath}.`,
    });
    const payload = this.asObject(response.payload);
    const contentBase64 = this.asString(payload.contentBase64);
    if (!contentBase64) {
      throw new NodeRoutingError("NODE_PROTOCOL_ERROR", "file.pull response missing contentBase64 payload.");
    }
    const bytes = this.decodeBase64Payload(contentBase64);
    if (bytes.length > maxBytes) {
      throw new NodeRoutingError(
        "NODE_PROTOCOL_ERROR",
        `Decoded file payload exceeded maxBytes (${bytes.length} > ${maxBytes}).`,
      );
    }
    const destinationPath = this.resolveGatewayTransferDestinationPath({
      localPath: localPathArg,
      remotePath,
      nodeId: params.nodeId,
      ctx: params.ctx,
    });
    if (!overwrite) {
      try {
        await fs.access(destinationPath);
        throw new NodeRoutingError(
          "NODE_PROTOCOL_ERROR",
          `node_file_pull destination exists: ${destinationPath} (set overwrite=true to replace).`,
        );
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code !== "ENOENT") throw err;
      }
    }
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return JSON.stringify(
      {
        ok: true,
        nodeId: params.nodeId,
        remotePath,
        localPath: destinationPath,
        sizeBytes: bytes.length,
        sha256,
        pulledAt: Date.now(),
      },
      null,
      2,
    );
  }

  private async requestFilePush(params: {
    nodeId: string;
    args: unknown;
    ctx: ToolContext;
    timeoutMs?: number;
  }): Promise<string> {
    const argsObj = this.asObject(params.args);
    const localPathArg = this.asString(argsObj.localPath);
    if (!localPathArg) {
      throw new NodeRoutingError("NODE_PROTOCOL_ERROR", "node_file_push requires `localPath`.");
    }
    const remotePath = this.asString(argsObj.remotePath) ?? this.asString(argsObj.path);
    if (!remotePath) {
      throw new NodeRoutingError("NODE_PROTOCOL_ERROR", "node_file_push requires `remotePath`.");
    }
    const overwrite = this.asBoolean(argsObj.overwrite) ?? false;
    const maxBytesRaw = this.asNumber(argsObj.maxBytes);
    const maxBytes = maxBytesRaw !== null ? Math.max(1_024, Math.min(50 * 1024 * 1024, Math.floor(maxBytesRaw))) : 5 * 1024 * 1024;
    const timeout = this.asNumber(argsObj.timeoutMs) ?? undefined;
    const sourcePath = this.resolveGatewayPathWithinRoots(localPathArg, params.ctx);
    let bytes: Buffer;
    try {
      const stat = await fs.stat(sourcePath);
      if (!stat.isFile()) {
        throw new NodeRoutingError("NODE_PROTOCOL_ERROR", `node_file_push localPath is not a file: ${sourcePath}`);
      }
      if (stat.size > maxBytes) {
        throw new NodeRoutingError(
          "NODE_PROTOCOL_ERROR",
          `node_file_push local file exceeds maxBytes (${stat.size} > ${maxBytes}).`,
        );
      }
      bytes = await fs.readFile(sourcePath);
    } catch (err) {
      if (err instanceof NodeRoutingError) throw err;
      throw new NodeRoutingError(
        "NODE_PROTOCOL_ERROR",
        `Failed to read local file for node_file_push: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const response = await this.requestNode({
      nodeId: params.nodeId,
      method: "file.push",
      params: {
        path: remotePath,
        contentBase64: bytes.toString("base64"),
        overwrite,
        maxBytes,
      },
      timeoutMs: timeout ?? params.timeoutMs,
    });
    this.throwOnRemoteError(response, {
      code: "NODE_EXECUTION_FAILED",
      message: `Node ${params.nodeId} failed file.push for ${remotePath}.`,
    });
    const payload = this.asObject(response.payload);
    const sha256 = this.asString(payload.sha256) ?? createHash("sha256").update(bytes).digest("hex");
    return JSON.stringify(
      {
        ok: true,
        nodeId: params.nodeId,
        localPath: sourcePath,
        remotePath: this.asString(payload.path) ?? remotePath,
        sizeBytes: this.asNumber(payload.sizeBytes) ?? bytes.length,
        sha256,
        pushedAt: Date.now(),
      },
      null,
      2,
    );
  }

  private resolveGatewayTransferDestinationPath(params: {
    localPath: string | null;
    remotePath: string;
    nodeId: string;
    ctx: ToolContext;
  }): string {
    if (params.localPath) {
      return this.resolveGatewayPathWithinRoots(params.localPath, params.ctx);
    }
    const baseName = path.basename(params.remotePath) || "node-file.bin";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const auto = path.resolve(params.ctx.stateDir, "node-transfers", params.nodeId, `${stamp}-${baseName}`);
    return this.resolveGatewayPathWithinRoots(auto, params.ctx);
  }

  private resolveGatewayPathWithinRoots(inputPath: string, ctx: ToolContext): string {
    const trimmed = inputPath.trim();
    if (!trimmed) {
      throw new NodeRoutingError("NODE_PROTOCOL_ERROR", "file transfer path cannot be empty.");
    }
    if (!path.isAbsolute(trimmed)) {
      throw new NodeRoutingError("NODE_PROTOCOL_ERROR", "file transfer paths must be absolute.");
    }
    const resolved = path.resolve(trimmed);
    const allowedRoots = [ctx.stateDir, ctx.workspaceDir, ctx.codeDir].map((root) => path.resolve(root));
    const allowed = allowedRoots.some((root) => {
      const rel = path.relative(root, resolved);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    if (!allowed) {
      throw new NodeRoutingError(
        "NODE_PROTOCOL_ERROR",
        `file transfer path is outside allowed roots: ${resolved}`,
      );
    }
    return resolved;
  }

  private decodeBase64Payload(value: string): Buffer {
    const normalized = value.trim().replace(/\s+/g, "");
    if (!normalized) {
      throw new NodeRoutingError("NODE_PROTOCOL_ERROR", "file transfer payload is empty.");
    }
    if (/[^A-Za-z0-9+/=]/.test(normalized)) {
      throw new NodeRoutingError("NODE_PROTOCOL_ERROR", "file transfer payload is not valid base64.");
    }
    try {
      return Buffer.from(normalized, "base64");
    } catch (err) {
      throw new NodeRoutingError(
        "NODE_PROTOCOL_ERROR",
        `failed to decode base64 payload: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private extractProcessId(value: Record<string, unknown>): string | null {
    return this.asString(value.id) ?? this.asString(value.processId);
  }

  private normalizeStructuredResult(payload: unknown): string {
    if (payload === null || payload === undefined) return "";
    if (typeof payload === "string") return payload;
    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      return String(payload);
    }
  }

  private readonly handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const pathname = this.getPathname(request);
    if (pathname !== "/nx/nodes" && pathname !== "/nodes") return;

    if (!this.isWebSocketUpgrade(request)) {
      this.rejectUpgrade(socket, 426, "Upgrade Required", {
        ok: false,
        error: "websocket_upgrade_required",
        message: `Connect to ${pathname} with a WebSocket upgrade request.`,
      });
      return;
    }

    if (pathname === "/nodes") {
      this.rejectUpgrade(socket, 501, "Not Implemented", {
        ok: false,
        error: "OPENCLAW_BACKEND_DEFERRED",
        message: "OpenClaw compatibility backend is reserved but not implemented yet.",
      });
      return;
    }

    if (this.deps.isStandby()) {
      this.rejectUpgrade(socket, 503, "Service Unavailable", {
        ok: false,
        error: "NODE_GATEWAY_STANDBY",
        message: "Standby gateway does not accept node WebSocket sessions.",
      });
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit("connection", ws, request);
    });
  };

  private readonly handleConnection = (ws: WebSocket, request: IncomingMessage): void => {
    const nowMs = Date.now();
    const session: NodeSocketSession = {
      sessionId: randomUUID(),
      nodeId: null,
      nodeSender: null,
      nodePublicKey: null,
      nodePublicKeyRaw: null,
      nodeFingerprint: null,
      authState: "connected",
      pendingChallenge: null,
      openedAt: nowMs,
      lastSeenAt: nowMs,
      heartbeatTimer: null,
      request,
    };
    this.sessions.set(ws, session);
    this.startHeartbeat(ws, session);

    ws.on("message", (data, isBinary) => {
      this.handleMessage(ws, session, data, isBinary);
    });
    ws.on("pong", () => {
      this.touchSession(session);
    });
    ws.on("close", () => {
      this.handleDisconnect(ws, session, "socket closed");
    });
    ws.on("error", (err) => {
      this.deps.log(`nodes/ws: session=${session.sessionId} error=${err instanceof Error ? err.message : String(err)}`);
    });

    this.deps.log(
      `nodes/ws: connected session=${session.sessionId} remote=${this.inferEndpoint(request) ?? "unknown"}`,
    );
  };

  private handleMessage(ws: WebSocket, session: NodeSocketSession, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.sendErrorResponse(ws, null, "INVALID_REQUEST", "Binary websocket frames are not supported.", false);
      return;
    }

    let parsed: unknown;
    try {
      const text = typeof data === "string" ? data : data.toString("utf8");
      parsed = JSON.parse(text);
    } catch {
      this.sendErrorResponse(ws, null, "INVALID_REQUEST", "Invalid JSON message.", false);
      return;
    }

    const envelope = this.asObject(parsed);
    const msg = this.asProtocolMessage(envelope);
    if (!msg) {
      this.sendErrorResponse(ws, null, "INVALID_REQUEST", "Invalid protocol message envelope.", false);
      return;
    }

    const auth = this.verifyIncomingMessage(session, msg, envelope);
    if (!auth.ok) {
      const id = msg.type === "req" ? msg.id : null;
      this.sendErrorResponse(ws, id, auth.code, auth.message, false);
      this.closeForAuthFailure(ws, auth.message);
      return;
    }

    this.touchSession(session);

    if (msg.type === "req") {
      this.handleRequestMessage(ws, session, msg);
      return;
    }
    if (msg.type === "res") {
      this.handleResponseMessage(session, msg);
      return;
    }
    this.handleEventMessage(session, msg);
  }

  private verifyIncomingMessage(
    session: NodeSocketSession,
    msg: ProtocolMessage,
    envelope: Record<string, unknown>,
  ): { ok: true } | { ok: false; code: string; message: string } {
    const nowMs = Date.now();
    const skewMs = Math.abs(nowMs - msg.ts);
    if (skewMs > this.maxMessageSkewMs) {
      return {
        ok: false,
        code: "AUTH_INVALID",
        message: `Message timestamp skew is too large (${skewMs}ms).`,
      };
    }

    if (!msg.sender.startsWith("node:")) {
      return {
        ok: false,
        code: "AUTH_INVALID",
        message: "Message sender must use node:<id> format.",
      };
    }

    if (msg.type === "req" && (msg.method === "connect.hello" || msg.method === "connect")) {
      const params = this.asObject(msg.params);
      const hello = this.extractHelloIdentity(params);
      if (!hello) {
        return {
          ok: false,
          code: "AUTH_INVALID",
          message: "connect.hello identity is missing or invalid.",
        };
      }
      const expectedSender = `node:${hello.nodeId}`;
      if (msg.sender !== expectedSender) {
        return {
          ok: false,
          code: "AUTH_INVALID",
          message: `connect.hello sender mismatch. expected=${expectedSender} actual=${msg.sender}`,
        };
      }
      if (this.requireMessageSignatures && !verifyProtocolEnvelope(envelope, hello.publicKey)) {
        return {
          ok: false,
          code: "AUTH_INVALID",
          message: "connect.hello signature verification failed.",
        };
      }
      return { ok: true };
    }

    if (!session.nodeId || !session.nodeSender || !session.nodePublicKey) {
      return {
        ok: false,
        code: "AUTH_INVALID",
        message: "Node identity is not established; send connect.hello first.",
      };
    }
    if (msg.sender !== session.nodeSender) {
      return {
        ok: false,
        code: "AUTH_INVALID",
        message: `Message sender mismatch. expected=${session.nodeSender} actual=${msg.sender}`,
      };
    }
    if (this.requireMessageSignatures && !verifyProtocolEnvelope(envelope, session.nodePublicKey)) {
      return {
        ok: false,
        code: "AUTH_INVALID",
        message: "Message signature verification failed.",
      };
    }

    if (session.authState !== "authenticated") {
      const isAllowedHandshakeStep = msg.type === "req" && (msg.method === "connect.prove" || msg.method === "ping");
      if (!isAllowedHandshakeStep) {
        return {
          ok: false,
          code: "AUTH_INVALID",
          message: "Session is not authenticated yet.",
        };
      }
    }

    return { ok: true };
  }

  private closeForAuthFailure(ws: WebSocket, reason: string): void {
    try {
      ws.close(4001, truncateReason(reason));
    } catch {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
  }

  private extractHelloIdentity(params: Record<string, unknown>): {
    nodeId: string;
    fingerprint: string;
    publicKey: KeyObject;
    publicKeyRaw: string;
  } | null {
    const device = this.asObject(params.device);
    const nodeId = this.asString(params.nodeId) ?? this.asString(device.id) ?? this.asString(device.fingerprint);
    const publicKeyRaw = this.asString(device.publicKey) ?? this.asString(params.publicKey);
    if (!nodeId || !publicKeyRaw) return null;

    const parsed = parseNodePublicKey(publicKeyRaw);
    if (!parsed) return null;

    const providedFingerprint = this.asString(device.fingerprint) ?? this.asString(params.fingerprint);
    if (providedFingerprint && providedFingerprint !== parsed.fingerprint) {
      this.deps.log(
        `nodes/ws: fingerprint mismatch provided=${providedFingerprint} derived=${parsed.fingerprint} node=${nodeId}; using derived fingerprint`,
      );
    }

    return {
      nodeId,
      fingerprint: parsed.fingerprint,
      publicKey: parsed.key,
      publicKeyRaw: parsed.raw,
    };
  }

  private buildHandshakeProofPayload(params: {
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

  private handleRequestMessage(ws: WebSocket, session: NodeSocketSession, msg: ProtocolRequest): void {
    switch (msg.method) {
      case "connect.hello":
      case "connect":
        this.handleConnectHello(ws, session, msg);
        return;
      case "connect.prove":
        this.handleConnectProve(ws, session, msg);
        return;
      case "ping":
        this.sendOkResponse(ws, msg.id, { pong: true, ts: Date.now() });
        return;
      default:
        this.sendErrorResponse(
          ws,
          msg.id,
          "METHOD_NOT_IMPLEMENTED",
          `Method ${msg.method} is not implemented yet.`,
          false,
        );
    }
  }

  private handleResponseMessage(session: NodeSocketSession, msg: ProtocolResponse): void {
    if (!msg.id) return;
    const pending = this.pendingGatewayRequests.get(msg.id);
    if (!pending) return;

    if (!session.nodeId) {
      this.deps.log(
        `nodes/ws: dropped response id=${msg.id} reason=node_not_identified session=${session.sessionId}`,
      );
      return;
    }
    if (pending.nodeId !== session.nodeId || pending.sessionId !== session.sessionId) {
      this.deps.log(
        `nodes/ws: dropped response id=${msg.id} reason=session_mismatch expected=${pending.nodeId}/${pending.sessionId} actual=${session.nodeId}/${session.sessionId}`,
      );
      return;
    }

    this.pendingGatewayRequests.delete(msg.id);
    clearTimeout(pending.timeout);
    pending.onSettle?.();
    pending.resolve(msg);
  }

  private handleEventMessage(session: NodeSocketSession, msg: ProtocolEvent): void {
    if (!session.nodeId) return;
    const receivedAt = Date.now();
    const payload = this.asObject(msg.payload);
    if (msg.event === "capability.update" || msg.event === "caps.advertise") {
      const capabilityState = this.resolveCapabilityAdvertisement(session.nodeId, payload);
      this.deps.registry.markHeartbeat({
        id: session.nodeId,
        nowMs: receivedAt,
        endpoint: this.inferEndpoint(session.request),
        capabilities: capabilityState.capabilities,
        tags: capabilityState.tags,
      });
      this.queueSymbolCatalogRefresh({
        nodeId: session.nodeId,
        reason: msg.event,
      });
      return;
    }

    if (msg.event === "log.append") {
      const processId = this.asString(payload.processId) ?? "unknown";
      const stream = this.asString(payload.stream) ?? "stdout";
      this.deps.log(`nodes/ws: log.append node=${session.nodeId} process=${processId} stream=${stream}`);
      if (this.deps.onLogAppend) {
        void this.deps.onLogAppend({
          nodeId: session.nodeId,
          sessionId: session.sessionId,
          payload,
          receivedAt,
        }).catch((err) => {
          this.deps.log(
            `nodes/ws: onLogAppend failed node=${session.nodeId} process=${processId} error=${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
      return;
    }

    if (msg.event === "process.update") {
      const processId = this.asString(payload.processId) ?? "unknown";
      const status = this.asString(payload.status) ?? "unknown";
      const deliveryId = this.asString(payload.deliveryId);
      this.deps.log(
        `nodes/ws: process.update node=${session.nodeId} process=${processId} status=${status} delivery=${deliveryId ?? "none"}`,
      );
      void this.handleProcessUpdateEvent({
        nodeId: session.nodeId,
        sessionId: session.sessionId,
        payload,
        receivedAt,
      });
      return;
    }

    if (msg.event === "webhook.deliver" || msg.event === "transport.event.ingest") {
      const nested = this.asObject(payload.payload);
      const webhookKind =
        this.asString(payload.kind) ??
        this.asString(payload.eventType) ??
        this.asString(nested.kind) ??
        this.asString(nested.eventType) ??
        "unknown";
      this.deps.log(`nodes/ws: webhook ingress node=${session.nodeId} event=${msg.event} kind=${webhookKind}`);
      if (this.deps.onWebhookIngress) {
        void this.deps.onWebhookIngress({
          nodeId: session.nodeId,
          sessionId: session.sessionId,
          event: msg.event,
          payload,
          receivedAt,
        }).catch((err) => {
          this.deps.log(
            `nodes/ws: onWebhookIngress failed node=${session.nodeId} event=${msg.event} error=${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
      return;
    }
  }

  private async handleProcessUpdateEvent(ctx: NodeProcessEventContext): Promise<void> {
    const processId = this.asString(ctx.payload.processId) ?? null;
    const deliveryId = this.asString(ctx.payload.deliveryId);
    let persistOk = true;
    if (this.deps.onProcessUpdate) {
      try {
        persistOk = await this.deps.onProcessUpdate(ctx);
      } catch (err) {
        persistOk = false;
        this.deps.log(
          `nodes/ws: onProcessUpdate failed node=${ctx.nodeId} process=${processId ?? "unknown"} error=${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (!deliveryId) return;
    if (!persistOk) {
      this.deps.log(
        `nodes/ws: skipped process.ack node=${ctx.nodeId} process=${processId ?? "unknown"} delivery=${deliveryId} reason=persist_failed`,
      );
      return;
    }
    await this.sendProcessAck({
      nodeId: ctx.nodeId,
      processId,
      deliveryId,
    });
  }

  private async sendProcessAck(params: {
    nodeId: string;
    processId: string | null;
    deliveryId: string;
  }): Promise<void> {
    const ackParams: Record<string, unknown> = { deliveryId: params.deliveryId };
    if (params.processId) ackParams.processId = params.processId;
    try {
      const res = await this.requestNode({
        nodeId: params.nodeId,
        method: "process.ack",
        params: ackParams,
        timeoutMs: 10_000,
      });
      if (!res.ok) {
        this.deps.log(
          `nodes/ws: process.ack rejected node=${params.nodeId} delivery=${params.deliveryId} code=${res.error?.code ?? "unknown"} message=${res.error?.message ?? "unknown"}`,
        );
      }
    } catch (err) {
      this.deps.log(
        `nodes/ws: process.ack failed node=${params.nodeId} delivery=${params.deliveryId} error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private queueSymbolCatalogRefresh(params: { nodeId: string; reason: string; force?: boolean }): void {
    void this.refreshSymbolCatalogCache(params).catch((err) => {
      this.deps.log(
        `nodes/ws: symbols cache refresh crashed node=${params.nodeId} reason=${params.reason} error=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  private async refreshSymbolCatalogCache(params: {
    nodeId: string;
    reason: string;
    force?: boolean;
  }): Promise<void> {
    const nowMs = Date.now();
    if (!params.force) {
      const last = this.symbolCatalogRefreshLastAt.get(params.nodeId) ?? 0;
      if (nowMs - last < this.symbolCatalogRefreshMinIntervalMs) return;
    }
    if (this.symbolCatalogRefreshInFlight.has(params.nodeId)) return;

    this.symbolCatalogRefreshInFlight.add(params.nodeId);
    this.symbolCatalogRefreshLastAt.set(params.nodeId, nowMs);
    try {
      const row = this.deps.registry.get(params.nodeId);
      if (!row) return;
      const supportsSymbolsList = row.capabilities.includes("*") || row.capabilities.includes("symbols.list");
      if (!supportsSymbolsList) return;
      if (!this.resolveActiveNodeSocket(params.nodeId)) return;
      const response = await this.requestNode({
        nodeId: params.nodeId,
        method: "symbols.list",
        params: {
          includeFields: true,
        },
        timeoutMs: Math.min(this.requestTimeoutMs, 15_000),
      });
      this.throwOnRemoteError(response, {
        code: "NODE_EXECUTION_FAILED",
        message: `Node ${params.nodeId} failed to refresh symbols catalog.`,
      });
      const cache = this.parseSymbolCatalogCache(response.payload, nowMs);
      this.deps.registry.setMetadata({
        id: params.nodeId,
        metadata: {
          ...row.metadata,
          symbolCatalogCache: cache,
        },
        nowMs,
      });
      this.deps.log(
        `nodes/ws: symbols cache refreshed node=${params.nodeId} keys=${cache.counts.keys} symbols=${cache.counts.symbols} reason=${params.reason}`,
      );
    } catch (err) {
      this.deps.log(
        `nodes/ws: symbols cache refresh failed node=${params.nodeId} reason=${params.reason} error=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.symbolCatalogRefreshInFlight.delete(params.nodeId);
    }
  }

  private parseSymbolCatalogCache(payload: unknown, fetchedAt: number): SymbolCatalogCache {
    const payloadObj = this.asObject(payload);
    const catalog = this.asObject(payloadObj.catalog);
    const symbols = this.parseOptionalStringArray(payloadObj.symbols) ?? [];
    const countsObj = this.asObject(payloadObj.counts);
    const derivedKeys = Object.values(catalog).reduce<number>((total, value) => {
      if (!Array.isArray(value)) return total;
      return total + value.length;
    }, 0);
    const keysRaw = this.asNumber(countsObj.keys);
    const symbolsRaw = this.asNumber(countsObj.symbols);
    return {
      fetchedAt,
      generatedAt: this.asNumber(payloadObj.generatedAt),
      counts: {
        keys: keysRaw !== null ? Math.max(0, Math.floor(keysRaw)) : derivedKeys,
        symbols: symbolsRaw !== null ? Math.max(0, Math.floor(symbolsRaw)) : symbols.length,
      },
      catalog,
      symbols,
    };
  }

  private handleConnectHello(ws: WebSocket, session: NodeSocketSession, msg: ProtocolRequest): void {
    if (session.authState !== "connected") {
      this.sendErrorResponse(ws, msg.id, "AUTH_INVALID", "connect.hello has already been processed for this session.", false);
      return;
    }

    const params = this.asObject(msg.params);
    const role = this.asString(params.role);
    if (role && role !== "node") {
      this.sendErrorResponse(ws, msg.id, "AUTH_INVALID", `Unsupported role: ${role}`, false);
      return;
    }

    const helloIdentity = this.extractHelloIdentity(params);
    if (!helloIdentity) {
      this.sendErrorResponse(
        ws,
        msg.id,
        "AUTH_INVALID",
        "connect.hello requires node identifier, fingerprint, and an Ed25519 public key.",
        false,
      );
      return;
    }

    const nodeId = helloIdentity.nodeId;
    const fingerprint = helloIdentity.fingerprint;
    const publicKey = helloIdentity.publicKeyRaw;
    const nodePublicKey = helloIdentity.publicKey;
    const nodeNonce = this.asString(params.nodeNonce);
    if (!nodeNonce) {
      this.sendErrorResponse(ws, msg.id, "AUTH_INVALID", "connect.hello requires nodeNonce for challenge-response.", false);
      return;
    }

    // Protocol version gate. Nodes that predate the explicit field are treated as
    // v1. Reject (with an actionable upgrade target) rather than letting a skewed
    // node fail later with confusing per-call errors.
    const protocolVersion = this.asNumber(params.protocolVersion) ?? 1;
    if (protocolVersion < MIN_SUPPORTED_NODE_PROTOCOL || protocolVersion > MAX_SUPPORTED_NODE_PROTOCOL) {
      const upgradeTarget = protocolVersion < MIN_SUPPORTED_NODE_PROTOCOL ? "node" : "gateway";
      const message =
        `Node protocol v${protocolVersion} is not supported by this gateway ` +
        `(supported: v${MIN_SUPPORTED_NODE_PROTOCOL}-v${MAX_SUPPORTED_NODE_PROTOCOL}). Upgrade the ${upgradeTarget}.`;
      this.deps.log(`nodes/ws: rejected node=${nodeId} reason=protocol_version_unsupported node_protocol=${protocolVersion}`);
      this.sendErrorResponse(ws, msg.id, "VERSION_UNSUPPORTED", message, false);
      this.closeForAuthFailure(ws, "unsupported protocol version");
      return;
    }
    const appVersion = this.asString(params.version);
    const nodeMetadata: Record<string, unknown> = {
      ...this.asObject(params.metadata),
      protocolVersion,
      ...(appVersion ? { appVersion } : {}),
    };

    const label = this.asString(params.displayName) ?? (nodeId ? `Node ${nodeId.slice(0, 8)}` : "Unknown Node");

    const nowMs = Date.now();
    const backend = this.parseBackend(this.asString(params.backend));
    const trustLevel = this.parseTrustLevel(this.asString(params.trustLevel));
    const firewallMode = this.parseFirewallMode(this.asString(params.firewallMode));
    const capabilities = this.parseStringArray(params.caps ?? params.capabilities);
    const tags = this.parseStringArray(params.tags);
    const endpoint = this.inferEndpoint(session.request);
    const existing = this.deps.registry.get(nodeId);
    if (!existing) {
      this.deps.registry.registerOrUpdate({
        id: nodeId,
        label,
        publicKey,
        fingerprint,
        status: "pending",
        endpoint,
        backend,
        trustLevel,
        firewallMode,
        capabilities,
        tags,
        metadata: nodeMetadata,
        connectedAt: null,
        lastSeenAt: nowMs,
        nowMs,
      });
      this.deps.log(
        `nodes/ws: pairing required node=${nodeId} fingerprint=${fingerprint} sender=${msg.sender}. Approve with node_manage action=set_status id=${nodeId} status=approved.`,
      );
      this.sendErrorResponse(
        ws,
        msg.id,
        "PAIRING_REQUIRED",
        `Node ${nodeId} is not approved. Set status=approved before reconnecting.`,
        false,
      );
      this.closeForAuthFailure(ws, "pairing required");
      return;
    }
    if (existing.fingerprint !== fingerprint) {
      this.sendErrorResponse(
        ws,
        msg.id,
        "AUTH_INVALID",
        `Fingerprint mismatch for node ${nodeId}. Expected ${existing.fingerprint}, got ${fingerprint}.`,
        false,
      );
      this.closeForAuthFailure(ws, "fingerprint mismatch");
      return;
    }
    if (existing.status === "blocked") {
      this.sendErrorResponse(ws, msg.id, "AUTH_INVALID", `Node ${nodeId} is blocked and cannot connect.`, false);
      this.closeForAuthFailure(ws, "node blocked");
      return;
    }
    if (existing.status === "pending") {
      this.deps.registry.registerOrUpdate({
        id: nodeId,
        label,
        publicKey,
        fingerprint,
        status: "pending",
        endpoint,
        backend,
        trustLevel,
        firewallMode,
        capabilities,
        tags,
        metadata: nodeMetadata,
        connectedAt: null,
        lastSeenAt: nowMs,
        nowMs,
      });
      this.sendErrorResponse(
        ws,
        msg.id,
        "PAIRING_PENDING",
        `Node ${nodeId} is pending approval. Approve with node_manage action=set_status id=${nodeId} status=approved.`,
        false,
      );
      this.closeForAuthFailure(ws, "pairing pending");
      return;
    }

    const existingActive = this.resolveActiveNodeSocket(nodeId);
    const preAuthStatus: NodeStatus = existingActive
      ? "online"
      : existing.status === "offline"
        ? "offline"
        : "approved";
    const preAuthConnectedAt = preAuthStatus === "online" ? existing.connectedAt : null;
    this.deps.registry.registerOrUpdate({
      id: nodeId,
      label,
      publicKey,
      fingerprint,
      status: preAuthStatus,
      endpoint,
      backend,
      trustLevel,
      firewallMode,
      capabilities,
      tags,
      metadata: this.asObject(params.metadata),
      connectedAt: preAuthConnectedAt,
      lastSeenAt: nowMs,
      nowMs,
    });

    session.nodeId = nodeId;
    session.nodeSender = msg.sender;
    session.nodePublicKey = nodePublicKey;
    session.nodePublicKeyRaw = publicKey;
    session.nodeFingerprint = fingerprint;
    session.authState = "challenged";

    const gatewayNonce = randomBytes(32).toString("base64url");
    session.pendingChallenge = {
      nodeNonce,
      gatewayNonce,
      issuedAt: nowMs,
    };
    const proofPayload = this.buildHandshakeProofPayload({
      nodeId,
      sessionId: session.sessionId,
      nodeNonce,
      gatewayNonce,
    });
    const challenge = {
      gatewayNonce,
      gatewayPublicKey: this.identity.publicKeyRaw,
      gatewayFingerprint: this.identity.fingerprint,
      gatewayProofSig: signDetachedPayload(proofPayload, this.identity.privateKey),
      ts: nowMs,
      sessionId: session.sessionId,
      // Advertise the protocol range so the node can detect/log skew client-side.
      gatewayProtocol: {
        min: MIN_SUPPORTED_NODE_PROTOCOL,
        max: MAX_SUPPORTED_NODE_PROTOCOL,
        current: GATEWAY_NODE_PROTOCOL,
      },
    };
    this.sendEvent(ws, "connect.challenge", challenge);
    this.sendOkResponse(ws, msg.id, {
      sessionId: session.sessionId,
      status: "connected",
      challengeIssued: true,
    });
    this.deps.log(`nodes/ws: hello accepted node=${nodeId} session=${session.sessionId}`);
  }

  private handleConnectProve(ws: WebSocket, session: NodeSocketSession, msg: ProtocolRequest): void {
    if (!session.nodeId || !session.nodePublicKey || !session.pendingChallenge || session.authState !== "challenged") {
      this.sendErrorResponse(ws, msg.id, "AUTH_INVALID", "connect.hello must be completed before connect.prove.", false);
      return;
    }
    const challengeAgeMs = Date.now() - session.pendingChallenge.issuedAt;
    if (challengeAgeMs > this.challengeTtlMs) {
      this.sendErrorResponse(
        ws,
        msg.id,
        "AUTH_INVALID",
        `connect.prove challenge expired after ${challengeAgeMs}ms.`,
        false,
      );
      this.closeForAuthFailure(ws, "connect.prove challenge expired");
      return;
    }

    const params = this.asObject(msg.params);
    const nodeProofSig = this.asString(params.nodeProofSig);
    if (!nodeProofSig) {
      this.sendErrorResponse(ws, msg.id, "AUTH_INVALID", "connect.prove requires nodeProofSig.", false);
      return;
    }

    const proofPayload = this.buildHandshakeProofPayload({
      nodeId: session.nodeId,
      sessionId: session.sessionId,
      nodeNonce: session.pendingChallenge.nodeNonce,
      gatewayNonce: session.pendingChallenge.gatewayNonce,
    });
    const verified = verifyDetachedPayload(proofPayload, nodeProofSig, session.nodePublicKey);
    if (!verified) {
      this.sendErrorResponse(ws, msg.id, "AUTH_INVALID", "connect.prove signature verification failed.", false);
      this.closeForAuthFailure(ws, "invalid connect.prove signature");
      return;
    }

    const challenge = session.pendingChallenge;
    session.authState = "authenticated";
    session.pendingChallenge = null;

    const nowMs = Date.now();
    const previousSessionId = this.activeNodeSessions.get(session.nodeId);
    this.activeNodeSessions.set(session.nodeId, session.sessionId);
    if (previousSessionId && previousSessionId !== session.sessionId) {
      this.rejectPendingRequestsForSession(previousSessionId, "node session replaced");
      this.deps.log(`nodes/ws: node=${session.nodeId} replaced prior session=${previousSessionId}`);
    }
    const nodeRow = this.deps.registry.get(session.nodeId);
    this.deps.registry.beginSession({
      id: session.sessionId,
      nodeId: session.nodeId,
      startedAt: nowMs,
      ipAddress: this.inferEndpoint(session.request),
      capabilities: nodeRow?.capabilities ?? [],
    });
    this.deps.registry.setStatus({
      id: session.nodeId,
      status: "online",
      connectedAt: nowMs,
      nowMs,
    });
    this.deps.registry.markHeartbeat({
      id: session.nodeId,
      nowMs,
      endpoint: this.inferEndpoint(session.request),
    });
    const acceptPayload = this.buildHandshakeProofPayload({
      nodeId: session.nodeId,
      sessionId: session.sessionId,
      nodeNonce: challenge.nodeNonce,
      gatewayNonce: challenge.gatewayNonce,
    });
    this.sendEvent(ws, "connect.accept", {
      sessionId: session.sessionId,
      connectedAt: session.openedAt,
      gatewayFingerprint: this.identity.fingerprint,
      gatewayAcceptSig: signDetachedPayload(acceptPayload, this.identity.privateKey),
    });
    this.sendOkResponse(ws, msg.id, {
      sessionId: session.sessionId,
      status: "ready",
      connectedAt: session.openedAt,
    });
    this.deps.log(`nodes/ws: auth ready node=${session.nodeId} session=${session.sessionId}`);
    this.queueSymbolCatalogRefresh({
      nodeId: session.nodeId,
      reason: "connect.prove",
      force: true,
    });
  }

  private handleDisconnect(ws: WebSocket, session: NodeSocketSession, reason: string): void {
    this.clearHeartbeat(session);
    this.sessions.delete(ws);
    this.rejectPendingRequestsForSession(session.sessionId, reason);
    if (session.nodeId) {
      const activeSession = this.activeNodeSessions.get(session.nodeId);
      if (activeSession === session.sessionId) {
        this.activeNodeSessions.delete(session.nodeId);
        const current = this.deps.registry.get(session.nodeId);
        const nextStatus = current?.status === "blocked" || current?.status === "pending" ? current.status : "offline";
        this.deps.registry.setStatus({
          id: session.nodeId,
          status: nextStatus,
          connectedAt: null,
          nowMs: Date.now(),
        });
      }
      this.deps.registry.endSession({
        id: session.sessionId,
        endedAt: Date.now(),
      });
      this.deps.log(`nodes/ws: disconnected node=${session.nodeId} session=${session.sessionId} reason=${reason}`);
      return;
    }
    this.deps.log(`nodes/ws: disconnected session=${session.sessionId} reason=${reason}`);
  }

  private startHeartbeat(ws: WebSocket, session: NodeSocketSession): void {
    session.heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        this.clearHeartbeat(session);
        return;
      }
      const nowMs = Date.now();
      const ageMs = nowMs - session.lastSeenAt;
      if (ageMs > this.heartbeatTimeoutMs) {
        this.deps.log(
          `nodes/ws: heartbeat timeout session=${session.sessionId} age_ms=${ageMs}; closing connection`,
        );
        try {
          ws.close(4000, "heartbeat timeout");
        } catch {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
        }
        return;
      }
      try {
        ws.ping();
      } catch {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
      }
    }, this.heartbeatIntervalMs);
    session.heartbeatTimer.unref?.();
  }

  private clearHeartbeat(session: NodeSocketSession): void {
    if (!session.heartbeatTimer) return;
    clearInterval(session.heartbeatTimer);
    session.heartbeatTimer = null;
  }

  private touchSession(session: NodeSocketSession): void {
    const nowMs = Date.now();
    session.lastSeenAt = nowMs;
    if (!session.nodeId) return;
    this.deps.registry.markHeartbeat({
      id: session.nodeId,
      nowMs,
      endpoint: this.inferEndpoint(session.request),
    });
  }

  private resolveActiveNodeSocket(nodeId: string): { ws: WebSocket; session: NodeSocketSession } | null {
    const activeSessionId = this.activeNodeSessions.get(nodeId);
    if (!activeSessionId) return null;
    for (const [ws, session] of this.sessions) {
      if (session.nodeId !== nodeId) continue;
      if (session.sessionId !== activeSessionId) continue;
      if (session.authState !== "authenticated") continue;
      if (ws.readyState !== WebSocket.OPEN) continue;
      return { ws, session };
    }
    return null;
  }

  private rejectPendingRequestsForSession(sessionId: string, reason: string): void {
    for (const [requestId, pending] of this.pendingGatewayRequests) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timeout);
      this.pendingGatewayRequests.delete(requestId);
      pending.onSettle?.();
      pending.reject(
        new NodeRoutingError(
          "NODE_SOCKET_UNAVAILABLE",
          `Node session closed before response (node=${pending.nodeId}, method=${pending.method}, requestId=${pending.id}, reason=${reason}).`,
        ),
      );
    }
  }

  private rejectAllPendingRequests(reason: string): void {
    for (const [requestId, pending] of this.pendingGatewayRequests) {
      clearTimeout(pending.timeout);
      this.pendingGatewayRequests.delete(requestId);
      pending.onSettle?.();
      pending.reject(
        new NodeRoutingError(
          "NODE_SOCKET_UNAVAILABLE",
          `Gateway closed before node response (node=${pending.nodeId}, method=${pending.method}, requestId=${pending.id}, reason=${reason}).`,
        ),
      );
    }
  }

  private normalizeToolResult(payload: unknown): string {
    if (payload === null || payload === undefined) return "";
    if (typeof payload === "string") return payload;
    if (typeof payload === "number" || typeof payload === "boolean") return String(payload);

    const payloadObj = this.asObject(payload);
    const output = this.asString(payloadObj.output);
    if (output) return output;
    const result = this.asString(payloadObj.result);
    if (result) return result;
    const text = this.asString(payloadObj.text);
    if (text) return text;

    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      return String(payload);
    }
  }

  private sendEvent(ws: WebSocket, event: string, payload: Record<string, unknown>): void {
    this.sendSignedEnvelope(ws, {
      type: "event",
      event,
      payload,
    });
  }

  private sendOkResponse(ws: WebSocket, id: string | null, payload: Record<string, unknown>): void {
    this.sendSignedEnvelope(ws, {
      type: "res",
      id,
      ok: true,
      payload,
    });
  }

  private sendErrorResponse(
    ws: WebSocket,
    id: string | null,
    code: string,
    message: string,
    retryable: boolean,
  ): void {
    this.sendSignedEnvelope(ws, {
      type: "res",
      id,
      ok: false,
      error: { code, message, retryable },
    });
  }

  private sendSignedEnvelope(ws: WebSocket, envelope: Record<string, unknown>): boolean {
    try {
      const withMeta = {
        ...envelope,
        ts: Date.now(),
        sender: this.gatewaySender,
      };
      const sig = signProtocolEnvelope(withMeta, this.identity.privateKey);
      return this.sendJson(ws, {
        ...withMeta,
        sig,
      });
    } catch (err) {
      this.deps.log(`nodes/ws: signing failed error=${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private sendJson(ws: WebSocket, payload: Record<string, unknown>): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      this.deps.log(`nodes/ws: send failed error=${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private getPathname(request: IncomingMessage): string {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      return url.pathname;
    } catch {
      return "/";
    }
  }

  private isWebSocketUpgrade(request: IncomingMessage): boolean {
    const upgrade = request.headers.upgrade;
    return typeof upgrade === "string" && upgrade.toLowerCase() === "websocket";
  }

  private rejectUpgrade(
    socket: Duplex,
    statusCode: number,
    statusText: string,
    payload: Record<string, unknown>,
  ): void {
    const body = JSON.stringify(payload);
    const response = [
      `HTTP/1.1 ${statusCode} ${statusText}`,
      "Content-Type: application/json; charset=utf-8",
      "Connection: close",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body,
    ].join("\r\n");
    try {
      socket.write(response);
    } finally {
      socket.destroy();
    }
  }

  private inferEndpoint(request: IncomingMessage): string | null {
    const fwd = request.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0]?.trim() ?? null;
    if (Array.isArray(fwd) && fwd.length > 0) return fwd[0]?.trim() ?? null;
    return request.socket.remoteAddress ?? null;
  }

  private asProtocolMessage(value: unknown): ProtocolMessage | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const obj = value as Record<string, unknown>;
    const type = this.asString(obj.type);
    const ts = this.asNumber(obj.ts);
    const sender = this.asString(obj.sender);
    const sig = this.asString(obj.sig);
    if (!ts || !sender || (this.requireMessageSignatures && !sig)) return null;
    const normalizedSig = sig ?? "";
    if (type === "req") {
      const id = this.asString(obj.id);
      const method = this.asString(obj.method);
      if (!id || !method) return null;
      return {
        type: "req",
        id,
        ts,
        sender,
        sig: normalizedSig,
        method,
        params: obj.params,
      };
    }
    if (type === "res") {
      const ok = obj.ok;
      if (typeof ok !== "boolean") return null;
      const errorObj = this.asObject(obj.error);
      const code = this.asString(errorObj.code);
      const message = this.asString(errorObj.message);
      const retryable = typeof errorObj.retryable === "boolean" ? errorObj.retryable : undefined;
      return {
        type: "res",
        id: this.asString(obj.id),
        ts,
        sender,
        sig: normalizedSig,
        ok,
        payload: obj.payload,
        error:
          code || message || retryable !== undefined
            ? {
                code: code ?? "NODE_EXECUTION_FAILED",
                message: message ?? "Node execution failed.",
                retryable,
              }
            : undefined,
      };
    }
    if (type === "event") {
      const event = this.asString(obj.event);
      if (!event) return null;
      return {
        type: "event",
        ts,
        sender,
        sig: normalizedSig,
        event,
        payload: obj.payload,
      };
    }
    return null;
  }

  private asObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  }

  private asString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private asNumber(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return value;
  }

  private asBoolean(value: unknown): boolean | null {
    if (typeof value !== "boolean") return null;
    return value;
  }

  private resolveCapabilityAdvertisement(
    nodeId: string,
    payload: Record<string, unknown>,
  ): { capabilities?: string[]; tags?: string[] } {
    const current = this.deps.registry.get(nodeId);
    const delta = this.asObject(payload.delta);

    const fullCapabilitiesRaw = payload.capabilities ?? payload.caps;
    const fullTagsRaw = payload.tags;
    const hasFullCapabilities = fullCapabilitiesRaw !== undefined;
    const hasFullTags = fullTagsRaw !== undefined;
    const fullCapabilities = this.parseOptionalStringArray(fullCapabilitiesRaw);
    const fullTags = this.parseOptionalStringArray(fullTagsRaw);

    const addCapabilities = this.parseOptionalStringArray(payload.addCapabilities ?? delta.addCapabilities) ?? [];
    const removeCapabilities = this.parseOptionalStringArray(payload.removeCapabilities ?? delta.removeCapabilities) ?? [];
    const addTags = this.parseOptionalStringArray(payload.addTags ?? delta.addTags) ?? [];
    const removeTags = this.parseOptionalStringArray(payload.removeTags ?? delta.removeTags) ?? [];

    let nextCapabilities = hasFullCapabilities ? this.uniqueStrings(fullCapabilities ?? []) : [...(current?.capabilities ?? [])];
    let nextTags = hasFullTags ? this.uniqueStrings(fullTags ?? []) : [...(current?.tags ?? [])];
    let capabilitiesChanged = hasFullCapabilities;
    let tagsChanged = hasFullTags;

    for (const capability of addCapabilities) {
      if (!nextCapabilities.includes(capability)) {
        nextCapabilities.push(capability);
        capabilitiesChanged = true;
      }
    }
    if (removeCapabilities.length > 0) {
      const removeSet = new Set(removeCapabilities);
      const before = nextCapabilities.length;
      nextCapabilities = nextCapabilities.filter((capability) => !removeSet.has(capability));
      if (nextCapabilities.length !== before) capabilitiesChanged = true;
    }

    for (const tag of addTags) {
      if (!nextTags.includes(tag)) {
        nextTags.push(tag);
        tagsChanged = true;
      }
    }
    if (removeTags.length > 0) {
      const removeSet = new Set(removeTags);
      const before = nextTags.length;
      nextTags = nextTags.filter((tag) => !removeSet.has(tag));
      if (nextTags.length !== before) tagsChanged = true;
    }

    return {
      capabilities: capabilitiesChanged ? nextCapabilities : undefined,
      tags: tagsChanged ? nextTags : undefined,
    };
  }

  private parseOptionalStringArray(value: unknown): string[] | undefined {
    if (value === undefined) return undefined;
    return this.parseStringArray(value);
  }

  private uniqueStrings(value: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of value) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
    return out;
  }

  private parseStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  private parseBackend(value: string | null): NodeBackend {
    if (value === "openclaw") return "openclaw";
    return "nexus";
  }

  private parseTrustLevel(value: string | null): NodeTrustLevel {
    if (value === "untrusted" || value === "secure") return value;
    return "standard";
  }

  private parseFirewallMode(value: string | null): NodeFirewallMode {
    if (value === "hermes" || value === "audit-only") return value;
    return "transparent";
  }
}

function truncateReason(value: string): string {
  if (value.length <= 120) return value;
  return `${value.slice(0, 117)}...`;
}
