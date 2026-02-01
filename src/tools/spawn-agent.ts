import { z } from "zod";

import { defineTool } from "../core/tools.js";
import { AgentRunner } from "../core/agent-runner.js";
import { getPreset, getPresetNames } from "../core/presets.js";
import type { AgentTracker } from "../core/agent-tracker.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import type { OpenAICompatClient } from "../llm/openai-compat.js";
import type { NexusDatabase } from "../storage/database.js";

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
      .describe("Worker preset name (coder, researcher, trader, analyst)"),
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

    // We need to get the LLM client. It's not directly on ToolContext, but we can
    // access it through a convention: the spawn_agent tool stores it on ctx.
    const llm = (ctx as Record<string, unknown>).__llm as OpenAICompatClient | undefined;
    if (!llm) return "ERROR: LLM client not available for worker agents";

    const db = ctx.db as NexusDatabase | undefined;

    // Filter tools by preset whitelist
    const allTools = registry.list();
    const allowedNames = new Set(preset.tools);
    const workerTools = allTools.filter((t) => allowedNames.has(t.name));

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

    const maxDepth = envInt("NEXUS_MAX_AGENT_DEPTH") ?? 3;

    // Build worker system prompt
    const systemPrompt = [
      preset.systemPrompt ?? `You are a ${preset.name} agent.`,
      contextText,
      "",
      "## Instructions",
      "Complete the task below. When done, write your results to the blackboard using `write_to_blackboard`.",
      "For binary outputs (files, images), write them to disk and reference paths in blackboard attachments.",
      `You may spawn sub-agents only when necessary. Maximum delegation depth is ${maxDepth}. Do not recursively delegate beyond that.`,
      "Do not delegate the exact same task text to another agent. If you spawn workers, break the task into distinct subtopics.",
    ].join("\n");

    // Resolve budget
    const budget = {
      maxToolCalls: args.budget?.maxToolCalls ?? preset.budget?.maxToolCalls ?? 50,
      maxIterations: args.budget?.maxIterations ?? preset.budget?.maxIterations ?? 20,
    };

    const tracker = ctx.agentTracker as AgentTracker | undefined;
    const parent = ctx.request;
    const effectiveParentRunId = args.parentRunId ?? parent?.runId ?? null;
    if (maxDepth >= 0 && effectiveParentRunId && db) {
      const parentDepth = computeRunDepth(db, effectiveParentRunId);
      if (parentDepth + 1 > maxDepth) {
        return `ERROR: max agent depth exceeded (depth=${parentDepth + 1}, max=${maxDepth}).`;
      }
      const parentTask = getParentTask(db, effectiveParentRunId);
      if (parentTask && normalizeTask(parentTask) === normalizeTask(args.task)) {
        return "ERROR: refusing to spawn a sub-agent with the same task as the parent.";
      }
    }
    const runId = tracker?.startRun({
      parentRunId: effectiveParentRunId,
      agentId: parent?.agentId ? `${parent.agentId}:${preset.name}` : `worker:${preset.name}`,
      preset: preset.name,
      channel: parent?.channel ?? "worker",
      channelKey: parent?.channelKey ?? "worker",
      sessionId: parent?.sessionId ?? "unknown",
      task: args.task,
    });

    // Create worker ToolContext (inherit from orchestrator but with worker identity)
    const workerCtx = {
      ...ctx,
      request: ctx.request
        ? {
            ...ctx.request,
            agentId: `${ctx.request.agentId}:${preset.name}`,
            runId,
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
        userMessage: args.task,
      });

      // Auto-write result to blackboard
      if (db && ctx.request?.sessionId) {
        const crypto = await import("node:crypto");
        const entryId = crypto.randomUUID();
        db.db
          .prepare(
            `INSERT INTO blackboard (id, session_scope, type, agent_id, agent_preset, title, content, attachments_json, metadata_json, created_at, last_accessed_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            entryId,
            ctx.request.sessionId,
            "artifact",
            `${ctx.request.agentId}:${preset.name}`,
            preset.name,
            `${preset.name} result: ${args.task.slice(0, 100)}`,
            result.output,
            "[]",
            JSON.stringify({ status: result.status, toolCalls: result.toolCallsUsed, iterations: result.iterationsUsed }),
            ctx.nowMs(),
            ctx.nowMs(),
            null,
          );
      }

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
      return JSON.stringify({
        status: result.status,
        output: result.output,
        toolCallsUsed: result.toolCallsUsed,
        iterationsUsed: result.iterationsUsed,
      }, null, 2);
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
  },
});

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
