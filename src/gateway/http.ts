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
import { registerGatewayAuth } from "./auth.js";

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
  db?: NexusDatabase;
  processManager?: ProcessManager;
  agentTracker?: AgentTracker;
  nodeGateway?: NodeWebSocketGateway;
  mcp?: McpManager;
  getModelMode?: () => ModelRoutingMode;
  setModelMode?: (mode: ModelRoutingMode) => ModelRoutingMode;
};

export async function startHttpServer(
  deps: GatewayHttpDeps,
): Promise<{ stop: () => Promise<void>; listen: () => ReturnType<typeof serve>; app: Hono }> {
  const app = new Hono();
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
