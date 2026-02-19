// IPC message types for process-isolated worker agents

/**
 * Configuration sent from parent to worker process.
 * All fields must be JSON-serializable (no functions, no class instances).
 */
export type WorkerConfig = {
  // Paths
  stateDir: string;
  workspaceDir: string;
  codeDir: string;
  dbPath: string;

  // LLM configuration (serializable subset of OpenAICompatConfig)
  llmConfig: {
    baseUrl: string;
    apiKey?: string;
    model: string;
  };
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
  sessionId: string;
  channel: string;
  channelKey: string;
  modelMode: "default" | "local_only";

  // Depth enforcement
  currentDepth: number;
  maxDepth: number;

  // Optional run-scoped MCP grants for this worker.
  mcpGrantIds?: string[];
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

/** Messages sent from worker to parent */
export type WorkerMessage = WorkerLogMessage | WorkerResultMessage | WorkerErrorMessage;

/** Messages sent from parent to worker */
export type ParentMessage = WorkerTaskMessage;
