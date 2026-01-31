import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { BrowserManager } from "../browser/manager.js";

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
      "type",
      "scroll",
      "press",
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
      case "type":
        requireField("ref", "ref is required");
        requireField("text", "text is required");
        break;
      case "scroll":
        requireField("deltaY", "deltaY is required");
        break;
      case "press":
        requireField("key", "key is required");
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
      case "type":
        return await mgr.type(args.ref!, args.text!, args.submit);
      case "scroll":
        return await mgr.scroll(args.deltaY!);
      case "press":
        return await mgr.press(args.key!);
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
