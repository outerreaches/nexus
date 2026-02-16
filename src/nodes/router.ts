import type { Tool, ToolContext } from "../core/tools.js";
import { NodeRegistry } from "./registry.js";
import type { NodeDescriptor, NodeRouter } from "./types.js";
import { NodeRoutingError } from "./types.js";

export class NodeToolRouter implements NodeRouter {
  constructor(
    private readonly deps: {
      registry: NodeRegistry;
      log: (line: string) => void;
    },
  ) {}

  async routeToolExecution(tool: Tool, args: unknown, ctx: ToolContext): Promise<string> {
    const node = this.selectNode(tool.name, ctx);
    this.assertNodeCanExecute(node, tool.name, ctx);
    this.deps.log(`nodes: route request node=${node.id} tool=${tool.name} backend=${node.backend}`);

    throw new NodeRoutingError(
      "NODE_ROUTING_NOT_IMPLEMENTED",
      `Remote execution transport is not implemented yet (node=${node.id}, tool=${tool.name}).`,
    );
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
}
