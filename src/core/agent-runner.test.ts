import test from "node:test";
import assert from "node:assert/strict";

import { AgentRunner, classifyToolResultStatus, toolResultIndicatesDeployApplied } from "./agent-runner.js";
import type { LLMClient } from "../llm/openai-compat.js";
import type { ToolCall } from "./types.js";
import type { ToolContext } from "./tools.js";

function makeCall(name: string): ToolCall {
  return {
    id: "call-1",
    name,
    arguments: "{}",
  };
}

test("classifyToolResultStatus marks plain ERROR-prefixed output as error", () => {
  const call = makeCall("file_write");
  const result = classifyToolResultStatus(call, "ERROR: write failed");
  assert.equal(result.status, "error");
  assert.equal(result.errorSummary, "ERROR: write failed");
  assert.equal(result.errorClass, "unknown_error");
});

test("classifyToolResultStatus marks spawn_agent failed JSON status as error", () => {
  const call = makeCall("spawn_agent");
  const payload = JSON.stringify({
    status: "failed",
    output: "ERROR: worker process timed out",
    toolCallsUsed: 0,
    iterationsUsed: 0,
  });
  const result = classifyToolResultStatus(call, payload);
  assert.equal(result.status, "error");
  assert.equal(result.errorSummary, "ERROR: worker process timed out");
  assert.equal(result.errorClass, "transient_provider_error");
  assert.equal(result.retryPolicy, "yes");
});

test("classifyToolResultStatus marks spawn_agent budget_exhausted JSON status as error", () => {
  const call = makeCall("spawn_agent");
  const payload = JSON.stringify({
    status: "budget_exhausted",
    output: "Budget exhausted while iterating.",
  });
  const result = classifyToolResultStatus(call, payload);
  assert.equal(result.status, "error");
  assert.equal(result.errorSummary, "Budget exhausted while iterating.");
  assert.equal(result.errorClass, "unknown_error");
});

test("classifyToolResultStatus keeps spawn_agent complete JSON status as ok", () => {
  const call = makeCall("spawn_agent");
  const payload = JSON.stringify({
    status: "complete",
    output: "Done",
  });
  const result = classifyToolResultStatus(call, payload);
  assert.equal(result.status, "ok");
});

test("classifyToolResultStatus does not parse non-spawn JSON payloads", () => {
  const call = makeCall("web_fetch");
  const payload = JSON.stringify({
    status: "failed",
    output: "bad",
  });
  const result = classifyToolResultStatus(call, payload);
  assert.equal(result.status, "ok");
});

test("classifyToolResultStatus classifies validation errors", () => {
  const call = makeCall("spawn_agent");
  const result = classifyToolResultStatus(call, "ERROR: invalid tool arguments for 'spawn_agent' (not valid JSON)");
  assert.equal(result.status, "error");
  assert.equal(result.errorClass, "validation_error");
  assert.equal(result.retryPolicy, "no");
});

test("classifyToolResultStatus classifies rate limit errors", () => {
  const call = makeCall("web_search");
  const result = classifyToolResultStatus(call, "ERROR: web search failed: 429 Too Many Requests");
  assert.equal(result.status, "error");
  assert.equal(result.errorClass, "rate_limited");
  assert.equal(result.retryPolicy, "after_backoff");
});

test("classifyToolResultStatus classifies abort/timeouts as transient provider errors", () => {
  const call = makeCall("web_search");
  const result = classifyToolResultStatus(
    call,
    "ERROR: tool request timed out or aborted: This operation was aborted",
  );
  assert.equal(result.status, "error");
  assert.equal(result.errorClass, "transient_provider_error");
  assert.equal(result.retryPolicy, "yes");
});

test("classifyToolResultStatus classifies capability mismatch errors", () => {
  const call = makeCall("image_edit");
  const result = classifyToolResultStatus(call, "ERROR: No endpoints found that support the requested output modalities");
  assert.equal(result.status, "error");
  assert.equal(result.errorClass, "capability_mismatch");
  assert.equal(result.retryPolicy, "no");
});

test("classifyToolResultStatus classifies not_found errors", () => {
  const call = makeCall("file_read");
  const result = classifyToolResultStatus(call, "ERROR: no such file or directory");
  assert.equal(result.status, "error");
  assert.equal(result.errorClass, "not_found");
  assert.equal(result.retryPolicy, "no");
});

test("toolResultIndicatesDeployApplied detects direct ha_deploy apply success", () => {
  const call = makeCall("ha_deploy");
  const didApply = toolResultIndicatesDeployApplied(call, { action: "apply" }, "OK: deploy completed");
  assert.equal(didApply, true);
});

test("toolResultIndicatesDeployApplied ignores approval-required ha_deploy apply results", () => {
  const call = makeCall("ha_deploy");
  const didApply = toolResultIndicatesDeployApplied(
    call,
    { action: "apply" },
    "APPROVAL REQUIRED: created deploy approval request HA123.",
  );
  assert.equal(didApply, false);
});

test("toolResultIndicatesDeployApplied ignores ha_deploy status action", () => {
  const call = makeCall("ha_deploy");
  const didApply = toolResultIndicatesDeployApplied(call, { action: "status" }, "LAST_STATUS=ok");
  assert.equal(didApply, false);
});

test("toolResultIndicatesDeployApplied detects spawn_agent deployApplied flag", () => {
  const call = makeCall("spawn_agent");
  const payload = JSON.stringify({
    status: "complete",
    output: "Done",
    deployApplied: true,
  });
  const didApply = toolResultIndicatesDeployApplied(call, {}, payload);
  assert.equal(didApply, true);
});

test("toolResultIndicatesDeployApplied ignores ERROR-prefixed results", () => {
  const call = makeCall("ha_deploy");
  const didApply = toolResultIndicatesDeployApplied(call, { action: "apply" }, "ERROR: failed");
  assert.equal(didApply, false);
});

function makeToolContext(): ToolContext {
  return {
    workspaceDir: "/tmp",
    stateDir: "/tmp",
    codeDir: "/tmp",
    nowMs: () => Date.now(),
    log: () => {},
  };
}

test("AgentRunner retries once when final assistant output is empty", async () => {
  let callCount = 0;
  const llm: LLMClient = {
    completeChat: async () => {
      callCount += 1;
      if (callCount === 1) return { content: null, toolCalls: [] };
      return { content: "non-empty", toolCalls: [] };
    },
  };

  const runner = new AgentRunner({
    llm,
    tools: [],
    budget: { maxIterations: 3, maxToolCalls: 5 },
    toolContext: makeToolContext(),
  });

  const result = await runner.run({
    systemPrompt: "You are a test runner.",
    history: [],
    userMessage: "hello",
  });

  assert.equal(result.status, "complete");
  assert.equal(result.output, "non-empty");
  assert.equal(result.iterationsUsed, 2);
});

test("AgentRunner does not hand off the run when ha_deploy returns approval required", async () => {
  let step = 0;
  const llm: LLMClient = {
    completeChat: async () => {
      if (step === 0) {
        step += 1;
        return {
          content: null,
          toolCalls: [
            {
              id: "call-ha-deploy-apply",
              name: "ha_deploy",
              arguments: JSON.stringify({ action: "apply", commitMessage: "test" }),
            },
          ],
        };
      }
      return { content: "approval still pending", toolCalls: [] };
    },
  };

  const runner = new AgentRunner({
    llm,
    tools: [
      {
        name: "ha_deploy",
        description: "test",
        jsonSchema: {},
        execute: async () => "APPROVAL REQUIRED: created deploy approval request HA123.",
      },
    ],
    budget: { maxIterations: 3, maxToolCalls: 4 },
    toolContext: makeToolContext(),
  });

  const result = await runner.run({
    systemPrompt: "You are a test runner.",
    history: [],
    userMessage: "deploy this change",
  });

  assert.equal(result.status, "complete");
  assert.equal(result.output, "approval still pending");
  assert.equal(
    result.newMessages.some(
      (msg) => msg.role === "assistant" && typeof msg.content === "string" && msg.content.includes("Deploy applied"),
    ),
    false,
  );
});

test("AgentRunner fails when repeated final output remains empty", async () => {
  const llm: LLMClient = {
    completeChat: async () => ({ content: null, toolCalls: [] }),
  };

  const runner = new AgentRunner({
    llm,
    tools: [],
    budget: { maxIterations: 2, maxToolCalls: 5 },
    toolContext: makeToolContext(),
  });

  const result = await runner.run({
    systemPrompt: "You are a test runner.",
    history: [],
    userMessage: "hello",
  });

  assert.equal(result.status, "failed");
  assert.match(result.output, /empty final response/i);
  assert.equal(result.iterationsUsed, 2);
});

test("AgentRunner does not auto-route shell_interactive even in remote execution mode", async () => {
  let step = 0;
  let localShellInteractiveCalls = 0;
  let routedCalls = 0;

  const llm: LLMClient = {
    completeChat: async () => {
      if (step === 0) {
        step += 1;
        return {
          content: null,
          toolCalls: [
            {
              id: "call-shell-interactive",
              name: "shell_interactive",
              arguments: JSON.stringify({ action: "list", target: "node", nodeId: "jetson-nano-001" }),
            },
          ],
        };
      }
      return { content: "done", toolCalls: [] };
    },
  };

  const runner = new AgentRunner({
    llm,
    tools: [
      {
        name: "shell_interactive",
        description: "test",
        jsonSchema: {},
        execute: async () => {
          localShellInteractiveCalls += 1;
          return JSON.stringify({ ok: true, action: "list", count: 0 });
        },
      },
    ],
    budget: { maxIterations: 4, maxToolCalls: 8 },
    toolContext: {
      ...makeToolContext(),
      executionNode: "jetson-nano-001",
      executionMode: "remote",
      nodeRouter: {
        routeToolExecution: async () => {
          routedCalls += 1;
          return "routed";
        },
      },
    },
  });

  const result = await runner.run({
    systemPrompt: "You are a test runner.",
    history: [],
    userMessage: "test shell_interactive routing",
  });

  assert.equal(result.status, "complete");
  assert.equal(localShellInteractiveCalls, 1);
  assert.equal(routedCalls, 0);
});

test("AgentRunner adds guidance after repeated progress-compacted shell reads", async () => {
  let step = 0;
  let readCalls = 0;
  const llm: LLMClient = {
    completeChat: async () => {
      if (step < 3) {
        step += 1;
        return {
          content: null,
          toolCalls: [
            {
              id: `call-shell-read-${step}`,
              name: "shell_interactive",
              arguments: JSON.stringify({ action: "read", session: "shell-1" }),
            },
          ],
        };
      }
      return { content: "done", toolCalls: [] };
    },
  };

  const runner = new AgentRunner({
    llm,
    tools: [
      {
        name: "shell_interactive",
        description: "test",
        jsonSchema: {},
        execute: async () => {
          readCalls += 1;
          return JSON.stringify({
            ok: true,
            action: "read",
            session: "shell-1",
            running: true,
            output: `[progress updates compacted batch ${readCalls}]`,
            progressCompacted: true,
            suppressedFrames: 8,
          });
        },
      },
    ],
    budget: { maxIterations: 5, maxToolCalls: 6 },
    toolContext: makeToolContext(),
  });

  const result = await runner.run({
    systemPrompt: "You are a test runner.",
    history: [],
    userMessage: "monitor shell progress",
  });

  assert.equal(result.status, "complete");
  assert.equal(result.output, "done");
  assert.equal(readCalls, 3);
  assert.equal(
    result.newMessages.some(
      (msg) =>
        msg.role === "tool" &&
        msg.name === "shell_interactive" &&
        typeof msg.content === "string" &&
        msg.content.includes("[SHELL READ GUIDANCE] This looks like progress monitoring"),
    ),
    true,
  );
});

test("AgentRunner adds guidance after repeated empty shell reads while session stays alive", async () => {
  let step = 0;
  let readCalls = 0;
  const llm: LLMClient = {
    completeChat: async () => {
      if (step < 2) {
        step += 1;
        return {
          content: null,
          toolCalls: [
            {
              id: `call-shell-empty-${step}`,
              name: "shell_interactive",
              arguments: JSON.stringify({ action: "read", session: "shell-1" }),
            },
          ],
        };
      }
      return { content: "done", toolCalls: [] };
    },
  };

  const runner = new AgentRunner({
    llm,
    tools: [
      {
        name: "shell_interactive",
        description: "test",
        jsonSchema: {},
        execute: async () => {
          readCalls += 1;
          return JSON.stringify({
            ok: true,
            action: "read",
            session: "shell-1",
            running: true,
            output: "",
          });
        },
      },
    ],
    budget: { maxIterations: 4, maxToolCalls: 5 },
    toolContext: makeToolContext(),
  });

  const result = await runner.run({
    systemPrompt: "You are a test runner.",
    history: [],
    userMessage: "wait for shell output",
  });

  assert.equal(result.status, "complete");
  assert.equal(result.output, "done");
  assert.equal(readCalls, 2);
  assert.equal(
    result.newMessages.some(
      (msg) =>
        msg.role === "tool" &&
        msg.name === "shell_interactive" &&
        typeof msg.content === "string" &&
        msg.content.includes("Recent reads returned no new output"),
    ),
    true,
  );
});

test("AgentRunner auto-routes shell_exec in remote execution mode", async () => {
  let step = 0;
  let localShellExecCalls = 0;
  let routedCalls = 0;

  const llm: LLMClient = {
    completeChat: async () => {
      if (step === 0) {
        step += 1;
        return {
          content: null,
          toolCalls: [
            {
              id: "call-shell-exec",
              name: "shell_exec",
              arguments: JSON.stringify({ command: "echo test" }),
            },
          ],
        };
      }
      return { content: "done", toolCalls: [] };
    },
  };

  const runner = new AgentRunner({
    llm,
    tools: [
      {
        name: "shell_exec",
        description: "test",
        nodeRoutable: true,
        jsonSchema: {},
        execute: async () => {
          localShellExecCalls += 1;
          return "local";
        },
      },
    ],
    budget: { maxIterations: 4, maxToolCalls: 8 },
    toolContext: {
      ...makeToolContext(),
      executionNode: "jetson-nano-001",
      executionMode: "remote",
      nodeRouter: {
        routeToolExecution: async () => {
          routedCalls += 1;
          return "routed";
        },
      },
    },
  });

  const result = await runner.run({
    systemPrompt: "You are a test runner.",
    history: [],
    userMessage: "test shell_exec routing",
  });

  assert.equal(result.status, "complete");
  assert.equal(localShellExecCalls, 0);
  assert.equal(routedCalls, 1);
});

test("AgentRunner logs prompt estimate calibration when usage is available", async () => {
  const logs: string[] = [];
  const llm: LLMClient = {
    completeChat: async () => ({
      content: "done",
      toolCalls: [],
      usage: {
        promptTokens: 100,
        completionTokens: 10,
        totalTokens: 110,
      },
    }),
  };

  const runner = new AgentRunner({
    llm,
    tools: [],
    budget: { maxIterations: 2, maxToolCalls: 4, maxContextTokens: 200 },
    toolContext: makeToolContext(),
    onLog: (line) => logs.push(line),
  });

  const result = await runner.run({
    systemPrompt: "You are a test runner.",
    history: [],
    userMessage: "hello",
  });

  assert.equal(result.status, "complete");
  assert.equal(logs.some((line) => line.includes("llm_prompt_estimate mode=default")), true);
});

test("AgentRunner treats tool-local AbortError as tool failure, not run cancellation", async () => {
  let step = 0;
  const llm: LLMClient = {
    completeChat: async () => {
      if (step === 0) {
        step += 1;
        return {
          content: null,
          toolCalls: [
            {
              id: "call-web-search",
              name: "web_search",
              arguments: JSON.stringify({ query: "test query" }),
            },
          ],
        };
      }
      return { content: "continued after tool error", toolCalls: [] };
    },
  };

  const runner = new AgentRunner({
    llm,
    tools: [
      {
        name: "web_search",
        description: "test",
        jsonSchema: {},
        execute: async () => {
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          throw err;
        },
      },
    ],
    budget: { maxIterations: 3, maxToolCalls: 4 },
    toolContext: makeToolContext(),
  });

  const result = await runner.run({
    systemPrompt: "You are a test runner.",
    history: [],
    userMessage: "trigger web_search",
  });

  assert.equal(result.status, "complete");
  assert.equal(result.output, "continued after tool error");
});

test("AgentRunner still cancels run when abortSignal is aborted during tool execution", async () => {
  const controller = new AbortController();
  let step = 0;
  const llm: LLMClient = {
    completeChat: async () => {
      if (step === 0) {
        step += 1;
        return {
          content: null,
          toolCalls: [
            {
              id: "call-web-search",
              name: "web_search",
              arguments: JSON.stringify({ query: "test query" }),
            },
          ],
        };
      }
      return { content: "should not complete", toolCalls: [] };
    },
  };

  const runner = new AgentRunner({
    llm,
    tools: [
      {
        name: "web_search",
        description: "test",
        jsonSchema: {},
        execute: async () => {
          controller.abort("test abort");
          const err = new Error("This operation was aborted");
          err.name = "AbortError";
          throw err;
        },
      },
    ],
    budget: { maxIterations: 3, maxToolCalls: 4 },
    toolContext: makeToolContext(),
    abortSignal: controller.signal,
  });

  await assert.rejects(
    () => runner.run({
      systemPrompt: "You are a test runner.",
      history: [],
      userMessage: "trigger web_search",
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.name, "RunCancelledError");
      assert.match(err.message, /test abort/i);
      return true;
    },
  );
});

test("AgentRunner clears identical-call blocks after a successful file mutation", async () => {
  let step = 0;
  let shellExecCalls = 0;
  const llm: LLMClient = {
    completeChat: async () => {
      switch (step++) {
        case 0:
          return {
            content: null,
            toolCalls: [
              {
                id: "call-build-1",
                name: "shell_exec",
                arguments: JSON.stringify({ command: "npm --prefix /tmp/repo run build" }),
              },
            ],
          };
        case 1:
          return {
            content: null,
            toolCalls: [
              {
                id: "call-edit-1",
                name: "file_write",
                arguments: JSON.stringify({ path: "/tmp/repo/src/example.ts", content: "export const ok = true;\n" }),
              },
            ],
          };
        case 2:
          return {
            content: null,
            toolCalls: [
              {
                id: "call-build-2",
                name: "shell_exec",
                arguments: JSON.stringify({ command: "npm --prefix /tmp/repo run build" }),
              },
            ],
          };
        default:
          return { content: "done", toolCalls: [] };
      }
    },
  };

  const runner = new AgentRunner({
    llm,
    tools: [
      {
        name: "shell_exec",
        description: "test",
        jsonSchema: {},
        execute: async () => {
          shellExecCalls += 1;
          if (shellExecCalls === 1) return "ERROR: build failed";
          return "build ok";
        },
      },
      {
        name: "file_write",
        description: "test",
        jsonSchema: {},
        execute: async () => "OK: wrote file",
      },
    ],
    budget: { maxIterations: 6, maxToolCalls: 8 },
    toolContext: makeToolContext(),
  });

  const result = await runner.run({
    systemPrompt: "You are a test runner.",
    history: [],
    userMessage: "fix the build and rerun it",
  });

  assert.equal(result.status, "complete");
  assert.equal(result.output, "done");
  assert.equal(shellExecCalls, 2);
});

test("AgentRunner clears identical-call blocks after successful dependency bootstrap", async () => {
  let step = 0;
  let typecheckCalls = 0;
  let installCalls = 0;
  const llm: LLMClient = {
    completeChat: async () => {
      switch (step++) {
        case 0:
          return {
            content: null,
            toolCalls: [
              {
                id: "call-typecheck-1",
                name: "shell_exec",
                arguments: JSON.stringify({ command: "cd /tmp/repo && npm run typecheck" }),
              },
            ],
          };
        case 1:
          return {
            content: null,
            toolCalls: [
              {
                id: "call-install-1",
                name: "shell_exec",
                arguments: JSON.stringify({ command: "cd /tmp/repo && npm ci" }),
              },
            ],
          };
        case 2:
          return {
            content: null,
            toolCalls: [
              {
                id: "call-typecheck-2",
                name: "shell_exec",
                arguments: JSON.stringify({ command: "cd /tmp/repo && npm run typecheck" }),
              },
            ],
          };
        default:
          return { content: "done", toolCalls: [] };
      }
    },
  };

  const runner = new AgentRunner({
    llm,
    tools: [
      {
        name: "shell_exec",
        description: "test",
        jsonSchema: {},
        execute: async (args) => {
          const command = typeof (args as { command?: unknown }).command === "string"
            ? (args as { command: string }).command
            : "";
          if (command.includes("npm ci")) {
            installCalls += 1;
            return "install ok";
          }
          typecheckCalls += 1;
          if (typecheckCalls === 1) return "ERROR: typecheck failed";
          return "typecheck ok";
        },
      },
    ],
    budget: { maxIterations: 6, maxToolCalls: 8 },
    toolContext: makeToolContext(),
  });

  const result = await runner.run({
    systemPrompt: "You are a test runner.",
    history: [],
    userMessage: "install deps and rerun typecheck",
  });

  assert.equal(result.status, "complete");
  assert.equal(result.output, "done");
  assert.equal(installCalls, 1);
  assert.equal(typecheckCalls, 2);
});

test("AgentRunner keeps identical-call blocks when only read-only tools succeed in between", async () => {
  let step = 0;
  let shellExecCalls = 0;
  const llm: LLMClient = {
    completeChat: async () => {
      switch (step++) {
        case 0:
          return {
            content: null,
            toolCalls: [
              {
                id: "call-build-1",
                name: "shell_exec",
                arguments: JSON.stringify({ command: "npm --prefix /tmp/repo run build" }),
              },
            ],
          };
        case 1:
          return {
            content: null,
            toolCalls: [
              {
                id: "call-read-1",
                name: "file_read",
                arguments: JSON.stringify({ path: "/tmp/repo/src/example.ts" }),
              },
            ],
          };
        case 2:
          return {
            content: null,
            toolCalls: [
              {
                id: "call-build-2",
                name: "shell_exec",
                arguments: JSON.stringify({ command: "npm --prefix /tmp/repo run build" }),
              },
            ],
          };
        default:
          return { content: "done", toolCalls: [] };
      }
    },
  };

  const runner = new AgentRunner({
    llm,
    tools: [
      {
        name: "shell_exec",
        description: "test",
        jsonSchema: {},
        execute: async () => {
          shellExecCalls += 1;
          return "ERROR: build failed";
        },
      },
      {
        name: "file_read",
        description: "test",
        jsonSchema: {},
        execute: async () => "export const value = 1;\n",
      },
    ],
    budget: { maxIterations: 6, maxToolCalls: 8 },
    toolContext: makeToolContext(),
  });

  const result = await runner.run({
    systemPrompt: "You are a test runner.",
    history: [],
    userMessage: "read the file and retry the same build",
  });

  assert.equal(result.status, "complete");
  assert.equal(result.output, "done");
  assert.equal(shellExecCalls, 1);
  const blockedToolMessage = result.newMessages.find(
    (msg) => msg.role === "tool" && msg.name === "shell_exec" && String(msg.content).includes("blocked by retry policy"),
  );
  assert.ok(blockedToolMessage);
});

test("AgentRunner allows one identical retry for telegram_send file-not-found results", async () => {
  let step = 0;
  let telegramCalls = 0;
  const llm: LLMClient = {
    completeChat: async () => {
      switch (step++) {
        case 0:
          return {
            content: null,
            toolCalls: [
              {
                id: "call-telegram-send-1",
                name: "telegram_send",
                arguments: JSON.stringify({
                  text: "Atlas dashboard screenshot",
                  path: "/home/user/.nexus-node/dashboard.png",
                }),
              },
            ],
          };
        case 1:
          return {
            content: null,
            toolCalls: [
              {
                id: "call-telegram-send-2",
                name: "telegram_send",
                arguments: JSON.stringify({
                  text: "Atlas dashboard screenshot",
                  path: "/home/user/.nexus-node/dashboard.png",
                }),
              },
            ],
          };
        default:
          return { content: "done", toolCalls: [] };
      }
    },
  };

  const runner = new AgentRunner({
    llm,
    tools: [
      {
        name: "telegram_send",
        description: "test",
        jsonSchema: {},
        execute: async () => {
          telegramCalls += 1;
          if (telegramCalls === 1) return "ERROR: file not found: /home/user/.nexus-node/dashboard.png";
          return "OK: sent dashboard.png to chat 1000000001";
        },
      },
    ],
    budget: { maxIterations: 4, maxToolCalls: 6 },
    toolContext: makeToolContext(),
  });

  const result = await runner.run({
    systemPrompt: "You are a test runner.",
    history: [],
    userMessage: "send the screenshot to telegram",
  });

  assert.equal(result.status, "complete");
  assert.equal(result.output, "done");
  assert.equal(telegramCalls, 2);
  assert.equal(
    result.newMessages.some(
      (msg) =>
        msg.role === "tool" &&
        msg.name === "telegram_send" &&
        typeof msg.content === "string" &&
        msg.content.includes("One identical retry is allowed"),
    ),
    true,
  );
  assert.equal(
    result.newMessages.some(
      (msg) =>
        msg.role === "tool" &&
        msg.name === "telegram_send" &&
        typeof msg.content === "string" &&
        msg.content.includes("blocked by retry policy"),
    ),
    false,
  );
});
