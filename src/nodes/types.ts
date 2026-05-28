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

export interface NodeRouter {
  routeToolExecution(tool: Tool, args: unknown, ctx: ToolContext): Promise<string>;
}
