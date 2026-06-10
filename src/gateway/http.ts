import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { NexusDatabase } from "../storage/database.js";
import type { ProcessManager } from "../process/manager.js";
import type { AgentTracker } from "../core/agent-tracker.js";
import type { NodeWebSocketGateway } from "../nodes/ws-gateway.js";
import type { McpManager } from "../mcp/manager.js";
import type { ModelRoutingMode } from "../llm/model-router.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { getGatewayRequestAuth, registerGatewayAuth } from "./auth.js";

export type GatewayHttpDeps = {
  port: number;
  stateDir: string;
  getStatus: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  log: (msg: string) => void;
  federationLocalInstanceId?: string;
  federationWebhooksFederatedOnly?: boolean;
  federationWebhooksExternalEnabled?: boolean;
  federationAllowInsecureTransportDev?: boolean;
  federationAllowInsecureWebhookHttpDev?: boolean;
  runtimeProfile?: string;
  getFederationBreakglassState?: () => { globalDisable: boolean };
  setFederationGlobalDisable?: (disabled: boolean) => { globalDisable: boolean };
  isStandby?: () => boolean;
  /** Epoch ms when this instance last transitioned to active mode. */
  getActivatedAt?: () => number | null;
  db?: NexusDatabase;
  processManager?: ProcessManager;
  agentTracker?: AgentTracker;
  nodeGateway?: NodeWebSocketGateway;
  mcp?: McpManager;
  getMemoryHintsSeen?: () => Record<string, string[]>;
  dispatchCliMessage?: (params: {
    channel: string;
    channelKey: string;
    agentId: string;
    text: string;
  }) => Promise<{
    runId: string | null;
    sessionId: string;
    output: string;
    status: "complete" | "failed" | "budget_exhausted";
    toolCallsUsed: number;
    iterationsUsed: number;
  }>;
  getModelMode?: () => ModelRoutingMode;
  setModelMode?: (mode: ModelRoutingMode) => ModelRoutingMode;
  getCircuitBreakerStats?: () => {
    state: string;
    consecutiveFailures: number;
    lastFailureMs: number;
    lastFailureMessage: string;
    manualMode: ModelRoutingMode | null;
    effectiveMode: ModelRoutingMode;
  };
};

export async function startHttpServer(
  deps: GatewayHttpDeps,
): Promise<{ stop: () => Promise<void>; listen: () => ReturnType<typeof serve>; app: Hono }> {
  const app = new Hono();
  // Surface unhandled route exceptions in the host log, and — for
  // authenticated requests only — in the response body. Hono's default 500 is
  // a bare "Internal Server Error" with no detail, which makes operator
  // diagnosis impossible without container log access. The dashboard is
  // operator-only, so leaking message + truncated stack frames to an
  // authenticated session is an acceptable tradeoff. Unauthenticated callers
  // (public paths, or auth disabled) get a generic 500 to avoid disclosing
  // internals.
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : "";
    const path = c.req.path;
    deps.log(`http_error path=${path} message=${message}`);
    if (stack) {
      // Keep the host log compact; full stack lines first 8.
      const stackLines = stack.split("\n").slice(0, 8).join("\n");
      deps.log(`http_error_stack path=${path}\n${stackLines}`);
    }
    if (!getGatewayRequestAuth(c)) {
      return c.text("Internal Server Error", 500);
    }
    const body = [
      `Error: ${message}`,
      "",
      "Path: " + path,
      "",
      stack ? stack.split("\n").slice(0, 12).join("\n") : "(no stack)",
    ].join("\n");
    return c.text(body, 500);
  });

  registerGatewayAuth(app, deps);

  // Keep this module as pure HTTP bootstrap. Node WebSocket transport is wired
  // separately in gateway startup to keep boundaries explicit.
  registerHealthRoutes(app, deps);
  registerApiRoutes(app, deps);
  registerDashboardRoutes(app, deps);

  let server: ReturnType<typeof serve> | null = null;

  return {
    listen: () => {
      if (server) return server;
      server = serve({
        fetch: app.fetch,
        port: deps.port,
      });
      deps.log(`http: listening on :${deps.port}`);
      return server;
    },
    stop: async () => {
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = null;
    },
    app,
  };
}
