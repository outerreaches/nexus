import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

import { AgentRunner, RunCancelledError } from "./agent-runner.js";
import { buildPresetSystemPrompt, buildSystemPrompt } from "./prompt.js";
import { resolveRunCodeContext } from "./run-code-context.js";
import { buildRunState, type Tool, type ToolContext } from "./tools.js";
import type { ChatMessage, ChatUserContentPart } from "./types.js";
import type { LLMClient } from "../llm/openai-compat.js";
import type { NexusDatabase } from "../storage/database.js";
import { appendMessage, getOrCreateSessionId, getHomeSession, loadRecentHistory } from "../storage/sessions.js";
import { beginSessionTurnNudges, completeSessionTurnNudges } from "../storage/nudges.js";
import { Semaphore } from "./semaphore.js";
import { getPreset, type AgentPreset } from "./presets.js";
import { extractKeywords, generateMemoryHints, hasRecentMemorySearch } from "./memory-hints.js";
import type { AgentTracker } from "./agent-tracker.js";
import type { ModelRouter, ModelRoutingMode } from "../llm/model-router.js";
import type { LlmCircuitBreaker } from "../llm/circuit-breaker.js";
import type { SkillsConfig } from "../state/config.js";
import { resolveSkillScopes, filterToolsBySkillAccess } from "../state/skill-policy.js";

type ExecutionLane = "interactive" | "background";
type TopLevelCoderTaskType = "plan" | "review" | "walkthrough" | "write";
type NudgeConfig = {
  enabled: boolean;
  channels: string[];
  memoryTurnInterval: number;
  skillIterationInterval: number;
};

export type HistoryScope =
  | {
    mode: "exact";
    channel: string;
    channelKey: string;
    agentId?: string;
  }
  | {
    mode: "latest_telegram_for_agent";
  }
  | {
    mode: "home";
  };

export function resolveHistoryScopeForRequest(params: {
  db: NexusDatabase;
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

  const home = getHomeSession({ db: params.db, agentId: params.agentId });
  if (home) {
    return {
      channel: home.channel,
      channelKey: home.channelKey,
      agentId: params.agentId,
      source: "home",
    };
  }

  const latestTelegram = params.db.db
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

  const fallbackSource = scope.mode === "home" ? "home:fallback" : "latest_telegram_for_agent:fallback";
  if (params.channel.trim().toLowerCase() === "internal_events") {
    return {
      channel: "agent",
      channelKey: params.agentId,
      agentId: params.agentId,
      source: `${fallbackSource}:agent`,
    };
  }
  return { ...fallback, source: fallbackSource };
}

function clampPositiveInt(value: number): number {
  return Math.max(1, Math.floor(value));
}

function clampNonNegativeInt(value: number): number {
  return Math.max(0, Math.floor(value));
}

/** Compose the llama.cpp slot-affinity key for a run. Keep granular enough to
 *  separate distinct logical sessions (different chats, different lanes,
 *  different presets) but stable across turns of the same logical session so
 *  the slot owner doesn't churn on every message. */
function buildSlotKey(params: {
  channel: string;
  channelKey: string;
  lane: ExecutionLane;
  preset: string;
}): string {
  return `${params.channel}:${params.channelKey}:${params.lane}:${params.preset}`;
}

function buildRuntimeClockSystemMessage(nowMs: number): string {
  // Round to the top of the hour so the trailing hint block is byte-stable
  // within a one-hour window. Coarser than seconds, but fine for current-events
  // routing — and lets prompt caches survive across multi-turn sessions.
  const hourStartMs = Math.floor(nowMs / 3_600_000) * 3_600_000;
  const hour = new Date(hourStartMs);
  const iso = hour.toISOString();
  return [
    "Runtime clock (UTC, rounded to hour):",
    `- hour: ${iso.slice(0, 13)}:00Z`,
    `- date: ${iso.slice(0, 10)}`,
    `- year: ${hour.getUTCFullYear()}`,
  ].join("\n");
}

function buildMemoryRetentionNudgeSystemMessage(params: { turnCount: number; interval: number }): string {
  return [
    "Memory retention nudge (ephemeral):",
    `- This session reached turn ${params.turnCount} (interval=${params.interval}).`,
    "- If this run surfaces durable facts/preferences/plans, store them with memory_store using specific keys.",
    "- Skip storing transient scratch details.",
  ].join("\n");
}

function buildSkillNudgeSystemMessage(params: { iterationInterval: number }): string {
  return [
    "Skill capture nudge (ephemeral):",
    `- Multiple iterations elapsed without a new skill action (interval=${params.iterationInterval}).`,
    "- If you are repeating a stable workflow, capture it using skill_create or update it with skill_update.",
    "- Prefer saving skills in a relevant category directory instead of the skills root; use the `category` field on skill_create, and create a new category when none fits.",
    "- Keep skills concise and reusable; do not store one-off task details.",
  ].join("\n");
}

function collectToolNames(messages: ChatMessage[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        const name = call.name.trim();
        if (name) names.add(name);
      }
      continue;
    }
    if (message.role === "tool" && typeof message.name === "string") {
      const name = message.name.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

const COMPACTION_SUMMARY_HINT_MAX_CHARS = 2400;

function truncateWithMarker(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…(+${text.length - maxChars} chars)`;
}

function buildCompactionSummarySystemMessage(params: { summary: string; updatedAt: number }): string {
  const iso = params.updatedAt > 0 ? new Date(params.updatedAt).toISOString() : "unknown";
  return [
    "Historical context note (auto-loaded):",
    `- source: compaction summary memory (${iso})`,
    "- This summary covers earlier conversation context that may no longer be in recent history.",
    "- Validate critical details with tools before irreversible actions.",
    "- If durable knowledge appears here, retain it via memory tiers: Tier A -> AGENTS.md, Tier M -> MEMORY.md, Tier B -> memory_store, Tier C -> NOTES.md.",
    "",
    truncateWithMarker(params.summary, COMPACTION_SUMMARY_HINT_MAX_CHARS),
  ].join("\n");
}

function inferTopLevelCoderTaskType(text: string): TopLevelCoderTaskType | undefined {
  const match = text.match(/(?:^|\n)\s*Task type:\s*(plan|review|walkthrough|write)\b/i);
  if (!match?.[1]) return undefined;
  const normalized = match[1].trim().toLowerCase();
  return normalized === "plan" || normalized === "review" || normalized === "walkthrough" || normalized === "write"
    ? normalized
    : undefined;
}

export class AgentService {
  private readonly interactiveSemaphore: Semaphore;
  private readonly backgroundSemaphore: Semaphore;
  private readonly memoryHintsSeen: Map<string, Set<string>> = new Map();
  private readonly activeRunCancels = new Map<
    string,
    {
      runId: string | null;
      sessionId: string;
      channel: string;
      channelKey: string;
      agentId: string;
      startedAt: number;
      controller: AbortController;
    }
  >();

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
        anchorRolloverMessages?: number;
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
      /** Optional proactive nudges (memory/skill) injected per session cadence. */
      nudges?: NudgeConfig;
      /** Skill prompt + tool access controls from config. */
      skillsConfig?: SkillsConfig;
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

  cancelSessionRuns(sessionId: string, reason: string = "session stopped"): number {
    const target = sessionId.trim();
    if (!target) return 0;
    return this.cancelMatchingRuns((entry) => entry.sessionId === target, reason);
  }

  cancelAllRuns(reason: string = "all sessions stopped"): number {
    return this.cancelMatchingRuns(() => true, reason);
  }

  private cancelMatchingRuns(
    predicate: (entry: {
      runId: string | null;
      sessionId: string;
      channel: string;
      channelKey: string;
      agentId: string;
      startedAt: number;
      controller: AbortController;
    }) => boolean,
    reason: string,
  ): number {
    let cancelled = 0;
    const text = reason.trim() || "stopped";
    for (const entry of this.activeRunCancels.values()) {
      if (!predicate(entry)) continue;
      if (entry.controller.signal.aborted) continue;
      entry.controller.abort(new Error(text));
      cancelled += 1;
    }
    return cancelled;
  }

  private isRunCancellationError(err: unknown, signal: AbortSignal): boolean {
    if (signal.aborted) return true;
    if (err instanceof RunCancelledError) return true;
    if (!(err instanceof Error)) return false;
    if (err.name === "AbortError") return true;
    return /run cancelled|aborted|abort/i.test(err.message);
  }

  private cancellationMessage(signal: AbortSignal): string {
    const reason = signal.reason;
    if (typeof reason === "string" && reason.trim().length > 0) return `Run stopped: ${reason.trim()}`;
    if (reason instanceof Error && reason.message.trim().length > 0) return `Run stopped: ${reason.message.trim()}`;
    return "Run stopped.";
  }

  private defaultLaneForChannel(channel: string): ExecutionLane {
    return channel === "telegram" || channel === "cli" ? "interactive" : "background";
  }

  private shouldRunMemoryHintsForChannel(channel: string): boolean {
    return channel === "telegram" || channel === "cli";
  }

  private shouldRunNudgesForChannel(channel: string): boolean {
    const nudges = this.deps.nudges;
    if (!nudges?.enabled) return false;
    const target = channel.trim().toLowerCase();
    if (!target) return false;
    return nudges.channels.some((allowed) => allowed.trim().toLowerCase() === target);
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

  private loadLatestCompactionSummary(agentId: string, sessionId: string): { summary: string; updatedAt: number } | null {
    const row = this.deps.db.db
      .prepare(
        `SELECT value, updated_at
         FROM memories
         WHERE agent_id = ? AND key LIKE ?
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get(agentId, `compaction:${sessionId}:%`) as { value: string; updated_at: number } | undefined;
    if (!row || typeof row.value !== "string") return null;
    const summary = row.value.trim();
    if (!summary) return null;
    return {
      summary,
      updatedAt: typeof row.updated_at === "number" ? row.updated_at : 0,
    };
  }

  private resolveHistoryScope(params: {
    channel: string;
    channelKey: string;
    agentId: string;
    historyScope?: HistoryScope;
  }): { channel: string; channelKey: string; agentId: string; source: string } {
    return resolveHistoryScopeForRequest({
      db: this.deps.db,
      channel: params.channel,
      channelKey: params.channelKey,
      agentId: params.agentId,
      historyScope: params.historyScope,
    });
  }

  private buildInternalEventSummary(params: {
    sourceChannel: string;
    output: string;
    toolCallsUsed: number;
    newMessages: ChatMessage[];
    maxChars: number;
  }): string | null {
    const t = params.output.trim().toUpperCase();
    if ((t === "IDLE" || t === "NOOP" || t === "NO-OP") && params.toolCallsUsed === 0) return null;

    const toolNames = new Set<string>();
    for (const msg of params.newMessages) {
      if (msg.role === "tool" && msg.name) toolNames.add(msg.name);
    }

    const outcomeLimit = Math.max(100, params.maxChars - 200);
    const outcome = params.output.trim().length > outcomeLimit
      ? params.output.trim().slice(0, outcomeLimit) + "…"
      : params.output.trim();

    const lines = [
      `[INTERNAL_EVENT_SUMMARY source=${params.sourceChannel} internal_callback_not_user_message]`,
      `tools_used: ${toolNames.size > 0 ? Array.from(toolNames).join(", ") : "none"}`,
      `outcome: ${outcome}`,
    ];

    const text = lines.join("\n");
    return text.length > params.maxChars ? text.slice(0, params.maxChars) + "…" : text;
  }

  async handleUserMessage(params: {
    channel: string;
    channelKey: string;
    agentId: string;
    text: string;
    contentParts?: ChatUserContentPart[];
    /** Override preset for this invocation. */
    preset?: string;
    /** Optional top-level coder task mode. */
    taskType?: TopLevelCoderTaskType;
    /** Override model routing mode (default/local_only). */
    modelMode?: ModelRoutingMode;
    /** Queue lane for this run. Defaults by channel (telegram/cli=interactive, others=background). */
    executionLane?: ExecutionLane;
    /** Optional history scope override for session continuity across channels. */
    historyScope?: HistoryScope;
    /** If true, the session state and the result messages will NOT be saved to the DB, unless the agent takes an action. */
    ephemeralSessionSave?: "unless_action" | "always_skip";
    /** Persist run messages to a separate session. History still loaded from historyScope. */
    writeSession?: { channel: string; channelKey: string; agentId?: string };
    /** Max chars for the summary injected into the read session when writeSession is set. Default 800. */
    summaryMaxChars?: number;
    /** Called with each text content delta during LLM streaming. */
    onTextDelta?: (delta: string) => void;
    /** Called when a tool begins execution with a human-readable preview. */
    onToolStart?: (name: string, preview: string) => void;
    /** Called when a tool finishes execution. */
    onToolEnd?: (name: string) => void;
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
      const readSessionId = getOrCreateSessionId({
        db: this.deps.db,
        channel: historyScope.channel,
        channelKey: historyScope.channelKey,
        agentId: historyScope.agentId,
        nowMs,
      });
      const writeSessionId = params.writeSession
        ? getOrCreateSessionId({
          db: this.deps.db,
          channel: params.writeSession.channel,
          channelKey: params.writeSession.channelKey,
          agentId: params.writeSession.agentId ?? params.agentId,
          nowMs,
        })
        : readSessionId;

      // Note: do not auto-archive/clear blackboard here; keep entries available across runs.

      const history = loadRecentHistory({
        db: this.deps.db,
        sessionId: readSessionId,
        maxMessages: this.deps.limits.maxMessages,
        anchorRolloverMessages: this.deps.limits.anchorRolloverMessages,
        nowMs,
      });
      const runHistory: ChatMessage[] = [];
      for (const message of history) {
        if (message.role !== "system") runHistory.push(message);
      }
      // Cache breakpoint #2 of 3: end of stable persisted history. Caches the prefix up
      // through the previous turn so subsequent turns in the same session re-use it.
      // (#1 is the system prompt, marked by AgentRunner; #3 is the trailing hint block,
      // marked below after all hints are appended.)
      if (runHistory.length > 0) {
        const lastIdx = runHistory.length - 1;
        runHistory[lastIdx] = {
          ...runHistory[lastIdx]!,
          cacheControl: { type: "ephemeral" },
        };
      }

      // Resolve preset and filter tools
      const presetName = params.preset ?? this.deps.defaultPreset;
      const preset = presetName ? getPreset(presetName) : undefined;
      const runModelMode: ModelRoutingMode = params.modelMode ?? this.deps.circuitBreaker?.getEffectiveMode() ?? "default";

      const skillAccessCtx = { agentId: params.agentId, preset: preset?.name ?? presetName };
      const skillScopes = resolveSkillScopes(this.deps.skillsConfig, skillAccessCtx);
      const systemPrompt = !preset || preset.name === "orchestrator"
        ? await buildSystemPrompt({
          stateDir: this.deps.stateDir,
          agentId: params.agentId,
          presetName: preset?.name ?? presetName,
          presetSystemPrompt: preset?.systemPrompt,
          skillScopes,
          skillsOptions: this.deps.skillsConfig?.prompt,
          channel: params.channel,
        })
        : await buildPresetSystemPrompt({
          stateDir: this.deps.stateDir,
          agentId: params.agentId,
          presetName: preset.name,
          promptFiles: preset.promptFiles,
          systemPrompt: preset.systemPrompt ?? `You are a ${preset.name} agent.`,
          includePresets: false,
          skillScopes,
          skillsOptions: this.deps.skillsConfig?.prompt,
          channel: params.channel,
        });

      const onRunnerLog = this.deps.onRunnerLog
        ? (line: string) => {
          this.deps.onRunnerLog?.(
            `channel=${params.channel} key=${params.channelKey} agent=${params.agentId} ${line}`,
          );
        }
        : undefined;

      const nudgesEnabledForChannel = this.shouldRunNudgesForChannel(params.channel);
      let nudgeTurnCount: number | null = null;
      let memoryNudgeDue = false;
      let skillNudgeDue = false;
      if (nudgesEnabledForChannel && this.deps.nudges) {
        try {
          const nudgeTurn = beginSessionTurnNudges({
            db: this.deps.db,
            sessionId: readSessionId,
            nowMs,
            memoryTurnInterval: this.deps.nudges.memoryTurnInterval,
            skillIterationInterval: this.deps.nudges.skillIterationInterval,
          });
          nudgeTurnCount = nudgeTurn.state.userTurnCount;
          memoryNudgeDue = nudgeTurn.memoryNudgeDue;
          skillNudgeDue = nudgeTurn.skillNudgeDue;
          onRunnerLog?.(
            `nudges_begin session=${readSessionId} turn=${nudgeTurn.state.userTurnCount} memory_due=${memoryNudgeDue} skill_due=${skillNudgeDue}`,
          );
        } catch (err) {
          onRunnerLog?.(`nudges_begin_failed error=${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const finalizeTurnNudges = (args: { iterationsUsed: number; messages: ChatMessage[] }): void => {
        if (!nudgesEnabledForChannel || !this.deps.nudges || nudgeTurnCount === null) return;
        try {
          const toolNames = collectToolNames(args.messages);
          const memoryActionUsed = toolNames.has("memory_store") || toolNames.has("memory_delete");
          const skillActionUsed = toolNames.has("skill_create") || toolNames.has("skill_update");
          const next = completeSessionTurnNudges({
            db: this.deps.db,
            sessionId: readSessionId,
            nowMs: this.deps.toolContext.nowMs(),
            userTurnCount: nudgeTurnCount,
            iterationsUsed: args.iterationsUsed,
            memoryActionUsed,
            skillActionUsed,
          });
          onRunnerLog?.(
            `nudges_complete session=${readSessionId} memory_action=${memoryActionUsed} skill_action=${skillActionUsed} iterations=${args.iterationsUsed} skill_iterations_since_action=${next.skillIterationsSinceAction}`,
          );
        } catch (err) {
          onRunnerLog?.(`nudges_complete_failed error=${err instanceof Error ? err.message : String(err)}`);
        }
      };

      // Hints below all merge into a single trailing system block (collapseConsecutiveSystemMessages
      // in openai-compat). None of them carry cacheControl — the trailing block is volatile
      // across turns (memory hint depends on user keywords, nudges fire periodically, etc.),
      // so anchoring breakpoint #3 here would target volatile content and confuse engines that
      // restore from the most-recent marker. Breakpoint #3 lives on the user message in
      // AgentRunner — stable within a turn, naturally invalidated across turns at a clean boundary.
      const shouldInjectCompactionSummary = !preset || preset.name === "orchestrator" || preset.name === "coder";
      if (shouldInjectCompactionSummary) {
        const compaction = this.loadLatestCompactionSummary(params.agentId, readSessionId);
        if (compaction) {
          const compactionHint = buildCompactionSummarySystemMessage(compaction);
          runHistory.push({
            role: "system",
            content: compactionHint,
          });
          onRunnerLog?.(`compaction_summary_injected length=${compactionHint.length}`);
        }
      }

      // ── Memory hints: nudge agent about potentially relevant memories ──
      let memoryHint: string | null = null;
      if ((preset?.name === "orchestrator" || !preset) && this.shouldRunMemoryHintsForChannel(params.channel)) {
        const messageText = params.text;
        onRunnerLog?.(`memory_hint_check text_len=${messageText?.length ?? 0}`);
        const recentMemorySearch = hasRecentMemorySearch(runHistory);
        const internalMessage = messageText.includes("internal_callback_not_user_message");
        if (messageText && !recentMemorySearch && !internalMessage) {
          const keywords = extractKeywords(messageText);
          onRunnerLog?.(`memory_hint_keywords [${keywords.join(", ")}]`);
          if (keywords.length > 0) {
            if (!this.memoryHintsSeen.has(readSessionId)) {
              this.memoryHintsSeen.set(readSessionId, new Set());
            }
            const seenItems = Array.from(this.memoryHintsSeen.get(readSessionId)!);
            onRunnerLog?.(`memory_hint_seen [${seenItems.join(", ")}]`);
            memoryHint = generateMemoryHints({
              db: this.deps.db,
              agentId: params.agentId,
              keywords,
              seenKeywords: this.memoryHintsSeen.get(readSessionId)!,
              messageText,
            });
            onRunnerLog?.(`memory_hint_generated ${memoryHint ? 'YES' : 'NO'}`);
          }
        } else {
          onRunnerLog?.(
            `memory_hint_skipped hasRecentSearch=${recentMemorySearch} internal=${internalMessage} hasText=${messageText.length > 0}`,
          );
        }
      } else if (preset?.name === "orchestrator" || !preset) {
        onRunnerLog?.(`memory_hint_skipped channel=${params.channel}`);
      }

      // Append ephemeral runtime hints right before the latest user message. They merge
      // into one trailing system block via collapseConsecutiveSystemMessages. No cacheControl
      // is set here — the user message in AgentRunner carries breakpoint #3.
      if (memoryHint) {
        onRunnerLog?.(`memory_hint_injected length=${memoryHint.length}`);
        runHistory.push({
          role: "system",
          content: memoryHint,
        });
      }
      if (memoryNudgeDue && this.deps.nudges && nudgeTurnCount !== null) {
        const memoryNudge = buildMemoryRetentionNudgeSystemMessage({
          turnCount: nudgeTurnCount,
          interval: this.deps.nudges.memoryTurnInterval,
        });
        runHistory.push({
          role: "system",
          content: memoryNudge,
        });
        onRunnerLog?.(`memory_nudge_injected turn=${nudgeTurnCount} length=${memoryNudge.length}`);
      }
      if (skillNudgeDue && this.deps.nudges) {
        const skillNudge = buildSkillNudgeSystemMessage({
          iterationInterval: this.deps.nudges.skillIterationInterval,
        });
        runHistory.push({
          role: "system",
          content: skillNudge,
        });
        onRunnerLog?.(`skill_nudge_injected length=${skillNudge.length}`);
      }
      // Runtime channel hint moved into the cached system prompt (formatChannelRoutingHint).
      const runtimeClockHint = buildRuntimeClockSystemMessage(nowMs);
      runHistory.push({
        role: "system",
        content: runtimeClockHint,
      });
      onRunnerLog?.(`runtime_clock_injected length=${runtimeClockHint.length}`);

      const finalSystemPrompt = systemPrompt;

      onRunnerLog?.(
        `history_scope source=${historyScope.source} channel=${historyScope.channel} key=${historyScope.channelKey} lane=${lane} stored_messages=${history.length} run_messages=${runHistory.length}`,
      );

      let llm: LLMClient = this.deps.llm;
      let llmConfig = this.deps.toolContext.llmConfig;
      let trackCircuitBreaker = true;
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
        trackCircuitBreaker = route.primaryProvider === "default";
        onRunnerLog?.(
          `llm_route mode=${route.mode} source=${route.source} primary=${route.primaryProvider}/${route.primary.model} breaker_track=${trackCircuitBreaker ? "yes" : "no"}`,
        );
      }

      const tools = filterToolsBySkillAccess({
        tools: filterToolsByPreset(this.deps.getTools(), preset),
        config: this.deps.skillsConfig,
        ctx: {
          agentId: params.agentId,
          preset: preset?.name ?? presetName,
        },
      });

      // Resolve budget: global limits are hard caps; presets can only tighten.
      const budget = this.resolveRunBudget(preset);
      const runtimeLimits = this.globalRuntimeLimits();

      // Build tool context — inject LLM reference so spawn_agent can create workers
      const runId = this.deps.agentTracker?.startRun({
        agentId: params.agentId,
        preset: presetName ?? "default",
        channel: params.channel,
        channelKey: params.channelKey,
        sessionId: writeSessionId,
        task: params.text,
      });
      let runBaseContext: ToolContext;
      const topLevelCoderTaskType =
        preset?.name === "coder" ? params.taskType ?? inferTopLevelCoderTaskType(params.text) : undefined;
      try {
        runBaseContext = await resolveRunCodeContext({
          baseContext: this.deps.toolContext,
          presetName: preset?.name ?? presetName,
          taskType: topLevelCoderTaskType,
          runId: runId ?? null,
          sessionId: writeSessionId,
          log: onRunnerLog,
        });
      } catch (err) {
        if (runId && this.deps.agentTracker) {
          this.deps.agentTracker.completeRun(runId, {
            status: "failed",
            outputPreview: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
            endedAt: this.deps.toolContext.nowMs(),
          });
        }
        finalizeTurnNudges({ iterationsUsed: 0, messages: [] });
        throw err;
      }
      const abortController = new AbortController();
      const cancellationKey = runId ?? `runless:${crypto.randomUUID()}`;
      this.activeRunCancels.set(cancellationKey, {
        runId: runId ?? null,
        sessionId: writeSessionId,
        channel: params.channel,
        channelKey: params.channelKey,
        agentId: params.agentId,
        startedAt: nowMs,
        controller: abortController,
      });

      const runState = preset
        ? buildRunState({
            presetKernel: preset.kernel,
            presetTools: preset.tools,
            filteredToolNames: tools.map((t) => t.name),
          })
        : null;

      const toolContext: ToolContext = {
        ...runBaseContext,
        llm,
        llmConfig,
        modelRouter: this.deps.modelRouter,
        modelMode: runModelMode,
        runtimeLimits,
        abortSignal: abortController.signal,
        request: {
          channel: params.channel,
          channelKey: params.channelKey,
          agentId: params.agentId,
          homeAgentId: params.agentId,
          preset: preset?.name ?? presetName,
          sessionId: writeSessionId,
          runId,
          modelMode: runModelMode,
        },
        ...(runState ? { runState } : {}),
      };

      // Slot key for llama.cpp slot affinity. channel:channelKey:lane:preset
      // — stable across all turns of a logical session+preset, distinguishes
      // worker presets from the parent orchestrator, and lets heartbeat /
      // gateway / interactive traffic each own their own slot.
      const slotKey = buildSlotKey({
        channel: params.channel,
        channelKey: params.channelKey,
        lane,
        preset: preset?.name ?? presetName ?? "default",
      });

      const runner = new AgentRunner({
        llm,
        tools,
        toolCallCaps: preset?.toolCallCaps,
        budget,
        toolContext,
        onLog: onRunnerLog,
        onTextDelta: params.onTextDelta,
        onToolStart: params.onToolStart,
        onToolEnd: params.onToolEnd,
        circuitBreaker: this.deps.circuitBreaker,
        trackCircuitBreaker,
        slotKey,
        transientRetries: this.deps.transientRetries ?? 5,
        abortSignal: abortController.signal,
      });

      let result: Awaited<ReturnType<AgentRunner["run"]>>;
      try {
        result = await runner.run({
          systemPrompt: finalSystemPrompt,
          history: runHistory,
          userMessage: params.contentParts && params.contentParts.length > 0 ? params.contentParts : params.text,
        });
      } catch (err) {
        if (this.isRunCancellationError(err, abortController.signal)) {
          const cancellationOutput = this.cancellationMessage(abortController.signal);
          const cancellationMessages: ChatMessage[] = [
            {
              role: "user",
              content: params.contentParts && params.contentParts.length > 0 ? params.contentParts : params.text,
            },
            {
              role: "assistant",
              content: cancellationOutput,
            },
          ];
          if (params.ephemeralSessionSave !== "always_skip") {
            const runNowMs = this.deps.toolContext.nowMs();
            try {
              for (const msg of cancellationMessages) {
                appendMessage({ db: this.deps.db, sessionId: writeSessionId, message: msg, nowMs: runNowMs });
              }
            } catch (persistErr) {
              onRunnerLog?.(
                `cancel_persist_failed session=${writeSessionId} error=${
                  persistErr instanceof Error ? persistErr.message : String(persistErr)
                }`,
              );
            }

            if (writeSessionId !== readSessionId) {
              const summary = this.buildInternalEventSummary({
                sourceChannel: params.channel,
                output: cancellationOutput,
                toolCallsUsed: 0,
                newMessages: cancellationMessages,
                maxChars: params.summaryMaxChars ?? 800,
              });
              if (summary) {
                try {
                  appendMessage({
                    db: this.deps.db,
                    sessionId: readSessionId,
                    message: { role: "user", name: "system_report", content: summary },
                    nowMs: runNowMs + 1,
                  });
                  onRunnerLog?.(`summary_injected target=${readSessionId} len=${summary.length}`);
                } catch (persistErr) {
                  onRunnerLog?.(
                    `cancel_summary_persist_failed session=${readSessionId} error=${
                      persistErr instanceof Error ? persistErr.message : String(persistErr)
                    }`,
                  );
                }
              }
            }
          }
          finalizeTurnNudges({ iterationsUsed: 0, messages: cancellationMessages });
          if (runId && this.deps.agentTracker) {
            this.deps.agentTracker.completeRun(runId, {
              status: "stopped",
              outputPreview: cancellationOutput,
              endedAt: this.deps.toolContext.nowMs(),
            });
          }
          return {
            runId: runId ?? null,
            sessionId: writeSessionId,
            output: cancellationOutput,
            status: "failed",
            toolCallsUsed: 0,
            iterationsUsed: 0,
          };
        }
        if (runId && this.deps.agentTracker) {
          this.deps.agentTracker.completeRun(runId, {
            status: "failed",
            outputPreview: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
            endedAt: this.deps.toolContext.nowMs(),
          });
        }
        finalizeTurnNudges({ iterationsUsed: 0, messages: [] });
        throw err;
      } finally {
        this.activeRunCancels.delete(cancellationKey);
      }

      let shouldPersistHistory = true;
      const runTookAction = result.newMessages.some((msg) => {
        if (msg.role === "tool") return true;
        if (msg.role === "assistant" && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) return true;
        return false;
      });
      if (params.ephemeralSessionSave === "unless_action") {
        const t = result.output.trim().toUpperCase();
        if ((t === "IDLE" || t === "NOOP" || t === "NO-OP") && !runTookAction) {
          shouldPersistHistory = false;
        }
      } else if (params.ephemeralSessionSave === "always_skip") {
        shouldPersistHistory = false;
      }
      finalizeTurnNudges({ iterationsUsed: result.iterationsUsed, messages: result.newMessages as ChatMessage[] });

      const runNowMs = this.deps.toolContext.nowMs();
      if (shouldPersistHistory) {
        for (const msg of result.newMessages) {
          appendMessage({ db: this.deps.db, sessionId: writeSessionId, message: msg as ChatMessage, nowMs: runNowMs });
        }
      }

      // When writing to a separate session, inject a brief summary into the read session
      // so the orchestrator retains awareness without the full verbose exchange.
      if (writeSessionId !== readSessionId && shouldPersistHistory) {
        const summary = this.buildInternalEventSummary({
          sourceChannel: params.channel,
          output: result.output,
          toolCallsUsed: result.toolCallsUsed,
          newMessages: result.newMessages,
          maxChars: params.summaryMaxChars ?? 800,
        });
        if (summary) {
          appendMessage({
            db: this.deps.db,
            sessionId: readSessionId,
            message: { role: "user", name: "system_report", content: summary },
            nowMs: runNowMs,
          });
          onRunnerLog?.(`summary_injected target=${readSessionId} len=${summary.length}`);
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
          sessionId: writeSessionId,
          channel: params.channel,
          channelKey: params.channelKey,
          agentId: params.agentId,
        });
      }

      return {
        runId: runId ?? null,
        sessionId: writeSessionId,
        output: result.output,
        status: result.status,
        toolCallsUsed: result.toolCallsUsed,
        iterationsUsed: result.iterationsUsed,
      };
    });
  }

  /**
   * Run a Telegram delivery callback and ack the pending deploy after it
   * settles. Centralizes the "deliver, then ack" contract that telegram.ts and
   * scheduler/job-scheduler.ts both need: ack must happen after sendOutput
   * because finalize on the host rebuilds this container, and we don't want
   * to be killed mid-reply. Ack fires in `finally` so transient delivery
   * failures don't strand a finalize-pending forever.
   */
  async withTelegramDeliveryAck<T>(
    ackContext: { chatId: number | string; runId: string | null; sessionId: string; agentId: string },
    deliver: () => Promise<T>,
  ): Promise<T> {
    try {
      return await deliver();
    } finally {
      this.ackDeployIfPending({
        runId: ackContext.runId,
        sessionId: ackContext.sessionId,
        channel: "telegram",
        channelKey: String(ackContext.chatId),
        agentId: ackContext.agentId,
      });
    }
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

      const triggerId = (pending.triggerId ?? "").trim();
      if (!triggerId) {
        this.deps.onRunnerLog?.("deploy-ack deferred: pending deploy is missing triggerId");
        return;
      }
      const ackDir = path.join(stateDir, "deploy-acks");
      mkdirSync(ackDir, { recursive: true });
      const ackFile = path.join(ackDir, `${triggerId}.json`);
      if (existsSync(ackFile)) {
        try { unlinkSync(finalizePending); } catch { /* race with ha-deployer cleanup */ }
        this.deps.onRunnerLog?.("deploy-ack skipped: matching ack file already exists");
        return;
      }
      const ackPayload = {
        triggerId,
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
      const ackTmp = `${ackFile}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(ackTmp, JSON.stringify(ackPayload, null, 2) + "\n");
      renameSync(ackTmp, ackFile);
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
    homeAgentId?: string;
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

export function shouldAckPending(
  pending: FinalizePending,
  current: { runId: string | null; sessionId: string; channel: string; channelKey: string; agentId?: string },
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
    const expectedAgentId = (pending.request?.homeAgentId ?? pending.request?.agentId ?? "").trim();
    if (expectedAgentId && expectedAgentId !== (current.agentId ?? "").trim()) return false;
    const expectedChannel = (pending.request?.channel ?? "").trim();
    const expectedChannelKey = (pending.request?.channelKey ?? "").trim();
    if (expectedChannel && expectedChannel !== current.channel) return false;
    if (expectedChannelKey && expectedChannelKey !== current.channelKey) return false;
    return true;
  }
  return false;
}

function filterToolsByPreset(allTools: Tool[], preset?: AgentPreset): Tool[] {
  if (!preset) return allTools;
  const allowed = new Set(preset.tools);
  return allTools.filter((t) => allowed.has(t.name));
}
