/**
 * Worker entry point for process-isolated agents.
 * This script is forked by spawn_agent when preset.isolated=true.
 *
 * It self-bootstraps: opens its own DB connection, creates its own LLM client,
 * ToolRegistry, ProcessManager, and AgentTracker. Then runs the AgentRunner and
 * sends the result back via IPC.
 */
import "../env.js";
import path from "node:path";

import { openDatabase } from "../storage/database.js";
import { OpenAICompatClient } from "../llm/openai-compat.js";
import { ModelRouter } from "../llm/model-router.js";
import { ToolRegistry } from "./tool-registry.js";
import { AgentTracker } from "./agent-tracker.js";
import { AgentRunner } from "./agent-runner.js";
import { ProcessManager } from "../process/manager.js";
import { getBuiltInTools } from "../tools/index.js";
import { getPreset } from "./presets.js";
import { hydrateResolvedSecrets } from "../secrets/resolve-env.js";
import { McpManager } from "../mcp/manager.js";
import type { Tool, ToolContext } from "./tools.js";
import type { ChatMessage } from "./types.js";
import type { ParentMessage, WorkerMessage, WorkerConfig } from "./isolated-worker-types.js";

function send(msg: WorkerMessage): void {
  if (process.send) process.send(msg);
}

function log(line: string): void {
  send({ type: "log", line });
}

const NODE_ROUTE_REQUEST_TIMEOUT_MS = 130_000;
let nodeRouteRequestSeq = 0;
let taskStarted = false;
const pendingNodeRouteRequests = new Map<
  string,
  {
    resolve: (value: string) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }
>();

process.on("message", async (msg: ParentMessage) => {
  if (msg.type === "node_route_response") {
    resolveNodeRouteResponse(msg);
    return;
  }
  if (msg.type !== "task") return;
  if (taskStarted) {
    log("received duplicate task payload; ignoring");
    return;
  }
  taskStarted = true;
  const cfg: WorkerConfig = msg.config;

  try {
    // Bootstrap own resources
    // Hydrate resolved secrets from parent so getSecret() works in this process.
    if (cfg.resolvedSecrets) {
      hydrateResolvedSecrets(cfg.resolvedSecrets);
    }

    const dbPath = path.join(cfg.stateDir, "nexus.db");
    const db = await openDatabase(dbPath);
    // Set busy timeout for WAL mode concurrent access
    db.db.pragma("busy_timeout = 10000");

    const llm = new OpenAICompatClient(cfg.llmConfig);
    const modelRouter = cfg.modelRouterConfig ? new ModelRouter(cfg.modelRouterConfig) : undefined;
    const builtIns = getBuiltInTools();
    const preset = getPreset(cfg.presetName);
    if (!preset) {
      throw new Error(`Unknown preset: ${cfg.presetName}`);
    }
    const mcpGrantIds = Array.from(new Set((cfg.mcpGrantIds ?? []).map((id) => id.trim()).filter(Boolean)));
    const needsMcp =
      mcpGrantIds.length > 0 ||
      preset.tools.some((name) => name.startsWith("mcp_") || name.startsWith("mcp."));

    const mcp = needsMcp
      ? new McpManager({
        db,
        log: (line) => log(line),
        stateDir: cfg.stateDir,
      })
      : null;
    if (mcp) {
      await mcp.init();
    }

    const registry = new ToolRegistry({ builtIns, stateDir: cfg.stateDir, ...(mcp ? { mcp } : {}) });
    await registry.init();
    const processManager = new ProcessManager({ stateDir: cfg.stateDir, db });
    const agentTracker = new AgentTracker({ db });

    const allowedNames = new Set(preset.tools);
    // Remove spawn_agent if at max depth
    if (cfg.currentDepth >= cfg.maxDepth) {
      allowedNames.delete("spawn_agent");
    }
    const blockedToolNames = new Set((cfg.blockedToolNames ?? []).map((name) => name.trim()).filter(Boolean));
    for (const name of blockedToolNames) {
      allowedNames.delete(name);
    }
    if (cfg.presetName === "coder" && cfg.taskType) {
      log(
        `coder task policy: taskType=${cfg.taskType} enforcement=${cfg.taskTypeEnforcement ?? "soft"} ` +
        `blocked_tools=${blockedToolNames.size}`,
      );
    }
    const baseTools = registry.list().filter((t) => allowedNames.has(t.name));
    const grantTools = mcp
      ? mcp.listToolsForGrants({
        grantIds: mcpGrantIds,
        presetName: cfg.presetName,
        runId: cfg.runId,
      })
      : [];
    const byName = new Map(baseTools.map((tool) => [tool.name, tool] as const));
    for (const tool of grantTools) {
      byName.set(tool.name, tool);
    }
    const workerTools = [...byName.values()];
    const effectiveWorkerTools = applyExecutionToolOverridesForIsolatedWorker(workerTools, cfg.executionTarget);
    const nodeRoutingBridgeEnabled = cfg.executionTarget?.target === "node";
    if (nodeRoutingBridgeEnabled && !effectiveWorkerTools.some((tool) => tool.name === "shell_interactive")) {
      throw new Error("node-target worker requires shell_interactive, but it is unavailable after policy filtering");
    }
    const routeToolViaParent = async (tool: Tool, args: unknown, routeCtx: ToolContext): Promise<string> => {
      if (!nodeRoutingBridgeEnabled) {
        throw new Error("node routing bridge is not enabled for this worker");
      }
      return await requestNodeRouteFromParent(tool, args, routeCtx);
    };

    // Build ToolContext
    const toolContext: ToolContext = {
      workspaceDir: cfg.workspaceDir,
      stateDir: cfg.stateDir,
      codeDir: cfg.codeDir,
      llm,
      llmConfig: cfg.llmConfig,
      modelRouter,
      modelMode: cfg.modelMode,
      db,
      browser: undefined, // Workers do NOT get a browser instance
      registry,
      processManager,
      mcp: mcp ?? undefined,
      agentTracker,
      telegram: undefined,
      allowShellExec: cfg.allowShellExec,
      allowCodeEdit: cfg.allowCodeEdit,
      allowCodeWrite: cfg.allowCodeWrite,
      request: {
        channel: cfg.channel,
        channelKey: cfg.channelKey,
        agentId: cfg.agentId,
        preset: cfg.presetName,
        sessionId: cfg.sessionId,
        runId: cfg.runId ?? undefined,
        parentRunId: cfg.parentRunId ?? undefined,
        modelMode: cfg.modelMode,
      },
      ...(cfg.executionTarget?.target === "node"
        ? {
          executionNode: cfg.executionTarget.nodeId,
          executionMode: "remote" as const,
        }
        : {
          executionNode: undefined,
          executionMode: "local" as const,
        }),
      ...(nodeRoutingBridgeEnabled
        ? {
          nodeRouter: {
            routeToolExecution: routeToolViaParent,
          },
        }
        : {}),
      runtimeLimits: cfg.runtimeLimits,
      nowMs: () => Date.now(),
      log,
    };

    const runner = new AgentRunner({
      llm,
      tools: effectiveWorkerTools,
      toolCallCaps: preset.toolCallCaps,
      budget: cfg.budget,
      toolContext,
      onLog: log,
    });

    const result = await runner.run({
      systemPrompt: cfg.systemPrompt,
      history: [],
      userMessage: cfg.userMessage,
    });

    const calls = collectToolCallRecords(result.newMessages);
    let deployApplied = calls.some((call) => isApplyDeployCall(call) && isSuccessfulResult(call.result));
    const readOnlyTask = isReadOnlyCoderTaskType(cfg.taskType);

    // Coder safeguard: if code was edited and built but ha_deploy was never
    // called, auto-trigger it so deploys can't be silently skipped.
    // Disabled for explicit read-only coder task types.
    if (cfg.presetName === "coder" && !readOnlyTask) {
      const codeEditMatches = calls.filter((call) => isCodeEditCall(call, cfg.codeDir));
      const editedCode = codeEditMatches.length > 0;
      const buildValidation = collectSuccessfulBuildCommands(calls);
      const validatedBuild = buildValidation.typecheckCommands.length > 0 && buildValidation.buildCommands.length > 0;
      const builtCode = editedCode && validatedBuild;
      const deployed = deployApplied;

      if (builtCode && !deployed) {
        log(
          "coder deploy safeguard details: " +
          `code_edits=${summarizeItems(codeEditMatches.map((call) => summarizeDeployRelevantCall(call)))} ` +
          `typecheck=${summarizeItems(buildValidation.typecheckCommands)} ` +
          `build=${summarizeItems(buildValidation.buildCommands)}`,
        );
        log("coder edited code + built but skipped ha_deploy — auto-triggering deploy");
        const haDeployTool = effectiveWorkerTools.find((t) => t.name === "ha_deploy");
        if (haDeployTool) {
          try {
            const deployResult = await haDeployTool.execute({ action: "apply" }, toolContext);
            log(`auto ha_deploy: ${deployResult.slice(0, 200)}`);
            result.output += `\n\n[AUTO-DEPLOY] ${deployResult}`;
            if (isSuccessfulResult(deployResult)) {
              deployApplied = true;
            }
          } catch (err) {
            log(`auto ha_deploy failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    // Complete tracking in the worker's own DB connection
    if (cfg.runId) {
      agentTracker.completeRun(cfg.runId, {
        status: result.status,
        toolCallsUsed: result.toolCallsUsed,
        iterationsUsed: result.iterationsUsed,
        outputPreview: result.output.trim().slice(0, 240),
        endedAt: Date.now(),
      });
    }

    send({
      type: "result",
      result: {
        status: result.status,
        output: result.output,
        toolCallsUsed: result.toolCallsUsed,
        iterationsUsed: result.iterationsUsed,
        deployApplied,
      },
    });
    rejectPendingNodeRouteRequests("worker completed");

    if (mcp) {
      await mcp.close();
    }
    db.close();
    process.exit(0);
  } catch (err) {
    rejectPendingNodeRouteRequests("worker failed");
    send({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
});

// Handle uncaught errors
process.on("uncaughtException", (err) => {
  rejectPendingNodeRouteRequests("worker uncaught exception");
  send({ type: "error", error: `Uncaught exception: ${err.message}` });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  rejectPendingNodeRouteRequests("worker unhandled rejection");
  send({ type: "error", error: `Unhandled rejection: ${reason}` });
  process.exit(1);
});

process.on("disconnect", () => {
  rejectPendingNodeRouteRequests("worker IPC disconnected");
});

function applyExecutionToolOverridesForIsolatedWorker(tools: Tool[], executionTarget: WorkerConfig["executionTarget"]): Tool[] {
  if (executionTarget?.target !== "node") return tools;
  return tools.map((tool) => {
    if (tool.name !== "shell_interactive") return tool;
    return {
      ...tool,
      execute: async (args: unknown, ctx: ToolContext) => {
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          return "ERROR: shell_interactive arguments must be an object.";
        }
        const patched = { ...(args as Record<string, unknown>) };
        const target = typeof patched.target === "string" ? patched.target.trim().toLowerCase() : "";
        if (target && target !== "node") {
          return `ERROR: node-pinned worker requires shell_interactive target=node (nodeId=${executionTarget.nodeId}).`;
        }
        patched.target = "node";
        patched.nodeId = executionTarget.nodeId;
        return await tool.execute(patched, ctx);
      },
    };
  });
}

function requestNodeRouteFromParent(tool: Tool, args: unknown, routeCtx: ToolContext): Promise<string> {
  if (!process.send) {
    return Promise.reject(new Error("node routing bridge unavailable: IPC channel is not connected"));
  }
  const requestId = `node_route_${Date.now()}_${++nodeRouteRequestSeq}`;
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingNodeRouteRequests.delete(requestId);
      reject(new Error(`node routing bridge timed out after ${NODE_ROUTE_REQUEST_TIMEOUT_MS}ms`));
    }, NODE_ROUTE_REQUEST_TIMEOUT_MS);
    pendingNodeRouteRequests.set(requestId, { resolve, reject, timer });
    try {
      send({
        type: "node_route_request",
        requestId,
        toolName: tool.name,
        args,
        context: serializeNodeRouteContext(routeCtx),
      });
    } catch (err) {
      clearTimeout(timer);
      pendingNodeRouteRequests.delete(requestId);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function resolveNodeRouteResponse(msg: Extract<ParentMessage, { type: "node_route_response" }>): void {
  const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
  if (!requestId) return;
  const pending = pendingNodeRouteRequests.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingNodeRouteRequests.delete(requestId);
  if (msg.ok) {
    pending.resolve(typeof msg.result === "string" ? msg.result : "");
    return;
  }
  const detail = typeof msg.error === "string" && msg.error.trim().length > 0
    ? msg.error
    : "node routing bridge request failed";
  pending.reject(new Error(detail));
}

function serializeNodeRouteContext(routeCtx: ToolContext): {
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
} {
  const request = routeCtx.request;
  return {
    ...(typeof routeCtx.executionNode === "string" && routeCtx.executionNode.trim().length > 0
      ? { executionNode: routeCtx.executionNode.trim() }
      : {}),
    ...(routeCtx.executionMode === "local" || routeCtx.executionMode === "remote" || routeCtx.executionMode === "auto"
      ? { executionMode: routeCtx.executionMode }
      : {}),
    ...(typeof routeCtx.firewallSession === "string" && routeCtx.firewallSession.trim().length > 0
      ? { firewallSession: routeCtx.firewallSession.trim() }
      : routeCtx.firewallSession === null
        ? { firewallSession: null }
        : {}),
    ...(request
      ? {
        request: {
          channel: request.channel,
          channelKey: request.channelKey,
          agentId: request.agentId,
          sessionId: request.sessionId,
          ...(request.preset ? { preset: request.preset } : {}),
          ...(request.runId ? { runId: request.runId } : {}),
          ...(request.parentRunId ? { parentRunId: request.parentRunId } : {}),
          ...(request.modelMode ? { modelMode: request.modelMode } : {}),
        },
      }
      : {}),
  };
}

function rejectPendingNodeRouteRequests(reason: string): void {
  for (const [requestId, pending] of pendingNodeRouteRequests.entries()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingNodeRouteRequests.delete(requestId);
  }
}

type ToolCallRecord = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
};

function collectToolCallRecords(messages: ChatMessage[]): ToolCallRecord[] {
  const records: ToolCallRecord[] = [];
  const byId = new Map<string, ToolCallRecord>();
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        const record: ToolCallRecord = {
          id: call.id,
          name: call.name,
          args: parseJsonObject(call.arguments),
        };
        records.push(record);
        byId.set(call.id, record);
      }
      continue;
    }
    if (message.role === "tool" && typeof message.toolCallId === "string") {
      const existing = byId.get(message.toolCallId);
      if (existing) {
        existing.result = typeof message.content === "string" ? message.content : "";
      }
    }
  }
  return records;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function isSuccessfulResult(result: string | undefined): boolean {
  if (typeof result !== "string") return false;
  return !result.trimStart().startsWith("ERROR:");
}

function isApplyDeployCall(call: ToolCallRecord): boolean {
  if (call.name !== "ha_deploy") return false;
  return call.args.action === "apply";
}

function isCodeEditCall(call: ToolCallRecord, codeDir: string): boolean {
  if (call.name !== "file_edit" && call.name !== "file_edit_lines" && call.name !== "file_write") {
    return false;
  }
  if (call.args.root === "code") return true;
  const rawPath = typeof call.args.path === "string" ? call.args.path.trim() : "";
  if (!rawPath) return false;
  if (rawPath === "code" || rawPath.startsWith("code/") || rawPath.startsWith("code\\")) return true;
  if (!path.isAbsolute(rawPath)) return false;
  const normalizedPath = path.normalize(rawPath);
  const normalizedCodeDir = path.normalize(codeDir);
  return normalizedPath === normalizedCodeDir || normalizedPath.startsWith(`${normalizedCodeDir}${path.sep}`);
}

function isReadOnlyCoderTaskType(taskType: WorkerConfig["taskType"]): boolean {
  return taskType === "plan" || taskType === "review" || taskType === "walkthrough";
}

function collectSuccessfulBuildCommands(calls: ToolCallRecord[]): { typecheckCommands: string[]; buildCommands: string[] } {
  const typecheckCommands: string[] = [];
  const buildCommands: string[] = [];
  for (const call of calls) {
    if (call.name !== "shell_exec") continue;
    if (!isSuccessfulResult(call.result)) continue;
    const command = typeof call.args.command === "string" ? call.args.command : "";
    if (/\bnpm\s+run\s+typecheck\b/.test(command)) {
      typecheckCommands.push(command);
    }
    if (/\bnpm\s+run\s+build\b/.test(command)) {
      buildCommands.push(command);
    }
  }
  return { typecheckCommands, buildCommands };
}

function summarizeDeployRelevantCall(call: ToolCallRecord): string {
  const root = typeof call.args.root === "string" ? call.args.root.trim() : "";
  const filePath = typeof call.args.path === "string" ? call.args.path.trim() : "";
  const command = typeof call.args.command === "string" ? call.args.command.trim() : "";
  if (command) return `${call.name} command=${sanitizeForLog(command, 160)}`;
  if (filePath) {
    const rootPart = root ? `root=${root} ` : "";
    return `${call.name} ${rootPart}path=${sanitizeForLog(filePath, 120)}`.trim();
  }
  return call.name;
}

function summarizeItems(items: string[], maxItems: number = 3): string {
  if (items.length === 0) return "(none)";
  const rendered = items.slice(0, maxItems).map((item) => sanitizeForLog(item, 160));
  if (items.length > maxItems) {
    rendered.push(`(+${items.length - maxItems} more)`);
  }
  return rendered.join(" | ");
}

function sanitizeForLog(value: string, maxLen: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen)}...(+${compact.length - maxLen} chars)`;
}
