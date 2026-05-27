import type { ChatMessage, ChatUserContent, ReasoningItem, ToolCall } from "../core/types.js";
import type { Tool } from "../core/tools.js";
import { Agent } from "undici";
import { estimateUserContentPayloadChars, renderUserContentForText } from "../core/message-content.js";
import { CHARS_PER_TOKEN } from "../core/context-compactor.js";
import { parseSseDataEvents } from "./sse-reader.js";

export type OpenAICompatConfig = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  maxTokens?: number;
  stream?: boolean;
  stripCacheControl?: boolean;
  /** Optional llama.cpp slot save/restore manager. When provided, completeChat
   *  routes requests through a logical-key → physical-slot allocator so
   *  long-lived sessions don't thrash the server's small slot pool. */
  slotCache?: import("./slot-cache.js").SlotCacheManager;
  onLog?: (line: string) => void;
};

export type LLMCompleteChatParams = {
  messages: ChatMessage[];
  tools: Tool[];
  temperature?: number;
  timeoutMode?: "default" | "extended";
  allowImageFallback?: boolean;
  onActivity?: () => void;
  /** Called with each text content delta as it arrives from the SSE stream. */
  onTextDelta?: (delta: string) => void;
  abortSignal?: AbortSignal;
  /** Optional logical session key for llama.cpp slot affinity / save+restore.
   *  Examples: "telegram:1452:interactive:orchestrator", "heartbeat:gateway:background:orchestrator".
   *  Ignored unless the client config carries a slotCache manager. */
  slotKey?: string;
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
  completeChat(params: LLMCompleteChatParams): Promise<{
    content: string | null;
    toolCalls: ToolCall[];
    usage?: LLMUsage;
    /** Reasoning items returned by the model — present only for Responses API providers. */
    reasoning?: ReasoningItem[];
  }>;
}

const DEFAULT_HTTP_TIMEOUT_MS = 120_000;
const DEFAULT_HTTP_TIMEOUT_MAX_MS = 420_000;
const DEFAULT_HTTP_TIMEOUT_PER_1K_TOKENS_MS = 3_000;
const DEFAULT_HTTP_TIMEOUT_EXTENDED_MULTIPLIER = 2;
const undiciAgents = new Map<string, Agent>();

type FetchInitWithDispatcher = RequestInit & { dispatcher?: Agent };

function getFetchDispatcher(baseUrl: string, timeoutMs: number, bodyInactivityMs: number): Agent | undefined {
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
  const headersTimeout = Math.max(1_000, timeoutMs + 5_000);
  const bodyTimeout = Math.max(1_000, bodyInactivityMs + 5_000);
  const connectTimeout = Math.max(10_000, Math.min(headersTimeout, 60_000));
  const key = `${origin}|h=${headersTimeout}|b=${bodyTimeout}|c=${connectTimeout}`;
  let agent = undiciAgents.get(key);
  if (!agent) {
    agent = new Agent({ headersTimeout, bodyTimeout, connectTimeout });
    undiciAgents.set(key, agent);
  }
  return agent;
}

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
  | { role: "system"; content: string; cache_control?: { type: "ephemeral" } }
  | {
    role: "user";
    name?: string;
    content:
    | string
    | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
    cache_control?: { type: "ephemeral" };
  }
  | { role: "assistant"; content: string | null; tool_calls?: unknown[]; cache_control?: { type: "ephemeral" } }
  | { role: "tool"; content: string; tool_call_id: string; name: string; cache_control?: { type: "ephemeral" } };

export function collapseConsecutiveSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const collapsed: ChatMessage[] = [];

  for (const message of messages) {
    if (message.role !== "system") {
      collapsed.push(message);
      continue;
    }

    const previous = collapsed[collapsed.length - 1];
    if (!previous || previous.role !== "system") {
      collapsed.push({ ...message });
      continue;
    }

    collapsed[collapsed.length - 1] = {
      role: "system",
      content: `${previous.content}\n\n${message.content}`,
      ...(message.cacheControl ?? previous.cacheControl ? { cacheControl: message.cacheControl ?? previous.cacheControl } : {}),
    };
  }

  return collapsed;
}

function normalizeToolCallArgumentsForRequest(raw: unknown): string {
  const toObjectString = (value: unknown): string | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  };

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return "{}";
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return "{}";
    }
    if (typeof parsed === "string") {
      const nested = parsed.trim();
      if (!nested) return "{}";
      try {
        parsed = JSON.parse(nested);
      } catch {
        return "{}";
      }
    }
    return toObjectString(parsed) ?? "{}";
  }

  return toObjectString(raw) ?? "{}";
}

const QWEN_CONTEXT_USER_PREFIX = "[Nexus runtime context]\n";
const QWEN_CONTINUATION_USER_ANCHOR =
  "[Nexus continuation]\nContinue the current Nexus task using the context and tool results above. " +
  "If the task is complete, provide the final answer.";

function userContentAsText(content: ChatUserContent): string {
  return typeof content === "string"
    ? content
    : renderUserContentForText(content, { includeImageUrls: false });
}

function isToolResponseUserContent(content: ChatUserContent): boolean {
  const text = userContentAsText(content).trim();
  return text.startsWith("<tool_response>") && text.endsWith("</tool_response>");
}

function shouldUseQwenChatTemplateCompat(config: OpenAICompatConfig): boolean {
  const override = (process.env.NEXUS_LLM_CHAT_TEMPLATE_COMPAT ?? "").trim().toLowerCase();
  if (override === "none" || override === "off" || override === "false" || override === "0") return false;
  if (override === "qwen" || override === "qwen3" || override === "qwen3.5" || override === "qwen3.6") return true;
  return config.model.toLowerCase().includes("qwen");
}

export function normalizeMessagesForQwenChatTemplate(messages: ChatMessage[]): ChatMessage[] {
  const collapsed = collapseConsecutiveSystemMessages(messages);
  const normalized: ChatMessage[] = [];

  for (const message of collapsed) {
    if (message.role !== "system") {
      normalized.push(message);
      continue;
    }

    if (normalized.length === 0) {
      normalized.push(message);
      continue;
    }

    normalized.push({
      role: "user",
      content: `${QWEN_CONTEXT_USER_PREFIX}${message.content}`,
      ...(message.cacheControl ? { cacheControl: message.cacheControl } : {}),
    });
  }

  const hasRealUserQuery = normalized.some((message) =>
    message.role === "user" && !isToolResponseUserContent(message.content)
  );
  if (!hasRealUserQuery) {
    normalized.push({
      role: "user",
      content: QWEN_CONTINUATION_USER_ANCHOR,
    });
  }

  return normalized;
}

function prepareMessagesForChatTemplate(messages: ChatMessage[], config: OpenAICompatConfig): ChatMessage[] {
  if (shouldUseQwenChatTemplateCompat(config)) {
    return normalizeMessagesForQwenChatTemplate(messages);
  }
  return collapseConsecutiveSystemMessages(messages);
}

function toOpenAIMessages(messages: ChatMessage[], config: OpenAICompatConfig): OpenAIChatMessage[] {
  return prepareMessagesForChatTemplate(messages, config).map((m) => {
    if (m.role === "user") {
      return {
        role: "user",
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
        ...(!config.stripCacheControl && m.cacheControl ? { cache_control: m.cacheControl } : {}),
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
            function: { name: tc.name, arguments: normalizeToolCallArgumentsForRequest(tc.arguments) },
          })),
          ...(!config.stripCacheControl && m.cacheControl ? { cache_control: m.cacheControl } : {}),
        };
      }
      return { role: "assistant", content: m.content, ...(!config.stripCacheControl && m.cacheControl ? { cache_control: m.cacheControl } : {}) };
    }
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId, name: m.name, ...(!config.stripCacheControl && m.cacheControl ? { cache_control: m.cacheControl } : {}) };
    }
    // Handle system messages explicitly to appease TS
    if (m.role === "system") {
      return { role: "system", content: m.content, ...(!config.stripCacheControl && m.cacheControl ? { cache_control: m.cacheControl } : {}) };
    }
    return m as unknown as OpenAIChatMessage;
  });
}

function estimateOpenAIMessageChars(message: OpenAIChatMessage): number {
  let total = 0;
  if (typeof message.content === "string") {
    total += message.content.length;
  } else if (Array.isArray(message.content)) {
    total += message.content.reduce((sum, part) => {
      if (part.type === "text") return sum + part.text.length;
      return sum + part.image_url.url.length;
    }, 0);
  }
  if ("tool_calls" in message && Array.isArray(message.tool_calls)) {
    for (const raw of message.tool_calls) {
      if (!isRecord(raw)) continue;
      const fn = isRecord(raw.function) ? raw.function : undefined;
      total += String(raw.id ?? "").length;
      total += String(fn?.name ?? "").length;
      total += String(fn?.arguments ?? "").length;
    }
  }
  if ("name" in message && typeof message.name === "string") total += message.name.length;
  if ("tool_call_id" in message && typeof message.tool_call_id === "string") total += message.tool_call_id.length;
  return total;
}

function describePromptCacheMarkers(messages: OpenAIChatMessage[]): string {
  const markerIndexes: number[] = [];
  const roles: Record<string, number> = {};
  let totalChars = 0;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    roles[message.role] = (roles[message.role] ?? 0) + 1;
    totalChars += estimateOpenAIMessageChars(message);
    if (message.cache_control) markerIndexes.push(i);
  }
  const roleSummary = Object.entries(roles).map(([role, count]) => `${role}:${count}`).join(",");
  const markerSummary = markerIndexes.length > 0 ? markerIndexes.join(",") : "none";
  return `messages=${messages.length} roles=${roleSummary || "none"} chars=${totalChars} cache_markers=${markerIndexes.length} marker_indexes=${markerSummary}`;
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

function isFireworksBaseUrl(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (!trimmed) return false;
  try {
    const host = new URL(trimmed).hostname.toLowerCase();
    return host === "api.fireworks.ai" || host.endsWith(".fireworks.ai");
  } catch {
    return trimmed.toLowerCase().includes("fireworks.ai");
  }
}

function resolveChatCompletionStreaming(config: OpenAICompatConfig, payload: Record<string, unknown>): boolean {
  if (typeof payload.stream === "boolean") return payload.stream;
  if (typeof config.stream === "boolean") return config.stream;
  return isFireworksBaseUrl(config.baseUrl);
}

/**
 * Creates a stateful incremental SSE parser that extracts text content deltas
 * from raw SSE chunk data as it arrives. Buffers partial lines across chunks.
 */
function createIncrementalSseTextExtractor(onDelta: (delta: string) => void): (rawChunk: string) => void {
  let lineBuffer = "";
  let currentData = "";
  return (rawChunk: string): void => {
    lineBuffer += rawChunk;
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length === 0) {
        const trimmed = currentData.trim();
        currentData = "";
        if (!trimmed || trimmed === "[DONE]") continue;
        try {
          const parsed = JSON.parse(trimmed);
          const choices = Array.isArray(parsed?.choices) ? parsed.choices : [];
          for (const choice of choices) {
            const content = choice?.delta?.content;
            if (typeof content === "string" && content) {
              onDelta(content);
            }
          }
        } catch { /* skip malformed */ }
        continue;
      }
      if (line.startsWith(":")) continue;
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trimStart();
        currentData = currentData.length > 0 ? `${currentData}\n${payload}` : payload;
      }
    }
  };
}

// Data-event extraction lives in ./sse-reader.ts so codex-responses (Responses
// API stream) can reuse the same line buffering. Re-imported here for the
// post-stream reconciliation pass over a buffered body.
// (parseSseDataEvents is imported at the top of this file.)

type StreamToolCallAccumulator = {
  id?: string;
  name?: string;
  arguments: string;
};

function appendStreamContentChunks(out: Array<string | Record<string, unknown>>, raw: unknown): void {
  if (typeof raw === "string") {
    out.push(raw);
    return;
  }
  if (Array.isArray(raw)) {
    for (const part of raw) {
      if (typeof part === "string") {
        out.push(part);
      } else if (isRecord(part)) {
        out.push(part);
      }
    }
    return;
  }
  if (isRecord(raw)) {
    if (typeof raw.text === "string") {
      out.push(raw.text);
      return;
    }
    out.push(raw);
  }
}

function mergeStreamToolCallDelta(target: Map<number, StreamToolCallAccumulator>, raw: unknown): void {
  if (!Array.isArray(raw)) return;
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (!isRecord(entry)) continue;
    const index = typeof entry.index === "number" && Number.isFinite(entry.index) ? Math.floor(entry.index) : i;
    const acc = target.get(index) ?? { arguments: "" };
    if (typeof entry.id === "string" && entry.id.trim().length > 0) acc.id = entry.id;
    const fn = isRecord(entry.function) ? entry.function : undefined;
    if (fn && typeof fn.name === "string" && fn.name.trim().length > 0) acc.name = fn.name;
    if (fn && typeof fn.arguments === "string") {
      acc.arguments += fn.arguments;
    } else if (typeof entry.arguments === "string") {
      acc.arguments += entry.arguments;
    }
    target.set(index, acc);
  }
}

function collapseStreamContent(chunks: Array<string | Record<string, unknown>>): unknown {
  if (chunks.length === 0) return null;
  if (chunks.every((chunk) => typeof chunk === "string")) {
    return (chunks as string[]).join("");
  }

  const parts: Record<string, unknown>[] = [];
  let textBuffer = "";
  const flushText = () => {
    if (!textBuffer) return;
    parts.push({ type: "text", text: textBuffer });
    textBuffer = "";
  };

  for (const chunk of chunks) {
    if (typeof chunk === "string") {
      textBuffer += chunk;
      continue;
    }
    flushText();
    parts.push(chunk);
  }
  flushText();

  if (parts.length === 1 && parts[0]?.type === "text" && typeof parts[0]?.text === "string") {
    return parts[0].text;
  }
  return parts;
}

function buildToolCallsFromStream(acc: Map<number, StreamToolCallAccumulator>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const sorted = [...acc.entries()].sort((a, b) => a[0] - b[0]);
  for (const [index, entry] of sorted) {
    if (!entry.name) continue;
    out.push({
      id: entry.id ?? `call_${index}`,
      type: "function",
      function: {
        name: entry.name,
        arguments: entry.arguments || "{}",
      },
    });
  }
  return out;
}

function mergeFinalAndStreamMessage(params: {
  finalMessage: Record<string, unknown> | null;
  streamMessage: Record<string, unknown>;
}): Record<string, unknown> {
  if (!params.finalMessage) return params.streamMessage;
  const merged: Record<string, unknown> = {
    ...params.streamMessage,
    ...params.finalMessage,
  };
  if (!Object.prototype.hasOwnProperty.call(params.finalMessage, "tool_calls")) {
    const streamToolCalls = params.streamMessage.tool_calls;
    if (Array.isArray(streamToolCalls) && streamToolCalls.length > 0) {
      merged.tool_calls = streamToolCalls;
    }
  }
  if (
    (!Object.prototype.hasOwnProperty.call(params.finalMessage, "content") ||
      params.finalMessage.content === null ||
      params.finalMessage.content === "") &&
    params.streamMessage.content
  ) {
    merged.content = params.streamMessage.content;
  }
  if (!Object.prototype.hasOwnProperty.call(merged, "role")) merged.role = "assistant";
  return merged;
}

function parseStreamedChatCompletionBody(rawBody: string): Record<string, unknown> {
  const dataEvents = parseSseDataEvents(rawBody);
  const contentChunks: Array<string | Record<string, unknown>> = [];
  const toolCallAccumulator = new Map<number, StreamToolCallAccumulator>();
  let usage: unknown;
  let finishReason: unknown;
  let responseId: string | undefined;
  let responseModel: string | undefined;
  let responseObject: string | undefined;
  let finalMessage: Record<string, unknown> | null = null;

  for (const payload of dataEvents) {
    if (!payload || payload === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    if (!responseId && typeof parsed.id === "string") responseId = parsed.id;
    if (!responseModel && typeof parsed.model === "string") responseModel = parsed.model;
    if (!responseObject && typeof parsed.object === "string") responseObject = parsed.object;
    if (parsed.usage !== undefined) usage = parsed.usage;

    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        finishReason = choice.finish_reason;
      }
      if (isRecord(choice.message)) {
        finalMessage = choice.message;
      }
      const delta = isRecord(choice.delta) ? choice.delta : undefined;
      if (!delta) continue;
      appendStreamContentChunks(contentChunks, delta.content);
      mergeStreamToolCallDelta(toolCallAccumulator, delta.tool_calls);
    }
  }

  const streamMessage: Record<string, unknown> = {
    role: "assistant",
    content: collapseStreamContent(contentChunks),
  };
  const streamToolCalls = buildToolCallsFromStream(toolCallAccumulator);
  if (streamToolCalls.length > 0) streamMessage.tool_calls = streamToolCalls;

  const message = mergeFinalAndStreamMessage({
    finalMessage,
    streamMessage,
  });
  const choice: Record<string, unknown> = { index: 0, message };
  if (finishReason !== undefined) choice.finish_reason = finishReason;

  const out: Record<string, unknown> = {
    choices: [choice],
  };
  if (responseId) out.id = responseId;
  if (responseModel) out.model = responseModel;
  if (responseObject) out.object = responseObject;
  if (usage !== undefined) out.usage = usage;
  return out;
}

export function parseChatCompletionResponseBody(bodyText: string, stream: boolean): Record<string, unknown> {
  if (!stream) {
    return JSON.parse(bodyText) as Record<string, unknown>;
  }
  return parseStreamedChatCompletionBody(bodyText);
}

export async function requestOpenAICompatChatCompletion(params: {
  llm: OpenAICompatConfig;
  payload: Record<string, unknown>;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  onActivity?: () => void;
  onLog?: (line: string) => void;
}): Promise<Record<string, unknown>> {
  const url = joinUrl(params.llm.baseUrl, "chat/completions");
  const controller = new AbortController();
  const startMs = Date.now();
  const stream = resolveChatCompletionStreaming(params.llm, params.payload);
  const bodyInactivityMs = Math.max(
    1_000,
    envInt("NEXUS_LLM_BODY_INACTIVITY_TIMEOUT_MS") ?? DEFAULT_BODY_INACTIVITY_TIMEOUT_MS,
  );
  const dispatcher = getFetchDispatcher(params.llm.baseUrl, params.timeoutMs, bodyInactivityMs);
  const requestPayload: Record<string, unknown> = {
    ...params.payload,
    ...(stream ? { stream: true } : {}),
  };

  let externalAbortListener: (() => void) | null = null;
  if (params.abortSignal) {
    const onExternalAbort = () => {
      params.onLog?.(`llm_fetch_abort_external elapsed=${Date.now() - startMs}ms`);
      controller.abort(params.abortSignal?.reason);
    };
    if (params.abortSignal.aborted) {
      onExternalAbort();
    } else {
      params.abortSignal.addEventListener("abort", onExternalAbort, { once: true });
      externalAbortListener = () => {
        params.abortSignal?.removeEventListener("abort", onExternalAbort);
      };
    }
  }

  let abortFired = false;
  const timeout = setTimeout(() => {
    abortFired = true;
    controller.abort();
  }, params.timeoutMs);

  try {
    const fetchInit: FetchInitWithDispatcher = {
      method: "POST",
      headers: {
        ...(params.llm.apiKey ? { Authorization: `Bearer ${params.llm.apiKey}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload),
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    };
    const res = await fetch(url, fetchInit);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`LLM request failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`);
    }

    clearTimeout(timeout);
    const bodyText = await readBodyWithInactivityTimeout({
      body: res.body,
      controller,
      inactivityMs: bodyInactivityMs,
      onActivity: params.onActivity,
      onLog: params.onLog,
      startMs,
    });
    return parseChatCompletionResponseBody(bodyText, stream);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      const mode = abortFired ? `after ${params.timeoutMs}ms` : "(external abort)";
      throw new Error(`LLM request timed out ${mode}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    externalAbortListener?.();
  }
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
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
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

const DEFAULT_BODY_INACTIVITY_TIMEOUT_MS = 60_000;

async function readBodyWithInactivityTimeout(params: {
  body: ReadableStream<Uint8Array> | null;
  controller: AbortController;
  inactivityMs: number;
  onActivity?: () => void;
  onChunk?: (text: string) => void;
  onLog?: (line: string) => void;
  startMs: number;
}): Promise<string> {
  if (!params.body) return "";
  const reader = params.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let lastActivityMs = Date.now();
  let lastActivityCallMs = 0;

  const inactivityCheck = setInterval(() => {
    if (Date.now() - lastActivityMs > params.inactivityMs) {
      params.onLog?.(`llm_fetch_body_stall elapsed=${Date.now() - params.startMs}ms inactivity=${params.inactivityMs}ms`);
      params.controller.abort();
    }
  }, 5_000);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const decoded = decoder.decode(value, { stream: true });
      chunks.push(decoded);
      params.onChunk?.(decoded);
      lastActivityMs = Date.now();
      if (params.onActivity && Date.now() - lastActivityCallMs > 4_000) {
        lastActivityCallMs = Date.now();
        params.onActivity();
      }
    }
    const final = decoder.decode();
    if (final) chunks.push(final);
    return chunks.join("");
  } finally {
    clearInterval(inactivityCheck);
    reader.releaseLock();
  }
}

export class OpenAICompatClient implements LLMClient {
  constructor(private readonly config: OpenAICompatConfig) { }

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

    // Acquire llama.cpp slot lease for the duration of this call (covering
    // image-fallback retry loops). On opt-in providers this serializes
    // concurrent calls onto the configured slot pool and triggers save+restore
    // when ownership rotates.
    let slotLease: Awaited<ReturnType<NonNullable<typeof this.config.slotCache>["acquire"]>> | null = null;
    if (this.config.slotCache && params.slotKey) {
      try {
        slotLease = await this.config.slotCache.acquire(params.slotKey);
        log?.(`llm_slot_lease key=${params.slotKey} slot=${slotLease.slotId} restored=${slotLease.restored ? "yes" : "no"}`);
      } catch (err) {
        // Slot acquisition failures should not block inference — fall back to
        // server-managed slot selection.
        log?.(`llm_slot_lease_failed key=${params.slotKey} err=${err instanceof Error ? err.message : String(err)}`);
      }
    }

    try {
    for (;;) {
      const timeoutMs = resolveTimeoutForMode({
        mode: params.timeoutMode ?? "default",
        messages: activeMessages,
        tools: params.tools,
      });
      const estimatedTokens = estimateRequestTokens(activeMessages, params.tools);
      const startMs = Date.now();
      const requestMessages = toOpenAIMessages(activeMessages, this.config);
      const requestPayload: Record<string, unknown> = {
        model: this.config.model,
        tools,
        tool_choice: "auto",
        temperature: params.temperature ?? 0.2,
        max_tokens: this.config.maxTokens ?? 16384,
        messages: requestMessages,
      };
      if (slotLease) {
        // Pin the call to the leased slot so llama.cpp does NOT migrate state
        // mid-flight. cache_prompt=true keeps the KV cache populated after
        // the response so the next same-key call hits in-memory.
        requestPayload.id_slot = slotLease.slotId;
        requestPayload.cache_prompt = true;
      }
      const stream = resolveChatCompletionStreaming(this.config, requestPayload);
      if (stream) requestPayload.stream = true;
      const bodyInactivityMs = Math.max(
        1_000,
        envInt("NEXUS_LLM_BODY_INACTIVITY_TIMEOUT_MS") ?? DEFAULT_BODY_INACTIVITY_TIMEOUT_MS,
      );
      const dispatcher = getFetchDispatcher(this.config.baseUrl, timeoutMs, bodyInactivityMs);

      log?.(
        `llm_fetch_start model=${this.config.model} timeout=${timeoutMs}ms est_tokens=${estimatedTokens} stream=${stream ? "yes" : "no"}`,
      );
      log?.(`llm_prompt_shape ${describePromptCacheMarkers(requestMessages)}`);

      const controller = new AbortController();
      const externalAbortSignal = params.abortSignal;
      let externalAbortListener: (() => void) | null = null;
      if (externalAbortSignal) {
        const onExternalAbort = () => {
          log?.(`llm_fetch_abort_external elapsed=${Date.now() - startMs}ms`);
          controller.abort(externalAbortSignal.reason);
        };
        if (externalAbortSignal.aborted) {
          onExternalAbort();
        } else {
          externalAbortSignal.addEventListener("abort", onExternalAbort, { once: true });
          externalAbortListener = () => {
            externalAbortSignal.removeEventListener("abort", onExternalAbort);
          };
        }
      }
      let abortFired = false;
      const timeout = setTimeout(() => {
        abortFired = true;
        log?.(`llm_fetch_abort_fired elapsed=${Date.now() - startMs}ms timeout=${timeoutMs}ms`);
        controller.abort();
      }, timeoutMs);
      try {
        const fetchInit: FetchInitWithDispatcher = {
          method: "POST",
          headers: {
            ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
          ...(dispatcher ? { dispatcher } : {}),
        };
        const res = await fetch(url, fetchInit);
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

        // Headers arrived OK — switch from fixed timeout to inactivity-based body read
        clearTimeout(timeout);
        const sseOnChunk = (stream && params.onTextDelta)
          ? createIncrementalSseTextExtractor(params.onTextDelta)
          : undefined;
        const bodyText = await readBodyWithInactivityTimeout({
          body: res.body,
          controller,
          inactivityMs: bodyInactivityMs,
          onActivity: params.onActivity,
          onChunk: sseOnChunk,
          onLog: log,
          startMs,
        });
        const json = parseChatCompletionResponseBody(bodyText, stream) as Record<string, unknown>;
        const totalElapsed = Date.now() - startMs;
        log?.(`llm_fetch_complete elapsed=${totalElapsed}ms headers_at=${headersElapsed}ms body_read=${totalElapsed - headersElapsed}ms`);

        const choices = Array.isArray(json.choices) ? json.choices : [];
        const firstChoice = choices[0];
        const choiceRecord = isRecord(firstChoice) ? firstChoice : undefined;
        const message = isRecord(choiceRecord?.message) ? choiceRecord.message : undefined;
        const content = normalizeAssistantContent(message?.content);
        const toolCalls = normalizeToolCalls(message?.tool_calls);
        const usage = normalizeUsage(json.usage);
        if (usage) {
          log?.(
            "llm_usage " +
              `prompt=${usage.promptTokens ?? "n/a"} completion=${usage.completionTokens ?? "n/a"} total=${usage.totalTokens ?? "n/a"} ` +
              `cached=${usage.cachedPromptTokens ?? "n/a"} cache_write=${usage.cacheWritePromptTokens ?? "n/a"} reasoning=${usage.reasoningTokens ?? "n/a"}`,
          );
        }
        if (!content && toolCalls.length === 0) {
          const completion = typeof usage?.completionTokens === "number" ? usage.completionTokens : "n/a";
          const total = typeof usage?.totalTokens === "number" ? usage.totalTokens : "n/a";
          log?.(
            "llm_empty_assistant_content " +
              `has_message=${message ? "yes" : "no"} ` +
              `content_shape=${describeAssistantContentShape(message?.content)} ` +
              `completion=${completion} total=${total}`,
          );
        }
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
        externalAbortListener?.();
      }
    }
    } finally {
      slotLease?.release();
    }
  }

  static parseToolArgs(raw: string): unknown {
    const parsed = safeJsonParse(raw);
    return typeof parsed === "string" ? safeJsonParse(parsed) : parsed;
  }
}

function addAssistantText(out: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed) return;
  out.push(trimmed);
}

function collectAssistantText(raw: unknown, out: string[], depth: number): void {
  if (depth > 4 || raw === null || raw === undefined) return;
  if (typeof raw === "string") {
    addAssistantText(out, raw);
    return;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) collectAssistantText(item, out, depth + 1);
    return;
  }
  if (!isRecord(raw)) return;

  addAssistantText(out, raw.text);
  addAssistantText(out, raw.content);
  addAssistantText(out, raw.value);
  addAssistantText(out, raw.output_text);
  addAssistantText(out, raw.refusal);

  if (isRecord(raw.text)) addAssistantText(out, raw.text.value);
  if (isRecord(raw.content)) addAssistantText(out, raw.content.value);
  if (isRecord(raw.output_text)) addAssistantText(out, raw.output_text.value);
  if (isRecord(raw.refusal)) addAssistantText(out, raw.refusal.value);

  if (Array.isArray(raw.content)) collectAssistantText(raw.content, out, depth + 1);
  if (Array.isArray(raw.parts)) collectAssistantText(raw.parts, out, depth + 1);
  if (Array.isArray(raw.output)) collectAssistantText(raw.output, out, depth + 1);
  if (Array.isArray(raw.items)) collectAssistantText(raw.items, out, depth + 1);

  if (isRecord(raw.delta)) collectAssistantText(raw.delta, out, depth + 1);
  if (isRecord(raw.message)) collectAssistantText(raw.message, out, depth + 1);
}

function describeAssistantContentShape(raw: unknown): string {
  if (raw === null) return "null";
  if (raw === undefined) return "undefined";
  if (typeof raw === "string") return `string(len=${raw.length})`;
  if (Array.isArray(raw)) {
    const parts = raw
      .slice(0, 4)
      .map((part) => {
        if (typeof part === "string") return "string";
        if (isRecord(part)) {
          if (typeof part.type === "string") return `obj:${part.type}`;
          const keys = Object.keys(part).slice(0, 3).join("|");
          return `obj:${keys || "empty"}`;
        }
        return typeof part;
      })
      .join(",");
    return `array(len=${raw.length};parts=${parts || "none"})`;
  }
  if (isRecord(raw)) {
    const keys = Object.keys(raw).slice(0, 6).join("|");
    return `object(keys=${keys || "none"})`;
  }
  return typeof raw;
}

export function normalizeAssistantContent(raw: unknown): string | null {
  const textParts: string[] = [];
  collectAssistantText(raw, textParts, 0);
  const unique = textParts.filter((part, idx) => textParts.indexOf(part) === idx);
  const out = unique.join("\n").trim();
  return out.length > 0 ? out : null;
}
