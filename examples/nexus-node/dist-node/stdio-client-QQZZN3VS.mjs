import "./chunk-LZOMFHX3.mjs";

// ../../src/mcp/stdio-client.ts
import { spawn } from "child_process";
var McpStdioClient = class {
  constructor(config) {
    this.config = config;
  }
  child = null;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  stdoutBuffer = "";
  initialized = false;
  async initialize() {
    await this.ensureStarted();
    const result = await this.request("initialize", {
      protocolVersion: "2025-11-05",
      capabilities: {},
      clientInfo: { name: "nexus", version: "0.0.1" }
    });
    await this.notify("notifications/initialized", {});
    this.initialized = true;
    return result;
  }
  async listTools() {
    if (!this.initialized) {
      await this.initialize();
    }
    const tools = [];
    let cursor;
    for (let i = 0; i < 50; i += 1) {
      const params = cursor ? { cursor } : {};
      const result = await this.request("tools/list", params);
      if (Array.isArray(result.tools)) {
        for (const tool of result.tools) {
          if (!tool || typeof tool !== "object" || typeof tool.name !== "string") continue;
          tools.push({
            name: tool.name,
            description: typeof tool.description === "string" ? tool.description : void 0,
            inputSchema: isJsonObject(tool.inputSchema) ? tool.inputSchema : void 0
          });
        }
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }
  async callTool(name, args) {
    if (!this.initialized) {
      await this.initialize();
    }
    const result = await this.request("tools/call", {
      name,
      arguments: args ?? {}
    });
    return result ?? {};
  }
  async listResources(cursor) {
    if (!this.initialized) {
      await this.initialize();
    }
    const params = cursor ? { cursor } : {};
    const result = await this.request("resources/list", params);
    const resources = Array.isArray(result.resources) ? result.resources.filter((item) => {
      return !!item && typeof item === "object" && typeof item.uri === "string";
    }) : [];
    return {
      resources,
      ...typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}
    };
  }
  async readResource(uri) {
    if (!this.initialized) {
      await this.initialize();
    }
    const result = await this.request("resources/read", { uri });
    return result ?? {};
  }
  async close() {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`MCP process closed before response id=${id}`));
      this.pending.delete(id);
    }
    this.initialized = false;
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    child.removeAllListeners();
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  async ensureStarted() {
    if (this.child) return;
    const child = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...this.config.env ?? {} },
      stdio: "pipe"
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleStdoutChunk(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      var _a, _b;
      const line = chunk.trim();
      if (line) (_b = (_a = this.config).log) == null ? void 0 : _b.call(_a, `mcp stderr: ${line}`);
    });
    child.on("exit", (code, signal) => {
      var _a, _b;
      const reason = `MCP process exited code=${code ?? "null"} signal=${signal ?? "null"}`;
      (_b = (_a = this.config).log) == null ? void 0 : _b.call(_a, reason);
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
      }
      this.pending.clear();
      this.child = null;
      this.initialized = false;
    });
    child.on("error", (err) => {
      var _a, _b;
      (_b = (_a = this.config).log) == null ? void 0 : _b.call(_a, `mcp process error: ${err.message}`);
    });
  }
  async notify(method, params) {
    const child = this.child;
    if (!child) throw new Error("MCP process not started");
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params
    });
    await this.writeLine(`${payload}
`);
  }
  async request(method, params) {
    const child = this.child;
    if (!child) throw new Error("MCP process not started");
    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };
    const timeoutMs = this.config.timeoutMs;
    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out method=${method} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    await this.writeLine(`${JSON.stringify(payload)}
`);
    return responsePromise;
  }
  async writeLine(line) {
    const child = this.child;
    if (!child) throw new Error("MCP process not started");
    await new Promise((resolve, reject) => {
      child.stdin.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
  handleStdoutChunk(chunk) {
    this.stdoutBuffer += chunk;
    for (; ; ) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }
  handleLine(line) {
    var _a, _b;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      (_b = (_a = this.config).log) == null ? void 0 : _b.call(_a, `mcp stdout(non-json): ${line}`);
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const msg = parsed;
    if (typeof msg.id !== "number") {
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(msg.error.message || `MCP request failed id=${msg.id}`));
      return;
    }
    pending.resolve(msg.result);
  }
};
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export {
  McpStdioClient
};
//# sourceMappingURL=stdio-client-QQZZN3VS.mjs.map