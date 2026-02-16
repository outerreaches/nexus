import type { Hono } from "hono";

export type NodeRouteDeps = {
  isStandby: () => boolean;
};

export function registerNodeRoutes(app: Hono, deps: NodeRouteDeps): void {
  app.get("/nodes", async (c) => {
    const upgrade = c.req.header("upgrade");
    const wantsWebSocket = typeof upgrade === "string" && upgrade.toLowerCase() === "websocket";
    if (!wantsWebSocket) {
      return c.json(
        {
          ok: false,
          error: "websocket_upgrade_required",
          message: "Connect to /nodes with a WebSocket upgrade request.",
        },
        426,
      );
    }
    return c.json(
      {
        ok: false,
        error: "OPENCLAW_BACKEND_DEFERRED",
        message: "OpenClaw compatibility backend is reserved but not implemented yet.",
      },
      501,
    );
  });

  app.get("/nx/nodes", async (c) => {
    const upgrade = c.req.header("upgrade");
    const wantsWebSocket = typeof upgrade === "string" && upgrade.toLowerCase() === "websocket";
    if (!wantsWebSocket) {
      return c.json(
        {
          ok: false,
          error: "websocket_upgrade_required",
          message: "Connect to /nx/nodes with a WebSocket upgrade request.",
        },
        426,
      );
    }

    if (deps.isStandby()) {
      return c.json(
        {
          ok: false,
          error: "NODE_GATEWAY_STANDBY",
          message: "Standby gateway does not accept node WebSocket sessions.",
        },
        503,
      );
    }

    return c.json(
      {
        ok: false,
        error: "NEXUS_NODE_WS_STUB",
        message: "Node WebSocket transport is scaffolded but not implemented yet.",
      },
      501,
    );
  });
}
