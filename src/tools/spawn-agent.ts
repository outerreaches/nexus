import { z } from "zod";

import { defineTool } from "../core/tools.js";
import { AgentRunner } from "../core/agent-runner.js";
import { getPreset, getPresetNames } from "../core/presets.js";
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
    "The worker's output is returned to you and also written to the Blackboard.",
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

    // Build worker system prompt
    const systemPrompt = [
      preset.systemPrompt ?? `You are a ${preset.name} agent.`,
      contextText,
      "",
      "## Instructions",
      "Complete the task below. When done, write your results to the blackboard using `write_to_blackboard`.",
      "For binary outputs (files, images), write them to disk and reference paths in blackboard attachments.",
    ].join("\n");

    // Resolve budget
    const budget = {
      maxToolCalls: args.budget?.maxToolCalls ?? preset.budget?.maxToolCalls ?? 50,
      maxIterations: args.budget?.maxIterations ?? preset.budget?.maxIterations ?? 20,
    };

    // Create worker ToolContext (inherit from orchestrator but with worker identity)
    const workerCtx = {
      ...ctx,
      request: ctx.request
        ? {
            ...ctx.request,
            agentId: `${ctx.request.agentId}:${preset.name}`,
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
            `INSERT INTO blackboard (id, session_scope, type, agent_id, agent_preset, title, content, attachments_json, metadata_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          );
      }

      // Return structured result to orchestrator
      return JSON.stringify({
        status: result.status,
        output: result.output,
        toolCallsUsed: result.toolCallsUsed,
        iterationsUsed: result.iterationsUsed,
      }, null, 2);
    } catch (e) {
      return `ERROR: worker agent failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}
