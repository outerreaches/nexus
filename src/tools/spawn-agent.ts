import { fork, exec, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { z } from "zod";

const execAsync = promisify(exec);

import { defineTool, type ToolContext } from "../core/tools.js";
import { AgentRunner } from "../core/agent-runner.js";
import { getPreset, getPresetNames, type AgentPreset } from "../core/presets.js";
import { buildPresetSystemPrompt } from "../core/prompt.js";
import type { AgentTracker } from "../core/agent-tracker.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import type { NexusDatabase } from "../storage/database.js";
import type { ParentMessage, WorkerMessage, WorkerConfig } from "../core/isolated-worker-types.js";

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
      .describe("Worker preset name (coder, researcher, trader, analyst, intake-manager)"),
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
        maxToolCalls: z.number().int().min(1).max(100).optional(),
        maxIterations: z.number().int().min(1).max(40).optional(),
      })
      .optional()
      .describe("Override preset budget limits"),
    parentRunId: z.string().min(1).optional().describe("Optional parent run id for hierarchical agent graphs"),
  }),
  execute: async (args, ctx) => {
    // Resolve preset
    const preset = getPreset(args.preset);
    if (!preset) {
      const available = getPresetNames().filter(n => n !== "orchestrator").join(", ");
      return `ERROR: unknown preset "${args.preset}". Available: ${available}`;
    }
    if (args.preset === "orchestrator") {
      return "ERROR: cannot spawn another orchestrator";
    }

    // Get dependencies from context
    const registry = ctx.registry as ToolRegistry | undefined;
    if (!registry) return "ERROR: tool registry not available";

    const llm = ctx.llm;
    if (!llm) return "ERROR: LLM client not available for worker agents";

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

    // Resolve budget
    const maxContextTokens = envInt("NEXUS_MAX_CONTEXT_TOKENS") ?? 128_000;
    const budget = {
      maxToolCalls: args.budget?.maxToolCalls ?? preset.budget?.maxToolCalls ?? 50,
      maxIterations: args.budget?.maxIterations ?? preset.budget?.maxIterations ?? 20,
      maxContextTokens,
    };

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
    const now = new Date();
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
      `Current date and time: ${now.toISOString()} (${now.getFullYear()}). For current events or time-sensitive queries, include the year in searches. For historical topics, use the appropriate time period.`,
      "",
      "**File system roots:**",
      `- workspace: ${ctx.workspaceDir} (use root: "workspace" for file tools, or this absolute path for shell commands)`,
      `- state: ${ctx.stateDir} (config files, HEARTBEAT.md, etc.)`,
      `- code: ${ctx.codeDir} (source code, if enabled)`,
      "",
      "We have a large list of verified data sources available via data intake tools. Use them when possible.",
      `Blackboard title: ${blackboardTitle}`,
      "When writing your primary result to the blackboard, use the exact Blackboard title above.",
      "Complete the task below. When done, write your results to the blackboard using `write_to_blackboard`.",
      "For binary outputs (files, images), write them to disk and reference paths in blackboard attachments.",
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

    // Git checkpoint before coder modifies code (for rollback capability)
    if (preset.name === "coder" && ctx.allowCodeEdit) {
      await gitCheckpoint(ctx.codeDir, runId ?? null, ctx.log);
    }

    // Branch: isolated process vs in-process
    if (preset.isolated) {
      return runIsolated({
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
        tracker,
        blackboardTitle,
      });
    }
    return runInProcess({
      ctx,
      preset,
      systemPrompt,
      task: cleanedTask,
      budget,
      runId: runId ?? null,
      workerTools: filterToolsForPreset(registry.list(), preset, isMaxDepth),
      tracker,
      blackboardTitle,
    });
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
  workerTools: ReturnType<ToolRegistry["list"]>;
  tracker: AgentTracker | undefined;
  blackboardTitle: string;
}): Promise<string> {
  const { ctx, preset, systemPrompt, task, budget, runId, workerTools, tracker, blackboardTitle } = params;
  const llm = ctx.llm!;

  // Create worker ToolContext (inherit from orchestrator but with worker identity)
  const workerCtx: ToolContext = {
    ...ctx,
    // Workers start with a fresh planState — don't inherit parent's completed plan
    planState: undefined,
    request: ctx.request
      ? {
          ...ctx.request,
          agentId: `${ctx.request.agentId}:${preset.name}`,
          runId: runId ?? undefined,
        }
      : undefined,
    // Workers get their own budget info
    budgetInfo: {
      iterationsUsed: 0,
      maxIterations: budget.maxIterations,
      toolCallsUsed: 0,
      maxToolCalls: budget.maxToolCalls,
    },
  };

  const log = ctx.log;
  const onLog = log
    ? (line: string) => log(`worker[${preset.name}] ${line}`)
    : undefined;

  // Create and run worker
  const runner = new AgentRunner({
    llm,
    tools: workerTools,
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
  tracker: AgentTracker | undefined;
  blackboardTitle: string;
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
    tracker,
    blackboardTitle,
  } = params;

  // Require llmConfig to serialize for the worker
  if (!ctx.llmConfig) {
    return "ERROR: llmConfig not available on context (required for isolated workers)";
  }

  const log = ctx.log;
  const logWorker = (line: string) => log?.(`worker[${preset.name}] ${line}`);

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
      llmConfig: ctx.llmConfig!,
      allowShellExec: ctx.allowShellExec ?? false,
      allowCodeEdit: ctx.allowCodeEdit ?? false,
      presetName: preset.name,
      systemPrompt,
      userMessage: task,
      budget,
      parentRunId: effectiveParentRunId,
      runId,
      agentId,
      sessionId: ctx.request?.sessionId ?? "unknown",
      channel: ctx.request?.channel ?? "worker",
      channelKey: ctx.request?.channelKey ?? "worker",
      currentDepth: workerDepth,
      maxDepth,
    };

    const taskMsg: ParentMessage = { type: "task", config };
    child.send(taskMsg);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Create a git checkpoint (commit) before coder agents modify code.
 * This allows rollback if the agent breaks something.
 * Only runs if codeDir is a git repository.
 */
async function gitCheckpoint(codeDir: string, runId: string | null, log?: (msg: string) => void): Promise<void> {
  try {
    // Check if codeDir is a git repo
    await execAsync("git rev-parse --git-dir", { cwd: codeDir });

    // Check if there are any changes to commit
    const { stdout: status } = await execAsync("git status --porcelain", { cwd: codeDir });
    if (!status.trim()) {
      log?.("git-checkpoint: no changes to commit");
      return;
    }

    // Stage all changes and commit
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const commitMsg = `checkpoint: pre-coder ${timestamp}${runId ? ` (run:${runId.slice(0, 8)})` : ""}`;

    await execAsync("git add -A", { cwd: codeDir });
    await execAsync(`git commit -m "${commitMsg}" --allow-empty`, { cwd: codeDir });

    log?.(`git-checkpoint: created commit "${commitMsg}"`);
  } catch (err) {
    // Not a git repo or git not available - that's fine, skip silently
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("not a git repository") && !msg.includes("command not found")) {
      log?.(`git-checkpoint: skipped (${msg})`);
    }
  }
}
