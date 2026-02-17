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

    // If a request with Upgrade headers reaches Hono, the raw HTTP upgrade
    // pipeline did not claim it. This is usually a proxy/header handling issue.
    return c.json(
      {
        ok: false,
        error: "NODE_WS_UPGRADE_HANDLED_BY_SERVER",
        message:
          "Node WebSocket upgrades are handled by the HTTP upgrade pipeline. If this route is hit with Upgrade headers, a proxy likely stripped or altered the upgrade request.",
      },
      426,
    );
  });
}
