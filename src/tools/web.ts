import { z } from "zod";

import { defineTool } from "../core/tools.js";

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|br|li|h1|h2|h3|h4|h5|h6)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const webFetch = defineTool({
  name: "web_fetch",
  description: "Fetch a URL and return extracted text (best-effort).",
  parameters: z.object({
    url: z.string().url(),
    maxChars: z.number().int().positive().default(12000),
  }),
  execute: async ({ url, maxChars }) => {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "NexusAgent/0.0.1 (+https://example.invalid)",
      },
    });
    if (!res.ok) throw new Error(`web_fetch failed: ${res.status} ${res.statusText}`);
    const ct = res.headers.get("content-type") ?? "";
    const body = await res.text();
    const text = ct.includes("text/html") ? stripHtml(body) : body;
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[truncated]` : text;
  },
});

