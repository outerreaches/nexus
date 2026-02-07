import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { NexusDatabase } from "../storage/database.js";
import type { ProcessManager } from "../process/manager.js";
import type { AgentTracker } from "../core/agent-tracker.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerApiRoutes } from "./routes/api.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";

export type GatewayHttpDeps = {
  port: number;
  stateDir: string;
  getStatus: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  log: (msg: string) => void;
  db?: NexusDatabase;
  processManager?: ProcessManager;
  agentTracker?: AgentTracker;
};

export async function startHttpServer(deps: GatewayHttpDeps): Promise<{ stop: () => Promise<void>; listen: () => void; app: Hono }> {
  const app = new Hono();

  registerHealthRoutes(app, deps);
  registerApiRoutes(app, deps);
  registerDashboardRoutes(app, deps);

  let server: ReturnType<typeof serve> | null = null;

  return {
    listen: () => {
      server = serve({
        fetch: app.fetch,
        port: deps.port,
      });
      deps.log(`http: listening on :${deps.port}`);
    },
    stop: async () => {
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
    },
    app,
  };
}
