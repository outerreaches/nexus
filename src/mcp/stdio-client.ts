import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type McpInitializeResult = {
  protocolVersion?: string;
  serverInfo?: {
    name?: string;
    version?: string;
  };
  capabilities?: Record<string, unknown>;
};

export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpToolCallResult = {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stdoutBuffer = "";
  private initialized = false;

  constructor(
    private readonly config: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      timeoutMs: number;
      log?: (line: string) => void;
    },
  ) {}

  async initialize(): Promise<McpInitializeResult> {
    await this.ensureStarted();
    const result = await this.request("initialize", {
      protocolVersion: "2025-11-05",
      capabilities: {},
      clientInfo: { name: "nexus", version: "0.0.1" },
    }) as McpInitializeResult;
    await this.notify("notifications/initialized", {});
    this.initialized = true;
    return result;
  }

  async listTools(): Promise<McpToolInfo[]> {
    if (!this.initialized) {
      await this.initialize();
    }
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i += 1) {
      const params = cursor ? { cursor } : {};
      const result = await this.request("tools/list", params) as {
        tools?: McpToolInfo[];
        nextCursor?: string;
      };
      if (Array.isArray(result.tools)) {
        for (const tool of result.tools) {
          if (!tool || typeof tool !== "object" || typeof tool.name !== "string") continue;
          tools.push({
            name: tool.name,
            description: typeof tool.description === "string" ? tool.description : undefined,
            inputSchema: isJsonObject(tool.inputSchema) ? tool.inputSchema : undefined,
          });
        }
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    if (!this.initialized) {
      await this.initialize();
    }
    const result = await this.request("tools/call", {
      name,
      arguments: args ?? {},
    }) as McpToolCallResult;
    return result ?? {};
  }

  async close(): Promise<void> {
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

  private async ensureStarted(): Promise<void> {
    if (this.child) return;
    const child = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: "pipe",
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdoutChunk(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const line = chunk.trim();
      if (line) this.config.log?.(`mcp stderr: ${line}`);
    });

    child.on("exit", (code, signal) => {
      const reason = `MCP process exited code=${code ?? "null"} signal=${signal ?? "null"}`;
      this.config.log?.(reason);
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
      }
      this.pending.clear();
      this.child = null;
      this.initialized = false;
    });

    child.on("error", (err) => {
      this.config.log?.(`mcp process error: ${err.message}`);
    });
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const child = this.child;
    if (!child) throw new Error("MCP process not started");
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    });
    await this.writeLine(`${payload}\n`);
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child) throw new Error("MCP process not started");
    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    const timeoutMs = this.config.timeoutMs;
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out method=${method} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    await this.writeLine(`${JSON.stringify(payload)}\n`);
    return responsePromise;
  }

  private async writeLine(line: string): Promise<void> {
    const child = this.child;
    if (!child) throw new Error("MCP process not started");
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.config.log?.(`mcp stdout(non-json): ${line}`);
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const msg = parsed as Partial<JsonRpcResponse>;
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
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
