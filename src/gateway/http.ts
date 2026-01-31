import { Hono } from "hono";
import { serve } from "@hono/node-server";

export type GatewayHttpDeps = {
  port: number;
  getStatus: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  log: (msg: string) => void;
};

export async function startHttpServer(deps: GatewayHttpDeps): Promise<{ stop: () => Promise<void>; app: Hono }> {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/status", async (c) => c.json(await deps.getStatus()));

  const server = serve({
    fetch: app.fetch,
    port: deps.port,
  });

  deps.log(`http: listening on :${deps.port}`);

  return {
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
    app,
  };
}
