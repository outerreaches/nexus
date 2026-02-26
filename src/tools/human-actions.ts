import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";
import { createHumanAction, getHumanAction } from "../storage/human-actions.js";

export const humanAction = defineTool({
  name: "human_action",
  description:
    "Create or inspect a human action request (OTP/MFA/CAPTCHA/etc). Use action='request' to ask for input/confirmation, or action='status' to poll by id.",
  parameters: z.object({
    action: z.enum(["request", "status"]).default("request"),
    kind: z.enum(["input", "confirm"]).optional().describe("Required when action='request' (default: input)"),
    prompt: z.string().min(1).max(2000).optional().describe("Required when action='request'"),
    ttlMs: z.number().int().min(0).max(24 * 60 * 60_000).optional().describe("Optional TTL for requests (default: 10 minutes)"),
    id: z.string().min(1).max(32).optional().describe("Required when action='status'"),
  }).superRefine((value, issueCtx) => {
    if (value.action === "request") {
      if (value.prompt) return;
      issueCtx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "prompt is required when action='request'",
        path: ["prompt"],
      });
      return;
    }
    if (value.id) return;
    issueCtx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "id is required when action='status'",
      path: ["id"],
    });
  }),
  execute: async (args, ctx) => {
    const db = ctx.db as NexusDatabase | undefined;
    if (!db) return "ERROR: database is not available";

    if (args.action === "request") {
      if (!ctx.request) return "ERROR: missing request context";

      const requestKind = args.kind ?? "input";
      const requestPrompt = args.prompt ?? "";
      const ttlMs = args.ttlMs ?? 10 * 60_000;
      try {
        const row = createHumanAction(db, {
          nowMs: ctx.nowMs(),
          ttlMs,
          sessionId: ctx.request.sessionId,
          channel: ctx.request.channel,
          channelKey: ctx.request.channelKey,
          agentId: ctx.request.agentId,
          kind: requestKind,
          prompt: requestPrompt,
        });

        const instructions = [
          "Human action required.",
          `ID: ${row.id}`,
          "",
          requestPrompt,
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
    }

    try {
      const row = getHumanAction(db, { id: args.id ?? "", nowMs: ctx.nowMs() });
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
