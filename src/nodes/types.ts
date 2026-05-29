import type { Tool, ToolContext } from "../core/tools.js";
import type {
  NodeBackend as NodeBackendKind,
  NodeFirewallMode,
  NodeRecord,
  NodeStatus,
  NodeTrustLevel,
} from "../storage/nodes.js";

export type NodeRoutingErrorCode =
  | "NODE_OFFLINE"
  | "NODE_DRAINING"
  | "CAPABILITY_UNAVAILABLE"
  | "SECURITY_CONSTRAINT_UNSATISFIED"
  | "NODE_SOCKET_UNAVAILABLE"
  | "NODE_RESPONSE_TIMEOUT"
  | "NODE_REQUEST_ABORTED"
  | "NODE_PROTOCOL_ERROR"
  | "NODE_EXECUTION_FAILED"
  | "NODE_ROUTING_NOT_IMPLEMENTED";

export class NodeRoutingError extends Error {
  constructor(
    readonly code: NodeRoutingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NodeRoutingError";
  }
}

export type NodeDescriptor = Pick<
  NodeRecord,
  | "id"
  | "label"
  | "backend"
  | "status"
  | "trustLevel"
  | "firewallMode"
  | "capabilities"
  | "tags"
  | "endpoint"
  | "connectedAt"
  | "lastSeenAt"
  | "metadata"
>;

export type NodeSession = {
  id: string;
  nodeId: string;
  backend: NodeBackendKind;
  status: NodeStatus;
  trustLevel: NodeTrustLevel;
  firewallMode: NodeFirewallMode;
  capabilities: string[];
  tags: string[];
  connectedAt: number;
  lastSeenAt: number;
};

export interface NodeBackend {
  readonly kind: NodeBackendKind;
  executeTool(
    node: NodeDescriptor,
    tool: Tool,
    args: unknown,
    ctx: ToolContext,
  ): Promise<string>;
}

export type NodeDrainResult = {
  /** True when no work a restart would interrupt remains. */
  drained: boolean;
  /** Work still in flight (in-flight synchronous requests + running/queued processes). */
  remaining: number;
  /** True if the node answered the node.drain handshake; false if we fell back to
   *  the gateway's pending-request count (older/third-party node). */
  nodeAcked: boolean;
};

export type NodeUpdateResult = {
  ok: boolean;
  /** Where the flow ended: preflight | drain | update | reconnect | complete. */
  stage: "preflight" | "drain" | "update" | "reconnect" | "complete";
  strategy: string;
  message: string;
  drain?: NodeDrainResult;
  /** Node accepted the node.update request. */
  accepted?: boolean;
  /** Node disconnected and reconnected online after the update. */
  reconnected?: boolean;
  /** Node's protocol/app version after reconnect (from the new hello). */
  protocolVersion?: number | null;
  appVersion?: string | null;
};

export interface NodeRouter {
  routeToolExecution(tool: Tool, args: unknown, ctx: ToolContext): Promise<string>;
  /** Drive the node.drain handshake (or gateway-side fallback) and report whether
   *  in-flight work has finished. Optional: only wired when a node transport is present. */
  awaitNodeDrained?(nodeId: string, opts?: { deadlineMs?: number }): Promise<NodeDrainResult>;
  /** Orchestrate a coordinated update: drain -> node.update -> await reconnect ->
   *  verify. Optional: only wired when a node transport is present. */
  updateNode?(
    nodeId: string,
    opts?: { strategy?: string; ref?: string; deadlineMs?: number; drainDeadlineMs?: number },
  ): Promise<NodeUpdateResult>;
}
