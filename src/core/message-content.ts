import type { ChatUserContent } from "./types.js";

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…(+${text.length - maxChars} chars)`;
}

function isDataUrl(url: string): boolean {
  return /^data:/i.test(url);
}

type RenderOptions = {
  includeImageUrls?: boolean;
  maxCharsPerUrl?: number;
};

export function renderUserContentForText(content: ChatUserContent, options: RenderOptions = {}): string {
  if (typeof content === "string") return content;
  const includeImageUrls = options.includeImageUrls ?? false;
  const maxCharsPerUrl = Math.max(32, options.maxCharsPerUrl ?? 200);
  const lines: string[] = [];

  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") {
      const text = typeof part.text === "string" ? part.text : "";
      if (text.trim().length > 0) lines.push(text);
      continue;
    }
    if (part.type === "image_url") {
      const url = typeof part.image_url?.url === "string" ? part.image_url.url : "";
      if (!url) {
        lines.push("[image]");
        continue;
      }
      if (!includeImageUrls) {
        lines.push(isDataUrl(url) ? "[image: inline data]" : "[image]");
        continue;
      }
      lines.push(`[image] ${truncate(url, maxCharsPerUrl)}`);
    }
  }

  return lines.join("\n").trim();
}

export function renderUserContentForStorage(content: ChatUserContent): string {
  const text = renderUserContentForText(content, { includeImageUrls: false });
  return truncate(text, 16_000);
}

export function estimateUserContentPayloadChars(content: ChatUserContent): number {
  if (typeof content === "string") return content.length;
  let total = 0;
  for (const part of content) {
    if (part.type === "text") {
      total += part.text.length;
      continue;
    }
    if (part.type === "image_url") {
      total += part.image_url?.url?.length ?? 0;
    }
  }
  return total;
}

