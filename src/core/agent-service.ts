import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { AgentRunner } from "./agent-runner.js";
import { buildPresetSystemPrompt, buildSystemPrompt } from "./prompt.js";
import type { Tool, ToolContext } from "./tools.js";
import type { ChatMessage, ChatUserContentPart } from "./types.js";
import type { LLMClient } from "../llm/openai-compat.js";
import type { NexusDatabase } from "../storage/database.js";
import { appendMessage, getOrCreateSessionId, loadRecentHistory } from "../storage/sessions.js";
import { Semaphore } from "./semaphore.js";
import { getPreset, type AgentPreset } from "./presets.js";
import type { AgentTracker } from "./agent-tracker.js";
import type { ModelRouter, ModelRoutingMode } from "../llm/model-router.js";

export class AgentService {
  private readonly semaphore: Semaphore;

  constructor(
    private readonly deps: {
      llm: LLMClient;
      modelRouter?: ModelRouter;
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
    contentParts?: ChatUserContentPart[];
    /** Override preset for this invocation. */
    preset?: string;
    /** Override model routing mode (default/local_only). */
    modelMode?: ModelRoutingMode;
  }): Promise<{
    runId: string | null;
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
      const runModelMode: ModelRoutingMode = params.modelMode ?? this.deps.toolContext.modelMode ?? "default";

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

      let llm: LLMClient = this.deps.llm;
      let llmConfig = this.deps.toolContext.llmConfig;
      let fallbackLlmConfig = this.deps.toolContext.fallbackLlmConfig;
      if (this.deps.modelRouter) {
        const route = this.deps.modelRouter.resolve({
          agentId: params.agentId,
          preset: presetName,
          mode: runModelMode,
          presetLlm: preset?.llm,
        });
        llm = this.deps.modelRouter.createClient(route, {
          onFallback: onRunnerLog,
        });
        llmConfig = route.primary;
        fallbackLlmConfig = route.fallback;
        const fallbackLabel = route.fallbackProvider && route.fallback
          ? ` fallback=${route.fallbackProvider}/${route.fallback.model}`
          : "";
        onRunnerLog?.(
          `llm_route mode=${route.mode} source=${route.source} primary=${route.primaryProvider}/${route.primary.model}${fallbackLabel}`,
        );
      }

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
        llm,
        llmConfig,
        fallbackLlmConfig,
        modelRouter: this.deps.modelRouter,
        modelMode: runModelMode,
        request: {
          channel: params.channel,
          channelKey: params.channelKey,
          agentId: params.agentId,
          sessionId,
          runId,
          modelMode: runModelMode,
        },
      };

      const runner = new AgentRunner({
        llm,
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
          userMessage: params.contentParts && params.contentParts.length > 0 ? params.contentParts : params.text,
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

      // Non-Telegram channels can ack immediately after the run completes.
      // Telegram acks are deferred until after sendOutput to avoid finalize
      // killing the old container before reply delivery.
      if (params.channel !== "telegram") {
        this.ackDeployIfPending({
          runId: runId ?? null,
          sessionId,
          channel: params.channel,
          channelKey: params.channelKey,
          agentId: params.agentId,
        });
      }

      return {
        runId: runId ?? null,
        sessionId,
        output: result.output,
        status: result.status,
        toolCallsUsed: result.toolCallsUsed,
        iterationsUsed: result.iterationsUsed,
      };
    });
  }

  /** Write deploy-ack if finalize-pending exists and this run matches the pending deploy context. */
  ackDeployIfPending(current: {
    runId: string | null;
    sessionId: string;
    channel: string;
    channelKey: string;
    agentId: string;
  }): void {
    try {
      const stateDir = this.deps.stateDir;
      const finalizePending = path.join(stateDir, "finalize-pending");
      if (!existsSync(finalizePending)) return;

      const pending = readFinalizePending(finalizePending);
      if (!pending) {
        this.deps.onRunnerLog?.("deploy-ack deferred: finalize-pending unreadable or missing context");
        return;
      }
      if (!shouldAckPending(pending, current)) {
        this.deps.onRunnerLog?.(
          `deploy-ack deferred: pending trigger=${pending.triggerId ?? "unknown"} expectedRun=${pending.expectedAckRunId ?? pending.request?.parentRunId ?? pending.request?.runId ?? "n/a"} currentRun=${current.runId ?? "none"}`,
        );
        return;
      }

      const ackFile = path.join(stateDir, "deploy-ack");
      const ackPayload = {
        triggerId: pending?.triggerId ?? null,
        expectedSha: pending?.expectedSha ?? null,
        ackedAt: new Date().toISOString(),
        by: {
          runId: current.runId,
          sessionId: current.sessionId,
          channel: current.channel,
          channelKey: current.channelKey,
          agentId: current.agentId,
        },
      };
      writeFileSync(ackFile, JSON.stringify(ackPayload, null, 2) + "\n");
      try { unlinkSync(finalizePending); } catch { /* race with ha-deployer cleanup */ }
      this.deps.onRunnerLog?.("deploy-ack written (matched pending deploy context)");
    } catch {
      // Non-fatal — ha-deployer has a timeout fallback
    }
  }
}

type FinalizePending = {
  triggerId?: string;
  expectedSha?: string;
  expectedAckRunId?: string;
  request?: {
    channel?: string;
    channelKey?: string;
    agentId?: string;
    sessionId?: string;
    runId?: string;
    parentRunId?: string;
  };
};

function readFinalizePending(filePath: string): FinalizePending | null {
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    if (!raw) return null;
    if (!raw.startsWith("{")) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as FinalizePending;
  } catch {
    return null;
  }
}

function shouldAckPending(
  pending: FinalizePending,
  current: { runId: string | null; sessionId: string; channel: string; channelKey: string },
): boolean {
  const expectedRunId = (
    pending.expectedAckRunId ??
    pending.request?.parentRunId ??
    pending.request?.runId ??
    ""
  ).trim();
  if (expectedRunId) {
    return Boolean(current.runId && current.runId === expectedRunId);
  }

  const expectedSessionId = (pending.request?.sessionId ?? "").trim();
  if (expectedSessionId) {
    if (expectedSessionId !== current.sessionId) return false;
    const expectedChannel = (pending.request?.channel ?? "").trim();
    const expectedChannelKey = (pending.request?.channelKey ?? "").trim();
    if (expectedChannel && expectedChannel !== current.channel) return false;
    if (expectedChannelKey && expectedChannelKey !== current.channelKey) return false;
    return true;
  }

  const expectedChannel = (pending.request?.channel ?? "").trim();
  const expectedChannelKey = (pending.request?.channelKey ?? "").trim();
  if (expectedChannel && expectedChannelKey) {
    return expectedChannel === current.channel && expectedChannelKey === current.channelKey;
  }
  return false;
}

function filterToolsByPreset(allTools: Tool[], preset?: AgentPreset): Tool[] {
  if (!preset) return allTools;
  const allowed = new Set(preset.tools);
  return allTools.filter((t) => allowed.has(t.name));
}
