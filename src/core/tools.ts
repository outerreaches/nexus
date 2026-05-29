import type { ChildProcess } from "node:child_process";

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AgentTracker } from "./agent-tracker.js";
import type { LLMClient, OpenAICompatConfig } from "../llm/openai-compat.js";
import type { ModelRouter, ModelRoutingMode } from "../llm/model-router.js";
import type { CandidateBinding } from "../state/candidates.js";
import type { LlmToolRouting, SkillsConfig } from "../state/config.js";

export type ToolContext = {
  workspaceDir: string;
  stateDir: string;
  codeDir: string;
  liveCodeDir?: string;
  candidateRootDir?: string;
  candidate?: CandidateBinding;
  llm?: LLMClient;
  /** Serializable LLM config for passing to isolated workers. */
  llmConfig?: OpenAICompatConfig;
  /** Optional model router for per-agent/preset model selection. */
  modelRouter?: ModelRouter;
  /** Optional tool-specific routing config (separate from agent reasoning routing). */
  llmToolRouting?: LlmToolRouting;
  /** Runtime skill-system controls (global enable + prompt formatting options). */
  skillsConfig?: SkillsConfig;
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
    homeAgentId?: string;
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
    /** Drain handshake: report whether a node's in-flight work has finished.
     *  Structurally matches nodes/types NodeDrainResult (inlined to avoid a cycle). */
    awaitNodeDrained?: (
      nodeId: string,
      opts?: { deadlineMs?: number },
    ) => Promise<{ drained: boolean; remaining: number; nodeAcked: boolean }>;
    /** Coordinated update orchestration; structurally matches nodes/types
     *  NodeUpdateResult (inlined to avoid a cycle). */
    updateNode?: (
      nodeId: string,
      opts?: { strategy?: string; ref?: string; deadlineMs?: number; drainDeadlineMs?: number },
    ) => Promise<{
      ok: boolean;
      stage: "preflight" | "drain" | "update" | "reconnect" | "complete";
      strategy: string;
      message: string;
      drain?: { drained: boolean; remaining: number; nodeAcked: boolean };
      accepted?: boolean;
      reconnected?: boolean;
      protocolVersion?: number | null;
      appVersion?: string | null;
    }>;
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
  /** Per-run mutable state shared between AgentRunner and tools. Tools that
   *  mutate this object (e.g. tool_load) affect what the runner exposes to the
   *  LLM on subsequent iterations. */
  runState?: RunState;
};

/** Lazy tool-loading state for a single run. */
export type RunState = {
  /** Names of tools always loaded for this preset (immutable for the run). */
  readonly kernelToolNames: ReadonlySet<string>;
  /** Names of all tools the agent CAN load (kernel ∪ catalog). Validation set
   *  for tool_load/tool_search/tool_unload. */
  readonly availableToolNames: ReadonlySet<string>;
  /** Mutable set of catalog tools currently loaded in addition to the kernel.
   *  Mutated by tool_load / tool_unload; read by AgentRunner each iteration. */
  readonly loadedToolNames: Set<string>;
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

/** Always loaded into the LLM tool schema, regardless of preset config. Without
 *  these the agent cannot discover or load anything else. Wired into `RunState`
 *  by `buildRunState`. */
export const LAZY_LOADING_KERNEL_TOOLS: readonly string[] = [
  "tool_search",
  "tool_load",
  "tool_unload",
];

/** Build per-run lazy-tool-loading state for an agent run. If the preset has
 *  no `kernel` configured, lazy loading is disabled and `null` is returned
 *  (the runner falls back to exposing every tool the preset is allowed). */
export function buildRunState(params: {
  presetKernel: readonly string[] | undefined;
  presetTools: readonly string[];
  filteredToolNames: readonly string[];
}): RunState | null {
  if (!params.presetKernel || params.presetKernel.length === 0) return null;
  const filteredSet = new Set(params.filteredToolNames);
  const presetSet = new Set(params.presetTools);
  // Kernel = preset.kernel ∩ filteredTools, plus the discovery tools so the
  // agent can always reach tool_search / tool_load / tool_unload.
  const kernel = new Set<string>();
  for (const name of params.presetKernel) {
    if (filteredSet.has(name)) kernel.add(name);
  }
  for (const name of LAZY_LOADING_KERNEL_TOOLS) {
    if (filteredSet.has(name)) kernel.add(name);
  }
  // Available = all tools the preset is allowed to use (after filtering).
  // The catalog (available − kernel) is what `tool_load` may surface.
  const available = new Set<string>();
  for (const name of params.filteredToolNames) {
    if (presetSet.has(name) || LAZY_LOADING_KERNEL_TOOLS.includes(name)) {
      available.add(name);
    }
  }
  return {
    kernelToolNames: kernel,
    availableToolNames: available,
    loadedToolNames: new Set<string>(),
  };
}

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
