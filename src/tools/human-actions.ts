import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";
import { createHumanAction, getHumanAction } from "../storage/human-actions.js";

export const humanRequest = defineTool({
  name: "human_request",
  description:
    "Request a human action/input (OTP/MFA/CAPTCHA/etc). Stores the request and returns instructions for the operator to reply without leaking secrets into chat history.",
  parameters: z.object({
    kind: z.enum(["input", "confirm"]).default("input"),
    prompt: z.string().min(1).max(2000),
    ttlMs: z.number().int().min(0).max(24 * 60 * 60_000).default(10 * 60_000),
  }),
  execute: async (args, ctx) => {
    const db = ctx.db as NexusDatabase | undefined;
    if (!db) return "ERROR: database is not available";
    if (!ctx.request) return "ERROR: missing request context";

    try {
      const row = createHumanAction(db, {
        nowMs: ctx.nowMs(),
        ttlMs: args.ttlMs,
        sessionId: ctx.request.sessionId,
        channel: ctx.request.channel,
        channelKey: ctx.request.channelKey,
        agentId: ctx.request.agentId,
        kind: args.kind,
        prompt: args.prompt,
      });

      const instructions = [
        "Human action required.",
        `ID: ${row.id}`,
        "",
        args.prompt,
        "",
        "Reply options:",
        `- Telegram: /act ${row.id} <your response>`,
        `- CLI: nexus actions respond ${row.id} <your response>`,
        "",
        "To use the response in a browser form field (without revealing it to the model):",
        `- browser: { action: \"type_action\", ref: \"<fieldRef>\", actionId: \"${row.id}\" }`,
      ].join("\n");

      return JSON.stringify(
        {
          id: row.id,
          kind: row.kind,
          status: row.status,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          prompt: row.prompt,
          instructions,
        },
        null,
        2,
      );
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

export const humanStatus = defineTool({
  name: "human_status",
  description: "Check the status of a human action request by id (does not return secret response).",
  parameters: z.object({
    id: z.string().min(1).max(32),
  }),
  execute: async (args, ctx) => {
    const db = ctx.db as NexusDatabase | undefined;
    if (!db) return "ERROR: database is not available";
    try {
      const row = getHumanAction(db, { id: args.id, nowMs: ctx.nowMs() });
      if (!row) return "ERROR: not found";
      return JSON.stringify(
        {
          id: row.id,
          kind: row.kind,
          status: row.status,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          respondedAt: row.respondedAt,
          respondedByChannel: row.respondedByChannel,
          respondedByKey: row.respondedByKey,
          responsePresent: Boolean(row.responseText && row.responseText.trim()),
          prompt: row.prompt,
        },
        null,
        2,
      );
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});
