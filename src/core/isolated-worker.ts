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
import { ToolRegistry } from "./tool-registry.js";
import { AgentTracker } from "./agent-tracker.js";
import { AgentRunner } from "./agent-runner.js";
import { ProcessManager } from "../process/manager.js";
import { getBuiltInTools } from "../tools/index.js";
import { getPreset } from "./presets.js";
import type { ToolContext } from "./tools.js";
import type { ParentMessage, WorkerMessage, WorkerConfig } from "./isolated-worker-types.js";

function send(msg: WorkerMessage): void {
  if (process.send) process.send(msg);
}

function log(line: string): void {
  send({ type: "log", line });
}

process.on("message", async (msg: ParentMessage) => {
  if (msg.type !== "task") return;
  const cfg: WorkerConfig = msg.config;

  try {
    // Bootstrap own resources
    const dbPath = path.join(cfg.stateDir, "nexus.db");
    const db = await openDatabase(dbPath);
    // Set busy timeout for WAL mode concurrent access
    db.db.pragma("busy_timeout = 10000");

    const llm = new OpenAICompatClient(cfg.llmConfig);
    const builtIns = getBuiltInTools();
    const registry = new ToolRegistry({ builtIns, stateDir: cfg.stateDir });
    await registry.init();
    const processManager = new ProcessManager({ stateDir: cfg.stateDir });
    const agentTracker = new AgentTracker({ db });

    // Resolve preset and filter tools
    const preset = getPreset(cfg.presetName);
    if (!preset) {
      throw new Error(`Unknown preset: ${cfg.presetName}`);
    }

    const allowedNames = new Set(preset.tools);
    // Remove spawn_agent if at max depth
    if (cfg.currentDepth >= cfg.maxDepth) {
      allowedNames.delete("spawn_agent");
    }
    const workerTools = registry.list().filter((t) => allowedNames.has(t.name));

    // Build ToolContext
    const toolContext: ToolContext = {
      workspaceDir: cfg.workspaceDir,
      stateDir: cfg.stateDir,
      codeDir: cfg.codeDir,
      llm,
      llmConfig: cfg.llmConfig,
      db,
      browser: undefined, // Workers do NOT get a browser instance
      registry,
      processManager,
      agentTracker,
      telegram: undefined,
      allowShellExec: cfg.allowShellExec,
      allowCodeEdit: cfg.allowCodeEdit,
      allowCodeWrite: cfg.allowCodeWrite,
      request: {
        channel: cfg.channel,
        channelKey: cfg.channelKey,
        agentId: cfg.agentId,
        sessionId: cfg.sessionId,
        runId: cfg.runId ?? undefined,
      },
      planState: undefined,
      budgetInfo: {
        iterationsUsed: 0,
        maxIterations: cfg.budget.maxIterations,
        toolCallsUsed: 0,
        maxToolCalls: cfg.budget.maxToolCalls,
      },
      nowMs: () => Date.now(),
      log,
    };

    const runner = new AgentRunner({
      llm,
      tools: workerTools,
      budget: cfg.budget,
      toolContext,
      onLog: log,
    });

    const result = await runner.run({
      systemPrompt: cfg.systemPrompt,
      history: [],
      userMessage: cfg.userMessage,
    });

    // Coder safeguard: if code was edited and built but ha_deploy was never
    // called, auto-trigger it so deploys can't be silently skipped.
    if (cfg.presetName === "coder") {
      const toolNames = new Set(
        result.newMessages.flatMap((m) => ("toolCalls" in m && m.toolCalls) ? m.toolCalls.map((tc) => tc.name) : []),
      );
      const builtCode = toolNames.has("shell_exec") &&
        (toolNames.has("file_edit") || toolNames.has("file_edit_lines") || toolNames.has("file_write"));
      const deployed = toolNames.has("ha_deploy");

      if (builtCode && !deployed) {
        log("coder edited code + built but skipped ha_deploy — auto-triggering deploy");
        const haDeployTool = workerTools.find((t) => t.name === "ha_deploy");
        if (haDeployTool) {
          try {
            const deployResult = await haDeployTool.execute({ action: "apply" }, toolContext);
            log(`auto ha_deploy: ${deployResult.slice(0, 200)}`);
            result.output += `\n\n[AUTO-DEPLOY] ${deployResult}`;
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
      },
    });

    db.close();
    process.exit(0);
  } catch (err) {
    send({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
});

// Handle uncaught errors
process.on("uncaughtException", (err) => {
  send({ type: "error", error: `Uncaught exception: ${err.message}` });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  send({ type: "error", error: `Unhandled rejection: ${reason}` });
  process.exit(1);
});
