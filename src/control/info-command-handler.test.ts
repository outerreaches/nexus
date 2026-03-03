import assert from "node:assert/strict";
import test from "node:test";

import { executeInfoCommand } from "./info-command-handler.js";

test("executeInfoCommand validates invalid limit before execution", async () => {
  const text = await executeInfoCommand({
    command: { kind: "info", topic: "jobs", rawLimit: "banana" },
    deps: {},
  });
  assert.match(text, /invalid limit/i);
});

test("executeInfoCommand lists tools from registry callback", async () => {
  const text = await executeInfoCommand({
    command: { kind: "info", topic: "tools", limit: 10 },
    deps: {
      listTools: () => [
        { name: "file_read", description: "Read files." },
        { name: "mcp.demo.echo", description: "Echo from MCP." },
      ],
    },
  });
  assert.match(text, /Tools: total=2/);
  assert.match(text, /file_read/);
  assert.match(text, /mcp\.demo\.echo/);
});
