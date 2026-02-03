import { AgentRunner } from "./agent-runner.js";
import { buildPresetSystemPrompt, buildSystemPrompt } from "./prompt.js";
import type { Tool, ToolContext } from "./tools.js";
import type { ChatMessage } from "./types.js";
import { OpenAICompatClient } from "../llm/openai-compat.js";
import type { NexusDatabase } from "../storage/database.js";
import { appendMessage, getOrCreateSessionId, loadRecentHistory } from "../storage/sessions.js";
import { Semaphore } from "./semaphore.js";
import { getPreset, type AgentPreset } from "./presets.js";
import type { AgentTracker } from "./agent-tracker.js";

export class AgentService {
  private readonly semaphore: Semaphore;

  constructor(
    private readonly deps: {
      llm: OpenAICompatClient;
      getTools: () => Tool[];
      toolContext: ToolContext;
      db: NexusDatabase;
      stateDir: string;
      limits: { maxMessages: number; maxToolCalls: number; maxIterations: number; maxConcurrent: number; maxContextTokens?: number };
      agentTracker?: AgentTracker;
      onRunnerLog?: (line: string) => void;
      /** Default preset name for agents (e.g. "orchestrator"). If unset, all tools are used. */
      defaultPreset?: string;
    },
  ) {
    this.semaphore = new Semaphore(deps.limits.maxConcurrent);
  }

  async handleUserMessage(params: {
    channel: string;
    channelKey: string;
    agentId: string;
    text: string;
    /** Override preset for this invocation. */
    preset?: string;
  }): Promise<{
    sessionId: string;
    output: string;
    status: "complete" | "failed" | "budget_exhausted";
    toolCallsUsed: number;
    iterationsUsed: number;
  }> {
    return await this.semaphore.withLock(async () => {
      const nowMs = this.deps.toolContext.nowMs();
      const sessionId = getOrCreateSessionId({
        db: this.deps.db,
        channel: params.channel,
        channelKey: params.channelKey,
        agentId: params.agentId,
        nowMs,
      });

      // Note: do not auto-archive/clear blackboard here; keep entries available across runs.

      const history = loadRecentHistory({
        db: this.deps.db,
        sessionId,
        maxMessages: this.deps.limits.maxMessages,
      });

      // Resolve preset and filter tools
      const presetName = params.preset ?? this.deps.defaultPreset;
      const preset = presetName ? getPreset(presetName) : undefined;

      const systemPrompt = !preset || preset.name === "orchestrator"
        ? await buildSystemPrompt({ stateDir: this.deps.stateDir, agentId: params.agentId })
        : await buildPresetSystemPrompt({
          stateDir: this.deps.stateDir,
          agentId: params.agentId,
          promptFiles: preset.promptFiles,
          systemPrompt: preset.systemPrompt ?? `You are a ${preset.name} agent.`,
          includePresets: true,
        });

      const onRunnerLog = this.deps.onRunnerLog
        ? (line: string) => {
          this.deps.onRunnerLog?.(
            `channel=${params.channel} key=${params.channelKey} agent=${params.agentId} ${line}`,
          );
        }
        : undefined;

      const tools = filterToolsByPreset(this.deps.getTools(), preset);

      // Resolve budget from preset or global limits
      const budget = {
        maxToolCalls: preset?.budget?.maxToolCalls ?? this.deps.limits.maxToolCalls,
        maxIterations: preset?.budget?.maxIterations ?? this.deps.limits.maxIterations,
        maxContextTokens: this.deps.limits.maxContextTokens ?? 0,
      };

      // Build tool context — inject LLM reference so spawn_agent can create workers
      const runId = this.deps.agentTracker?.startRun({
        agentId: params.agentId,
        preset: presetName ?? "default",
        channel: params.channel,
        channelKey: params.channelKey,
        sessionId,
        task: params.text,
      });

      const toolContext: ToolContext = {
        ...this.deps.toolContext,
        llm: this.deps.llm,
        request: {
          channel: params.channel,
          channelKey: params.channelKey,
          agentId: params.agentId,
          sessionId,
          runId,
        },
      };

      const runner = new AgentRunner({
        llm: this.deps.llm,
        tools,
        budget,
        toolContext,
        onLog: onRunnerLog,
      });

      let result: Awaited<ReturnType<AgentRunner["run"]>>;
      try {
        result = await runner.run({
          systemPrompt,
          history: history.filter((m) => m.role !== "system"),
          userMessage: params.text,
        });
      } catch (err) {
        if (runId && this.deps.agentTracker) {
          this.deps.agentTracker.completeRun(runId, {
            status: "failed",
            outputPreview: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
            endedAt: this.deps.toolContext.nowMs(),
          });
        }
        throw err;
      }

      for (const msg of result.newMessages) {
        appendMessage({ db: this.deps.db, sessionId, message: msg as ChatMessage, nowMs: this.deps.toolContext.nowMs() });
      }

      if (runId && this.deps.agentTracker) {
        const preview = result.output.trim().slice(0, 240);
        this.deps.agentTracker.completeRun(runId, {
          status: result.status,
          toolCallsUsed: result.toolCallsUsed,
          iterationsUsed: result.iterationsUsed,
          outputPreview: preview,
          endedAt: this.deps.toolContext.nowMs(),
        });
      }

      return {
        sessionId,
        output: result.output,
        status: result.status,
        toolCallsUsed: result.toolCallsUsed,
        iterationsUsed: result.iterationsUsed,
      };
    });
  }
}

function filterToolsByPreset(allTools: Tool[], preset?: AgentPreset): Tool[] {
  if (!preset) return allTools;
  const allowed = new Set(preset.tools);
  return allTools.filter((t) => allowed.has(t.name));
}
