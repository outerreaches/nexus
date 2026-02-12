import type { ChildProcess } from "node:child_process";

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AgentTracker } from "./agent-tracker.js";
import type { LLMClient, OpenAICompatConfig } from "../llm/openai-compat.js";
import type { ModelRouter, ModelRoutingMode } from "../llm/model-router.js";

export type ToolContext = {
  workspaceDir: string;
  stateDir: string;
  codeDir: string;
  llm?: LLMClient;
  /** Serializable LLM config for passing to isolated workers. */
  llmConfig?: OpenAICompatConfig;
  /** Optional fallback LLM config for passing to isolated workers. */
  fallbackLlmConfig?: OpenAICompatConfig;
  /** Optional model router for per-agent/preset model selection. */
  modelRouter?: ModelRouter;
  /** Resolved model mode for this run (default/local_only). */
  modelMode?: ModelRoutingMode;
  db?: unknown;
  browser?: unknown;
  registry?: unknown;
  processManager?: unknown;
  agentTracker?: AgentTracker;
  telegram?: unknown;
  allowShellExec?: boolean;
  allowCodeEdit?: boolean;
  allowCodeWrite?: boolean;
  requestRestart?: (reason: string, delayMs?: number) => void;
  request?: {
    channel: string;
    channelKey: string;
    agentId: string;
    preset?: string;
    sessionId: string;
    runId?: string;
    parentRunId?: string;
    modelMode?: ModelRoutingMode;
  };
  planState?: {
    completed: boolean;
    complexity: "simple" | "complex";
    steps: string[];
    parallelGroups?: string[][];
    createdAt: number;
  };
  budgetInfo?: { iterationsUsed: number; maxIterations: number; toolCallsUsed: number; maxToolCalls: number };
  nowMs: () => number;
  log: (msg: string) => void;
  /** Active isolated worker child processes (for shutdown cleanup). */
  isolatedWorkers?: Set<ChildProcess>;
};

export type ToolDefinition<TParams extends z.ZodTypeAny> = {
  name: string;
  description: string;
  parameters: TParams;
  execute: (args: z.infer<TParams>, ctx: ToolContext) => Promise<string>;
};

export type Tool = {
  name: string;
  description: string;
  jsonSchema: Record<string, unknown>;
  execute: (args: unknown, ctx: ToolContext) => Promise<string>;
};

export function defineTool<TParams extends z.ZodTypeAny>(def: ToolDefinition<TParams>): Tool {
  // OpenAI tool schemas expect JSON Schema (Draft 7-ish). In particular, they require
  // `exclusiveMinimum`/`exclusiveMaximum` to be numbers (not booleans like OpenAPI 3.0).
  const jsonSchema = zodToJsonSchema(def.parameters, {
    target: "jsonSchema7",
  }) as unknown as Record<string, unknown>;
  return {
    name: def.name,
    description: def.description,
    jsonSchema,
    execute: async (args: unknown, ctx: ToolContext) => {
      const parsed = def.parameters.parse(args) as z.infer<TParams>;
      return def.execute(parsed, ctx);
    },
  };
}
