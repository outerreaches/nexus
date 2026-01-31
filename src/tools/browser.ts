import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { BrowserManager } from "../browser/manager.js";
import { getCredentialField } from "../secrets/credentials.js";
import type { NexusDatabase } from "../storage/database.js";
import { getHumanActionResponseForTyping } from "../storage/human-actions.js";

const BrowserArgsSchema = z
  .object({
    action: z.enum([
      "status",
      "start",
      "stop",
      "tabs",
      "focus",
      "close",
      "open",
      "navigate",
      "snapshot",
      "text",
      "screenshot",
      "click",
      "click_text",
      "type",
      "type_secret",
      "type_action",
      "scroll",
      "press",
      "wait",
      "act",
    ]),
    // shared/optional params; validated by action-specific rules below
    url: z.string().url().optional(),
    newTab: z.boolean().default(true),
    maxElements: z.number().int().positive().default(60),
    maxChars: z.number().int().positive().default(12000),
    fileName: z.string().optional(),
    fullPage: z.boolean().default(false),
    ref: z.string().optional(),
    text: z.string().optional(),
    submit: z.boolean().default(false),
    deltaY: z.number().int().optional(),
    key: z.string().optional(),
    index: z.number().int().min(0).optional(),
    kind: z.enum(["click", "type", "press", "scroll"]).optional(),
    credentialId: z.string().max(64).optional(),
    credentialField: z.enum(["username", "password"]).optional(),
    actionId: z.string().max(32).optional(),
    timeoutMs: z.number().int().positive().default(15_000),
    waitKind: z.enum(["domcontentloaded", "networkidle", "selector", "text", "url_includes", "title_includes"]).optional(),
    waitValue: z.string().max(2000).optional(),
  })
  .superRefine((val, ctx) => {
    const requireField = (field: keyof typeof val, message: string) => {
      if (val[field] === undefined || val[field] === null || val[field] === "") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field as string], message });
      }
    };

    switch (val.action) {
      case "open":
      case "navigate":
        requireField("url", "url is required");
        break;
      case "snapshot":
      case "text":
      case "screenshot":
      case "status":
      case "start":
      case "stop":
      case "tabs":
        break;
      case "focus":
      case "close":
        requireField("index", "index is required");
        break;
      case "click":
        requireField("ref", "ref is required");
        break;
      case "click_text":
        requireField("text", "text is required");
        break;
      case "type":
        requireField("ref", "ref is required");
        requireField("text", "text is required");
        break;
      case "type_secret":
        requireField("ref", "ref is required");
        requireField("credentialId", "credentialId is required");
        requireField("credentialField", "credentialField is required");
        break;
      case "type_action":
        requireField("ref", "ref is required");
        requireField("actionId", "actionId is required");
        break;
      case "scroll":
        requireField("deltaY", "deltaY is required");
        break;
      case "press":
        requireField("key", "key is required");
        break;
      case "wait":
        requireField("waitKind", "waitKind is required");
        if (val.waitKind === "selector" || val.waitKind === "text" || val.waitKind === "url_includes" || val.waitKind === "title_includes") {
          requireField("waitValue", "waitValue is required for this waitKind");
        }
        break;
      case "act":
        requireField("kind", "kind is required");
        if (val.kind === "click") requireField("ref", "ref is required for click");
        if (val.kind === "type") {
          requireField("ref", "ref is required for type");
          requireField("text", "text is required for type");
        }
        if (val.kind === "press") requireField("key", "key is required for press");
        if (val.kind === "scroll") requireField("deltaY", "deltaY is required for scroll");
        break;
      default:
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["action"], message: "Unknown action" });
    }
  });

export const browserTool = defineTool({
  name: "browser",
  description: "Control a managed Chromium browser (OpenClaw-style): navigate, snapshot refs, click/type, and basic automation.",
  parameters: BrowserArgsSchema,
  execute: async (args, ctx) => {
    const mgr = ctx.browser as BrowserManager | undefined;
    if (!mgr) return "ERROR: browser is not configured";

    switch (args.action) {
      case "status":
        return JSON.stringify(await mgr.status(), null, 2);
      case "start":
        await mgr.start();
        return "OK";
      case "stop":
        await mgr.stop();
        return "OK";
      case "tabs":
        return JSON.stringify(await mgr.tabs(), null, 2);
      case "focus":
        return await mgr.focus(args.index!);
      case "close":
        return await mgr.close(args.index!);
      case "open":
        return await mgr.openUrl(args.url!, args.newTab);
      case "navigate":
        return await mgr.navigate(args.url!);
      case "snapshot":
        return await mgr.snapshot(args.maxElements);
      case "text":
        return await mgr.text(args.maxChars);
      case "screenshot":
        return await mgr.screenshot({ fileName: args.fileName, fullPage: args.fullPage });
      case "click":
        return await mgr.click(args.ref!);
      case "click_text":
        return await mgr.clickText(args.text!, args.timeoutMs);
      case "type":
        return await mgr.type(args.ref!, args.text!, args.submit);
      case "type_secret": {
        const value = await getCredentialField({
          stateDir: ctx.stateDir,
          id: args.credentialId!,
          field: args.credentialField!,
        });
        return await mgr.type(args.ref!, value, args.submit);
      }
      case "type_action": {
        const db = ctx.db as NexusDatabase | undefined;
        if (!db) return "ERROR: database is not available";
        const value = getHumanActionResponseForTyping(db, { id: args.actionId!, nowMs: ctx.nowMs() });
        return await mgr.type(args.ref!, value, args.submit);
      }
      case "scroll":
        return await mgr.scroll(args.deltaY!);
      case "press":
        return await mgr.press(args.key!);
      case "wait":
        return await mgr.wait({ kind: args.waitKind!, value: args.waitValue, timeoutMs: args.timeoutMs });
      case "act":
        switch (args.kind) {
          case "click":
            return await mgr.click(args.ref!);
          case "type":
            return await mgr.type(args.ref!, args.text!, args.submit);
          case "press":
            return await mgr.press(args.key!);
          case "scroll":
            return await mgr.scroll(args.deltaY!);
          default:
            return "ERROR: unknown act kind";
        }
      default:
        return "ERROR: unknown action";
    }
  },
});
