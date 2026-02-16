#!/usr/bin/env node

process.stdin.setEncoding("utf8");

const TOOLS = [
  {
    name: "echo",
    description: "Echoes input text.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
      additionalProperties: true,
    },
  },
  {
    name: "sum",
    description: "Returns a + b.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
      additionalProperties: true,
    },
  },
];

const RESOURCES = [
  {
    uri: "mem://public/info",
    name: "Public Info",
    mimeType: "text/plain",
    text: "public-resource-ok",
  },
  {
    uri: "mem://secret/token",
    name: "Secret Token",
    mimeType: "text/plain",
    text: "top-secret",
  },
];

let buffer = "";

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function asString(value) {
  return typeof value === "string" ? value : null;
}

function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function handleRequest(message) {
  const id = asNumber(message.id);
  const method = asString(message.method);
  const params = asObject(message.params);
  if (id === null || !method) return;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-11-05",
        serverInfo: { name: "smoke-mcp-server", version: "0.0.1" },
        capabilities: {
          tools: {},
          resources: {},
        },
      },
    });
    return;
  }

  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS,
      },
    });
    return;
  }

  if (method === "tools/call") {
    const name = asString(params.name);
    const args = asObject(params.arguments);
    if (name === "echo") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: asString(args.text) ?? "",
            },
          ],
        },
      });
      return;
    }
    if (name === "sum") {
      const a = asNumber(args.a) ?? 0;
      const b = asNumber(args.b) ?? 0;
      const total = a + b;
      send({
        jsonrpc: "2.0",
        id,
        result: {
          structuredContent: { total },
          content: [{ type: "text", text: String(total) }],
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32010,
        message: `Unknown tool: ${name ?? "unknown"}`,
      },
    });
    return;
  }

  if (method === "resources/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        resources: RESOURCES.map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          mimeType: resource.mimeType,
        })),
      },
    });
    return;
  }

  if (method === "resources/read") {
    const uri = asString(params.uri);
    const resource = RESOURCES.find((entry) => entry.uri === uri);
    if (!resource) {
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32020,
          message: `Unknown resource: ${uri ?? "unknown"}`,
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      result: {
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType,
            text: resource.text,
          },
        ],
      },
    });
    return;
  }

  send({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`,
    },
  });
}

process.stdin.on("data", (chunk) => {
  buffer += String(chunk);
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const message = asObject(parsed);
    if (!("id" in message)) continue;
    handleRequest(message);
  }
});
