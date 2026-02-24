export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ChatUserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatUserContent = string | ChatUserContentPart[];

export type CacheControl = { type: "ephemeral" };

export type ChatMessage =
  | { role: "system"; content: string; cacheControl?: CacheControl }
  | { role: "user"; content: ChatUserContent; name?: string; cacheControl?: CacheControl }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[]; cacheControl?: CacheControl }
  | { role: "tool"; content: string; toolCallId: string; name: string; cacheControl?: CacheControl };
