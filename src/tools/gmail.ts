import { z } from "zod";

import { defineTool } from "../core/tools.js";
import { getSecret } from "../secrets/resolve-env.js";
import type { GmailOauthConfig } from "../gmail/auth.js";
import { gmailRequest } from "../gmail/api.js";
import { buildRawEmail } from "../gmail/mime.js";
import { truncateText } from "./web-shared.js";

const DEFAULT_TIMEOUT_MS = 30_000;

function getGmailOauthFromEnv(): { ok: true; oauth: GmailOauthConfig } | { ok: false; error: string } {
  const clientId = (getSecret("GOOGLE_CLIENT_ID") ?? "").trim();
  const clientSecret = (getSecret("GOOGLE_CLIENT_SECRET") ?? "").trim();
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      error:
        "Gmail is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then run `nexus gmail auth` to connect your account.",
    };
  }

  // Only used for auth code exchange; refresh token requests do not require redirect_uri.
  const redirectUri = (process.env.GOOGLE_OAUTH_REDIRECT_URI ?? "http://127.0.0.1:18790/oauth2callback").trim();
  return { ok: true, oauth: { clientId, clientSecret, redirectUri } };
}

export const gmailSend = defineTool({
  name: "gmail_send",
  description: "Send an email via Gmail API (requires `nexus gmail auth` first).",
  parameters: z
    .object({
      to: z.string().min(3).max(2000).describe("Recipient email(s). Comma-separated ok."),
      subject: z.string().min(1).max(500),
      text: z.string().max(20000).optional().describe("Plaintext body"),
      html: z.string().max(40000).optional().describe("HTML body (optional; sends multipart/alternative)"),
      cc: z.string().max(2000).optional(),
      bcc: z.string().max(2000).optional(),
      replyTo: z.string().max(2000).optional(),
      timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
    })
    .superRefine((val, ctx) => {
      if (!val.text?.trim() && !val.html?.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["text"], message: "Provide at least one of text or html." });
      }
    }),
  execute: async (args, ctx) => {
    const oauthRes = getGmailOauthFromEnv();
    if (!oauthRes.ok) return `ERROR: ${oauthRes.error}`;

    try {
      const { rawBase64Url } = buildRawEmail({
        to: args.to,
        subject: args.subject,
        text: args.text,
        html: args.html,
        cc: args.cc,
        bcc: args.bcc,
        replyTo: args.replyTo,
      });

      const res = await gmailRequest<any>(
        { stateDir: ctx.stateDir, oauth: oauthRes.oauth, timeoutMs: args.timeoutMs },
        { method: "POST", path: "/users/me/messages/send", body: { raw: rawBase64Url } },
      );
      return truncateText(JSON.stringify(res, null, 2), 12000);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

export const gmailSearch = defineTool({
  name: "gmail_search",
  description: "Search Gmail messages by query (returns ids + optional metadata).",
  parameters: z.object({
    query: z.string().min(1).max(1000).describe('Gmail search query (e.g. "from:foo@example.com newer_than:7d")'),
    maxResults: z.number().int().min(1).max(10).default(5),
    includeSpamTrash: z.boolean().default(false),
    pageToken: z.string().optional(),
    includeMetadata: z.boolean().default(true),
    timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
    maxChars: z.number().int().positive().default(12000),
  }),
  execute: async (args, ctx) => {
    const oauthRes = getGmailOauthFromEnv();
    if (!oauthRes.ok) return `ERROR: ${oauthRes.error}`;

    try {
      const list = await gmailRequest<any>(
        { stateDir: ctx.stateDir, oauth: oauthRes.oauth, timeoutMs: args.timeoutMs },
        {
          method: "GET",
          path: "/users/me/messages",
          query: {
            q: args.query,
            maxResults: String(args.maxResults),
            includeSpamTrash: args.includeSpamTrash ? "true" : "false",
            ...(args.pageToken ? { pageToken: args.pageToken } : {}),
          },
        },
      );

      const messages = Array.isArray(list?.messages) ? (list.messages as Array<{ id?: string; threadId?: string }>) : [];
      const out: any = {
        query: args.query,
        resultSizeEstimate: list?.resultSizeEstimate,
        nextPageToken: list?.nextPageToken,
        messages: messages.map((m) => ({ id: m.id, threadId: m.threadId })),
      };

      if (args.includeMetadata) {
        const expanded: any[] = [];
        for (const m of messages.slice(0, args.maxResults)) {
          if (!m?.id) continue;
          const meta = await gmailRequest<any>(
            { stateDir: ctx.stateDir, oauth: oauthRes.oauth, timeoutMs: args.timeoutMs },
            {
              method: "GET",
              path: `/users/me/messages/${encodeURIComponent(String(m.id))}`,
              query: {
                format: "metadata",
                metadataHeaders: ["From", "To", "Subject", "Date"],
              },
            },
          );
          expanded.push({
            id: meta?.id,
            threadId: meta?.threadId,
            labelIds: meta?.labelIds,
            snippet: meta?.snippet,
            internalDate: meta?.internalDate,
            headers: meta?.payload?.headers,
          });
        }
        out.messages = expanded;
      }

      return truncateText(JSON.stringify(out, null, 2), args.maxChars);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

export const gmailGetMessage = defineTool({
  name: "gmail_get_message",
  description: "Fetch a Gmail message by id (format=metadata/full/raw).",
  parameters: z.object({
    id: z.string().min(1).max(200),
    format: z.enum(["metadata", "full", "raw"]).default("metadata"),
    timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
    maxChars: z.number().int().positive().default(12000),
  }),
  execute: async (args, ctx) => {
    const oauthRes = getGmailOauthFromEnv();
    if (!oauthRes.ok) return `ERROR: ${oauthRes.error}`;

    try {
      const msg = await gmailRequest<any>(
        { stateDir: ctx.stateDir, oauth: oauthRes.oauth, timeoutMs: args.timeoutMs },
        {
          method: "GET",
          path: `/users/me/messages/${encodeURIComponent(String(args.id))}`,
          query: {
            format: args.format,
            ...(args.format === "metadata" ? { metadataHeaders: ["From", "To", "Subject", "Date"] } : {}),
          },
        },
      );
      return truncateText(JSON.stringify(msg, null, 2), args.maxChars);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

export const gmailProfile = defineTool({
  name: "gmail_profile",
  description: "Get the authenticated Gmail profile (email address, historyId).",
  parameters: z.object({
    timeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
    maxChars: z.number().int().positive().default(4000),
  }),
  execute: async (args, ctx) => {
    const oauthRes = getGmailOauthFromEnv();
    if (!oauthRes.ok) return `ERROR: ${oauthRes.error}`;
    try {
      const res = await gmailRequest<any>(
        { stateDir: ctx.stateDir, oauth: oauthRes.oauth, timeoutMs: args.timeoutMs },
        { method: "GET", path: "/users/me/profile" },
      );
      return truncateText(JSON.stringify(res, null, 2), args.maxChars);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});
