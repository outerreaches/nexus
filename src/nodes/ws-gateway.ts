import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer, type RawData } from "ws";

import { NodeRegistry } from "./registry.js";
import type { NodeBackend, NodeFirewallMode, NodeTrustLevel } from "../storage/nodes.js";

type NodeSocketSession = {
  sessionId: string;
  nodeId: string | null;
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
  method: string;
  params?: unknown;
};

type ProtocolEvent = {
  type: "event";
  event: string;
  payload?: unknown;
};

type ProtocolMessage = ProtocolRequest | ProtocolEvent;

export class NodeWebSocketGateway {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sessions = new Map<WebSocket, NodeSocketSession>();
  private readonly activeNodeSessions = new Map<string, string>();
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly gatewaySender: string;
  private server: UpgradeCapableServer | null = null;

  constructor(
    private readonly deps: {
      registry: NodeRegistry;
      isStandby: () => boolean;
      log: (line: string) => void;
      heartbeatIntervalMs?: number;
      heartbeatTimeoutMs?: number;
      gatewaySender?: string;
    },
  ) {
    this.heartbeatIntervalMs = Math.max(5_000, deps.heartbeatIntervalMs ?? 30_000);
    this.heartbeatTimeoutMs = Math.max(this.heartbeatIntervalMs * 2, deps.heartbeatTimeoutMs ?? 95_000);
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
    this.touchSession(session);
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

    const msg = this.asProtocolMessage(parsed);
    if (!msg) {
      this.sendErrorResponse(ws, null, "INVALID_REQUEST", "Invalid protocol message envelope.", false);
      return;
    }

    if (msg.type === "req") {
      this.handleRequestMessage(ws, session, msg);
      return;
    }
    this.handleEventMessage(session, msg);
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

  private handleEventMessage(session: NodeSocketSession, msg: ProtocolEvent): void {
    if (!session.nodeId) return;
    if (msg.event !== "capability.update" && msg.event !== "caps.advertise") return;

    const payload = this.asObject(msg.payload);
    const capabilities = this.parseStringArray(payload.capabilities ?? payload.caps);
    const tags = this.parseStringArray(payload.tags);
    this.deps.registry.markHeartbeat({
      id: session.nodeId,
      nowMs: Date.now(),
      endpoint: this.inferEndpoint(session.request),
      capabilities,
      tags,
    });
  }

  private handleConnectHello(ws: WebSocket, session: NodeSocketSession, msg: ProtocolRequest): void {
    const params = this.asObject(msg.params);
    const role = this.asString(params.role);
    if (role && role !== "node") {
      this.sendErrorResponse(ws, msg.id, "AUTH_INVALID", `Unsupported role: ${role}`, false);
      return;
    }

    const device = this.asObject(params.device);
    const nodeId = this.asString(params.nodeId) ?? this.asString(device.id) ?? this.asString(device.fingerprint);
    const fingerprint = this.asString(device.fingerprint) ?? this.asString(device.id) ?? nodeId;
    const publicKey = this.asString(device.publicKey) ?? "";
    const label = this.asString(params.displayName) ?? (nodeId ? `Node ${nodeId.slice(0, 8)}` : "Unknown Node");
    if (!nodeId || !fingerprint || !publicKey) {
      this.sendErrorResponse(
        ws,
        msg.id,
        "AUTH_INVALID",
        "connect.hello requires node identifier, fingerprint, and public key.",
        false,
      );
      return;
    }

    const nowMs = Date.now();
    const backend = this.parseBackend(this.asString(params.backend));
    const trustLevel = this.parseTrustLevel(this.asString(params.trustLevel));
    const firewallMode = this.parseFirewallMode(this.asString(params.firewallMode));
    const capabilities = this.parseStringArray(params.caps ?? params.capabilities);
    const tags = this.parseStringArray(params.tags);
    const endpoint = this.inferEndpoint(session.request);

    const firstHelloInSession = session.nodeId === null;
    this.deps.registry.registerOrUpdate({
      id: nodeId,
      label,
      publicKey,
      fingerprint,
      status: "online",
      endpoint,
      backend,
      trustLevel,
      firewallMode,
      capabilities,
      tags,
      metadata: this.asObject(params.metadata),
      connectedAt: nowMs,
      lastSeenAt: nowMs,
      nowMs,
    });
    if (firstHelloInSession) {
      this.deps.registry.beginSession({
        id: session.sessionId,
        nodeId,
        startedAt: nowMs,
        ipAddress: endpoint,
        capabilities,
      });
    }
    this.deps.registry.setStatus({
      id: nodeId,
      status: "online",
      connectedAt: nowMs,
      nowMs,
    });

    session.nodeId = nodeId;
    const previousSessionId = this.activeNodeSessions.get(nodeId);
    this.activeNodeSessions.set(nodeId, session.sessionId);
    if (previousSessionId && previousSessionId !== session.sessionId) {
      this.deps.log(`nodes/ws: node=${nodeId} replaced prior session=${previousSessionId}`);
    }

    const challenge = {
      gatewayNonce: randomBytes(32).toString("base64url"),
      gatewayPublicKey: null,
      ts: nowMs,
      sessionId: session.sessionId,
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
    if (!session.nodeId) {
      this.sendErrorResponse(ws, msg.id, "AUTH_INVALID", "connect.hello must be completed before connect.prove.", false);
      return;
    }
    const nowMs = Date.now();
    this.deps.registry.markHeartbeat({
      id: session.nodeId,
      nowMs,
      endpoint: this.inferEndpoint(session.request),
    });
    this.sendOkResponse(ws, msg.id, {
      sessionId: session.sessionId,
      status: "ready",
      connectedAt: session.openedAt,
    });
  }

  private handleDisconnect(ws: WebSocket, session: NodeSocketSession, reason: string): void {
    this.clearHeartbeat(session);
    this.sessions.delete(ws);
    if (session.nodeId) {
      const activeSession = this.activeNodeSessions.get(session.nodeId);
      if (activeSession === session.sessionId) {
        this.activeNodeSessions.delete(session.nodeId);
        this.deps.registry.setStatus({
          id: session.nodeId,
          status: "offline",
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

  private sendEvent(ws: WebSocket, event: string, payload: Record<string, unknown>): void {
    this.sendJson(ws, {
      type: "event",
      event,
      payload,
      ts: Date.now(),
      sender: this.gatewaySender,
    });
  }

  private sendOkResponse(ws: WebSocket, id: string | null, payload: Record<string, unknown>): void {
    this.sendJson(ws, {
      type: "res",
      id,
      ok: true,
      payload,
      ts: Date.now(),
      sender: this.gatewaySender,
    });
  }

  private sendErrorResponse(
    ws: WebSocket,
    id: string | null,
    code: string,
    message: string,
    retryable: boolean,
  ): void {
    this.sendJson(ws, {
      type: "res",
      id,
      ok: false,
      error: { code, message, retryable },
      ts: Date.now(),
      sender: this.gatewaySender,
    });
  }

  private sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      this.deps.log(`nodes/ws: send failed error=${err instanceof Error ? err.message : String(err)}`);
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
    if (type === "req") {
      const id = this.asString(obj.id);
      const method = this.asString(obj.method);
      if (!id || !method) return null;
      return {
        type: "req",
        id,
        method,
        params: obj.params,
      };
    }
    if (type === "event") {
      const event = this.asString(obj.event);
      if (!event) return null;
      return {
        type: "event",
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
