import type { ChatMessage, ToolCall } from "../core/types.js";
import type { Tool } from "../core/tools.js";
import { estimateUserContentPayloadChars, renderUserContentForText } from "../core/message-content.js";

export type OpenAICompatConfig = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  onLog?: (line: string) => void;
};

export type LLMCompleteChatParams = {
  messages: ChatMessage[];
  tools: Tool[];
  temperature?: number;
  timeoutMode?: "default" | "extended";
  allowImageFallback?: boolean;
};

export type LLMUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedPromptTokens?: number;
  cacheWritePromptTokens?: number;
  reasoningTokens?: number;
};

export interface LLMClient {
  completeChat(params: LLMCompleteChatParams): Promise<{ content: string | null; toolCalls: ToolCall[]; usage?: LLMUsage }>;
}

const DEFAULT_HTTP_TIMEOUT_MS = 120_000;
const DEFAULT_HTTP_TIMEOUT_MAX_MS = 420_000;
const DEFAULT_HTTP_TIMEOUT_PER_1K_TOKENS_MS = 3_000;
const DEFAULT_HTTP_TIMEOUT_EXTENDED_MULTIPLIER = 2;

function envInt(name: string): number | null {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed);
}

function envBool(name: string): boolean | null {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return null;
}

type OpenAIChatMessage =
  | { role: "system"; content: string }
  | {
    role: "user";
    content:
      | string
      | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
  }
  | { role: "assistant"; content: string | null; tool_calls?: unknown[] }
  | { role: "tool"; content: string; tool_call_id: string; name: string };

function toOpenAIMessages(messages: ChatMessage[]): OpenAIChatMessage[] {
  return messages.map((m) => {
    if (m.role === "user") {
      return {
        role: "user",
        content: m.content,
      };
    }
    if (m.role === "assistant") {
      if (m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: m.content,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      }
      return { role: "assistant", content: m.content };
    }
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId, name: m.name };
    }
    return m;
  });
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function normalizeToolCalls(toolCalls: unknown): ToolCall[] {
  if (!Array.isArray(toolCalls)) return [];
  const out: ToolCall[] = [];
  for (const entry of toolCalls) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : "";
    const fn = typeof e.function === "object" && e.function ? (e.function as Record<string, unknown>) : undefined;
    const name = fn && typeof fn.name === "string" ? fn.name : "";
    const args = fn && typeof fn.arguments === "string" ? fn.arguments : "{}";
    if (!id || !name) continue;
    out.push({ id, name, arguments: args });
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  if (n < 0) return undefined;
  return n;
}

function normalizeUsage(raw: unknown): LLMUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const usage = raw;
  const promptTokens = toNonNegativeInt(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = toNonNegativeInt(usage.completion_tokens ?? usage.output_tokens);
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : undefined;
  const cachedPromptTokens = toNonNegativeInt(promptDetails?.cached_tokens ?? usage.cached_tokens);
  const cacheWritePromptTokens = toNonNegativeInt(promptDetails?.cache_write_tokens ?? usage.cache_write_tokens);
  const reasoningTokens = toNonNegativeInt(completionDetails?.reasoning_tokens ?? usage.reasoning_tokens);
  const explicitTotal = toNonNegativeInt(usage.total_tokens);
  const totalTokens =
    explicitTotal ??
    (typeof promptTokens === "number" && typeof completionTokens === "number"
      ? promptTokens + completionTokens
      : undefined);

  if (
    typeof promptTokens !== "number" &&
    typeof completionTokens !== "number" &&
    typeof totalTokens !== "number" &&
    typeof cachedPromptTokens !== "number" &&
    typeof cacheWritePromptTokens !== "number" &&
    typeof reasoningTokens !== "number"
  ) {
    return undefined;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedPromptTokens,
    cacheWritePromptTokens,
    reasoningTokens,
  };
}

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalizedBase).toString();
}

function estimateCharsForMessage(message: ChatMessage): number {
  if (message.role === "assistant") {
    const contentChars = typeof message.content === "string" ? message.content.length : 0;
    const toolCallChars = (message.toolCalls ?? []).reduce(
      (sum, call) => sum + call.name.length + call.arguments.length + call.id.length,
      0,
    );
    return contentChars + toolCallChars;
  }
  if (message.role === "tool") {
    return message.name.length + message.toolCallId.length + message.content.length;
  }
  if (message.role === "user") {
    return estimateUserContentPayloadChars(message.content);
  }
  return message.content.length;
}

function estimateRequestTokens(messages: ChatMessage[], tools: Tool[]): number {
  const messageChars = messages.reduce((sum, message) => sum + estimateCharsForMessage(message), 0);
  const toolSchemaChars = tools.reduce((sum, tool) => {
    let schemaChars = 0;
    try {
      schemaChars = JSON.stringify(tool.jsonSchema).length;
    } catch {
      schemaChars = 0;
    }
    return sum + tool.name.length + tool.description.length + schemaChars;
  }, 0);
  const totalChars = messageChars + toolSchemaChars;
  return Math.ceil(totalChars / 4);
}

function resolveHttpTimeoutMs(messages: ChatMessage[], tools: Tool[]): number {
  const baseTimeoutMs = Math.max(
    1_000,
    envInt("NEXUS_LLM_HTTP_TIMEOUT_MS") ?? envInt("NEXUS_LLM_TIMEOUT_MS") ?? DEFAULT_HTTP_TIMEOUT_MS,
  );
  const dynamicEnabled = envBool("NEXUS_LLM_HTTP_TIMEOUT_DYNAMIC") ?? true;
  if (!dynamicEnabled) return baseTimeoutMs;

  const maxTimeoutMs = Math.max(
    baseTimeoutMs,
    envInt("NEXUS_LLM_HTTP_TIMEOUT_MAX_MS") ?? DEFAULT_HTTP_TIMEOUT_MAX_MS,
  );
  const per1kTokensMs = Math.max(
    0,
    envInt("NEXUS_LLM_HTTP_TIMEOUT_PER_1K_TOKENS_MS") ?? DEFAULT_HTTP_TIMEOUT_PER_1K_TOKENS_MS,
  );

  const estimatedTokens = estimateRequestTokens(messages, tools);
  const extraMs = Math.ceil(estimatedTokens / 1_000) * per1kTokensMs;
  return Math.min(maxTimeoutMs, baseTimeoutMs + extraMs);
}

function resolveTimeoutForMode(params: {
  mode: "default" | "extended";
  messages: ChatMessage[];
  tools: Tool[];
}): number {
  const normalTimeoutMs = resolveHttpTimeoutMs(params.messages, params.tools);
  if (params.mode !== "extended") return normalTimeoutMs;

  const multiplier = Math.max(
    1,
    envInt("NEXUS_LLM_HTTP_TIMEOUT_EXTENDED_MULTIPLIER") ?? DEFAULT_HTTP_TIMEOUT_EXTENDED_MULTIPLIER,
  );
  const configuredExtendedMaxMs = envInt("NEXUS_LLM_HTTP_TIMEOUT_EXTENDED_MAX_MS");
  const extendedMaxMs = Math.max(
    normalTimeoutMs,
    configuredExtendedMaxMs ?? Math.ceil((envInt("NEXUS_LLM_HTTP_TIMEOUT_MAX_MS") ?? DEFAULT_HTTP_TIMEOUT_MAX_MS) * 1.5),
  );
  return Math.min(extendedMaxMs, Math.ceil(normalTimeoutMs * multiplier));
}

function messagesContainImageParts(messages: ChatMessage[]): boolean {
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "image_url") return true;
    }
  }
  return false;
}

function toTextOnlyUserMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "user" || typeof message.content === "string") return message;
    const rendered = renderUserContentForText(message.content, { includeImageUrls: false });
    return {
      role: "user",
      content: rendered || "[image attachment omitted for non-vision model]",
    };
  });
}

function shouldRetryWithoutImages(params: { status: number; statusText: string; body: string }): boolean {
  if (![400, 415, 422].includes(params.status)) return false;
  const haystack = `${params.statusText}\n${params.body}`.toLowerCase();
  return /image_url|vision|multimodal|does not support image|doesn't support image|image input|unsupported image|invalid image/.test(
    haystack,
  );
}

export class OpenAICompatClient implements LLMClient {
  constructor(private readonly config: OpenAICompatConfig) {}

  async completeChat(params: LLMCompleteChatParams): Promise<{ content: string | null; toolCalls: ToolCall[]; usage?: LLMUsage }> {
    const url = joinUrl(this.config.baseUrl, "chat/completions");
    const log = this.config.onLog;
    const tools = params.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.jsonSchema,
      },
    }));
    const hasImages = messagesContainImageParts(params.messages);
    const allowImageFallback = params.allowImageFallback ?? true;
    let fallbackAttempted = false;
    let activeMessages = params.messages;

    while (true) {
      const timeoutMs = resolveTimeoutForMode({
        mode: params.timeoutMode ?? "default",
        messages: activeMessages,
        tools: params.tools,
      });
      const estimatedTokens = estimateRequestTokens(activeMessages, params.tools);
      const startMs = Date.now();

      log?.(`llm_fetch_start model=${this.config.model} timeout=${timeoutMs}ms est_tokens=${estimatedTokens}`);

      const controller = new AbortController();
      let abortFired = false;
      const timeout = setTimeout(() => {
        abortFired = true;
        log?.(`llm_fetch_abort_fired elapsed=${Date.now() - startMs}ms timeout=${timeoutMs}ms`);
        controller.abort();
      }, timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.config.model,
            tools,
            tool_choice: "auto",
            temperature: params.temperature ?? 0.2,
            messages: toOpenAIMessages(activeMessages),
          }),
          signal: controller.signal,
        });
        const headersElapsed = Date.now() - startMs;
        log?.(`llm_fetch_headers status=${res.status} elapsed=${headersElapsed}ms`);

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          if (!fallbackAttempted && hasImages && allowImageFallback && shouldRetryWithoutImages({
            status: res.status,
            statusText: res.statusText,
            body,
          })) {
            fallbackAttempted = true;
            activeMessages = toTextOnlyUserMessages(params.messages);
            continue;
          }
          throw new Error(`LLM request failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
        }

        const json = (await res.json()) as any;
        const totalElapsed = Date.now() - startMs;
        log?.(`llm_fetch_complete elapsed=${totalElapsed}ms headers_at=${headersElapsed}ms body_read=${totalElapsed - headersElapsed}ms`);

        const message = json?.choices?.[0]?.message as any;
        const content = normalizeAssistantContent(message?.content);
        const toolCalls = normalizeToolCalls(message?.tool_calls);
        const usage = normalizeUsage(json?.usage);
        // Some providers return tool call arguments as non-JSON; keep raw string for tool execution layer.
        return { content, toolCalls, usage };
      } catch (err) {
        const elapsed = Date.now() - startMs;
        if (err instanceof Error && err.name === "AbortError") {
          log?.(`llm_fetch_timeout elapsed=${elapsed}ms timeout=${timeoutMs}ms abort_fired=${abortFired}`);
          throw new Error(`LLM request timed out after ${timeoutMs}ms`);
        }
        log?.(`llm_fetch_error elapsed=${elapsed}ms err=${err instanceof Error ? err.message : String(err)}`);
        throw err;
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  static parseToolArgs(raw: string): unknown {
    const parsed = safeJsonParse(raw);
    return typeof parsed === "string" ? safeJsonParse(parsed) : parsed;
  }
}

function normalizeAssistantContent(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return null;

  const textParts: string[] = [];
  for (const part of raw) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (typeof p.text === "string") {
      textParts.push(p.text);
      continue;
    }
    if (typeof p.content === "string") {
      textParts.push(p.content);
      continue;
    }
    if (typeof p.type === "string" && p.type === "text" && typeof p.text === "object" && p.text) {
      const textObj = p.text as Record<string, unknown>;
      if (typeof textObj.value === "string") textParts.push(textObj.value);
    }
  }

  const out = textParts.join("\n").trim();
  return out.length > 0 ? out : null;
}
