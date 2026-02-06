import { z } from "zod";

import { defineTool } from "../core/tools.js";

export const gatewayRestart = defineTool({
  name: "gateway_restart",
  description: "Request the gateway process to restart (requires a supervisor like systemd/pm2/Docker).",
  parameters: z.object({
    reason: z.string().default("requested by agent"),
    delayMs: z.number().int().min(0).max(30_000).default(2500),
    force: z.boolean().default(false),
  }),
  execute: async ({ reason, delayMs, force }, ctx) => {
    const haPeer = (process.env.NEXUS_HA_PEER_URL ?? "").trim();
    if (haPeer && !force) {
      return (
        "ERROR: gateway_restart is blocked in HA mode. " +
        "For code changes: commit to /data/code and deploy with ha_deploy_request (or ha-rollout on host). " +
        "Use force=true only for emergency restart without code rollout."
      );
    }
    if (!ctx.requestRestart) return "ERROR: restart is not available in this runtime";
    ctx.requestRestart(reason, delayMs);
    return "OK: restart scheduled";
  },
});
