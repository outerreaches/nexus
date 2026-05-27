import type { Tool, ToolContext } from "./tools.js";
import type { ChatMessage, ChatUserContent } from "./types.js";
import { OpenAICompatClient, type LLMClient, type LLMUsage } from "../llm/openai-compat.js";
import type { LlmCircuitBreaker } from "../llm/circuit-breaker.js";
import { createHash } from "node:crypto";
import { isSuccessfulApplyDeployResult } from "./deploy-result.js";
import {
  estimateTotalTokens,
  compactContext,
  storeCompactionRetentionCandidates,
  storeCompactionSummary,
} from "./context-compactor.js";
import type { NexusDatabase } from "../storage/database.js";
import type { ReasoningItem, ToolCall } from "./types.js";

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…(+${text.length - maxChars} chars)`;
}

function previewString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…(+${value.length - limit} chars)`;
}

/**
 * Builds the agent's visible output, prepending reasoning summary when the
 * model exposed one (codex/gpt-5.x). For chat-completions providers reasoning
 * is undefined and the output is just `text`.
 */
function composeOutputWithReasoning(text: string, reasoning?: ReasoningItem[]): string {
  if (!reasoning || reasoning.length === 0) return text;
  const summary = reasoning
    .flatMap((r) => r.summary)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("\n\n")
    .trim();
  if (!summary) return text;
  if (!text) return `[reasoning]\n${summary}\n[/reasoning]`;
  return `[reasoning]\n${summary}\n[/reasoning]\n\n${text}`;
}

function toolCallPreview(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "shell_exec":
      return typeof args.command === "string" ? previewString(args.command, 80) : "";
    case "file_read":
    case "file_write":
    case "file_edit":
      return typeof args.path === "string" ? args.path : "";
    case "web_search":
      return typeof args.query === "string" ? previewString(args.query, 60) : "";
    case "spawn_agent":
      return typeof args.task === "string" ? previewString(args.task, 60) : "";
    default: {
      // Build a compact "key=value" summary of top-level string/number/boolean args.
      const parts: string[] = [];
      for (const [k, v] of Object.entries(args)) {
        if (typeof v === "string") parts.push(`${k}=${previewString(v, 40)}`);
        else if (typeof v === "number" || typeof v === "boolean") parts.push(`${k}=${v}`);
      }
      return parts.length > 0 ? parts.join(", ") : "";
    }
  }
}

function redactForLog(value: unknown, depth: number = 0): unknown {
  if (depth > 6) return "[max_depth]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return previewString(value, 160);
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
        out[k] = previewString(v, 80);
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildInvalidToolArgsError(call: ToolCall, raw: string, reason: string): string {
  const normalized = raw.replace(/\s+/g, " ").trim();
  const preview = normalized ? truncate(normalized, 220) : "<empty>";
  return (
    `ERROR: invalid tool arguments for '${call.name}' (${reason}). ` +
    `Received: ${safeJson(preview)}. ` +
    `Retry this tool call with a valid JSON object for arguments.`
  );
}

type ParsedToolArgsResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; errorResult: string; argsForLog: unknown };

function parseToolArgsForExecution(call: ToolCall): ParsedToolArgsResult {
  let parsed: unknown;
  try {
    parsed = OpenAICompatClient.parseToolArgs(call.arguments);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorResult: buildInvalidToolArgsError(call, call.arguments, reason || "parse failed"),
      argsForLog: call.arguments,
    };
  }

  if (typeof parsed === "string") {
    return {
      ok: false,
      errorResult: buildInvalidToolArgsError(call, parsed, "not valid JSON"),
      argsForLog: parsed,
    };
  }

  if (!isPlainObject(parsed)) {
    const kind = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
    return {
      ok: false,
      errorResult: buildInvalidToolArgsError(call, call.arguments, `expected object, got ${kind}`),
      argsForLog: parsed,
    };
  }

  return { ok: true, args: parsed };
}

function formatLlmUsage(usage?: LLMUsage): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (typeof usage.promptTokens === "number") parts.push(`prompt=${usage.promptTokens}`);
  if (typeof usage.completionTokens === "number") parts.push(`completion=${usage.completionTokens}`);
  if (typeof usage.totalTokens === "number") parts.push(`total=${usage.totalTokens}`);
  if (typeof usage.cachedPromptTokens === "number") parts.push(`cached_prompt=${usage.cachedPromptTokens}`);
  if (typeof usage.cacheWritePromptTokens === "number") parts.push(`cache_write_prompt=${usage.cacheWritePromptTokens}`);
  if (
    typeof usage.cachedPromptTokens === "number" &&
    typeof usage.promptTokens === "number" &&
    usage.promptTokens > 0
  ) {
    const pct = (usage.cachedPromptTokens / usage.promptTokens) * 100;
    parts.push(`cache_hit=${pct.toFixed(1)}%`);
  }
  if (typeof usage.reasoningTokens === "number") parts.push(`reasoning=${usage.reasoningTokens}`);
  return parts.length > 0 ? parts.join(" ") : null;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function updatePromptEstimateMultiplier(current: number, actualPromptTokens: number, estimatedPromptTokens: number): number {
  if (!Number.isFinite(actualPromptTokens) || actualPromptTokens <= 0) return current;
  if (!Number.isFinite(estimatedPromptTokens) || estimatedPromptTokens <= 0) return current;
  const observedRatio = actualPromptTokens / estimatedPromptTokens;
  const boundedRatio = clampNumber(observedRatio, 0.75, 2.5);
  // EWMA update so one noisy response does not swing compaction policy.
  return clampNumber(current * 0.75 + boundedRatio * 0.25, 0.8, 2.5);
}

function isLlmTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /LLM request timed out/i.test(err.message);
}

/** Transient provider errors worth retrying once (429, 5xx, network). */
function isTransientLlmError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/LLM request timed out/i.test(message)) return true;
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message)) return true;
  // Codex SSE stream cut off before response.output_item.done — partial tool
  // call discarded by codex-responses.ts. Retry like a network blip.
  if (/Codex stream ended with \d+ unfinalized function call/i.test(message)) return true;
  const statusMatch = message.match(/LLM request failed:\s*(\d{3})\b/);
  if (!statusMatch) return false;
  const status = Number(statusMatch[1]);
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function trimMessagesForTimeoutRetry(messages: ChatMessage[], keepRecent: number = 48): ChatMessage[] {
  if (messages.length <= keepRecent + 1) return messages;
  const systemMessage = messages[0]?.role === "system" ? messages[0] : null;
  const start = systemMessage ? 1 : 0;
  const tail = messages.slice(Math.max(start, messages.length - keepRecent));
  return systemMessage ? [systemMessage, ...tail] : tail;
}

function toolCallSignature(call: import("./types.js").ToolCall): string {
  const hash = createHash("sha256").update(call.name).update("\n").update(call.arguments).digest("hex").slice(0, 16);
  return `${call.name}:${hash}`;
}

type ShellReadLoopState = {
  session: string | null;
  progressReads: number;
  emptyReads: number;
};

function resetShellReadLoopState(state: ShellReadLoopState): void {
  state.session = null;
  state.progressReads = 0;
  state.emptyReads = 0;
}

function parseShellInteractiveReadPayload(result: string): {
  session: string;
  running: boolean;
  output: string;
  progressCompacted: boolean;
} | null {
  const trimmed = result.trimStart();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(result) as unknown;
    if (!isPlainObject(parsed)) return null;
    if (parsed.action !== "read") return null;
    if (typeof parsed.session !== "string" || typeof parsed.output !== "string" || typeof parsed.running !== "boolean") {
      return null;
    }
    return {
      session: parsed.session,
      running: parsed.running,
      output: parsed.output,
      progressCompacted: parsed.progressCompacted === true,
    };
  } catch {
    return null;
  }
}

function maybeBuildShellReadGuidance(params: {
  call: ToolCall;
  args: unknown;
  result: string;
  state: ShellReadLoopState;
}): string | null {
  if (params.call.name !== "shell_interactive") return null;
  const action = isPlainObject(params.args) && typeof params.args.action === "string" ? params.args.action.trim().toLowerCase() : "";
  if (action !== "read") {
    resetShellReadLoopState(params.state);
    return null;
  }

  const payload = parseShellInteractiveReadPayload(params.result);
  if (!payload || !payload.running) {
    resetShellReadLoopState(params.state);
    return null;
  }

  if (params.state.session !== payload.session) {
    params.state.session = payload.session;
    params.state.progressReads = 0;
    params.state.emptyReads = 0;
  }

  if (payload.progressCompacted) {
    params.state.progressReads += 1;
    params.state.emptyReads = 0;
    if (params.state.progressReads === 3) {
      return (
        "[SHELL READ GUIDANCE] This looks like progress monitoring rather than interactive debugging. " +
        "Prefer `process_manage` for long-running work. If you must stay in the shell, use larger `waitMs`/`idleMs` and avoid tailing every small increment."
      );
    }
    return null;
  }

  if (payload.output.trim().length === 0) {
    params.state.emptyReads += 1;
    params.state.progressReads = 0;
    if (params.state.emptyReads === 2) {
      return (
        "[SHELL READ GUIDANCE] Recent reads returned no new output. `running=true` only means the shell session is still alive; " +
        "it does not guarantee the foreground command is still active. Close the session, send the next command, or switch to `process_manage`."
      );
    }
    return null;
  }

  resetShellReadLoopState(params.state);
  return null;
}

const RETRY_GUARD_RESETTING_FILE_TOOLS = new Set(["file_write", "file_edit", "file_edit_lines", "file_patch"]);

function shellCommandSegments(command: string): string[] {
  return command
    .split("&&")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function matchesPackageManagerScriptSegment(segment: string, script: "typecheck" | "build" | "test"): boolean {
  return (
    new RegExp(`^(?:npm|pnpm|yarn)(?:\\s+--prefix\\s+\\S+)?\\s+(?:run\\s+)?${script}\\b`).test(segment) ||
    new RegExp(`^(?:npm|pnpm|yarn)\\s+run\\s+(?:--prefix\\s+\\S+\\s+)?${script}\\b`).test(segment)
  );
}

function isVerificationShellCommand(command: string, task: "typecheck" | "build" | "test"): boolean {
  return shellCommandSegments(command).some((segment) => matchesPackageManagerScriptSegment(segment, task));
}

function isDependencyBootstrapShellCommand(command: string): boolean {
  return shellCommandSegments(command).some((segment) =>
    /^(?:npm)(?:\s+--prefix\s+\S+)?\s+ci\b/.test(segment) ||
    /^(?:npm)\s+ci(?:\s+--prefix\s+\S+)?\b/.test(segment) ||
    /^(?:npm|pnpm|yarn)(?:\s+--prefix\s+\S+)?\s+install\b/.test(segment) ||
    /^(?:npm|pnpm|yarn)\s+install(?:\s+--prefix\s+\S+)?\b/.test(segment),
  );
}

function successfulToolCallClearsRetryGuards(
  call: import("./types.js").ToolCall,
  args: unknown,
  result: string,
): boolean {
  if (result.trimStart().startsWith("ERROR:")) return false;
  if (RETRY_GUARD_RESETTING_FILE_TOOLS.has(call.name)) return true;
  if (call.name !== "shell_exec" || !isPlainObject(args)) return false;
  const command = typeof args.command === "string" ? args.command.trim() : "";
  return (
    isDependencyBootstrapShellCommand(command) ||
    isVerificationShellCommand(command, "typecheck") ||
    isVerificationShellCommand(command, "build") ||
    isVerificationShellCommand(command, "test")
  );
}

const DEPLOY_HANDOFF_LINE_1 =
  "Deploy applied. Stopping this run to avoid post-deploy tool calls on a stale process image.";
const DEPLOY_HANDOFF_LINE_2 =
  "Start a fresh follow-up request for runtime/schema validation or post-deploy actions.";

function stripLeadingDeployHandoff(text: string): string {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0) {
    const line = lines[0]?.trimEnd() ?? "";
    if (line === DEPLOY_HANDOFF_LINE_1 || line === DEPLOY_HANDOFF_LINE_2) {
      lines.shift();
      continue;
    }
    break;
  }
  return lines.join("\n").trimStart();
}

function summarizeItemsInline(items: string[], maxItems: number = 12): string {
  if (items.length === 0) return "(none)";
  const shown = items.slice(0, maxItems);
  const suffix = items.length > maxItems ? `, … (+${items.length - maxItems} more)` : "";
  // Keep on one line and avoid massive outputs.
  return truncate(shown.join(", ") + suffix, 500);
}

type ToolExecutionStatus = "ok" | "error";
type ToolErrorClass =
  | "validation_error"
  | "rate_limited"
  | "not_found"
  | "capability_mismatch"
  | "transient_provider_error"
  | "unknown_error";
type ToolRetryPolicy = "no" | "yes" | "after_backoff";

type ToolResultClassification = {
  status: ToolExecutionStatus;
  errorSummary?: string;
  errorClass?: ToolErrorClass;
  retryPolicy?: ToolRetryPolicy;
  retryGuidance?: string;
};

type ParsedSpawnAgentResult = {
  status?: string;
  output?: string;
  deployApplied?: boolean;
};

function parseSpawnAgentResult(result: string): ParsedSpawnAgentResult | null {
  try {
    const parsed = JSON.parse(result) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const status = typeof obj.status === "string" ? obj.status : undefined;
    const output = typeof obj.output === "string" ? obj.output : undefined;
    const deployApplied = obj.deployApplied === true;
    return { status, output, deployApplied };
  } catch {
    return null;
  }
}

function classifyToolError(summary: string): {
  errorClass: ToolErrorClass;
  retryPolicy: ToolRetryPolicy;
  retryGuidance: string;
} {
  const text = summary.toLowerCase();

  const has = (...needles: string[]): boolean => needles.some((needle) => text.includes(needle));
  const hasAnyRegex = (...patterns: RegExp[]): boolean => patterns.some((p) => p.test(text));

  if (
    has("rate limit", "too many requests", "retry after") ||
    hasAnyRegex(/\b429\b/, /\bhttp\s*429\b/)
  ) {
    return {
      errorClass: "rate_limited",
      retryPolicy: "after_backoff",
      retryGuidance: "Wait/back off, reduce request volume, then retry once.",
    };
  }

  if (
    has(
      "invalid tool arguments",
      "not valid json",
      "expected object",
      "required",
      "must be",
      "out of range",
      "non-empty",
      "parse failed",
      "zoderror",
      "invalid",
    )
  ) {
    return {
      errorClass: "validation_error",
      retryPolicy: "no",
      retryGuidance: "Fix arguments/inputs before retrying.",
    };
  }

  if (
    has("not found", "no such file or directory", "unknown tool", "unknown preset", "source not found", "not a file")
  ) {
    return {
      errorClass: "not_found",
      retryPolicy: "no",
      retryGuidance: "Verify identifiers/paths/resources exist, then retry.",
    };
  }

  if (
    has(
      "disabled by policy",
      "not configured",
      "not available",
      "tool call cap reached",
      "blocked_by_cap",
      "blocked by retry policy",
      "allowlisted",
      "unsupported",
      "outside current session scope",
      "no endpoints found that support",
      "cannot spawn another orchestrator",
      "code root is disabled by policy",
      "code root is read-only",
    )
  ) {
    return {
      errorClass: "capability_mismatch",
      retryPolicy: "no",
      retryGuidance: "Use a compatible tool/model/permission context instead of retrying unchanged.",
    };
  }

  if (
    has("timed out", "timeout", "service unavailable", "connection reset", "temporarily unavailable", "aborted", "aborterror") ||
    hasAnyRegex(/\b5\d\d\b/, /\beconnreset\b/, /\bhttp\s*50[0-9]\b/)
  ) {
    return {
      errorClass: "transient_provider_error",
      retryPolicy: "yes",
      retryGuidance: "Retry once with reduced scope/context; escalate if it fails again.",
    };
  }

  return {
    errorClass: "unknown_error",
    retryPolicy: "no",
    retryGuidance: "Diagnose first (inspect full error/output) before retrying.",
  };
}

export function classifyToolResultStatus(call: ToolCall, result: string): ToolResultClassification {
  if (result.startsWith("ERROR:")) {
    const errorSummary = result.split(/\r?\n/)[0] ?? "ERROR";
    const normalized = classifyToolError(errorSummary);
    return { status: "error", errorSummary, ...normalized };
  }
  if (call.name !== "spawn_agent") return { status: "ok" };

  const parsed = parseSpawnAgentResult(result);
  const status = parsed?.status?.trim().toLowerCase();
  if (!status) return { status: "ok" };
  if (status === "complete" || status === "completed") return { status: "ok" };

  const summarySource = parsed?.output?.trim() ? parsed.output.trim() : `spawn_agent status=${parsed?.status ?? status}`;
  const errorSummary = summarySource.split(/\r?\n/)[0] ?? summarySource;
  const normalized = classifyToolError(errorSummary);
  return {
    status: "error",
    errorSummary,
    ...normalized,
  };
}

function allowedIdenticalRetries(params: {
  call: ToolCall;
  args: unknown;
  errorClass?: ToolErrorClass;
  retryPolicy?: ToolRetryPolicy;
}): number {
  if (
    params.call.name === "telegram_send" &&
    params.errorClass === "not_found" &&
    isPlainObject(params.args) &&
    typeof params.args.path === "string" &&
    params.args.path.trim().length > 0
  ) {
    return 1;
  }
  if (params.retryPolicy === "yes" || params.retryPolicy === "after_backoff") return 1;
  return 0;
}

export function toolResultIndicatesDeployApplied(call: ToolCall, args: unknown, result: string): boolean {
  if (result.trimStart().startsWith("ERROR:")) return false;

  if (call.name === "ha_deploy") {
    const action = args && typeof args === "object" ? (args as Record<string, unknown>).action : undefined;
    return action === "apply" && isSuccessfulApplyDeployResult(result);
  }

  if (call.name === "spawn_agent") {
    const parsed = parseSpawnAgentResult(result);
    return parsed?.deployApplied === true;
  }

  return false;
}

export type AgentBudget = {
  maxToolCalls: number;
  maxIterations: number;
  maxContextTokens?: number;
};

export type AgentResult = {
  status: "complete" | "failed" | "budget_exhausted";
  output: string;
  newMessages: ChatMessage[];
  toolCallsUsed: number;
  iterationsUsed: number;
};

export class RunCancelledError extends Error {
  constructor(message: string = "Run cancelled") {
    super(message);
    this.name = "RunCancelledError";
  }
}

function abortReasonToText(reason: unknown): string | null {
  if (typeof reason === "string" && reason.trim().length > 0) return reason.trim();
  if (reason instanceof Error && reason.message.trim().length > 0) return reason.message.trim();
  return null;
}

function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  return /aborted|abort/i.test(err.message);
}

export class AgentRunner {
  constructor(
    private readonly deps: {
      llm: LLMClient;
      tools: Tool[];
      toolCallCaps?: Record<string, number>;
      budget: AgentBudget;
      toolContext: ToolContext;
      onLog?: (line: string) => void;
      /** Called with each text content delta during LLM streaming. */
      onTextDelta?: (delta: string) => void;
      /** Called when a tool begins execution with a human-readable preview. */
      onToolStart?: (name: string, preview: string) => void;
      /** Called when a tool finishes execution. */
      onToolEnd?: (name: string) => void;
      circuitBreaker?: LlmCircuitBreaker;
      /** Track circuit-breaker health for this run (default true). */
      trackCircuitBreaker?: boolean;
      /** Max retries for transient LLM errors (429, 5xx, network). Default 5. */
      transientRetries?: number;
      /** Abort signal used by stop controls to cancel this run. */
      abortSignal?: AbortSignal;
      /** Optional llama.cpp slot affinity key. Used by OpenAICompatClient when
       *  the configured provider has a slot cache manager. Stable for the
       *  entire run so iteration retries hit the same physical slot. */
      slotKey?: string;
    },
  ) { }

  private recordCircuitSuccess(): void {
    if (this.deps.trackCircuitBreaker === false) return;
    this.deps.circuitBreaker?.recordSuccess();
  }

  private recordCircuitFailure(err: unknown): void {
    if (this.deps.trackCircuitBreaker === false) return;
    this.deps.circuitBreaker?.recordFailure(err);
  }

  private throwIfCancelled(): void {
    if (!this.deps.abortSignal?.aborted) return;
    const reason = abortReasonToText(this.deps.abortSignal.reason);
    throw new RunCancelledError(reason ? `Run cancelled: ${reason}` : "Run cancelled");
  }

  /** Returns the LLM-facing tool list for the current iteration. When the run
   *  has lazy-loading state (toolContext.runState), this is `kernel ∪ loaded`;
   *  otherwise it's the full pool the caller passed in. Execution-side lookups
   *  (`this.deps.tools.find(...)`) keep using the full pool so already-loaded
   *  tools remain callable even if dropped from the visible set mid-batch. */
  private visibleTools(): Tool[] {
    const runState = this.deps.toolContext.runState;
    if (!runState) return this.deps.tools;
    return this.deps.tools.filter(
      (t) => runState.kernelToolNames.has(t.name) || runState.loadedToolNames.has(t.name),
    );
  }

  async run(params: { systemPrompt: string; history: ChatMessage[]; userMessage: ChatUserContent }): Promise<AgentResult> {
    this.throwIfCancelled();
    // Cache breakpoint layout (3 markers; Anthropic budget = 4):
    //   #1: system prompt — stable across all sessions for the same agent/preset.
    //   #2: last persisted-history message — agent-service marks this; stable across turns.
    //   #3: the new user message — stable within a turn (iteration retries see the same user
    //       input), naturally invalidated across turns at a clean semantic boundary. Anything
    //       after this point (assistant + tool messages produced in the run loop) sits outside
    //       the cached prefix, which is fine: token-level prefix matching catches them anyway.
    // The trailing system block (compaction summary / memory hint / nudges / runtime clock)
    // is volatile across turns; we deliberately do NOT anchor a breakpoint there so engines
    // that restore from the most-recent marker don't end up targeting volatile content.
    const baseMessages: ChatMessage[] = [
      { role: "system", content: params.systemPrompt, cacheControl: { type: "ephemeral" } },
      ...params.history,
    ];
    const newMessages: ChatMessage[] = [
      { role: "user", content: params.userMessage, cacheControl: { type: "ephemeral" } },
    ];
    const messages: ChatMessage[] = [...baseMessages, ...newMessages];

    let toolCallsUsed = 0;
    const toolCallsPerName = new Map<string, number>();
    const repeatedFailures = new Map<string, number>();
    const blockedToolCalls = new Map<string, string>();
    const shellReadLoopState: ShellReadLoopState = { session: null, progressReads: 0, emptyReads: 0 };
    const maxSameToolFailures = 4;
    // Keep spawn_agent execution sequential so deploy handoff/retry guards are deterministic.
    const allowConcurrentSpawnBatches = false;
    const touchedFilePaths = new Set<string>();
    let typecheckOk = false;
    let buildOk = false;

    const maxContextTokens = this.deps.budget.maxContextTokens ?? 0;
    const softCompactionThreshold = 0.65;
    const hardCompactionThreshold = 0.85;
    let softCompactionAttempted = false;
    let promptEstimateMultiplier = 1;
    const runStartedAtMs = this.deps.toolContext.nowMs();

    const logUsageAndCalibrate = (
      mode: "default" | "transient_retry" | "extended",
      usage: LLMUsage | undefined,
      estimateRaw: number,
      estimateCalibrated: number,
    ): void => {
      const usageLine = formatLlmUsage(usage);
      if (usageLine) this.deps.onLog?.(`llm_usage mode=${mode} ${usageLine}`);
      const actualPrompt = usage?.promptTokens;
      if (typeof actualPrompt !== "number" || actualPrompt <= 0) return;
      const prevMultiplier = promptEstimateMultiplier;
      const rawRatio = actualPrompt / Math.max(1, estimateRaw);
      const calibratedRatio = actualPrompt / Math.max(1, estimateCalibrated);
      promptEstimateMultiplier = updatePromptEstimateMultiplier(
        promptEstimateMultiplier,
        actualPrompt,
        estimateRaw,
      );
      this.deps.onLog?.(
        `llm_prompt_estimate mode=${mode} raw=${estimateRaw} calibrated=${estimateCalibrated} ` +
        `actual=${actualPrompt} ratio_raw=${rawRatio.toFixed(2)} ratio_cal=${calibratedRatio.toFixed(2)} ` +
        `multiplier=${prevMultiplier.toFixed(2)}->${promptEstimateMultiplier.toFixed(2)}`,
      );
    };

    for (let iteration = 0; iteration < this.deps.budget.maxIterations; iteration++) {
      this.throwIfCancelled();
      // Snapshot visible tools (kernel ∪ loaded) once per iteration. All LLM
      // calls in this iteration — initial, transient retries, timeout retries —
      // must see the same tool set for consistent token estimates and caching.
      const currentTools = this.visibleTools();
      // ── Context compaction ─────────────────────────────────────────────
      if (maxContextTokens > 0) {
        const estimatedRaw = estimateTotalTokens(messages, currentTools);
        const estimated = Math.ceil(estimatedRaw * promptEstimateMultiplier);
        const shouldHardCompact = estimated > maxContextTokens * hardCompactionThreshold;
        const shouldSoftCompact =
          !softCompactionAttempted && estimated > maxContextTokens * softCompactionThreshold;
        if (shouldHardCompact || shouldSoftCompact) {
          const mode = shouldHardCompact ? "hard" : "soft";
          if (shouldSoftCompact) softCompactionAttempted = true;
          this.deps.onLog?.(
            `compaction: mode=${mode} estimated=${estimated} raw=${estimatedRaw} limit=${maxContextTokens} ` +
            `threshold=${Math.round((shouldHardCompact ? hardCompactionThreshold : softCompactionThreshold) * 100)}% ` +
            `factor=${promptEstimateMultiplier.toFixed(2)}`,
          );
          try {
            const result = await compactContext({
              messages,
              tools: currentTools,
              llm: this.deps.llm,
              maxContextTokens,
              mode,
              estimationFactor: promptEstimateMultiplier,
              minRecentMessages: shouldHardCompact ? 10 : 14,
              onLog: this.deps.onLog,
            });
            if (result.compacted) {
              // Replace the messages array contents in-place
              messages.length = 0;
              messages.push(...result.messages);
              this.deps.onLog?.(
                `compaction: removed ${result.messagesRemoved} messages, ${result.tokensBefore} → ${result.tokensAfter} tokens`,
              );
              // Store summary in memory for cross-session recall
              if (result.summary) {
                const db = this.deps.toolContext.db as NexusDatabase | undefined;
                const agentId = this.deps.toolContext.request?.agentId ?? "main";
                const sessionId = this.deps.toolContext.request?.sessionId;
                if (db && sessionId) {
                  const nowMs = this.deps.toolContext.nowMs();
                  storeCompactionSummary({
                    db,
                    agentId,
                    sessionId,
                    summary: result.summary,
                    nowMs,
                  });
                  const retention = storeCompactionRetentionCandidates({
                    db,
                    agentId,
                    sessionId,
                    summary: result.summary,
                    nowMs,
                    onLog: this.deps.onLog,
                  });
                  if (retention.detected > 0) {
                    this.deps.onLog?.(
                      `retention_pass: detected=${retention.detected} stored=${retention.stored} session=${sessionId}`,
                    );
                  }
                }
              }
            }
          } catch (compErr) {
            this.deps.onLog?.(`compaction: failed (${compErr instanceof Error ? compErr.message : String(compErr)}), proceeding without`);
          }
        }
      }

      let content: string | null = null;
      let toolCalls: import("./types.js").ToolCall[] = [];
      let reasoning: import("./types.js").ReasoningItem[] | undefined;
      const promptEstimateRaw = estimateTotalTokens(messages, currentTools);
      const promptEstimateCalibrated = Math.ceil(promptEstimateRaw * promptEstimateMultiplier);
      this.deps.onLog?.(
        `llm_call iteration=${iteration} messages=${messages.length} tool_calls_used=${toolCallsUsed} ` +
        `tools_visible=${currentTools.length} ` +
        `est_prompt=${promptEstimateCalibrated} est_prompt_raw=${promptEstimateRaw} est_factor=${promptEstimateMultiplier.toFixed(2)}`,
      );
      try {
        const res = await this.deps.llm.completeChat({
          messages,
          tools: currentTools,
          onTextDelta: this.deps.onTextDelta,
          abortSignal: this.deps.abortSignal,
          ...(this.deps.slotKey ? { slotKey: this.deps.slotKey } : {}),
        });
        this.recordCircuitSuccess();
        this.throwIfCancelled();
        content = res.content;
        toolCalls = res.toolCalls;
        reasoning = res.reasoning;
        logUsageAndCalibrate("default", res.usage, promptEstimateRaw, promptEstimateCalibrated);
      } catch (err) {
        if (this.deps.abortSignal?.aborted || isAbortLikeError(err)) {
          throw new RunCancelledError(abortReasonToText(this.deps.abortSignal?.reason) ?? "Run cancelled during LLM call");
        }
        this.recordCircuitFailure(err);
        const isTimeout = isLlmTimeoutError(err);
        const isTransient = isTransientLlmError(err);

        // Non-retryable errors: fail immediately
        if (!isTimeout && !isTransient) {
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

        let errMsg = err instanceof Error ? err.message : String(err);

        // Transient provider errors (429, 5xx, network): backoff + retry loop
        if (isTransient && !isTimeout) {
          const maxRetries = this.deps.transientRetries ?? 5;
          let retrySucceeded = false;
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const backoffMs = Math.min(3_000 * attempt, 15_000);
            this.deps.onLog?.(`llm_transient_error: ${truncate(errMsg, 200)} — retry ${attempt}/${maxRetries} after ${backoffMs}ms`);
            this.throwIfCancelled();
            await new Promise((r) => setTimeout(r, backoffMs));
            this.throwIfCancelled();
            const retryEstimateRaw = estimateTotalTokens(messages, currentTools);
            const retryEstimateCalibrated = Math.ceil(retryEstimateRaw * promptEstimateMultiplier);
            this.deps.onLog?.(
              `llm_call_retry iteration=${iteration} messages=${messages.length} mode=transient attempt=${attempt} ` +
              `est_prompt=${retryEstimateCalibrated} est_prompt_raw=${retryEstimateRaw} est_factor=${promptEstimateMultiplier.toFixed(2)}`,
            );
            try {
              const retry = await this.deps.llm.completeChat({
                messages,
                tools: currentTools,
                onTextDelta: this.deps.onTextDelta,
                abortSignal: this.deps.abortSignal,
                ...(this.deps.slotKey ? { slotKey: this.deps.slotKey } : {}),
              });
              this.recordCircuitSuccess();
              this.throwIfCancelled();
              content = retry.content;
              toolCalls = retry.toolCalls;
              reasoning = retry.reasoning;
              logUsageAndCalibrate("transient_retry", retry.usage, retryEstimateRaw, retryEstimateCalibrated);
              this.deps.onLog?.(`llm_transient_recovery: succeeded on attempt ${attempt}`);
              retrySucceeded = true;
              break;
            } catch (retryErr) {
              if (this.deps.abortSignal?.aborted || isAbortLikeError(retryErr)) {
                throw new RunCancelledError(abortReasonToText(this.deps.abortSignal?.reason) ?? "Run cancelled during LLM retry");
              }
              this.recordCircuitFailure(retryErr);
              errMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              if (attempt === maxRetries || !isTransientLlmError(retryErr)) {
                this.deps.onLog?.(`llm_error ${truncate(errMsg, 240)}`);
                const errorText = `LLM error: ${errMsg}`;
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
            }
          }
          if (!retrySucceeded) {
            const errorText = `LLM error: ${errMsg}`;
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
        } else {
          // Timeout: compact/trim context + retry with extended timeout
          this.deps.onLog?.("llm_timeout: attempting one recovery retry with compacted context and extended timeout");
          let retryMessages = messages;
          let compacted = false;

          if (maxContextTokens > 0) {
            try {
              const compactedResult = await compactContext({
                messages: [...messages],
                tools: currentTools,
                llm: this.deps.llm,
                maxContextTokens,
                mode: "hard",
                estimationFactor: promptEstimateMultiplier,
                minRecentMessages: 8,
                onLog: this.deps.onLog,
              });
              if (compactedResult.compacted) {
                retryMessages = compactedResult.messages;
                compacted = true;
                this.deps.onLog?.(
                  `llm_timeout_recovery: compacted ${compactedResult.tokensBefore} -> ${compactedResult.tokensAfter} tokens`,
                );
              }
            } catch (compErr) {
              this.deps.onLog?.(
                `llm_timeout_recovery: compaction failed (${compErr instanceof Error ? compErr.message : String(compErr)})`,
              );
            }
          }

          if (!compacted) {
            const trimmed = trimMessagesForTimeoutRetry(messages);
            if (trimmed.length !== messages.length) {
              retryMessages = trimmed;
              this.deps.onLog?.(
                `llm_timeout_recovery: trimmed history ${messages.length} -> ${retryMessages.length} messages`,
              );
            }
          }

          const elapsedMs = Math.max(0, this.deps.toolContext.nowMs() - runStartedAtMs);
          const retryInstruction: ChatMessage = {
            role: "system",
            content: [
              "Previous LLM request timed out. Continue from current context.",
              "Prioritize a concise, direct response or minimal tool calls needed to finish.",
              `Current time: ${new Date(this.deps.toolContext.nowMs()).toISOString()}.`,
              `Run elapsed: ${elapsedMs}ms.`,
            ].join("\n"),
          };

          const extendedEstimateRaw = estimateTotalTokens([...retryMessages, retryInstruction], currentTools);
          const extendedEstimateCalibrated = Math.ceil(extendedEstimateRaw * promptEstimateMultiplier);
          this.deps.onLog?.(
            `llm_call_retry iteration=${iteration} messages=${retryMessages.length + 1} mode=extended ` +
            `est_prompt=${extendedEstimateCalibrated} est_prompt_raw=${extendedEstimateRaw} est_factor=${promptEstimateMultiplier.toFixed(2)}`,
          );
          try {
            const retry = await this.deps.llm.completeChat({
              messages: [...retryMessages, retryInstruction],
              tools: currentTools,
              timeoutMode: "extended",
              abortSignal: this.deps.abortSignal,
              ...(this.deps.slotKey ? { slotKey: this.deps.slotKey } : {}),
            });
            this.recordCircuitSuccess();
            this.throwIfCancelled();
            content = retry.content;
            toolCalls = retry.toolCalls;
            reasoning = retry.reasoning;
            logUsageAndCalibrate("extended", retry.usage, extendedEstimateRaw, extendedEstimateCalibrated);
            this.deps.onLog?.("llm_timeout_recovery: retry succeeded");
          } catch (retryErr) {
            if (this.deps.abortSignal?.aborted || isAbortLikeError(retryErr)) {
              throw new RunCancelledError(abortReasonToText(this.deps.abortSignal?.reason) ?? "Run cancelled during LLM timeout recovery");
            }
            this.recordCircuitFailure(retryErr);
            const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
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
        }
      }

      if (toolCalls.length === 0) {
        const finalTextRaw = content ?? "";
        const finalText = finalTextRaw.trim();
        if (!finalText) {
          if (iteration + 1 < this.deps.budget.maxIterations) {
            this.deps.onLog?.("llm_empty_final_output: requesting one repair turn");
            messages.push({
              role: "system",
              content:
                "Previous assistant response was empty and had no tool calls. " +
                "Respond now with a short, non-empty user-facing message.",
            });
            continue;
          }
          const errorText = "ERROR: assistant returned an empty final response at iteration limit.";
          this.deps.onLog?.("llm_empty_final_output: failed at iteration limit");
          const msg: ChatMessage = { role: "assistant", content: errorText };
          messages.push(msg);
          newMessages.push(msg);
          return {
            status: "failed",
            output: errorText,
            newMessages,
            toolCallsUsed,
            iterationsUsed: iteration + 1,
          };
        }
        const msg: ChatMessage = {
          role: "assistant",
          content: finalTextRaw,
          ...(reasoning && reasoning.length > 0 ? { reasoning } : {}),
        };
        messages.push(msg);
        newMessages.push(msg);
        // Surface reasoning summary in the visible output so callers (scheduled
        // jobs, telegram) see the model's explanation, not just a terse line.
        const visibleOutput = composeOutputWithReasoning(finalTextRaw, reasoning);
        return {
          status: "complete",
          output: visibleOutput,
          newMessages,
          toolCallsUsed,
          iterationsUsed: iteration + 1,
        };
      }

      const toolCallingMsg: ChatMessage = {
        role: "assistant",
        content: content ?? null,
        toolCalls,
        ...(reasoning && reasoning.length > 0 ? { reasoning } : {}),
      };
      messages.push(toolCallingMsg);
      newMessages.push(toolCallingMsg);

      const handleToolResult = (
        call: import("./types.js").ToolCall,
        args: unknown,
        result: string,
        callIndex: number,
      ): AgentResult | null => {
        const classification = classifyToolResultStatus(call, result);
        const status = classification.status;
        const errorFirstLine = classification.errorSummary ?? result.split(/\r?\n/)[0] ?? "";
        const errorClass = classification.errorClass;
        const retryPolicy = classification.retryPolicy;
        const errPreview = status === "error" ? ` msg=${safeJson(truncate(errorFirstLine, 200))}` : "";
        const errMeta =
          status === "error" && errorClass
            ? ` class=${errorClass}${retryPolicy ? ` retry=${retryPolicy}` : ""}`
            : "";
        const okPreview = status === "ok" && result.length > 0 ? ` preview=${safeJson(truncate(result, 120))}` : "";
        this.deps.onLog?.(
          `tool_result name=${call.name} id=${call.id} status=${status}${errMeta} chars=${result.length}${errPreview}${okPreview}`,
        );

        const toolResultMsg: ChatMessage = {
          role: "tool",
          name: call.name,
          toolCallId: call.id,
          content: result,
        };
        if (status === "error" && errorClass) {
          const retryLine = retryPolicy ? ` retry=${retryPolicy}` : "";
          const guidanceLine = classification.retryGuidance ? ` ${classification.retryGuidance}` : "";
          toolResultMsg.content += `\n\n[ERROR_CLASS=${errorClass}${retryLine}]${guidanceLine}`;
        }
        const shellReadGuidance = maybeBuildShellReadGuidance({
          call,
          args,
          result,
          state: shellReadLoopState,
        });
        if (shellReadGuidance) {
          toolResultMsg.content += `\n\n${shellReadGuidance}`;
        }
        messages.push(toolResultMsg);
        newMessages.push(toolResultMsg);

        if (!result.trimStart().startsWith("ERROR:") && isPlainObject(args)) {
          if (call.name === "file_edit" || call.name === "file_edit_lines" || call.name === "file_write") {
            const rawPath = typeof args.path === "string" ? args.path.trim() : "";
            if (rawPath) touchedFilePaths.add(rawPath);
          }
          if (call.name === "shell_exec") {
            const command = typeof args.command === "string" ? args.command.trim() : "";
            if (isVerificationShellCommand(command, "typecheck")) typecheckOk = true;
            if (isVerificationShellCommand(command, "build")) buildOk = true;
          }
        }

        const sig = toolCallSignature(call);
        if (status === "error") {
          const next = (repeatedFailures.get(sig) ?? 0) + 1;
          repeatedFailures.set(sig, next);

          const retryBudget = allowedIdenticalRetries({
            call,
            args,
            errorClass,
            retryPolicy,
          });
          const maxFailuresBeforeBlock = retryBudget + 1;
          const retriesUsed = Math.max(0, next - 1);
          const retriesRemaining = Math.max(0, retryBudget - retriesUsed);

          if (next === 1) {
            if (retryBudget === 0) {
              toolResultMsg.content +=
                "\n\n[RETRY GUARD] This failure is non-retriable with identical arguments. " +
                "Do not repeat this exact call; inspect output and change approach.";
            } else {
              const backoff = retryPolicy === "after_backoff" ? " after backoff" : "";
              toolResultMsg.content +=
                `\n\n[RETRY GUARD] One identical retry is allowed${backoff}. ` +
                "If it fails again, this exact call will be blocked for the rest of this run.";
            }
          }

          if (next >= maxFailuresBeforeBlock) {
            const reason =
              retryBudget === 0
                ? `retry=no for ${errorClass ?? "unknown_error"}`
                : `retry budget exhausted for ${retryPolicy ?? "unknown"} (${errorClass ?? "unknown_error"})`;
            blockedToolCalls.set(sig, reason);
            toolResultMsg.content +=
              `\n\n[RETRY GUARD] Identical call is now blocked for this run (${reason}). ` +
              "Use different arguments or a different tool.";
          } else if (retriesRemaining === 1) {
            toolResultMsg.content += "\n\n[RETRY GUARD] You have one identical retry remaining for this call.";
          }

          // Escalating warnings before hard abort so the agent can self-correct.
          if (next >= 2 && next < maxSameToolFailures) {
            const severity = next === 2 ? "WARNING" : "CRITICAL WARNING";
            const remaining = maxSameToolFailures - next;
            const escalation =
              `\n\n--- ${severity} ---\n` +
              `Tool '${call.name}' has failed ${next} times with identical arguments. ` +
              `${remaining} more identical failure(s) will abort this run.\n` +
              `You MUST change your approach: use different arguments, a different tool, or diagnose the error first.\n` +
              "For periodic/scheduled tasks, prefer job_manage(action='create') over process_manage(action='start') with scripts.\n" +
              `---`;
            toolResultMsg.content += escalation;
          }

          if (next >= maxSameToolFailures) {
            const firstLine = truncate(result.split(/\r?\n/)[0] ?? "ERROR", 220);
            const abortText =
              `Aborting run: tool '${call.name}' failed ${next} times with the same arguments. ` +
              `Stop retrying and change approach (inspect logs/error output, adjust inputs, or use a different tool). ` +
              `Last error: ${firstLine}`;

            // Ensure every tool_call gets a tool response, even if we abort early.
            for (let j = callIndex + 1; j < toolCalls.length; j++) {
              const pending = toolCalls[j];
              const pendingMsg: ChatMessage = {
                role: "tool",
                name: pending.name,
                toolCallId: pending.id,
                content: `ERROR: aborted by runner due to repeated tool failures (${call.name})`,
              };
              messages.push(pendingMsg);
              newMessages.push(pendingMsg);
            }

            const assistantMsg: ChatMessage = { role: "assistant", content: abortText };
            messages.push(assistantMsg);
            newMessages.push(assistantMsg);
            return {
              status: "failed",
              output: abortText,
              newMessages,
              toolCallsUsed,
              iterationsUsed: iteration + 1,
            };
          }
        } else {
          // Any successful tool call resets ALL failure counters — the agent is
          // doing productive work between retries (e.g. rewriting a file before
          // re-running a command).  Budget caps still prevent infinite loops.
          repeatedFailures.clear();
          if (successfulToolCallClearsRetryGuards(call, args, result) && blockedToolCalls.size > 0) {
            blockedToolCalls.clear();
            this.deps.onLog?.(
              `retry_guard_reset name=${call.name} reason=successful_state_change_or_verification`,
            );
          }
        }

        // Inject low-budget warning when approaching limits.
        const iterPct = ((iteration + 1) / this.deps.budget.maxIterations) * 100;
        const toolPct = (toolCallsUsed / this.deps.budget.maxToolCalls) * 100;
        if (iterPct >= 80 || toolPct >= 80) {
          const iterRemain = this.deps.budget.maxIterations - iteration - 1;
          const toolRemain = this.deps.budget.maxToolCalls - toolCallsUsed;
          toolResultMsg.content +=
            `\n\n[BUDGET WARNING: ${iterRemain} iterations and ${toolRemain} tool calls remaining. ` +
            `Wrap up or summarize progress soon.]`;
        }

        // Hard workflow guard: once deploy is applied, stop this run immediately
        // (including worker runs). Any further runtime/schema checks in the same
        // process can observe stale state.
        const deployApplied = toolResultIndicatesDeployApplied(call, args, result);
        const shouldHandoff =
          call.name === "spawn_agent"
            ? deployApplied
            : call.name === "ha_deploy"
              ? deployApplied
              : false;

        if (shouldHandoff) {
          const outputLines: string[] = [];

          if (call.name === "spawn_agent") {
            const parsedSpawn = parseSpawnAgentResult(result);
            const workerOutputRaw = parsedSpawn?.output?.trim() ?? "";
            const workerOutput = stripLeadingDeployHandoff(workerOutputRaw);
            outputLines.push("Deploy applied by worker. Stopping this run to avoid post-deploy tool calls on a stale process image.");
            if (workerOutput) {
              outputLines.push("");
              outputLines.push("Worker summary:");
              outputLines.push(truncate(workerOutput, 4000));
            }
            outputLines.push("");
            outputLines.push(DEPLOY_HANDOFF_LINE_2);
          } else {
            // ha_deploy applied in this run.
            const paths = Array.from(touchedFilePaths).sort();
            const commitMessage =
              isPlainObject(args) && typeof args.commitMessage === "string" ? args.commitMessage.trim() : "";
            outputLines.push(DEPLOY_HANDOFF_LINE_1);
            outputLines.push("");
            outputLines.push("Summary (pre-deploy):");
            outputLines.push(`- Files modified (${paths.length}): ${summarizeItemsInline(paths)}`);
            outputLines.push(
              `- Validation: typecheck=${typecheckOk ? "OK" : "not run"}, build=${buildOk ? "OK" : "not run"}`,
            );
            outputLines.push(
              commitMessage
                ? `- Deploy: ha_deploy action=apply commitMessage="${truncate(commitMessage, 200)}"`
                : "- Deploy: ha_deploy action=apply",
            );
            outputLines.push("");
            outputLines.push(DEPLOY_HANDOFF_LINE_2);
          }

          const handoffText = outputLines.join("\n").trim();

          for (let j = callIndex + 1; j < toolCalls.length; j++) {
            const pending = toolCalls[j];
            const pendingMsg: ChatMessage = {
              role: "tool",
              name: pending.name,
              toolCallId: pending.id,
              content: "ERROR: deferred until a fresh post-deploy run",
            };
            messages.push(pendingMsg);
            newMessages.push(pendingMsg);
          }

          const assistantMsg: ChatMessage = { role: "assistant", content: handoffText };
          messages.push(assistantMsg);
          newMessages.push(assistantMsg);
          return {
            status: "complete",
            output: handoffText,
            newMessages,
            toolCallsUsed,
            iterationsUsed: iteration + 1,
          };
        }

        return null;
      };

      for (let i = 0; i < toolCalls.length; i++) {
        this.throwIfCancelled();
        const call = toolCalls[i];
        if (call.name === "spawn_agent") {
          let j = i;
          while (j < toolCalls.length && toolCalls[j]?.name === "spawn_agent") j += 1;
          const batch = toolCalls.slice(i, j);
          const remainingBudget = this.deps.budget.maxToolCalls - toolCallsUsed;
          if (remainingBudget < batch.length || !allowConcurrentSpawnBatches) {
            // Fall back to sequential handling.
          } else {
            const executions: {
              call: import("./types.js").ToolCall;
              args: unknown;
              promise: Promise<string>;
            }[] = [];

            for (const batchCall of batch) {
              const tool = this.deps.tools.find((t) => t.name === batchCall.name);
              if (!tool) {
                executions.push({
                  call: batchCall,
                  args: {},
                  promise: Promise.resolve(`ERROR: unknown tool '${batchCall.name}'`),
                });
                continue;
              }

              const parsedArgs = parseToolArgsForExecution(batchCall);
              if (!parsedArgs.ok) {
                this.deps.onLog?.(
                  `tool_call name=${batchCall.name} id=${batchCall.id} args=${safeJson(redactForLog(parsedArgs.argsForLog))} args_valid=false`,
                );
                executions.push({
                  call: batchCall,
                  args: {},
                  promise: Promise.resolve(parsedArgs.errorResult),
                });
                continue;
              }

              const args = parsedArgs.args;
              const callSig = toolCallSignature(batchCall);
              const blockedReason = blockedToolCalls.get(callSig);
              if (blockedReason) {
                const blockedResult =
                  `ERROR: blocked by retry policy for identical tool call. ${blockedReason} ` +
                  "Change arguments/approach before retrying.";
                this.deps.onLog?.(
                  `tool_call name=${batchCall.name} id=${batchCall.id} args=${safeJson(redactForLog(args))} blocked_by_retry_policy=true`,
                );
                executions.push({ call: batchCall, args, promise: Promise.resolve(blockedResult) });
                continue;
              }
              const cap = resolveToolCallCap(this.deps.toolCallCaps, batchCall.name);
              const usedForTool = toolCallsPerName.get(batchCall.name) ?? 0;
              if (cap !== null && usedForTool >= cap) {
                const capResult =
                  `ERROR: tool call cap reached for '${batchCall.name}' (${cap} per run). ` +
                  "Stop calling this tool in this run; synthesize/delegate with current evidence.";
                this.deps.onLog?.(
                  `tool_call name=${batchCall.name} id=${batchCall.id} args=${safeJson(redactForLog(args))} blocked_by_cap=${cap}`,
                );
                executions.push({ call: batchCall, args, promise: Promise.resolve(capResult) });
                continue;
              }
              toolCallsPerName.set(batchCall.name, usedForTool + 1);
              this.deps.onLog?.(`tool_call name=${batchCall.name} id=${batchCall.id} args=${safeJson(redactForLog(args))}`);
              this.deps.onToolStart?.(batchCall.name, toolCallPreview(batchCall.name, args));
              const promise = tool
                .execute(args, this.deps.toolContext)
                .catch((err) => `ERROR: ${err instanceof Error ? err.message : String(err)}`);
              executions.push({ call: batchCall, args, promise });
            }

            const results = await Promise.all(executions.map((e) => e.promise));
            this.throwIfCancelled();
            for (const entry of executions) {
              this.deps.onToolEnd?.(entry.call.name);
            }
            for (let idx = 0; idx < executions.length; idx++) {
              const entry = executions[idx];
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
              const result = results[idx] ?? "";
              const abort = handleToolResult(entry.call, entry.args, result, i + idx);
              if (abort) {
                return abort;
              }
            }

            i = j - 1;
            continue;
          }
        }

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

        const parsedArgs = parseToolArgsForExecution(call);
        if (!parsedArgs.ok) {
          this.deps.onLog?.(
            `tool_call name=${call.name} id=${call.id} args=${safeJson(redactForLog(parsedArgs.argsForLog))} args_valid=false`,
          );
          const abort = handleToolResult(call, {}, parsedArgs.errorResult, i);
          if (abort) {
            return abort;
          }
          continue;
        }

        const args = parsedArgs.args;
        const callSig = toolCallSignature(call);
        const blockedReason = blockedToolCalls.get(callSig);
        if (blockedReason) {
          const blockedResult =
            `ERROR: blocked by retry policy for identical tool call. ${blockedReason} ` +
            "Change arguments/approach before retrying.";
          this.deps.onLog?.(
            `tool_call name=${call.name} id=${call.id} args=${safeJson(redactForLog(args))} blocked_by_retry_policy=true`,
          );
          const abort = handleToolResult(call, args, blockedResult, i);
          if (abort) {
            return abort;
          }
          continue;
        }
        const cap = resolveToolCallCap(this.deps.toolCallCaps, call.name);
        const usedForTool = toolCallsPerName.get(call.name) ?? 0;
        if (cap !== null && usedForTool >= cap) {
          const capResult =
            `ERROR: tool call cap reached for '${call.name}' (${cap} per run). ` +
            "Stop calling this tool in this run; synthesize/delegate with current evidence.";
          this.deps.onLog?.(
            `tool_call name=${call.name} id=${call.id} args=${safeJson(redactForLog(args))} blocked_by_cap=${cap}`,
          );
          const abort = handleToolResult(call, args, capResult, i);
          if (abort) {
            return abort;
          }
          continue;
        }
        toolCallsPerName.set(call.name, usedForTool + 1);
        this.deps.onLog?.(`tool_call name=${call.name} id=${call.id} args=${safeJson(redactForLog(args))}`);
        this.deps.onToolStart?.(call.name, toolCallPreview(call.name, args));
        let result: string;
        try {
          const hasNodeRoutingContext =
            this.deps.toolContext.executionNode !== undefined ||
            this.deps.toolContext.executionMode === "remote" ||
            this.deps.toolContext.executionMode === "auto";
          const wantsNodeRouting = hasNodeRoutingContext && tool.nodeRoutable === true;
          this.throwIfCancelled();
          if (wantsNodeRouting && this.deps.toolContext.nodeRouter) {
            result = await this.deps.toolContext.nodeRouter.routeToolExecution(
              tool,
              args,
              this.deps.toolContext,
            );
          } else {
            result = await tool.execute(args, this.deps.toolContext);
          }
          this.throwIfCancelled();
        } catch (err) {
          if (this.deps.abortSignal?.aborted) {
            throw new RunCancelledError(abortReasonToText(this.deps.abortSignal?.reason) ?? "Run cancelled during tool execution");
          }
          const msg = err instanceof Error ? err.message : String(err);
          const code =
            err &&
              typeof err === "object" &&
              "code" in err &&
              typeof (err as { code?: unknown }).code === "string"
              ? (err as { code: string }).code
              : null;
          if (isAbortLikeError(err)) {
            const normalized = msg.trim() ? `tool request timed out or aborted: ${msg}` : "tool request timed out or aborted";
            result = code ? `ERROR: [${code}] ${normalized}` : `ERROR: ${normalized}`;
          } else {
            result = code ? `ERROR: [${code}] ${msg}` : `ERROR: ${msg}`;
          }
        }
        this.deps.onToolEnd?.(call.name);

        const abort = handleToolResult(call, args, result, i);
        if (abort) {
          return abort;
        }
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

function resolveToolCallCap(toolCallCaps: Record<string, number> | undefined, toolName: string): number | null {
  if (!toolCallCaps) return null;
  const raw = toolCallCaps[toolName];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const cap = Math.floor(raw);
  if (cap < 1) return null;
  return cap;
}
