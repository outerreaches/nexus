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
import { extractKeywords, generateMemoryHints, hasRecentMemorySearch } from "./memory-hints.js";
import type { AgentTracker } from "./agent-tracker.js";
import type { ModelRouter, ModelRoutingMode } from "../llm/model-router.js";
import type { LlmCircuitBreaker } from "../llm/circuit-breaker.js";

type ExecutionLane = "interactive" | "background";

type HistoryScope =
  | {
    mode: "exact";
    channel: string;
    channelKey: string;
    agentId?: string;
  }
  | {
    mode: "latest_telegram_for_agent";
  };

function clampPositiveInt(value: number): number {
  return Math.max(1, Math.floor(value));
}

function clampNonNegativeInt(value: number): number {
  return Math.max(0, Math.floor(value));
}

export class AgentService {
  private readonly interactiveSemaphore: Semaphore;
  private readonly backgroundSemaphore: Semaphore;
  private readonly memoryHintsSeen: Map<string, Set<string>> = new Map();

  constructor(
    private readonly deps: {
      llm: LLMClient;
      modelRouter?: ModelRouter;
      circuitBreaker?: LlmCircuitBreaker;
      getTools: () => Tool[];
      toolContext: ToolContext;
      db: NexusDatabase;
      stateDir: string;
      limits: {
        maxMessages: number;
        maxToolCalls: number;
        maxIterations: number;
        maxConcurrent: number;
        maxConcurrentInteractive?: number;
        maxConcurrentBackground?: number;
        maxContextTokens?: number;
      };
      agentTracker?: AgentTracker;
      onRunnerLog?: (line: string) => void;
      /** Default preset name for agents (e.g. "orchestrator"). If unset, all tools are used. */
      defaultPreset?: string;
      /** Max retries for transient LLM errors (429, 5xx, network). Default 5. */
      transientRetries?: number;
    },
  ) {
    const interactiveMax = Math.max(1, deps.limits.maxConcurrentInteractive ?? deps.limits.maxConcurrent);
    const backgroundMax = Math.max(1, deps.limits.maxConcurrentBackground ?? deps.limits.maxConcurrent);
    this.interactiveSemaphore = new Semaphore(interactiveMax);
    this.backgroundSemaphore = new Semaphore(backgroundMax);
  }

  public getMemoryHintsSeen(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [sessionId, keywords] of this.memoryHintsSeen.entries()) {
      result[sessionId] = Array.from(keywords);
    }
    return result;
  }

  getCircuitBreaker(): LlmCircuitBreaker | undefined {
    return this.deps.circuitBreaker;
  }

  private defaultLaneForChannel(channel: string): ExecutionLane {
    return channel === "telegram" || channel === "cli" ? "interactive" : "background";
  }

  private globalRuntimeLimits(): { maxToolCalls: number; maxIterations: number; maxContextTokens: number } {
    return {
      maxToolCalls: clampPositiveInt(this.deps.limits.maxToolCalls),
      maxIterations: clampPositiveInt(this.deps.limits.maxIterations),
      maxContextTokens: clampNonNegativeInt(this.deps.limits.maxContextTokens ?? 0),
    };
  }

  private resolveRunBudget(preset?: AgentPreset): { maxToolCalls: number; maxIterations: number; maxContextTokens: number } {
    const global = this.globalRuntimeLimits();
    const presetToolCalls = preset?.budget?.maxToolCalls;
    const presetIterations = preset?.budget?.maxIterations;
    return {
      maxToolCalls: Math.min(global.maxToolCalls, clampPositiveInt(presetToolCalls ?? global.maxToolCalls)),
      maxIterations: Math.min(global.maxIterations, clampPositiveInt(presetIterations ?? global.maxIterations)),
      maxContextTokens: global.maxContextTokens,
    };
  }

  private resolveHistoryScope(params: {
    channel: string;
    channelKey: string;
    agentId: string;
    historyScope?: HistoryScope;
  }): { channel: string; channelKey: string; agentId: string; source: string } {
    const fallback = {
      channel: params.channel,
      channelKey: params.channelKey,
      agentId: params.agentId,
      source: "request",
    };

    const scope = params.historyScope;
    if (!scope) return fallback;

    if (scope.mode === "exact") {
      return {
        channel: scope.channel,
        channelKey: scope.channelKey,
        agentId: scope.agentId ?? params.agentId,
        source: "exact",
      };
    }

    const latestTelegram = this.deps.db.db
      .prepare(
        `SELECT s.channel_key AS channel_key
         FROM sessions s
         LEFT JOIN messages m ON m.session_id = s.id
         WHERE s.channel = 'telegram' AND s.agent_id = ?
         GROUP BY s.id
         ORDER BY COALESCE(MAX(m.created_at), s.created_at) DESC, s.created_at DESC
         LIMIT 1`,
      )
      .get(params.agentId) as { channel_key: string } | undefined;

    if (latestTelegram?.channel_key) {
      return {
        channel: "telegram",
        channelKey: latestTelegram.channel_key,
        agentId: params.agentId,
        source: "latest_telegram_for_agent",
      };
    }

    return { ...fallback, source: "latest_telegram_for_agent:fallback" };
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
    /** Queue lane for this run. Defaults by channel (telegram/cli=interactive, others=background). */
    executionLane?: ExecutionLane;
    /** Optional history scope override for session continuity across channels. */
    historyScope?: HistoryScope;
    /** If true, the session state and the result messages will NOT be saved to the DB, unless the agent takes an action. */
    ephemeralSessionSave?: "unless_action" | "always_skip";
  }): Promise<{
    runId: string | null;
    sessionId: string;
    output: string;
    status: "complete" | "failed" | "budget_exhausted";
    toolCallsUsed: number;
    iterationsUsed: number;
  }> {
    const lane = params.executionLane ?? this.defaultLaneForChannel(params.channel);
    const semaphore = lane === "background" ? this.backgroundSemaphore : this.interactiveSemaphore;
    return await semaphore.withLock(async () => {
      const nowMs = this.deps.toolContext.nowMs();
      const historyScope = this.resolveHistoryScope({
        channel: params.channel,
        channelKey: params.channelKey,
        agentId: params.agentId,
        historyScope: params.historyScope,
      });
      const sessionId = getOrCreateSessionId({
        db: this.deps.db,
        channel: historyScope.channel,
        channelKey: historyScope.channelKey,
        agentId: historyScope.agentId,
        nowMs,
      });

      // Note: do not auto-archive/clear blackboard here; keep entries available across runs.

      const history = loadRecentHistory({
        db: this.deps.db,
        sessionId,
        maxMessages: this.deps.limits.maxMessages,
        nowMs,
      });

      // Resolve preset and filter tools
      const presetName = params.preset ?? this.deps.defaultPreset;
      const preset = presetName ? getPreset(presetName) : undefined;
      const runModelMode: ModelRoutingMode = params.modelMode ?? this.deps.circuitBreaker?.getEffectiveMode() ?? "default";

      const systemPrompt = !preset || preset.name === "orchestrator"
        ? await buildSystemPrompt({ stateDir: this.deps.stateDir, agentId: params.agentId, presetSystemPrompt: preset?.systemPrompt })
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

      // ── Memory hints: nudge agent about potentially relevant memories ──
      let memoryHint: string | null = null;
      if (preset?.name === "orchestrator" || !preset) {
        const messageText = params.text;
        onRunnerLog?.(`memory_hint_check text_len=${messageText?.length ?? 0}`);
        if (messageText && !hasRecentMemorySearch(history)) {
          const keywords = extractKeywords(messageText);
          onRunnerLog?.(`memory_hint_keywords [${keywords.join(", ")}]`);
          if (keywords.length > 0) {
            if (!this.memoryHintsSeen.has(sessionId)) {
              this.memoryHintsSeen.set(sessionId, new Set());
            }
            const seenItems = Array.from(this.memoryHintsSeen.get(sessionId)!);
            onRunnerLog?.(`memory_hint_seen [${seenItems.join(", ")}]`);
            memoryHint = generateMemoryHints({
              db: this.deps.db,
              agentId: params.agentId,
              keywords,
              seenKeywords: this.memoryHintsSeen.get(sessionId)!,
              messageText,
            });
            onRunnerLog?.(`memory_hint_generated ${memoryHint ? 'YES' : 'NO'}`);
          }
        } else {
          onRunnerLog?.(`memory_hint_skipped hasRecentSearch=${hasRecentMemorySearch(history)}`);
        }
      }

      // Instead of changing the system prompt (which breaks the prefix cache),
      // append the memory hint to the end of the history stack right before the user message.
      if (memoryHint) {
        onRunnerLog?.(`memory_hint_injected length=${memoryHint.length}`);
        history.push({
          role: "system",
          content: memoryHint,
        });
      }

      const finalSystemPrompt = systemPrompt;

      onRunnerLog?.(
        `history_scope source=${historyScope.source} channel=${historyScope.channel} key=${historyScope.channelKey} lane=${lane} messages=${history.length}`,
      );

      let llm: LLMClient = this.deps.llm;
      let llmConfig = this.deps.toolContext.llmConfig;
      if (this.deps.modelRouter) {
        const route = this.deps.modelRouter.resolve({
          agentId: params.agentId,
          preset: presetName,
          mode: runModelMode,
          presetLlm: preset?.llm,
        });
        llm = this.deps.modelRouter.createClient(route, {
          onLog: onRunnerLog,
        });
        llmConfig = route.primary;
        onRunnerLog?.(
          `llm_route mode=${route.mode} source=${route.source} primary=${route.primaryProvider}/${route.primary.model}`,
        );
      }

      const tools = filterToolsByPreset(this.deps.getTools(), preset);

      // Resolve budget: global limits are hard caps; presets can only tighten.
      const budget = this.resolveRunBudget(preset);
      const runtimeLimits = this.globalRuntimeLimits();

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
        modelRouter: this.deps.modelRouter,
        modelMode: runModelMode,
        runtimeLimits,
        request: {
          channel: params.channel,
          channelKey: params.channelKey,
          agentId: params.agentId,
          preset: preset?.name ?? presetName,
          sessionId,
          runId,
          modelMode: runModelMode,
        },
      };

      const runner = new AgentRunner({
        llm,
        tools,
        toolCallCaps: preset?.toolCallCaps,
        budget,
        toolContext,
        onLog: onRunnerLog,
        circuitBreaker: this.deps.circuitBreaker,
        transientRetries: this.deps.transientRetries ?? 5,
      });

      let result: Awaited<ReturnType<AgentRunner["run"]>>;
      try {
        result = await runner.run({
          systemPrompt: finalSystemPrompt,
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

      let shouldPersistHistory = true;
      if (params.ephemeralSessionSave === "unless_action") {
        const t = result.output.trim().toUpperCase();
        if (t === "IDLE" || t === "NOOP" || t === "NO-OP") {
          shouldPersistHistory = false;
        }
      } else if (params.ephemeralSessionSave === "always_skip") {
        shouldPersistHistory = false;
      }

      const runNowMs = this.deps.toolContext.nowMs();
      if (shouldPersistHistory) {
        // Also persist the initial user message if we skipped doing it in proactive.ts
        if (historyScope.source === "latest_telegram_for_agent" && params.channel === "heartbeat") {
          appendMessage({ db: this.deps.db, sessionId, message: { role: "user", content: params.text }, nowMs: runNowMs });
        }
        for (const msg of result.newMessages) {
          appendMessage({ db: this.deps.db, sessionId, message: msg as ChatMessage, nowMs: runNowMs });
        }
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
