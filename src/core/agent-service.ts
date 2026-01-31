import { AgentRunner } from "./agent-runner.js";
import { buildSystemPrompt } from "./prompt.js";
import type { Tool, ToolContext } from "./tools.js";
import type { ChatMessage } from "./types.js";
import { OpenAICompatClient } from "../llm/openai-compat.js";
import type { NexusDatabase } from "../storage/database.js";
import { appendMessage, getOrCreateSessionId, loadRecentHistory } from "../storage/sessions.js";
import { Semaphore } from "./semaphore.js";

export class AgentService {
  private readonly semaphore: Semaphore;

  constructor(
    private readonly deps: {
      llm: OpenAICompatClient;
      getTools: () => Tool[];
      toolContext: ToolContext;
      db: NexusDatabase;
      workspaceDir: string;
      limits: { maxMessages: number; maxToolCalls: number; maxIterations: number; maxConcurrent: number };
      onRunnerLog?: (line: string) => void;
    },
  ) {
    this.semaphore = new Semaphore(deps.limits.maxConcurrent);
  }

  async handleUserMessage(params: {
    channel: string;
    channelKey: string;
    agentId: string;
    text: string;
  }): Promise<{ sessionId: string; output: string }> {
    return await this.semaphore.withLock(async () => {
      const nowMs = this.deps.toolContext.nowMs();
      const sessionId = getOrCreateSessionId({
        db: this.deps.db,
        channel: params.channel,
      channelKey: params.channelKey,
      agentId: params.agentId,
      nowMs,
    });

    const history = loadRecentHistory({
      db: this.deps.db,
      sessionId,
      maxMessages: this.deps.limits.maxMessages,
    });

    const systemPrompt = await buildSystemPrompt({ workspaceDir: this.deps.workspaceDir, agentId: params.agentId });

    const onRunnerLog = this.deps.onRunnerLog
      ? (line: string) => {
          this.deps.onRunnerLog?.(
            `channel=${params.channel} key=${params.channelKey} agent=${params.agentId} ${line}`,
          );
        }
      : undefined;

    const runner = new AgentRunner({
      llm: this.deps.llm,
      tools: this.deps.getTools(),
      budget: {
        maxToolCalls: this.deps.limits.maxToolCalls,
        maxIterations: this.deps.limits.maxIterations,
      },
      toolContext: {
        ...this.deps.toolContext,
        request: {
          channel: params.channel,
          channelKey: params.channelKey,
          agentId: params.agentId,
          sessionId,
        },
      },
      onLog: onRunnerLog,
    });

    const result = await runner.run({
      systemPrompt,
      history: history.filter((m) => m.role !== "system"),
      userMessage: params.text,
    });

    for (const msg of result.newMessages) {
      appendMessage({ db: this.deps.db, sessionId, message: msg as ChatMessage, nowMs: this.deps.toolContext.nowMs() });
    }

    return { sessionId, output: result.output };
    });
  }
}
