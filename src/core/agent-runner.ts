import type { Tool, ToolContext } from "./tools.js";
import type { ChatMessage } from "./types.js";
import { OpenAICompatClient } from "../llm/openai-compat.js";

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
      const { content, toolCalls } = await this.deps.llm.completeChat({
        messages,
        tools: this.deps.tools,
      });

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

        this.deps.onLog?.(`tool:${call.name}`);
        let result: string;
        try {
          result = await tool.execute(args, this.deps.toolContext);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result = `ERROR: ${msg}`;
        }

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
