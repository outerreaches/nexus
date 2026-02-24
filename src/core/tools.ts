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
  /** Optional model router for per-agent/preset model selection. */
  modelRouter?: ModelRouter;
  /** Optional circuit breaker for global LLM provider health tracking. */
  circuitBreaker?: import("../llm/circuit-breaker.js").LlmCircuitBreaker;
  /** Resolved model mode for this run (default/local_only). */
  modelMode?: ModelRoutingMode;
  db?: unknown;
  browser?: unknown;
  registry?: unknown;
  processManager?: unknown;
  mcp?: unknown;
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
  /** Abort signal for the current run (used by stop controls). */
  abortSignal?: AbortSignal;
  /** Optional explicit node target for remote execution. */
  executionNode?: string;
  /** Optional execution preference. Undefined keeps existing local behavior. */
  executionMode?: "local" | "remote" | "auto";
  /** Opaque Hermes firewall session identifier (node-owned state). */
  firewallSession?: string;
  /** Optional node-aware execution router for remote tool dispatch. */
  nodeRouter?: {
    routeToolExecution: (tool: Tool, args: unknown, ctx: ToolContext) => Promise<string>;
  };
  /** Global runtime caps for agent budgets; worker budgets should not exceed these. */
  runtimeLimits?: {
    maxToolCalls: number;
    maxIterations: number;
    maxContextTokens: number;
  };
  nowMs: () => number;
  log: (msg: string) => void;
  /** Active isolated worker child processes (for shutdown cleanup). */
  isolatedWorkers?: Set<ChildProcess>;
  /** Register an isolated worker with ownership metadata for stop controls. */
  registerIsolatedWorker?: (
    child: ChildProcess,
    owner: {
      sessionId: string | null;
      runId: string | null;
      channel: string | null;
      channelKey: string | null;
      agentId: string | null;
    },
  ) => void;
  /** Unregister an isolated worker from stop control tracking. */
  unregisterIsolatedWorker?: (child: ChildProcess) => void;
};

export type ToolDefinition<TParams extends z.ZodTypeAny> = {
  name: string;
  description: string;
  /** When true, AgentRunner may route this tool through nodeRouter in remote execution mode. */
  nodeRoutable?: boolean;
  parameters: TParams;
  execute: (args: z.infer<TParams>, ctx: ToolContext) => Promise<string>;
};

export type Tool = {
  name: string;
  description: string;
  /** When true, AgentRunner may route this tool through nodeRouter in remote execution mode. */
  nodeRoutable?: boolean;
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
    nodeRoutable: def.nodeRoutable === true,
    jsonSchema,
    execute: async (args: unknown, ctx: ToolContext) => {
      const parsed = def.parameters.parse(args) as z.infer<TParams>;
      return def.execute(parsed, ctx);
    },
  };
}
