import type { ModelRouterConfig, SerializableOpenAICompatConfig } from "../llm/model-router.js";
import type { CandidateBinding } from "../state/candidates.js";
import type { LlmToolRouting, SkillsConfig } from "../state/config.js";

// IPC message types for process-isolated worker agents

export type WorkerExecutionTarget =
  | { target: "local" }
  | { target: "node"; nodeId: string };

/**
 * Configuration sent from parent to worker process.
 * All fields must be JSON-serializable (no functions, no class instances).
 */
export type WorkerConfig = {
  // Paths
  stateDir: string;
  workspaceDir: string;
  codeDir: string;
  liveCodeDir?: string;
  candidateRootDir?: string;
  candidate?: CandidateBinding;
  dbPath: string;

  // LLM configuration (serializable subset of OpenAICompatConfig)
  llmConfig: SerializableOpenAICompatConfig;
  // Optional serialized model-router config so isolated workers can route
  // provider-specific tool calls (e.g., imageProvider overrides).
  modelRouterConfig?: ModelRouterConfig;
  // Optional tool-specific routing config (separate from agent reasoning routing).
  llmToolRouting?: LlmToolRouting;
  // Optional runtime skill config for prompt/tool access controls.
  skillsConfig?: SkillsConfig;
  // Permissions
  allowShellExec: boolean;
  allowCodeEdit: boolean;
  allowCodeWrite: boolean;

  // Preset
  presetName: string;

  // Task
  systemPrompt: string;
  userMessage: string;

  // Budget
  budget: {
    maxToolCalls: number;
    maxIterations: number;
    maxContextTokens: number;
  };
  runtimeLimits: {
    maxToolCalls: number;
    maxIterations: number;
    maxContextTokens: number;
  };

  // Tracking context
  parentRunId: string | null;
  runId: string | null;
  agentId: string;
  homeAgentId: string;
  sessionId: string;
  channel: string;
  channelKey: string;
  modelMode: "default" | "local_only";

  // Depth enforcement
  currentDepth: number;
  maxDepth: number;

  // Optional run-scoped MCP grants for this worker.
  mcpGrantIds?: string[];
  // Optional runtime denylist applied to this worker's preset tool set.
  blockedToolNames?: string[];
  // Optional coder-mode metadata for read-only/write behavior.
  taskType?: "plan" | "review" | "walkthrough" | "write";
  taskTypeEnforcement?: "soft" | "hard";
  // Optional execution target for this worker.
  executionTarget?: WorkerExecutionTarget;

  // Resolved secrets forwarded from parent process (populated by resolveEnvSecrets at startup).
  // Allows isolated workers to use getSecret() for tools like web_search.
  resolvedSecrets?: Record<string, string>;
};

/**
 * Parent → Worker: sent once on startup to initiate the task.
 */
export type WorkerTaskMessage = {
  type: "task";
  config: WorkerConfig;
};

/**
 * Worker → Parent: log line for real-time visibility.
 */
export type WorkerLogMessage = {
  type: "log";
  line: string;
};

/**
 * Worker → Parent: successful completion with result.
 */
export type WorkerResultMessage = {
  type: "result";
  result: {
    status: "complete" | "failed" | "budget_exhausted";
    output: string;
    toolCallsUsed: number;
    iterationsUsed: number;
    deployApplied: boolean;
  };
};

/**
 * Worker → Parent: unrecoverable error (caught exception).
 */
export type WorkerErrorMessage = {
  type: "error";
  error: string;
};

export type WorkerNodeRouteContext = {
  executionNode?: string;
  executionMode?: "local" | "remote" | "auto";
  firewallSession?: string | null;
  request?: {
    channel: string;
    channelKey: string;
    agentId: string;
    preset?: string;
    sessionId: string;
    runId?: string;
    parentRunId?: string;
    modelMode?: "default" | "local_only";
  };
};

/**
 * Worker → Parent: proxy a node-routed tool call through gateway-local nodeRouter.
 */
export type WorkerNodeRouteRequestMessage = {
  type: "node_route_request";
  requestId: string;
  toolName: string;
  args: unknown;
  context?: WorkerNodeRouteContext;
};

/**
 * Parent → Worker: response to node_route_request.
 */
export type ParentNodeRouteResponseMessage = {
  type: "node_route_response";
  requestId: string;
  ok: boolean;
  result?: string;
  error?: string;
};

/** Messages sent from worker to parent */
export type WorkerMessage =
  | WorkerLogMessage
  | WorkerResultMessage
  | WorkerErrorMessage
  | WorkerNodeRouteRequestMessage;

/** Messages sent from parent to worker */
export type ParentMessage = WorkerTaskMessage | ParentNodeRouteResponseMessage;
