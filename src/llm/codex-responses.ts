/**
 * Codex Responses API client.
 *
 * The ChatGPT Codex backend (chatgpt.com/backend-api/codex) uses the
 * Responses API — a different wire format from chat/completions.
 * This client translates our internal ChatMessage format to the
 * Responses API input format, streams the response via SSE, and
 * converts back to our standard LLMClient result shape.
 *
 * Reference: Hermes Agent's _CodexCompletionsAdapter
 * (NousResearch/hermes-agent, agent/auxiliary_client.py)
 */

import type { ChatMessage, ChatUserContent, ReasoningItem, ToolCall } from "../core/types.js";
import type { LLMClient, LLMCompleteChatParams, LLMUsage } from "./openai-compat.js";
import { readSseDataEvents } from "./sse-reader.js";

export type CodexResponsesConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  onLog?: (line: string) => void;
};

export class CodexResponsesClient implements LLMClient {
  constructor(private readonly config: CodexResponsesConfig) {}

  async completeChat(params: LLMCompleteChatParams): Promise<{
    content: string | null;
    toolCalls: ToolCall[];
    usage?: LLMUsage;
    reasoning?: ReasoningItem[];
  }> {
    const log = this.config.onLog;
    const url = joinUrl(this.config.baseUrl, "responses");

    // Convert messages to Responses API format
    const { instructions, input } = convertMessages(params.messages);

    // Convert tools
    const tools = params.tools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.jsonSchema,
    }));

    const body: Record<string, unknown> = {
      model: this.config.model,
      instructions,
      input,
      store: false,
      stream: true,
      // Encrypted reasoning enables round-tripping reasoning items across turns
      // when stateless (store: false) — required for codex to maintain its
      // chain of thought through an agent loop.
      include: ["reasoning.encrypted_content"],
    };

    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    // The Codex endpoint does NOT support max_output_tokens or temperature.

    const startMs = Date.now();
    log?.(`codex_fetch_start model=${this.config.model} input_items=${input.length} tools=${tools.length}`);

    const controller = new AbortController();
    const timeoutMs = 300_000;
    const timeout = setTimeout(() => {
      log?.(`codex_fetch_abort_timeout elapsed=${Date.now() - startMs}ms`);
      controller.abort();
    }, timeoutMs);

    if (params.abortSignal) {
      const onAbort = () => {
        log?.(`codex_fetch_abort_external elapsed=${Date.now() - startMs}ms`);
        controller.abort(params.abortSignal?.reason);
      };
      if (params.abortSignal.aborted) {
        onAbort();
      } else {
        params.abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      log?.(`codex_fetch_headers status=${res.status} elapsed=${Date.now() - startMs}ms`);

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        // Truncate HTML error bodies (Cloudflare pages etc.)
        const truncated = errBody.length > 500 ? errBody.slice(0, 500) + "..." : errBody;
        throw new Error(`Codex API request failed: ${res.status} ${res.statusText} — ${truncated}`);
      }

      // Parse SSE stream
      const result = await readResponsesStream(res, {
        onTextDelta: params.onTextDelta,
        onActivity: params.onActivity,
        onLog: log,
        startMs,
      });

      log?.(`codex_fetch_complete elapsed=${Date.now() - startMs}ms text_len=${result.content?.length ?? 0} tool_calls=${result.toolCalls.length}`);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── Message conversion ──────────────────────────────────────────────────────

function convertMessages(messages: ChatMessage[]): {
  instructions: string;
  input: ResponsesInputItem[];
} {
  let instructions = "You are a helpful assistant.";
  const input: ResponsesInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      instructions = msg.content;
      continue;
    }

    if (msg.role === "user") {
      input.push({
        type: "message",
        role: "user",
        content: convertUserContent(msg.content),
      });
      continue;
    }

    if (msg.role === "assistant") {
      // Reasoning items must come BEFORE the message/tool calls they reasoned
      // about. Replaying them with encrypted_content lets codex resume its
      // chain of thought without re-deriving it.
      if (msg.reasoning) {
        for (const r of msg.reasoning) {
          const item: ResponsesInputItem = {
            type: "reasoning",
            id: r.id,
            summary: r.summary.map((text) => ({ type: "summary_text", text })),
          };
          if (r.encryptedContent) item.encrypted_content = r.encryptedContent;
          input.push(item);
        }
      }

      // Text content
      if (msg.content) {
        input.push({
          type: "message",
          role: "assistant",
          content: msg.content,
        });
      }

      // Tool calls become function_call items
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
          });
        }
      }
      continue;
    }

    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.toolCallId,
        output: msg.content,
      });
    }
  }

  return { instructions, input };
}

type ResponsesInputItem =
  | { type: "message"; role: "user" | "assistant"; content: string | ResponsesContentPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | {
      type: "reasoning";
      id: string;
      summary: Array<{ type: "summary_text"; text: string }>;
      encrypted_content?: string;
    };

type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

function convertUserContent(content: ChatUserContent): string | ResponsesContentPart[] {
  if (typeof content === "string") return content;

  const parts: ResponsesContentPart[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "input_text", text: part.text });
    } else if (part.type === "image_url") {
      parts.push({ type: "input_image", image_url: part.image_url.url });
    }
  }
  return parts;
}

// ── SSE stream parsing ──────────────────────────────────────────────────────

async function readResponsesStream(
  res: Response,
  opts: {
    onTextDelta?: (delta: string) => void;
    onActivity?: () => void;
    onLog?: (line: string) => void;
    startMs: number;
  },
): Promise<{
  content: string | null;
  toolCalls: ToolCall[];
  usage?: LLMUsage;
  reasoning?: ReasoningItem[];
}> {
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const reasoningItems: ReasoningItem[] = [];
  // Track function call arguments as they stream in
  const pendingFunctionArgs = new Map<string, { id: string; name: string; args: string[] }>();
  let usage: LLMUsage | undefined;

  const body = res.body;
  if (!body) throw new Error("Codex API response has no body");

  // SSE byte→data-payload pipeline shared with openai-compat. Event-type
  // dispatch below is Responses-API-specific and stays local.
  for await (const data of readSseDataEvents(body, { onChunk: () => opts.onActivity?.() })) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }

    const eventType = String(event.type ?? "");

    // Text content delta
    if (eventType === "response.output_text.delta") {
      const delta = String(event.delta ?? "");
      if (delta) {
        textParts.push(delta);
        opts.onTextDelta?.(delta);
      }
    }

    // Function call arguments streaming
    if (eventType === "response.function_call_arguments.delta") {
      const callId = String(event.call_id ?? event.item_id ?? "");
      const delta = String(event.delta ?? "");
      if (callId && delta) {
        const pending = pendingFunctionArgs.get(callId);
        if (pending) {
          pending.args.push(delta);
        }
      }
    }

    // Output item added — start tracking function calls
    if (eventType === "response.output_item.added") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") {
        const callId = String(item.call_id ?? "");
        const name = String(item.name ?? "");
        if (callId) {
          pendingFunctionArgs.set(callId, { id: callId, name, args: [] });
        }
      }
    }

    // Output item done — finalize
    if (eventType === "response.output_item.done") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") {
        const callId = String(item.call_id ?? "");
        const name = String(item.name ?? "");
        const args = String(item.arguments ?? "{}");
        // Prefer the accumulated streamed args if we have them
        const pending = pendingFunctionArgs.get(callId);
        const finalArgs = pending && pending.args.length > 0 ? pending.args.join("") : args;
        toolCalls.push({ id: callId, name, arguments: finalArgs });
        pendingFunctionArgs.delete(callId);
      } else if (item?.type === "message") {
        // Extract text from completed message if we missed deltas
        const content = item.content as unknown[];
        if (Array.isArray(content)) {
          for (const part of content) {
            const p = part as Record<string, unknown>;
            if ((p.type === "output_text" || p.type === "text") && typeof p.text === "string") {
              // Only add if we didn't already capture via deltas
              if (textParts.length === 0) {
                textParts.push(p.text);
              }
            }
          }
        }
      } else if (item?.type === "reasoning") {
        const id = String(item.id ?? "");
        if (!id) continue;
        const summaryParts = Array.isArray(item.summary) ? item.summary : [];
        const summary: string[] = [];
        for (const part of summaryParts) {
          const p = part as Record<string, unknown>;
          if (p?.type === "summary_text" && typeof p.text === "string" && p.text.trim()) {
            summary.push(p.text);
          }
        }
        const encryptedContent = typeof item.encrypted_content === "string" ? item.encrypted_content : undefined;
        reasoningItems.push({ id, summary, ...(encryptedContent ? { encryptedContent } : {}) });
      }
    }

    // Response completed — extract usage
    if (eventType === "response.completed") {
      const response = event.response as Record<string, unknown> | undefined;
      const u = response?.usage as Record<string, number> | undefined;
      if (u) {
        usage = {
          promptTokens: u.input_tokens,
          completionTokens: u.output_tokens,
          totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
          reasoningTokens: typeof u.output_tokens_details === "object" && u.output_tokens_details !== null
            ? Number((u.output_tokens_details as Record<string, unknown>).reasoning_tokens ?? 0) || undefined
            : undefined,
        };
      }
    }
  }

  // Stream EOF without a matching response.output_item.done for an in-flight
  // function call means the model's response was truncated mid-call. We can't
  // know whether all argument deltas arrived, and silently emitting a partial
  // tool call risks executing a malformed action. Throw so the runner retries.
  if (pendingFunctionArgs.size > 0) {
    const names = Array.from(pendingFunctionArgs.values())
      .map((p) => p.name || "<unnamed>")
      .join(", ");
    throw new Error(
      `Codex stream ended with ${pendingFunctionArgs.size} unfinalized function call(s): ${names}. ` +
      "Stream truncated before response.output_item.done; partial tool call discarded.",
    );
  }

  // Keep content clean (model's message text only). Reasoning items are
  // returned separately so the agent runner can round-trip them across turns
  // without duplication, and surface the summary in the final output.
  const messageText = textParts.join("").trim();
  const content = messageText.length > 0 ? messageText : null;

  return {
    content,
    toolCalls,
    usage,
    ...(reasoningItems.length > 0 ? { reasoning: reasoningItems } : {}),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalizedBase).toString();
}
