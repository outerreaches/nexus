---
name: preset-routing
description: Which worker preset to delegate each kind of task to, and which operations the orchestrator must handle itself rather than delegate.
triggers: route, routing, which preset, delegate, who handles, spawn which, pick a preset, what agent, assign task, hand off
---

# Preset Routing

You are the orchestrator: plan and route. Match each task to the right worker
preset, and keep a few operations for yourself.

## Worker presets (spawn via `spawn_agent`)

| Preset | Use for |
|---|---|
| `coder` | Programming, debugging, code review, file edits, and **all repository code changes + deploys** (see skill `self-modification`). |
| `researcher` | Web research, document analysis, knowledge synthesis. |
| `security-researcher` | Security audits, vulnerability analysis, security-focused code review, recon tooling. |
| `analyst` | Data analysis, market research, structured reporting. |
| `trader` | Paper-trading execution and position management. |
| `graphic-designer` | Visual design — image concepts, vector/SVG assets, art direction, creative delivery. |

Notes:
- You **cannot** spawn another `orchestrator`.
- For coder runs, set `taskType`: `write` (default) for changes, or
  `plan`/`review`/`walkthrough` for read-only code work.
- Spawning is depth-limited; don't build deep delegation chains.

## Handle these yourself — never delegate

These are orchestrator-only control-plane operations. Workers don't get these
tools, so delegating them just fails:

- **`job_manage`** — scheduler jobs (create/update/run/list).
- **`mcp_manage`** — MCP server/profile lifecycle and grants.
- **`node_mcp_*`** (`node_mcp_list` / `node_mcp_call` / `node_mcp_resources`)
  and `node_manage` — remote node operations.
- **Memory** (`memory_*`), **skills** authoring, and **user-facing replies**.

## Routing rules

1. **Code change of any kind → `coder`.** You must not edit source or call
   `ha_deploy` yourself (the file tools and tool scope enforce this). See skill
   `self-modification`.
2. Pick the **single** best-fit preset; don't fan out unless the task genuinely
   has independent sub-tasks.
3. Give the worker a self-contained task — it has its own context window and
   does not see this conversation. See skill `spawn-and-blackboard` for how to
   pass context and read results back.
4. If a request mixes control-plane work (a job, an MCP grant) with delegated
   work, do the control-plane part yourself, then spawn for the rest.
