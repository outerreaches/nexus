---
name: node-ops
description: Manage Nexus execution nodes — provisioning, health checks, remote commands, process management, and file transfers.
triggers: node, remote, jetson, node manage, node ops, node health, remote node
---

# Node Operations (Nexus)

Use this skill for any task involving remote execution nodes — checking status, running commands, managing processes, or transferring files.

## Discovery & Health Check (always do first)

1. List all nodes and their status:
   - `node_manage` action=`list`
2. Get details for a specific node:
   - `node_manage` action=`get` id=`<NODE_ID>`
3. Verify node connectivity:
   - `node_manage` action=`system_run` id=`<NODE_ID>` command=`echo ok`
4. Check node resource usage:
   - `node_manage` action=`system_run` id=`<NODE_ID>` command=`uptime && free -h && df -h /`

## Node Status Management

- Approve a pending node: `node_manage` action=`set_status` id=`<NODE_ID>` status=`approved`
- Block a node: `node_manage` action=`set_status` id=`<NODE_ID>` status=`blocked`
- Remove a node: `node_manage` action=`delete` id=`<NODE_ID>`

Valid statuses: `pending`, `approved`, `blocked`, `offline`, `online`.

## Remote Command Execution

- One-shot command: `node_manage` action=`system_run` id=`<NODE_ID>` command=`<CMD>` timeoutMs=`30000`
- Check if a binary exists: `node_manage` action=`system_which` id=`<NODE_ID>` command=`<BINARY>`

## Remote Process Management

1. Start a background process:
   - `process_manage` target=`node` nodeId=`<NODE_ID>` action=`start` command=`<CMD>` notify=`{"mode":"on_failure"}`
2. Check process status:
   - `process_manage` target=`node` nodeId=`<NODE_ID>` action=`status` processId=`<PID>`
3. Tail process logs:
   - `process_manage` target=`node` nodeId=`<NODE_ID>` action=`logs` processId=`<PID>` maxChars=`10000`
4. Stop a process:
   - `process_manage` target=`node` nodeId=`<NODE_ID>` action=`stop` processId=`<PID>` signal=`SIGTERM`
5. Force kill (if SIGTERM fails):
   - `process_manage` target=`node` nodeId=`<NODE_ID>` action=`stop` processId=`<PID>` signal=`SIGKILL`

## File Transfers

- Pull file from node: `node_manage` action=`file_pull` id=`<NODE_ID>` remotePath=`<REMOTE>` localPath=`<LOCAL>`
- Push file to node: `node_manage` action=`file_push` id=`<NODE_ID>` localPath=`<LOCAL>` remotePath=`<REMOTE>`
- Overwrite existing: add `overwrite=true`
- Size limit: `maxBytes` (default up to 50 MB)

## Troubleshooting Patterns

1. **Node offline**: Check if the node process is running on the host. Verify network connectivity.
2. **Command timeout**: Increase `timeoutMs` (max 300000). For long-running tasks, use `process_manage` action=`start` instead.
3. **Process crash**: Check logs with `process_manage` action=`logs`, review exit code in `process_manage` action=`status`.
4. **Auth failure**: Node may need re-approval. Check status with `get`, then `set_status` to `approved`.

## Guardrails

1. Always verify node status is `online` before sending commands.
2. Use `notify={"mode":"on_failure"}` for important background processes.
3. Prefer `SIGTERM` before `SIGKILL` when stopping processes.
4. Use absolute paths for all file operations.
5. Do not run destructive commands (rm -rf /, format, etc.) without explicit user confirmation.
