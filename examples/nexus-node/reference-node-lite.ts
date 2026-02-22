#!/usr/bin/env node
import process from "node:process";

process.env.NEXUS_NODE_PROFILE ??= "minimal";
process.env.NEXUS_NODE_STATE_BACKEND ??= "json";
process.env.NEXUS_NODE_MCP_BRIDGE ??= "0";
process.env.NEXUS_NODE_LOG_FORMAT ??= "json";
process.env.NEXUS_REFERENCE_NODE_NO_AUTORUN = "1";

const { runReferenceNode } = await import("./reference-node.js");

void runReferenceNode(process.argv.slice(2), {
  forceProfile: "minimal",
  forceStateBackend: "json",
}).catch((err) => {
  process.stderr.write(`[reference-node-lite] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
