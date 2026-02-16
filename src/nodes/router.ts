import type { Tool, ToolContext } from "../core/tools.js";
import { NodeRegistry } from "./registry.js";
import type { NodeDescriptor, NodeRouter } from "./types.js";
import { NodeRoutingError } from "./types.js";

type ExecuteOnNodeParams = {
  nodeId: string;
  toolName: string;
  args: unknown;
  ctx: ToolContext;
};

export class NodeToolRouter implements NodeRouter {
  constructor(
    private readonly deps: {
      registry: NodeRegistry;
      log: (line: string) => void;
      executeOnNode?: (params: ExecuteOnNodeParams) => Promise<string>;
    },
  ) {}

  async routeToolExecution(tool: Tool, args: unknown, ctx: ToolContext): Promise<string> {
    const remoteToolName = this.resolveRemoteToolName(tool.name);
    const node = this.selectNode(remoteToolName, ctx);
    this.assertNodeCanExecute(node, remoteToolName, ctx);
    this.deps.log(
      `nodes: route request node=${node.id} tool=${tool.name} remote_tool=${remoteToolName} backend=${node.backend}`,
    );

    if (node.backend !== "nexus") {
      throw new NodeRoutingError(
        "NODE_ROUTING_NOT_IMPLEMENTED",
        `Node backend ${node.backend} is reserved but not implemented (node=${node.id}).`,
      );
    }

    if (!this.deps.executeOnNode) {
      throw new NodeRoutingError(
        "NODE_ROUTING_NOT_IMPLEMENTED",
        `Remote execution transport is not wired (node=${node.id}, tool=${remoteToolName}).`,
      );
    }

    return this.deps.executeOnNode({
      nodeId: node.id,
      toolName: remoteToolName,
      args,
      ctx,
    });
  }

  private selectNode(toolName: string, ctx: ToolContext): NodeDescriptor {
    if (ctx.executionNode) {
      const node = this.deps.registry.get(ctx.executionNode);
      if (!node) {
        throw new NodeRoutingError("NODE_OFFLINE", `Node ${ctx.executionNode} is not registered.`);
      }
      return node;
    }

    const mode = ctx.executionMode ?? "local";
    if (mode !== "remote" && mode !== "auto") {
      throw new NodeRoutingError(
        "NODE_ROUTING_NOT_IMPLEMENTED",
        `Node routing requested without remote mode (executionMode=${mode}).`,
      );
    }

    const nodes = this.deps.registry.list(500);
    const candidate = nodes.find((node) => node.status === "online" && this.nodeHasCapability(node, toolName));
    if (!candidate) {
      throw new NodeRoutingError(
        "CAPABILITY_UNAVAILABLE",
        `No online node advertises capability for tool ${toolName}.`,
      );
    }
    return candidate;
  }

  private assertNodeCanExecute(node: NodeDescriptor, toolName: string, ctx: ToolContext): void {
    if (node.status !== "online") {
      throw new NodeRoutingError("NODE_OFFLINE", `Node ${node.id} is ${node.status}.`);
    }
    if (!this.nodeHasCapability(node, toolName)) {
      throw new NodeRoutingError(
        "CAPABILITY_UNAVAILABLE",
        `Node ${node.id} does not advertise tool capability ${toolName}.`,
      );
    }

    // If a firewall session is present, avoid silently downgrading to transparent mode.
    if (ctx.firewallSession && node.firewallMode === "transparent") {
      throw new NodeRoutingError(
        "SECURITY_CONSTRAINT_UNSATISFIED",
        `Node ${node.id} is transparent and cannot satisfy firewall session continuity.`,
      );
    }
  }

  private nodeHasCapability(node: NodeDescriptor, toolName: string): boolean {
    return node.capabilities.includes("*") || node.capabilities.includes(toolName);
  }

  private resolveRemoteToolName(toolName: string): string {
    // Current local shell tool maps to protocol-level system.run on Nexus nodes.
    if (toolName === "shell_exec") return "system.run";
    if (toolName === "process_start") return "process.start";
    if (toolName === "process_status") return "process.status";
    if (toolName === "process_logs") return "process.logs";
    if (toolName === "process_stop") return "process.cancel";
    if (toolName === "process_list") {
      throw new NodeRoutingError(
        "NODE_ROUTING_NOT_IMPLEMENTED",
        "Remote process listing is not implemented yet; use explicit process_status/process_logs/process_stop.",
      );
    }
    return toolName;
  }
}
