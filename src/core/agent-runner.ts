import type { Tool, ToolContext } from "./tools.js";
import type { ChatMessage, ChatUserContent } from "./types.js";
import { OpenAICompatClient, type LLMClient, type LLMUsage } from "../llm/openai-compat.js";
import { createHash } from "node:crypto";
import { estimateTotalTokens, compactContext, storeCompactionSummary } from "./context-compactor.js";
import type { NexusDatabase } from "../storage/database.js";
import type { ToolCall } from "./types.js";

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

function isLlmTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /LLM request timed out/i.test(err.message);
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
    has("timed out", "timeout", "service unavailable", "connection reset", "temporarily unavailable") ||
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

function allowedIdenticalRetries(retryPolicy?: ToolRetryPolicy): number {
  if (retryPolicy === "yes" || retryPolicy === "after_backoff") return 1;
  return 0;
}

export function toolResultIndicatesDeployApplied(call: ToolCall, args: unknown, result: string): boolean {
  if (result.trimStart().startsWith("ERROR:")) return false;

  if (call.name === "ha_deploy") {
    const action = args && typeof args === "object" ? (args as Record<string, unknown>).action : undefined;
    return action === "apply";
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

export class AgentRunner {
  constructor(
    private readonly deps: {
      llm: LLMClient;
      tools: Tool[];
      toolCallCaps?: Record<string, number>;
      budget: AgentBudget;
      toolContext: ToolContext;
      onLog?: (line: string) => void;
    },
  ) {}

  async run(params: { systemPrompt: string; history: ChatMessage[]; userMessage: ChatUserContent }): Promise<AgentResult> {
    const baseMessages: ChatMessage[] = [{ role: "system", content: params.systemPrompt }, ...params.history];
    const newMessages: ChatMessage[] = [{ role: "user", content: params.userMessage }];
    const messages: ChatMessage[] = [...baseMessages, ...newMessages];

    let toolCallsUsed = 0;
    const toolCallsPerName = new Map<string, number>();
    const repeatedFailures = new Map<string, number>();
    const blockedToolCalls = new Map<string, string>();
    const maxSameToolFailures = 4;

    const maxContextTokens = this.deps.budget.maxContextTokens ?? 0;
    const runStartedAtMs = this.deps.toolContext.nowMs();

    for (let iteration = 0; iteration < this.deps.budget.maxIterations; iteration++) {
      // ── Context compaction ─────────────────────────────────────────────
      if (maxContextTokens > 0) {
        const estimated = estimateTotalTokens(messages, this.deps.tools);
        // Compact when we exceed 85% of the limit
        if (estimated > maxContextTokens * 0.85) {
          this.deps.onLog?.(`compaction: estimated ${estimated} tokens (limit ${maxContextTokens}), compacting`);
          try {
            const result = await compactContext({
              messages,
              tools: this.deps.tools,
              llm: this.deps.llm,
              maxContextTokens,
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
                  storeCompactionSummary({
                    db,
                    agentId,
                    sessionId,
                    summary: result.summary,
                    nowMs: this.deps.toolContext.nowMs(),
                  });
                }
              }
            }
          } catch (compErr) {
            this.deps.onLog?.(`compaction: failed (${compErr instanceof Error ? compErr.message : String(compErr)}), proceeding without`);
          }
        }
      }

      let content: string | null;
      let toolCalls: import("./types.js").ToolCall[];
      try {
        const res = await this.deps.llm.completeChat({
          messages,
          tools: this.deps.tools,
        });
        content = res.content;
        toolCalls = res.toolCalls;
        const usageLine = formatLlmUsage(res.usage);
        if (usageLine) this.deps.onLog?.(`llm_usage mode=default ${usageLine}`);
      } catch (err) {
        const isTimeout = isLlmTimeoutError(err);
        if (!isTimeout) {
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

        this.deps.onLog?.("llm_timeout: attempting one recovery retry with compacted context and extended timeout");
        let retryMessages = messages;
        let compacted = false;

        if (maxContextTokens > 0) {
          try {
            const compactedResult = await compactContext({
              messages: [...messages],
              tools: this.deps.tools,
              llm: this.deps.llm,
              maxContextTokens,
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

        try {
          const retry = await this.deps.llm.completeChat({
            messages: [...retryMessages, retryInstruction],
            tools: this.deps.tools,
            timeoutMode: "extended",
          });
          content = retry.content;
          toolCalls = retry.toolCalls;
          const usageLine = formatLlmUsage(retry.usage);
          if (usageLine) this.deps.onLog?.(`llm_usage mode=extended ${usageLine}`);
          this.deps.onLog?.("llm_timeout_recovery: retry succeeded");
        } catch (retryErr) {
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
        this.deps.onLog?.(
          `tool_result name=${call.name} id=${call.id} status=${status}${errMeta} chars=${result.length}${errPreview}`,
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
        messages.push(toolResultMsg);
        newMessages.push(toolResultMsg);

        const sig = toolCallSignature(call);
        if (status === "error") {
          const next = (repeatedFailures.get(sig) ?? 0) + 1;
          repeatedFailures.set(sig, next);

          const retryBudget = allowedIdenticalRetries(retryPolicy);
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
              `For periodic/scheduled tasks, prefer job_create over process_start with scripts.\n` +
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
          const parsedSpawn = call.name === "spawn_agent" ? parseSpawnAgentResult(result) : null;
          const workerLine = parsedSpawn?.output?.trim()?.split(/\r?\n/)[0] ?? "";
          const outputLines = [
            "Deploy applied. Stopping this run to avoid post-deploy tool calls on a stale process image.",
            "Start a fresh follow-up request for runtime/schema validation or post-deploy actions.",
          ];
          if (workerLine) {
            outputLines.push(`Latest worker output: ${truncate(workerLine, 220)}`);
          }
          const handoffText = outputLines.join("\n");

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
        const call = toolCalls[i];
        if (call.name === "spawn_agent") {
          let j = i;
          while (j < toolCalls.length && toolCalls[j]?.name === "spawn_agent") j += 1;
          const batch = toolCalls.slice(i, j);
          const remainingBudget = this.deps.budget.maxToolCalls - toolCallsUsed;
          if (remainingBudget < batch.length) {
            // Not enough budget to run a full batch concurrently; fall back to sequential handling.
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
              const promise = tool
                .execute(args, this.deps.toolContext)
                .catch((err) => `ERROR: ${err instanceof Error ? err.message : String(err)}`);
              executions.push({ call: batchCall, args, promise });
            }

            const results = await Promise.all(executions.map((e) => e.promise));
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
        let result: string;
        try {
          result = await tool.execute(args, this.deps.toolContext);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result = `ERROR: ${msg}`;
        }

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
