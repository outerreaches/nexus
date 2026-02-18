export type UnifiedFirewallBoundary = "federation" | "node";
export type UnifiedFirewallDirection = "ingress" | "egress";

export type UnifiedFirewallInput = {
  boundary: UnifiedFirewallBoundary;
  direction: UnifiedFirewallDirection;
  methodOrEvent: string;
  transportKind: string;
  peerEnabled?: boolean;
  peerTrustState?: "pending" | "trusted" | "revoked" | "quarantined";
  nodeFirewallMode?: string | null;
  requiresHermesMode?: boolean;
  carriesSecretRefs?: boolean;
};

export type UnifiedFirewallDecision = {
  allowed: boolean;
  decision: "allow" | "deny";
  reason: string;
  methodOrEvent: string;
  operation: string;
  boundary: UnifiedFirewallBoundary;
  direction: UnifiedFirewallDirection;
  transportKind: string;
};

const FEDERATION_BLOCKED_METHODS = new Set([
  "shell_exec",
  "shell.interactive",
  "node_system_run",
  "file_read",
  "file_write",
  "file_edit",
  "code_write",
  "spawn_agent",
  "db_query",
  "sql_exec",
]);

const FEDERATION_INGRESS_ALLOWLIST = new Set([
  "submit_task",
  "task.submit",
  "task_status",
  "task.status",
  "task.cancel",
  "webhook.deliver",
]);

const FEDERATION_EGRESS_ALLOWLIST = new Set([
  "submit_task",
  "task.submit",
  "task_status",
  "task.status",
  "task.cancel",
  "federation.outbox.dispatch",
  "webhook.deliver",
]);

function normalizeMethodOrEvent(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeNodeFirewallMode(value: string | null | undefined): "transparent" | "hermes" {
  return value === "hermes" ? "hermes" : "transparent";
}

function classifyOperation(methodOrEvent: string): string {
  const normalized = normalizeMethodOrEvent(methodOrEvent);
  if (normalized === "submit_task" || normalized === "task.submit") return "task.submit";
  if (normalized === "task_status" || normalized === "task.status") return "task.status";
  if (normalized === "task.cancel") return "task.cancel";
  if (normalized === "webhook.deliver") return "webhook.deliver";
  if (normalized.startsWith("event.")) return "event.publish";
  if (normalized.startsWith("service.")) return "service.control";
  return "unknown";
}

function deny(input: UnifiedFirewallInput, reason: string, methodOrEvent: string): UnifiedFirewallDecision {
  return {
    allowed: false,
    decision: "deny",
    reason,
    methodOrEvent,
    operation: classifyOperation(methodOrEvent),
    boundary: input.boundary,
    direction: input.direction,
    transportKind: input.transportKind,
  };
}

function allow(input: UnifiedFirewallInput, methodOrEvent: string): UnifiedFirewallDecision {
  return {
    allowed: true,
    decision: "allow",
    reason: "policy_allow",
    methodOrEvent,
    operation: classifyOperation(methodOrEvent),
    boundary: input.boundary,
    direction: input.direction,
    transportKind: input.transportKind,
  };
}

function evaluateFederationPolicy(input: UnifiedFirewallInput, methodOrEvent: string): UnifiedFirewallDecision {
  if (input.peerEnabled === false) {
    return deny(input, "peer_disabled", methodOrEvent);
  }
  if ((input.peerTrustState ?? "trusted") !== "trusted") {
    return deny(input, `peer_not_trusted:${input.peerTrustState ?? "pending"}`, methodOrEvent);
  }
  if (FEDERATION_BLOCKED_METHODS.has(methodOrEvent)) {
    return deny(input, `blocked_method:${methodOrEvent}`, methodOrEvent);
  }
  const allowlist = input.direction === "ingress" ? FEDERATION_INGRESS_ALLOWLIST : FEDERATION_EGRESS_ALLOWLIST;
  if (!allowlist.has(methodOrEvent)) {
    return deny(input, `${input.direction}_method_not_allowlisted:${methodOrEvent}`, methodOrEvent);
  }
  return allow(input, methodOrEvent);
}

function evaluateNodePolicy(input: UnifiedFirewallInput, methodOrEvent: string): UnifiedFirewallDecision {
  const mode = normalizeNodeFirewallMode(input.nodeFirewallMode);
  if (input.requiresHermesMode && mode !== "hermes") {
    return deny(input, "requires_hermes_mode", methodOrEvent);
  }
  if (input.carriesSecretRefs && mode !== "hermes") {
    return deny(input, "secret_material_requires_hermes_mode", methodOrEvent);
  }
  return allow(input, methodOrEvent);
}

export function evaluateUnifiedFirewallPolicy(input: UnifiedFirewallInput): UnifiedFirewallDecision {
  const methodOrEvent = normalizeMethodOrEvent(input.methodOrEvent);
  if (!methodOrEvent) {
    return deny(input, "empty_method_or_event", methodOrEvent);
  }
  if (input.boundary === "federation") {
    return evaluateFederationPolicy(input, methodOrEvent);
  }
  return evaluateNodePolicy(input, methodOrEvent);
}
