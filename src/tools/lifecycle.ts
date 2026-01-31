import { z } from "zod";

import { defineTool } from "../core/tools.js";

export const gatewayRestart = defineTool({
  name: "gateway_restart",
  description: "Request the gateway process to restart (requires a supervisor like systemd/pm2/Docker).",
  parameters: z.object({
    reason: z.string().default("requested by agent"),
    delayMs: z.number().int().min(0).max(30_000).default(2500),
  }),
  execute: async ({ reason, delayMs }, ctx) => {
    if (!ctx.requestRestart) return "ERROR: restart is not available in this runtime";
    ctx.requestRestart(reason, delayMs);
    return "OK: restart scheduled";
  },
});
