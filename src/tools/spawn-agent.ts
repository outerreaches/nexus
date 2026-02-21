import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { defineTool, type Tool, type ToolContext } from "../core/tools.js";
import { AgentRunner } from "../core/agent-runner.js";
import { getPreset, getPresetNames, type AgentPreset } from "../core/presets.js";
import { buildPresetSystemPrompt } from "../core/prompt.js";
import type { AgentTracker } from "../core/agent-tracker.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import type { ChatMessage } from "../core/types.js";
import type { NexusDatabase } from "../storage/database.js";
import type { ParentMessage, WorkerMessage, WorkerConfig } from "../core/isolated-worker-types.js";
import { getResolvedSecretsSnapshot } from "../secrets/resolve-env.js";
import type { ModelRoutingMode } from "../llm/model-router.js";
import { bindMcpGrantToRun } from "../mcp/store.js";
import type { McpManager } from "../mcp/manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveIsolatedWorkerPath(): string {
  const candidates = [
    path.resolve(__dirname, "../core/isolated-worker.js"),
    path.resolve(__dirname, "../core/isolated-worker.ts"),
    path.resolve(process.cwd(), "dist/core/isolated-worker.js"),
    path.resolve(process.cwd(), "src/core/isolated-worker.ts"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`isolated worker entry not found (tried: ${candidates.join(", ")})`);
}

export const spawnAgent = defineTool({
  name: "spawn_agent",
  description:
    "Spawn a worker agent with a specialized preset to handle a sub-task. " +
    "The worker runs with a scoped set of tools and its own LLM context. " +
    "Available presets: " + getPresetNames().filter(n => n !== "orchestrator").join(", ") + ". " +
    "Use this to delegate coding, research, trading, or analysis tasks to specialists. " +
    "The worker's output is returned to you and also written to the Blackboard. " +
    "Note: spawning is depth-limited to prevent infinite delegation.",
  parameters: z.object({
    preset: z
      .string()
      .min(1)
      .describe("Worker preset name (see available presets list in this tool description)"),
    task: z
      .string()
      .min(1)
      .max(8000)
      .describe("Detailed task description for the worker"),
    context: z
      .array(z.string())
      .max(10)
      .default([])
      .describe("Blackboard entry IDs to inject as context for the worker"),
    budget: z
      .object({
        maxToolCalls: z.number().int().min(1).max(200).optional(),
        maxIterations: z.number().int().min(1).max(80).optional(),
      })
      .optional()
      .describe("Override preset budget limits"),
    parentRunId: z.string().min(1).optional().describe("Optional parent run id for hierarchical agent graphs"),
    modelMode: z
      .enum(["default", "local_only"])
      .optional()
      .describe("Optional model routing mode for this worker (`local_only` forces local provider routing)"),
    mcpGrantIds: z
      .array(z.string().min(1))
      .max(20)
      .default([])
      .describe("Internal: run-scoped MCP grant IDs to inject for this worker."),
  }),
  execute: async (args, ctx) => {
    const spawnStartedAtMs = ctx.nowMs();

    // Resolve preset
    const preset = getPreset(args.preset);
    if (!preset) {
      const available = getPresetNames().filter(n => n !== "orchestrator").join(", ");
      return `ERROR: unknown preset "${args.preset}". Available: ${available}`;
    }
    if (args.preset === "orchestrator") {
      return "ERROR: cannot spawn another orchestrator";
    }

    const parentPresetName = ctx.request?.preset;
    const parentPreset = parentPresetName ? getPreset(parentPresetName) : undefined;
    const spawnAllowlist = parentPreset?.spawnAllowlist;
    if (Array.isArray(spawnAllowlist) && spawnAllowlist.length > 0 && !spawnAllowlist.includes(args.preset)) {
      return `ERROR: preset "${parentPresetName}" cannot spawn "${args.preset}". Allowed: ${spawnAllowlist.join(", ")}`;
    }

    const workerModelMode: ModelRoutingMode = args.modelMode ?? ctx.request?.modelMode ?? ctx.modelMode ?? "default";

    // Get dependencies from context
    const registry = ctx.registry as ToolRegistry | undefined;
    if (!registry) return "ERROR: tool registry not available";

    const db = ctx.db as NexusDatabase | undefined;

    // Load blackboard context if entry IDs provided
    let contextText = "";
    if (args.context.length > 0 && db) {
      const placeholders = args.context.map(() => "?").join(", ");
      const rows = db.db
        .prepare(`SELECT id, type, title, content, attachments_json FROM blackboard WHERE id IN (${placeholders})`)
        .all(...args.context) as { id: string; type: string; title: string; content: string; attachments_json: string }[];

      if (rows.length > 0) {
        contextText = "\n\n## Blackboard Context\n\n" +
          rows.map((r) => {
            let entry = `### [${r.type}] ${r.title}\n${r.content}`;
            const attachments = safeJsonParse(r.attachments_json);
            if (Array.isArray(attachments) && attachments.length > 0) {
              entry += "\n\nAttachments:\n" +
                attachments.map((a: { path: string; mimeType?: string }) =>
                  `- ${a.path}${a.mimeType ? ` (${a.mimeType})` : ""}`
                ).join("\n");
            }
            return entry;
          }).join("\n\n");
      }
    }

    const maxDepth = envInt("NEXUS_MAX_AGENT_DEPTH") ?? 4;

    // Resolve budget (global runtime limits are hard caps; preset and override can only tighten).
    const runtimeLimits = resolveRuntimeLimits(ctx);
    const presetMaxToolCalls = clampPositiveInt(preset.budget?.maxToolCalls ?? runtimeLimits.maxToolCalls, runtimeLimits.maxToolCalls);
    const presetMaxIterations = clampPositiveInt(preset.budget?.maxIterations ?? runtimeLimits.maxIterations, runtimeLimits.maxIterations);
    const requestedMaxToolCalls = args.budget?.maxToolCalls;
    const requestedMaxIterations = args.budget?.maxIterations;
    const minOverrideRatio = resolveMinOverrideBudgetRatio();
    const minOverrideToolCalls = Math.max(1, Math.ceil(presetMaxToolCalls * minOverrideRatio));
    const minOverrideIterations = Math.max(1, Math.ceil(presetMaxIterations * minOverrideRatio));
    const adjustedRequestedMaxToolCalls =
      requestedMaxToolCalls === undefined ? undefined : Math.max(requestedMaxToolCalls, minOverrideToolCalls);
    const adjustedRequestedMaxIterations =
      requestedMaxIterations === undefined ? undefined : Math.max(requestedMaxIterations, minOverrideIterations);
    const budget = {
      maxToolCalls:
        adjustedRequestedMaxToolCalls === undefined
          ? Math.min(runtimeLimits.maxToolCalls, presetMaxToolCalls)
          : Math.min(runtimeLimits.maxToolCalls, presetMaxToolCalls, clampPositiveInt(adjustedRequestedMaxToolCalls, presetMaxToolCalls)),
      maxIterations:
        adjustedRequestedMaxIterations === undefined
          ? Math.min(runtimeLimits.maxIterations, presetMaxIterations)
          : Math.min(runtimeLimits.maxIterations, presetMaxIterations, clampPositiveInt(adjustedRequestedMaxIterations, presetMaxIterations)),
      maxContextTokens: runtimeLimits.maxContextTokens,
    };
    if (requestedMaxToolCalls !== undefined && budget.maxToolCalls < requestedMaxToolCalls) {
      ctx.log(
        `spawn_agent: clamped maxToolCalls ${requestedMaxToolCalls} -> ${budget.maxToolCalls} ` +
        `(global=${runtimeLimits.maxToolCalls}, preset=${presetMaxToolCalls})`,
      );
    }
    if (requestedMaxIterations !== undefined && budget.maxIterations < requestedMaxIterations) {
      ctx.log(
        `spawn_agent: clamped maxIterations ${requestedMaxIterations} -> ${budget.maxIterations} ` +
        `(global=${runtimeLimits.maxIterations}, preset=${presetMaxIterations})`,
      );
    }
    if (requestedMaxToolCalls !== undefined && adjustedRequestedMaxToolCalls !== undefined && adjustedRequestedMaxToolCalls > requestedMaxToolCalls) {
      ctx.log(
        `spawn_agent: raised low maxToolCalls ${requestedMaxToolCalls} -> ${adjustedRequestedMaxToolCalls} ` +
        `(min_ratio=${minOverrideRatio.toFixed(2)}, preset=${presetMaxToolCalls})`,
      );
    }
    if (requestedMaxIterations !== undefined && adjustedRequestedMaxIterations !== undefined && adjustedRequestedMaxIterations > requestedMaxIterations) {
      ctx.log(
        `spawn_agent: raised low maxIterations ${requestedMaxIterations} -> ${adjustedRequestedMaxIterations} ` +
        `(min_ratio=${minOverrideRatio.toFixed(2)}, preset=${presetMaxIterations})`,
      );
    }

    const tracker = ctx.agentTracker as AgentTracker | undefined;
    const parent = ctx.request;
    const effectiveParentRunId = args.parentRunId ?? parent?.runId ?? null;
    let parentDepth = 0;
    if (maxDepth >= 0 && effectiveParentRunId && db) {
      parentDepth = computeRunDepth(db, effectiveParentRunId);
      if (parentDepth + 1 > maxDepth) {
        return `ERROR: max agent depth exceeded (depth=${parentDepth + 1}, max=${maxDepth}).`;
      }
      const parentTask = getParentTask(db, effectiveParentRunId);
      if (parentTask && normalizeTask(parentTask) === normalizeTask(args.task)) {
        return "ERROR: refusing to spawn a sub-agent with the same task as the parent.";
      }
    }
    const workerDepth = parentDepth + 1;
    const isMaxDepth = maxDepth >= 0 && workerDepth >= maxDepth;

    const { title: blackboardTitle, cleanedTask } = parseBlackboardTitle(args.task, preset.name);

    // Build worker system prompt
    const basePrompt = await buildPresetSystemPrompt({
      stateDir: ctx.stateDir,
      promptFiles: preset.promptFiles,
      systemPrompt: preset.systemPrompt ?? `You are a ${preset.name} agent.`,
      includePresets: true,
    });
    const systemPrompt = [
      basePrompt,
      contextText,
      "",
      "## Instructions",
      "For time-sensitive queries, include explicit years/dates in searches. For historical topics, use the relevant time period.",
      "",
      "**File system roots:**",
      `- workspace: ${ctx.workspaceDir} (use absolute paths for file tools)`,
      `- state: ${ctx.stateDir} (config files, HEARTBEAT.md, etc.; use absolute paths)`,
      `- code: ${ctx.codeDir} (source code, if enabled; use absolute paths)`,
      "",
      "We have a large list of verified data sources available via data intake tools. Use them when possible.",
      `Blackboard title: ${blackboardTitle}`,
      "When writing your primary result to the blackboard, use the exact Blackboard title above.",
      "Complete the task below. When done, write your results to the blackboard using `write_to_blackboard`.",
      "For binary outputs (files, images), write them to disk and reference paths in blackboard attachments.",
      "Before first tool use, infer what has already been checked from task/context and avoid repeating the same URLs/queries/commands.",
      "If a repeat check is necessary for verification, do it once and state why it is needed.",
      "When spawning sub-agents, assign disjoint scopes and include explicit `Scope:` and `Do NOT repeat:` sections in each child task.",
      isMaxDepth
        ? "You are at the maximum delegation depth. Do NOT spawn sub-agents. Complete the task yourself as-is."
        : `You may spawn sub-agents only when necessary. Maximum delegation depth is ${maxDepth}. Do not recursively delegate beyond that.`,
      "Do not delegate the exact same task text to another agent. If you spawn workers, break the task into distinct subtopics.",
    ].join("\n");

    // Start run tracking BEFORE execution (so DB row exists for isolated workers)
    const agentId = parent?.agentId ? `${parent.agentId}:${preset.name}` : `worker:${preset.name}`;
    const runId = tracker?.startRun({
      parentRunId: effectiveParentRunId,
      agentId,
      preset: preset.name,
      channel: parent?.channel ?? "worker",
      channelKey: parent?.channelKey ?? "worker",
      sessionId: parent?.sessionId ?? "unknown",
      task: args.task,
    });

    const mcpGrantIds = Array.from(new Set((args.mcpGrantIds ?? []).map((id) => id.trim()).filter(Boolean)));
    if (mcpGrantIds.length > 0 && runId && db) {
      for (const grantId of mcpGrantIds) {
        bindMcpGrantToRun(db, grantId, { runId, parentRunId: effectiveParentRunId }, ctx.nowMs());
      }
    }
    const grantedTools = resolveMcpGrantTools({
      ctx,
      presetName: preset.name,
      runId: runId ?? null,
      grantIds: mcpGrantIds,
    });
    const baseTools = filterToolsForPreset(registry.list(), preset, isMaxDepth);
    const workerTools = mergeToolsByName(baseTools, grantedTools);

    // Branch: isolated process vs in-process
    let workerResult: string;
    if (preset.isolated) {
      workerResult = await runIsolated({
        ctx,
        preset,
        systemPrompt,
        task: cleanedTask,
        budget,
        runId: runId ?? null,
        effectiveParentRunId,
        agentId,
        workerDepth,
        maxDepth,
        modelMode: workerModelMode,
        tracker,
        blackboardTitle,
        mcpGrantIds,
      });
    } else {
      workerResult = await runInProcess({
        ctx,
        preset,
        systemPrompt,
        task: cleanedTask,
        budget,
        runId: runId ?? null,
        parentRunId: effectiveParentRunId,
        agentId,
        modelMode: workerModelMode,
        workerTools,
        tracker,
        blackboardTitle,
      });
    }

    return attachBlackboardReference(ctx, workerResult, blackboardTitle, spawnStartedAtMs);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// In-process execution (existing behavior)
// ─────────────────────────────────────────────────────────────────────────────

async function runInProcess(params: {
  ctx: ToolContext;
  preset: AgentPreset;
  systemPrompt: string;
  task: string;
  budget: { maxToolCalls: number; maxIterations: number; maxContextTokens: number };
  runId: string | null;
  parentRunId: string | null;
  agentId: string;
  modelMode: ModelRoutingMode;
  workerTools: ReturnType<ToolRegistry["list"]>;
  tracker: AgentTracker | undefined;
  blackboardTitle: string;
}): Promise<string> {
  const { ctx, preset, systemPrompt, task, budget, runId, parentRunId, agentId, modelMode, workerTools, tracker, blackboardTitle } = params;
  const log = ctx.log;
  const onLog = log
    ? (line: string) => log(`worker[${preset.name}] ${line}`)
    : undefined;

  let llm = ctx.llm;
  let llmConfig = ctx.llmConfig;
  if (ctx.modelRouter) {
    const route = ctx.modelRouter.resolve({
      agentId,
      preset: preset.name,
      mode: modelMode,
      presetLlm: preset.llm,
    });
    llm = ctx.modelRouter.createClient(route, { onLog });
    llmConfig = route.primary;
    onLog?.(
      `llm_route mode=${route.mode} source=${route.source} primary=${route.primaryProvider}/${route.primary.model}`,
    );
  }
  if (!llm) {
    return "ERROR: LLM client not available for worker agent";
  }

  // Create worker ToolContext (inherit from orchestrator but with worker identity)
  const workerCtx: ToolContext = {
    ...ctx,
    llm,
    llmConfig,
    modelMode,
    request: ctx.request
      ? {
        ...ctx.request,
        agentId: `${ctx.request.agentId}:${preset.name}`,
        preset: preset.name,
        runId: runId ?? undefined,
        parentRunId: parentRunId ?? undefined,
        modelMode,
      }
      : undefined,
  };

  // Create and run worker
  const runner = new AgentRunner({
    llm,
    tools: workerTools,
    toolCallCaps: preset.toolCallCaps,
    budget,
    toolContext: workerCtx,
    onLog,
  });

  try {
    const result = await runner.run({
      systemPrompt,
      history: [],
      userMessage: task,
    });

    if (runId && tracker) {
      const preview = result.output.trim().slice(0, 240);
      tracker.completeRun(runId, {
        status: result.status,
        toolCallsUsed: result.toolCallsUsed,
        iterationsUsed: result.iterationsUsed,
        outputPreview: preview,
        endedAt: ctx.nowMs(),
      });
    }

    // Return structured result to orchestrator
    const returnValue: Record<string, unknown> = {
      status: result.status,
      output: result.output,
      toolCallsUsed: result.toolCallsUsed,
      iterationsUsed: result.iterationsUsed,
      deployApplied: didRunApplyDeploy(result.newMessages),
      blackboardTitle,
    };
    return JSON.stringify(returnValue, null, 2);
  } catch (e) {
    if (runId && tracker) {
      tracker.completeRun(runId, {
        status: "failed",
        outputPreview: `ERROR: ${e instanceof Error ? e.message : String(e)}`,
        endedAt: ctx.nowMs(),
      });
    }
    return `ERROR: worker agent failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Isolated process execution (fork child process)
// ─────────────────────────────────────────────────────────────────────────────

async function runIsolated(params: {
  ctx: ToolContext;
  preset: AgentPreset;
  systemPrompt: string;
  task: string;
  budget: { maxToolCalls: number; maxIterations: number; maxContextTokens: number };
  runId: string | null;
  effectiveParentRunId: string | null;
  agentId: string;
  workerDepth: number;
  maxDepth: number;
  modelMode: ModelRoutingMode;
  tracker: AgentTracker | undefined;
  blackboardTitle: string;
  mcpGrantIds: string[];
}): Promise<string> {
  const {
    ctx,
    preset,
    systemPrompt,
    task,
    budget,
    runId,
    effectiveParentRunId,
    agentId,
    workerDepth,
    maxDepth,
    modelMode,
    tracker,
    blackboardTitle,
    mcpGrantIds,
  } = params;

  const log = ctx.log;
  const logWorker = (line: string) => log?.(`worker[${preset.name}] ${line}`);
  const runtimeLimits = resolveRuntimeLimits(ctx);
  const modelRouterConfig = ctx.modelRouter?.exportConfig();

  let llmConfig = ctx.llmConfig;
  if (ctx.modelRouter) {
    const route = ctx.modelRouter.resolve({
      agentId,
      preset: preset.name,
      mode: modelMode,
      presetLlm: preset.llm,
    });
    llmConfig = route.primary;
    logWorker(
      `llm_route mode=${route.mode} source=${route.source} primary=${route.primaryProvider}/${route.primary.model}`,
    );
  }
  if (!llmConfig) {
    return "ERROR: llmConfig not available on context (required for isolated workers)";
  }

  // Calculate timeout: maxIterations * 60s, capped at NEXUS_WORKER_TIMEOUT_MS or 30 min
  const defaultTimeoutMs = 30 * 60 * 1000; // 30 minutes
  const maxTimeoutMs = envInt("NEXUS_WORKER_TIMEOUT_MS") ?? defaultTimeoutMs;
  const timeoutMs = Math.min(budget.maxIterations * 60_000, maxTimeoutMs);
  let workerPath: string;
  try {
    workerPath = resolveIsolatedWorkerPath();
  } catch (err) {
    return JSON.stringify({
      status: "failed",
      output: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      toolCallsUsed: 0,
      iterationsUsed: 0,
      deployApplied: false,
    }, null, 2);
  }

  return new Promise<string>((resolve) => {
    const child: ChildProcess = fork(workerPath, [], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: process.env, // inherit env vars (API keys, etc.)
    });

    // Track active worker for shutdown cleanup
    ctx.isolatedWorkers?.add(child);

    let resolved = false;
    const finish = (resultJson: string) => {
      if (resolved) return;
      resolved = true;
      ctx.isolatedWorkers?.delete(child);
      resolve(attachBlackboardTitle(resultJson, blackboardTitle));
    };

    // Timeout handler
    const timer = setTimeout(() => {
      logWorker(`timeout after ${timeoutMs}ms, killing`);
      child.kill("SIGKILL");
      if (runId && tracker) {
        tracker.completeRun(runId, {
          status: "failed",
          outputPreview: "ERROR: worker timed out",
          endedAt: ctx.nowMs(),
        });
      }
      finish(JSON.stringify({
        status: "failed",
        output: "ERROR: worker process timed out",
        toolCallsUsed: 0,
        iterationsUsed: 0,
        deployApplied: false,
      }, null, 2));
    }, timeoutMs);

    // Handle IPC messages from worker
    child.on("message", (msg: WorkerMessage) => {
      if (msg.type === "log") {
        logWorker(msg.line);
      } else if (msg.type === "result") {
        clearTimeout(timer);
        if (runId && tracker) {
          const preview = msg.result.output?.trim?.().slice(0, 240) ?? "";
          tracker.completeRun(runId, {
            status: msg.result.status,
            toolCallsUsed: msg.result.toolCallsUsed,
            iterationsUsed: msg.result.iterationsUsed,
            outputPreview: preview,
            endedAt: ctx.nowMs(),
          });
        }
        finish(JSON.stringify(msg.result, null, 2));
      } else if (msg.type === "error") {
        clearTimeout(timer);
        if (runId && tracker) {
          tracker.completeRun(runId, {
            status: "failed",
            outputPreview: `ERROR: ${msg.error}`,
            endedAt: ctx.nowMs(),
          });
        }
        finish(JSON.stringify({
          status: "failed",
          output: `ERROR: worker process failed: ${msg.error}`,
          toolCallsUsed: 0,
          iterationsUsed: 0,
          deployApplied: false,
        }, null, 2));
      }
    });

    // Handle crash (exit without sending result)
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      ctx.isolatedWorkers?.delete(child);
      if (!resolved) {
        const reason = signal ? `killed by ${signal}` : `exited with code ${code}`;
        logWorker(`crashed: ${reason}`);
        if (runId && tracker) {
          tracker.completeRun(runId, {
            status: "failed",
            outputPreview: `ERROR: worker ${reason}`,
            endedAt: ctx.nowMs(),
          });
        }
        finish(JSON.stringify({
          status: "failed",
          output: `ERROR: worker process ${reason}`,
          toolCallsUsed: 0,
          iterationsUsed: 0,
          deployApplied: false,
        }, null, 2));
      }
    });

    // Forward stderr to parent log
    child.stderr?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString("utf8").trim().split("\n");
      for (const line of lines) {
        logWorker(`[stderr] ${line}`);
      }
    });

    // Build and send the task config
    const config: WorkerConfig = {
      stateDir: ctx.stateDir,
      workspaceDir: ctx.workspaceDir,
      codeDir: ctx.codeDir,
      dbPath: path.join(ctx.stateDir, "nexus.db"),
      llmConfig,
      modelRouterConfig,
      allowShellExec: ctx.allowShellExec ?? false,
      allowCodeEdit: ctx.allowCodeEdit ?? false,
      allowCodeWrite: ctx.allowCodeWrite ?? false,
      presetName: preset.name,
      systemPrompt,
      userMessage: task,
      budget,
      runtimeLimits,
      parentRunId: effectiveParentRunId,
      runId,
      agentId,
      sessionId: ctx.request?.sessionId ?? "unknown",
      channel: ctx.request?.channel ?? "worker",
      channelKey: ctx.request?.channelKey ?? "worker",
      modelMode,
      currentDepth: workerDepth,
      maxDepth,
      mcpGrantIds,
      resolvedSecrets: getResolvedSecretsSnapshot(),
    };

    const taskMsg: ParentMessage = { type: "task", config };
    child.send(taskMsg);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function resolveMcpGrantTools(params: {
  ctx: ToolContext;
  presetName: string;
  runId: string | null;
  grantIds: string[];
}): Tool[] {
  if (params.grantIds.length === 0) return [];
  const manager = params.ctx.mcp as McpManager | undefined;
  if (!manager) {
    params.ctx.log(`spawn_agent: mcp grants requested for preset=${params.presetName} but mcp manager unavailable`);
    return [];
  }
  return manager.listToolsForGrants({
    grantIds: params.grantIds,
    presetName: params.presetName,
    runId: params.runId,
  });
}

function mergeToolsByName(base: Tool[], extras: Tool[]): Tool[] {
  if (extras.length === 0) return base;
  const byName = new Map<string, Tool>();
  for (const tool of base) byName.set(tool.name, tool);
  for (const tool of extras) byName.set(tool.name, tool);
  return [...byName.values()];
}

function filterToolsForPreset(
  allTools: ReturnType<ToolRegistry["list"]>,
  preset: AgentPreset,
  isMaxDepth: boolean,
): ReturnType<ToolRegistry["list"]> {
  const allowedNames = new Set(preset.tools);
  if (isMaxDepth) {
    allowedNames.delete("spawn_agent");
  }
  return allTools.filter((t) => allowedNames.has(t.name));
}

function envInt(name: string): number | null {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
}

function envFloat(name: string): number | null {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

function clampPositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return Math.max(1, Math.floor(fallback));
  return Math.max(1, Math.floor(value));
}

function clampNonNegativeInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return Math.max(0, Math.floor(fallback));
  return Math.max(0, Math.floor(value));
}

function clampRatio(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function resolveMinOverrideBudgetRatio(): number {
  // Keep a floor so workers are not starved by tiny overrides, but allow
  // tighter scoped runs than the previous 75% default.
  const fallback = 0.5;
  const configured = envFloat("NEXUS_SPAWN_BUDGET_MIN_RATIO");
  if (configured === null) return fallback;
  return clampRatio(configured, fallback);
}

function resolveRuntimeLimits(ctx: ToolContext): { maxToolCalls: number; maxIterations: number; maxContextTokens: number } {
  const defaults = { maxToolCalls: 120, maxIterations: 60, maxContextTokens: 128_000 };
  const fromCtx = ctx.runtimeLimits ?? defaults;
  return {
    maxToolCalls: clampPositiveInt(fromCtx.maxToolCalls, defaults.maxToolCalls),
    maxIterations: clampPositiveInt(fromCtx.maxIterations, defaults.maxIterations),
    maxContextTokens: clampNonNegativeInt(fromCtx.maxContextTokens, defaults.maxContextTokens),
  };
}

function computeRunDepth(db: NexusDatabase, runId: string): number {
  let depth = 0;
  let current: string | null = runId;
  for (let i = 0; i < 20 && current; i++) {
    const row = db.db.prepare("SELECT parent_run_id FROM agent_runs WHERE run_id = ?").get(current) as
      | { parent_run_id: string | null }
      | undefined;
    if (!row?.parent_run_id) break;
    depth += 1;
    current = row.parent_run_id;
  }
  return depth;
}

function getParentTask(db: NexusDatabase, runId: string): string | null {
  const row = db.db.prepare("SELECT task FROM agent_runs WHERE run_id = ?").get(runId) as
    | { task: string | null }
    | undefined;
  if (!row?.task) return null;
  return String(row.task);
}

function normalizeTask(task: string): string {
  return task.replace(/\s+/g, " ").trim().toLowerCase();
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function didRunApplyDeploy(messages: ChatMessage[]): boolean {
  const callById = new Map<string, { name: string; args: Record<string, unknown>; result?: string }>();
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(call.arguments) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            parsedArgs = parsed as Record<string, unknown>;
          }
        } catch {
          parsedArgs = {};
        }
        callById.set(call.id, { name: call.name, args: parsedArgs });
      }
      continue;
    }
    if (message.role === "tool" && typeof message.toolCallId === "string") {
      const existing = callById.get(message.toolCallId);
      if (existing) {
        existing.result = typeof message.content === "string" ? message.content : "";
      }
    }
  }

  for (const call of callById.values()) {
    if (call.name !== "ha_deploy") continue;
    if (call.args.action !== "apply") continue;
    if (!call.result || call.result.trimStart().startsWith("ERROR:")) continue;
    return true;
  }

  return false;
}

function parseBlackboardTitle(task: string, presetName: string): { title: string; cleanedTask: string } {
  const lines = task.split(/\r?\n/);
  let explicit: string | null = null;
  const cleanedLines = lines.filter((line) => {
    const match = line.match(/^\s*Blackboard title\s*:\s*(.+)\s*$/i);
    if (match) {
      explicit = match[1].trim();
      return false;
    }
    return true;
  });
  const cleanedTask = cleanedLines.join("\n").trim() || task.trim();
  const title = explicit && (explicit as string).length > 0 ? explicit : defaultBlackboardTitle(presetName, cleanedTask);
  return { title, cleanedTask };
}

function defaultBlackboardTitle(presetName: string, task: string): string {
  const normalized = task.replace(/\s+/g, " ").trim();
  const prefix = presetName === "researcher" || presetName === "analyst"
    ? "Finding: "
    : presetName === "coder"
      ? "Summary: "
      : presetName === "trader"
        ? "Trade: "
        : "Result: ";
  const maxBaseLen = Math.max(20, 200 - prefix.length);
  const base = normalized.length > maxBaseLen
    ? normalized.slice(0, maxBaseLen - 1).trimEnd() + "…"
    : normalized;
  return prefix + (base || "Untitled task");
}

function attachBlackboardTitle(resultJson: string, blackboardTitle: string): string {
  try {
    const parsed = JSON.parse(resultJson) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      parsed.blackboardTitle = blackboardTitle;
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // ignore parse errors
  }
  return resultJson;
}

function attachBlackboardReference(
  ctx: ToolContext,
  resultJson: string,
  blackboardTitle: string,
  startedAtMs: number,
): string {
  let parsed: Record<string, unknown>;
  try {
    const candidate = JSON.parse(resultJson) as unknown;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return resultJson;
    }
    parsed = candidate as Record<string, unknown>;
  } catch {
    return resultJson;
  }

  if (typeof parsed.blackboardTitle !== "string" || parsed.blackboardTitle.trim().length === 0) {
    parsed.blackboardTitle = blackboardTitle;
  }

  const db = ctx.db as NexusDatabase | undefined;
  if (!db) return JSON.stringify(parsed, null, 2);

  const scope = ctx.request?.sessionId ?? "global";
  const nowMs = ctx.nowMs();
  const row = db.db
    .prepare(
      `SELECT id, type, created_at
       FROM blackboard
       WHERE (session_scope = ? OR session_scope = 'global')
         AND title = ?
         AND created_at >= ?
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(scope, blackboardTitle, startedAtMs, nowMs) as
    | { id: string; type: string; created_at: number }
    | undefined;

  if (row?.id) {
    parsed.blackboardEntryId = row.id;
    parsed.blackboardEntryType = row.type;
    parsed.blackboardEntryCreatedAt = Number(row.created_at);
  }

  return JSON.stringify(parsed, null, 2);
}
