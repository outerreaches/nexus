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

/**
 * Reasoning items returned by the OpenAI Responses API for reasoning models
 * (gpt-5.x). Captured by CodexResponsesClient and round-tripped on subsequent
 * turns so codex maintains its chain of thought across an agent run.
 *
 * Not persisted across sessions — lives in the agent runner's in-memory
 * message array only. Other LLM clients ignore this field.
 */
export type ReasoningItem = {
  id: string;
  /** Encrypted reasoning blob — opaque to us, replayed verbatim to codex. */
  encryptedContent?: string;
  /** Human-readable reasoning summary the model exposed. */
  summary: string[];
};

export type ChatMessage =
  | { role: "system"; content: string; cacheControl?: CacheControl }
  | { role: "user"; content: ChatUserContent; name?: string; cacheControl?: CacheControl }
  | { role: "assistant"; content: string | null; toolCalls?: ToolCall[]; cacheControl?: CacheControl; reasoning?: ReasoningItem[] }
  | { role: "tool"; content: string; toolCallId: string; name: string; cacheControl?: CacheControl };
