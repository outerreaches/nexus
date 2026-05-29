import type { Tool, ToolContext } from "../core/tools.js";
import { evaluateUnifiedFirewallPolicy } from "../firewall/policy.js";
import { NodeRegistry } from "./registry.js";
import type { NodeDescriptor, NodeDrainResult, NodeRouter, NodeUpdateResult } from "./types.js";
import { NodeRoutingError } from "./types.js";
import { containsRawSecretMaterial } from "../secrets/policy.js";

type ExecuteOnNodeParams = {
  nodeId: string;
  toolName: string;
  args: unknown;
  ctx: ToolContext;
};

// eslint-disable-next-line security/detect-unsafe-regex -- token parser with bounded character classes only.
const SYMBOL_REF_PATTERN = /\{\{[a-z]+:[a-zA-Z0-9._-]+(?::[a-zA-Z0-9._-]+)?\}\}/g;
// eslint-disable-next-line security/detect-unsafe-regex -- bounded by explicit template delimiters.
const SECRET_REF_PATTERN = /\{\{secret:[^}\n\r]+\}\}/i;
type RoutingSecurityConstraints = {
  requireNexusBackend: boolean;
  requireHermesMode: boolean;
};

export class NodeToolRouter implements NodeRouter {
  constructor(
    private readonly deps: {
      registry: NodeRegistry;
      log: (line: string) => void;
      executeOnNode?: (params: ExecuteOnNodeParams) => Promise<string>;
      awaitNodeDrained?: (params: { nodeId: string; deadlineMs?: number }) => Promise<NodeDrainResult>;
      updateNode?: (params: {
        nodeId: string;
        strategy?: string;
        ref?: string;
        deadlineMs?: number;
        drainDeadlineMs?: number;
      }) => Promise<NodeUpdateResult>;
    },
  ) { }

  async awaitNodeDrained(nodeId: string, opts?: { deadlineMs?: number }): Promise<NodeDrainResult> {
    if (!this.deps.awaitNodeDrained) {
      throw new NodeRoutingError(
        "NODE_ROUTING_NOT_IMPLEMENTED",
        "Drain handshake transport is not wired on this gateway.",
      );
    }
    return this.deps.awaitNodeDrained({ nodeId, ...(opts?.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}) });
  }

  async updateNode(
    nodeId: string,
    opts?: { strategy?: string; ref?: string; deadlineMs?: number; drainDeadlineMs?: number },
  ): Promise<NodeUpdateResult> {
    if (!this.deps.updateNode) {
      throw new NodeRoutingError(
        "NODE_ROUTING_NOT_IMPLEMENTED",
        "Coordinated update transport is not wired on this gateway.",
      );
    }
    return this.deps.updateNode({ nodeId, ...(opts ?? {}) });
  }

  async routeToolExecution(tool: Tool, args: unknown, ctx: ToolContext): Promise<string> {
    const remoteToolName = this.resolveRemoteToolName(tool.name);
    const requiredSymbols = this.extractRequiredSymbols(args);
    const carriesSecretRefs = this.containsSecretReferences(args) || containsRawSecretMaterial(args);
    const constraints = this.readRoutingSecurityConstraints(args);
    const node = this.selectNode(remoteToolName, args, ctx, requiredSymbols, constraints, carriesSecretRefs);
    this.assertNodeCanExecute(node, remoteToolName, ctx, constraints, carriesSecretRefs);
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

  private selectNode(
    toolName: string,
    args: unknown,
    ctx: ToolContext,
    requiredSymbols: string[],
    constraints: RoutingSecurityConstraints,
    carriesSecretRefs: boolean,
  ): NodeDescriptor {
    if (ctx.executionNode) {
      const node = this.deps.registry.get(ctx.executionNode);
      if (!node) {
        throw new NodeRoutingError("NODE_OFFLINE", `Node ${ctx.executionNode} is not registered.`);
      }
      this.assertSecurityConstraintsSatisfied(node, constraints, carriesSecretRefs);
      this.assertRequiredSymbolsSatisfied(node, requiredSymbols);
      return node;
    }

    const explicitNodeId = this.resolveNodeIdFromArgs(toolName, args);
    if (explicitNodeId) {
      const node = this.deps.registry.get(explicitNodeId);
      if (!node) {
        throw new NodeRoutingError("NODE_OFFLINE", `Node ${explicitNodeId} is not registered.`);
      }
      this.assertSecurityConstraintsSatisfied(node, constraints, carriesSecretRefs);
      this.assertRequiredSymbolsSatisfied(node, requiredSymbols);
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
    const capableOnline = nodes.filter(
      (node) =>
        node.status === "online" &&
        this.nodeHasCapability(node, toolName) &&
        this.nodeSatisfiesSecurityConstraints(node, constraints, carriesSecretRefs),
    );
    if (requiredSymbols.length > 0) {
      const cacheReady = capableOnline.filter((node) => this.getCachedSymbolSet(node) !== null);
      if (cacheReady.length > 0) {
        const symbolMatched = cacheReady.find((node) => this.nodeHasRequiredSymbols(node, requiredSymbols));
        if (!symbolMatched) {
          throw new NodeRoutingError(
            "CAPABILITY_UNAVAILABLE",
            `No online node advertises required symbols for this request: ${requiredSymbols.join(", ")}.`,
          );
        }
        return symbolMatched;
      }
      this.deps.log(
        `nodes: symbol-aware routing fallback (no symbol cache ready) symbols=${requiredSymbols.length} tool=${toolName}`,
      );
    }
    const candidate = capableOnline[0] ?? null;
    if (!candidate) {
      if (constraints.requireHermesMode || constraints.requireNexusBackend) {
        throw new NodeRoutingError(
          "SECURITY_CONSTRAINT_UNSATISFIED",
          constraints.requireHermesMode
            ? "No online node satisfies required security constraints (backend=nexus + hermes.mode.hermes)."
            : "No online node satisfies required security constraints (backend=nexus).",
        );
      }
      if (carriesSecretRefs) {
        throw new NodeRoutingError(
          "SECURITY_CONSTRAINT_UNSATISFIED",
          "No online node satisfies secret-bearing routing constraints (backend=nexus + hermes.mode.hermes).",
        );
      }
      throw new NodeRoutingError(
        "CAPABILITY_UNAVAILABLE",
        `No online node advertises capability for tool ${toolName}.`,
      );
    }
    return candidate;
  }

  private resolveNodeIdFromArgs(toolName: string, args: unknown): string | null {
    if (
      toolName !== "symbols.list" &&
      toolName !== "audit.query" &&
      toolName !== "mcp.list" &&
      toolName !== "mcp.call" &&
      toolName !== "mcp.resources" &&
      toolName !== "file.pull" &&
      toolName !== "file.push"
    ) {
      return null;
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    const id = (args as { id?: unknown }).id;
    if (typeof id !== "string") return null;
    const trimmed = id.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private assertNodeCanExecute(
    node: NodeDescriptor,
    toolName: string,
    ctx: ToolContext,
    constraints: RoutingSecurityConstraints,
    carriesSecretRefs: boolean,
  ): void {
    if (node.status === "draining") {
      throw new NodeRoutingError(
        "NODE_DRAINING",
        `Node ${node.id} is draining for an update and is not accepting new work. Undrain it (node_manage action=undrain) or target another node.`,
      );
    }
    if (node.status !== "online") {
      throw new NodeRoutingError("NODE_OFFLINE", `Node ${node.id} is ${node.status}.`);
    }
    if (!this.nodeHasCapability(node, toolName)) {
      throw new NodeRoutingError(
        "CAPABILITY_UNAVAILABLE",
        `Node ${node.id} does not advertise tool capability ${toolName}.`,
      );
    }
    this.assertSecurityConstraintsSatisfied(node, constraints, carriesSecretRefs);

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

  private nodeHasCapabilityFlag(node: NodeDescriptor, capability: string): boolean {
    return node.capabilities.includes(capability);
  }

  private nodeSatisfiesSecurityConstraints(
    node: NodeDescriptor,
    constraints: RoutingSecurityConstraints,
    carriesSecretRefs: boolean,
  ): boolean {
    if (constraints.requireNexusBackend && node.backend !== "nexus") return false;
    const decision = evaluateUnifiedFirewallPolicy({
      boundary: "node",
      direction: "egress",
      methodOrEvent: "tool.dispatch",
      transportKind: "node_ws",
      nodeFirewallMode: node.firewallMode,
      requiresHermesMode: constraints.requireHermesMode,
      carriesSecretRefs,
    });
    return decision.allowed;
  }

  private assertSecurityConstraintsSatisfied(
    node: NodeDescriptor,
    constraints: RoutingSecurityConstraints,
    carriesSecretRefs: boolean,
  ): void {
    if (this.nodeSatisfiesSecurityConstraints(node, constraints, carriesSecretRefs)) return;
    const decision = evaluateUnifiedFirewallPolicy({
      boundary: "node",
      direction: "egress",
      methodOrEvent: "tool.dispatch",
      transportKind: "node_ws",
      nodeFirewallMode: node.firewallMode,
      requiresHermesMode: constraints.requireHermesMode,
      carriesSecretRefs,
    });
    throw new NodeRoutingError(
      "SECURITY_CONSTRAINT_UNSATISFIED",
      `Node ${node.id} does not satisfy required security constraints (${decision.reason}).`,
    );
  }

  private readRoutingSecurityConstraints(args: unknown): RoutingSecurityConstraints {
    const argsObj = this.asObject(args);
    const security = this.asObject(argsObj.security);
    const routing = this.asObject(argsObj.routing);
    const requireHermesMode =
      this.asBoolean(security.requireHermesMode) === true || this.asBoolean(routing.requireHermesMode) === true;
    const requireNexusBackend =
      requireHermesMode ||
      this.asBoolean(security.requireNexusBackend) === true ||
      this.asBoolean(routing.requireNexusBackend) === true;
    return {
      requireNexusBackend,
      requireHermesMode,
    };
  }

  private asObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  }

  private asBoolean(value: unknown): boolean | null {
    if (typeof value !== "boolean") return null;
    return value;
  }

  private extractRequiredSymbols(value: unknown): string[] {
    const out = new Set<string>();
    const visit = (input: unknown): void => {
      if (typeof input === "string") {
        const matches = input.match(SYMBOL_REF_PATTERN) ?? [];
        for (const token of matches) out.add(token);
        return;
      }
      if (Array.isArray(input)) {
        for (const item of input) visit(item);
        return;
      }
      if (!input || typeof input !== "object") return;
      for (const nested of Object.values(input as Record<string, unknown>)) visit(nested);
    };
    visit(value);
    return [...out.values()].sort((a, b) => a.localeCompare(b));
  }

  private containsSecretReferences(value: unknown): boolean {
    let found = false;
    const visit = (input: unknown): void => {
      if (found) return;
      if (typeof input === "string") {
        if (SECRET_REF_PATTERN.test(input)) {
          found = true;
        }
        return;
      }
      if (Array.isArray(input)) {
        for (const item of input) visit(item);
        return;
      }
      if (!input || typeof input !== "object") return;
      for (const nested of Object.values(input as Record<string, unknown>)) visit(nested);
    };
    visit(value);
    return found;
  }

  private getCachedSymbolSet(node: NodeDescriptor): Set<string> | null {
    const metadata = node.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const cache = (metadata as Record<string, unknown>).symbolCatalogCache;
    if (!cache || typeof cache !== "object" || Array.isArray(cache)) return null;
    const symbols = (cache as Record<string, unknown>).symbols;
    if (!Array.isArray(symbols)) return null;
    const values = symbols.filter((item): item is string => typeof item === "string");
    return new Set(values);
  }

  private nodeHasRequiredSymbols(node: NodeDescriptor, requiredSymbols: string[]): boolean {
    const cached = this.getCachedSymbolSet(node);
    if (!cached) return false;
    for (const symbol of requiredSymbols) {
      if (!cached.has(symbol)) return false;
    }
    return true;
  }

  private assertRequiredSymbolsSatisfied(node: NodeDescriptor, requiredSymbols: string[]): void {
    if (requiredSymbols.length === 0) return;
    const cached = this.getCachedSymbolSet(node);
    if (!cached) return;
    const missing = requiredSymbols.filter((symbol) => !cached.has(symbol));
    if (missing.length > 0) {
      throw new NodeRoutingError(
        "CAPABILITY_UNAVAILABLE",
        `Node ${node.id} is missing required symbols: ${missing.join(", ")}.`,
      );
    }
  }

  private resolveRemoteToolName(toolName: string): string {
    // Current local shell tool maps to protocol-level system.run on Nexus nodes.
    if (toolName === "shell_exec") return "system.run";
    if (toolName === "process_start") return "process.start";
    if (toolName === "process_status") return "process.status";
    if (toolName === "process_logs") return "process.logs";
    if (toolName === "process_stop") return "process.cancel";
    if (toolName === "node_symbols_list") return "symbols.list";
    if (toolName === "node_audit_query") return "audit.query";
    if (toolName === "node_mcp_list") return "mcp.list";
    if (toolName === "node_mcp_call") return "mcp.call";
    if (toolName === "node_mcp_resources") return "mcp.resources";
    if (toolName === "node_file_pull") return "file.pull";
    if (toolName === "node_file_push") return "file.push";
    if (toolName === "process_list") {
      throw new NodeRoutingError(
        "NODE_ROUTING_NOT_IMPLEMENTED",
        "Remote process listing is not implemented yet; use process_manage with action='status', 'logs', or 'stop' and a known processId.",
      );
    }
    return toolName;
  }
}
