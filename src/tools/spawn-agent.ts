import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { ToolContext } from "../core/tools.js";
import { AgentRunner } from "../core/agent-runner.js";
import { getPreset, getPresetNames } from "../core/presets.js";
import { buildPresetSystemPrompt } from "../core/prompt.js";
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

    if (isMaxDepth) {
      workerTools.splice(0, workerTools.length, ...workerTools.filter((t) => t.name !== "spawn_agent"));
    }

    // Inject verified facts baseline for researcher agents
    let verifiedFactsContext = "";
    if (preset.name === "researcher" && db) {
      verifiedFactsContext = loadVerifiedFacts(db, args.task, ctx);
    }

    // Build worker system prompt
    const now = new Date();
    const basePrompt = await buildPresetSystemPrompt({
      workspaceDir: ctx.workspaceDir,
      promptFiles: preset.promptFiles,
      systemPrompt: preset.systemPrompt ?? `You are a ${preset.name} agent.`,
    });
    const systemPrompt = [
      basePrompt,
      contextText,
      verifiedFactsContext,
      "",
      "## Instructions",
      `Current date and time: ${now.toISOString()} (${now.getFullYear()}). For current events or time-sensitive queries, include the year in searches. For historical topics, use the appropriate time period.`,
      "Complete the task below. When done, write your results to the blackboard using `write_to_blackboard`.",
      "For binary outputs (files, images), write them to disk and reference paths in blackboard attachments.",
      isMaxDepth
        ? "You are at the maximum delegation depth. Do NOT spawn sub-agents. Complete the task yourself as-is."
        : `You may spawn sub-agents only when necessary. Maximum delegation depth is ${maxDepth}. Do not recursively delegate beyond that.`,
      "Do not delegate the exact same task text to another agent. If you spawn workers, break the task into distinct subtopics.",
    ].join("\n");
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
      // Workers start with a fresh planState — don't inherit parent's completed plan
      planState: undefined,
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
      let entryId: string | null = null;
      if (db && ctx.request?.sessionId) {
        const crypto = await import("node:crypto");
        entryId = crypto.randomUUID();
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

      // Auto-verify researcher output (structural — cannot be skipped)
      let verificationReport: string | null = null;
      if (preset.name === "researcher" && result.status === "complete" && db && entryId) {
        try {
          verificationReport = await autoVerifyResearcher({
            entryId,
            task: args.task,
            llm,
            registry,
            db,
            ctx: workerCtx,
            tracker,
            parentRunId: runId ?? null,
            onLog,
          });
        } catch (err) {
          onLog?.(`auto-verify failed: ${err instanceof Error ? err.message : String(err)}`);
        }
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
      const returnValue: Record<string, unknown> = {
        status: result.status,
        output: result.output,
        toolCallsUsed: result.toolCallsUsed,
        iterationsUsed: result.iterationsUsed,
      };
      if (verificationReport) {
        returnValue.verification = verificationReport;
      }
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

// ─────────────────────────────────────────────────────────────────────────────
// Verified facts injection — pre-populate researcher context with baseline data
// ─────────────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "what", "when", "where", "which", "about", "there", "these", "those",
  "this", "that", "with", "from", "have", "been", "were", "will", "would",
  "could", "should", "their", "they", "them", "your", "into", "also",
  "than", "then", "each", "some", "most", "other", "more", "find",
  "research", "search", "current", "latest", "recent", "today", "price",
  "data", "information", "report", "analysis", "details",
]);

function extractKeywords(task: string): string[] {
  const tokens = task.toLowerCase().split(/[\s,;:.()\[\]{}'"!?]+/);
  const keywords: string[] = [];
  for (const token of tokens) {
    const clean = token.replace(/[^\w]/g, "");
    if (clean.length > 3 && !STOP_WORDS.has(clean)) {
      keywords.push(clean);
    }
  }
  // Deduplicate and limit
  return [...new Set(keywords)].slice(0, 5);
}

function loadVerifiedFacts(
  db: NexusDatabase,
  task: string,
  ctx: { request?: { agentId: string }; nowMs: () => number },
): string {
  const agentId = ctx.request?.agentId ?? "main";
  const keywords = extractKeywords(task);
  if (keywords.length === 0) return "";

  const allFacts: { key: string; value: string; updated_at: number }[] = [];

  for (const kw of keywords) {
    const pattern = `%${kw}%`;
    try {
      const rows = db.db
        .prepare(
          `SELECT key, value, updated_at FROM memories
           WHERE agent_id = ? AND category = 'verified_fact'
           AND (key LIKE ? OR value LIKE ? OR tags_json LIKE ?)
           ORDER BY updated_at DESC LIMIT 5`,
        )
        .all(agentId, pattern, pattern, pattern) as { key: string; value: string; updated_at: number }[];
      allFacts.push(...rows);
    } catch {
      // Non-critical
    }
  }

  if (allFacts.length === 0) return "";

  // Deduplicate by key, keep most recent
  const byKey = new Map<string, { key: string; value: string; updated_at: number }>();
  for (const f of allFacts) {
    const existing = byKey.get(f.key);
    if (!existing || f.updated_at > existing.updated_at) {
      byKey.set(f.key, f);
    }
  }

  const nowMs = ctx.nowMs();
  const facts = [...byKey.values()].slice(0, 10);
  const lines = facts.map((f) => {
    const ageDays = Math.floor((nowMs - f.updated_at) / (24 * 60 * 60_000));
    return `- **${f.key}**: ${f.value} (verified ${ageDays}d ago)`;
  });

  return [
    "",
    "## Baseline Verified Facts",
    "Previously verified data points relevant to your task. Use as sanity checks — if your sources disagree with these, note the discrepancy explicitly.",
    "",
    ...lines,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-verification — structurally enforced fact-checking for researcher output
// ─────────────────────────────────────────────────────────────────────────────

async function autoVerifyResearcher(params: {
  entryId: string;
  task: string;
  llm: OpenAICompatClient;
  registry: ToolRegistry;
  db: NexusDatabase;
  ctx: ToolContext;
  tracker?: AgentTracker;
  parentRunId: string | null;
  onLog?: (line: string) => void;
}): Promise<string | null> {
  const { entryId, task, llm, registry, db, ctx, tracker, parentRunId, onLog } = params;

  const factCheckerPreset = getPreset("fact_checker");
  if (!factCheckerPreset) {
    onLog?.("auto-verify: fact_checker preset not found");
    return null;
  }

  // Load researcher's blackboard entry
  const entry = db.db
    .prepare("SELECT id, type, title, content FROM blackboard WHERE id = ?")
    .get(entryId) as { id: string; type: string; title: string; content: string } | undefined;

  if (!entry) {
    onLog?.("auto-verify: researcher blackboard entry not found");
    return null;
  }

  // Filter tools for fact_checker
  const allTools = registry.list();
  const allowed = new Set(factCheckerPreset.tools);
  const verifierTools = allTools.filter((t) => allowed.has(t.name));

  // Build system prompt with researcher output as context
  const researchContext = `\n\n## Research Findings to Verify\n\n### [${entry.type}] ${entry.title}\n${entry.content}`;
  const now = new Date();
  const systemPrompt = [
    factCheckerPreset.systemPrompt ?? "You are a fact-checking agent.",
    researchContext,
    "",
    "## Instructions",
    `Current date and time: ${now.toISOString()} (${now.getFullYear()}).`,
    "Verify the key claims in the research findings above. Write your verification report to the blackboard.",
    "Store confirmed data points in the verified facts store using memory_store.",
  ].join("\n");

  const maxContextTokens = envInt("NEXUS_MAX_CONTEXT_TOKENS") ?? 128_000;
  const verifierBudget = {
    maxToolCalls: 20,
    maxIterations: 10,
    maxContextTokens,
  };

  // ctx is the worker's ToolContext — spread it to inherit all base fields
  const parentRequest = ctx.request as { agentId: string; channel: string; channelKey: string; sessionId: string; runId?: string } | undefined;
  const verifierCtx: ToolContext = {
    ...ctx,
    planState: undefined,
    request: parentRequest
      ? {
          ...parentRequest,
          agentId: `${parentRequest.agentId}:fact_checker`,
        }
      : undefined,
    budgetInfo: {
      iterationsUsed: 0,
      maxIterations: verifierBudget.maxIterations,
      toolCallsUsed: 0,
      maxToolCalls: verifierBudget.maxToolCalls,
    },
  };

  // Track the verification run
  const verifyRunId = tracker?.startRun({
    parentRunId: parentRunId ?? undefined,
    agentId: parentRequest ? `${parentRequest.agentId}:fact_checker` : "worker:fact_checker",
    preset: "fact_checker",
    channel: parentRequest?.channel ?? "worker",
    channelKey: parentRequest?.channelKey ?? "worker",
    sessionId: parentRequest?.sessionId ?? "unknown",
    task: `Verify research: ${task.slice(0, 200)}`,
  });

  const verifyLog = onLog
    ? (line: string) => onLog(`fact_checker: ${line}`)
    : undefined;

  const runner = new AgentRunner({
    llm,
    tools: verifierTools,
    budget: verifierBudget,
    toolContext: verifierCtx,
    onLog: verifyLog,
  });

  try {
    const result = await runner.run({
      systemPrompt,
      history: [],
      userMessage: `Verify the key claims in the research findings about: ${task.slice(0, 500)}`,
    });

    if (verifyRunId && tracker) {
      tracker.completeRun(verifyRunId, {
        status: result.status,
        toolCallsUsed: result.toolCallsUsed,
        iterationsUsed: result.iterationsUsed,
        outputPreview: result.output.trim().slice(0, 240),
        endedAt: ctx.nowMs(),
      });
    }

    onLog?.(`auto-verify complete: status=${result.status}, toolCalls=${result.toolCallsUsed}`);
    return result.output;
  } catch (err) {
    if (verifyRunId && tracker) {
      tracker.completeRun(verifyRunId, {
        status: "failed",
        outputPreview: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
        endedAt: Date.now(),
      });
    }
    onLog?.(`auto-verify error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
