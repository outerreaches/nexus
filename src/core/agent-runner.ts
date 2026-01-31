import type { Tool, ToolContext } from "./tools.js";
import type { ChatMessage } from "./types.js";
import { OpenAICompatClient } from "../llm/openai-compat.js";

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…(+${text.length - maxChars} chars)`;
}

function redactForLog(value: unknown, depth: number = 0): unknown {
  if (depth > 6) return "[max_depth]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return value.length > 160 ? `[omitted ${value.length} chars]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) return value.map((v) => redactForLog(v, depth + 1));

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/(token|api[_-]?key|secret|password|authorization|cookie)/i.test(k)) {
        out[k] = "[redacted]";
        continue;
      }
      if (/(content|body|replace|text)/i.test(k) && typeof v === "string") {
        out[k] = `[omitted ${v.length} chars]`;
        continue;
      }
      out[k] = redactForLog(v, depth + 1);
    }
    return out;
  }

  return String(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export type AgentBudget = {
  maxToolCalls: number;
  maxIterations: number;
};

export type AgentResult = {
  status: "complete" | "failed" | "budget_exhausted";
  output: string;
  newMessages: ChatMessage[];
  toolCallsUsed: number;
  iterationsUsed: number;
};

export class AgentRunner {
  constructor(
    private readonly deps: {
      llm: OpenAICompatClient;
      tools: Tool[];
      budget: AgentBudget;
      toolContext: ToolContext;
      onLog?: (line: string) => void;
    },
  ) {}

  async run(params: { systemPrompt: string; history: ChatMessage[]; userMessage: string }): Promise<AgentResult> {
    const baseMessages: ChatMessage[] = [{ role: "system", content: params.systemPrompt }, ...params.history];
    const newMessages: ChatMessage[] = [{ role: "user", content: params.userMessage }];
    const messages: ChatMessage[] = [...baseMessages, ...newMessages];

    let toolCallsUsed = 0;
    for (let iteration = 0; iteration < this.deps.budget.maxIterations; iteration++) {
      let content: string | null;
      let toolCalls: import("./types.js").ToolCall[];
      try {
        const res = await this.deps.llm.completeChat({
          messages,
          tools: this.deps.tools,
        });
        content = res.content;
        toolCalls = res.toolCalls;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.deps.onLog?.(`llm_error ${truncate(msg, 240)}`);
        const errorText = `LLM error: ${msg}`;
        const assistantMsg: ChatMessage = { role: "assistant", content: errorText };
        newMessages.push(assistantMsg);
        return {
          status: "failed",
          output: errorText,
          newMessages,
          toolCallsUsed,
          iterationsUsed: iteration + 1,
        };
      }

      if (toolCalls.length === 0) {
        const finalText = content ?? "";
        const msg: ChatMessage = { role: "assistant", content: finalText };
        messages.push(msg);
        newMessages.push(msg);
        return {
          status: "complete",
          output: finalText,
          newMessages,
          toolCallsUsed,
          iterationsUsed: iteration + 1,
        };
      }

      const toolCallingMsg: ChatMessage = { role: "assistant", content: content ?? null, toolCalls };
      messages.push(toolCallingMsg);
      newMessages.push(toolCallingMsg);

      for (const call of toolCalls) {
        toolCallsUsed += 1;
        if (toolCallsUsed > this.deps.budget.maxToolCalls) {
          return {
            status: "budget_exhausted",
            output: "Budget exhausted while executing tools.",
            newMessages,
            toolCallsUsed,
            iterationsUsed: iteration + 1,
          };
        }

        const tool = this.deps.tools.find((t) => t.name === call.name);
        if (!tool) {
          const msg: ChatMessage = {
            role: "tool",
            name: call.name,
            toolCallId: call.id,
            content: `ERROR: unknown tool '${call.name}'`,
          };
          messages.push(msg);
          newMessages.push(msg);
          continue;
        }

        let args: unknown = {};
        try {
          args = OpenAICompatClient.parseToolArgs(call.arguments);
        } catch {
          args = {};
        }

        this.deps.onLog?.(`tool_call name=${call.name} id=${call.id} args=${safeJson(redactForLog(args))}`);
        let result: string;
        try {
          result = await tool.execute(args, this.deps.toolContext);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result = `ERROR: ${msg}`;
        }

        const status = result.startsWith("ERROR:") ? "error" : "ok";
        const errPreview = status === "error" ? ` msg=${safeJson(truncate(result.split(/\r?\n/)[0] ?? "", 200))}` : "";
        this.deps.onLog?.(`tool_result name=${call.name} id=${call.id} status=${status} chars=${result.length}${errPreview}`);

        const toolResultMsg: ChatMessage = {
          role: "tool",
          name: call.name,
          toolCallId: call.id,
          content: result,
        };
        messages.push(toolResultMsg);
        newMessages.push(toolResultMsg);
      }
    }

    return {
      status: "budget_exhausted",
      output: "Budget exhausted while iterating.",
      newMessages,
      toolCallsUsed,
      iterationsUsed: this.deps.budget.maxIterations,
    };
  }
}
