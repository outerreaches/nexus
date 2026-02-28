---
name: claude-code
description: Delegate coding tasks to Claude Code CLI through Nexus shell tools with safe execution-mode selection.
triggers: claude, claude code, claude-code, run claude, claude review
---

# Claude Code CLI (Nexus)

Use this skill when a task should be delegated to Claude Code CLI instead of being solved directly.

## Preflight (always do first)

1. Confirm Claude Code is available:
   - `command -v claude`
   - `claude --version`
2. Confirm CLI session/auth is usable:
   - `claude -p "Reply exactly with: ok" --output-format text --max-turns 1`
3. If Claude Code is missing or the probe returns auth/login/subscription/quota errors, stop and report the blocker.

## Execution Mode Selection (strict)

1. Use `shell_exec` for short, stateless, non-interactive runs:
   - Preferred default:
     - `bash -lc 'cd "<ABS_PATH>" && claude -p "<PROMPT>" --allowedTools "Edit,Read,Write,Bash" --output-format text'`
2. Use `shell_interactive` only for stateful multi-step workflows:
   - Required loop: `open -> send -> read -> ... -> close`
   - Never send multiple commands without reading output in between.
   - Never use sleep loops for waiting.
3. Use process tools for long-running/background tasks:
   - local: `process_start -> process_status/process_logs -> process_stop`
   - node: `node_manage` action=`process_start|process_status|process_logs|process_stop`

## Command Patterns

### One-shot coding task

- `bash -lc 'cd "<ABS_PATH>" && claude -p "<TASK_PROMPT>" --allowedTools "Edit,Read,Write,Bash" --output-format text'`

### One-shot coding task with max turns

- `bash -lc 'cd "<ABS_PATH>" && claude -p "<TASK_PROMPT>" --allowedTools "Edit,Read,Write,Bash" --output-format text --max-turns 20'`

### Capture final response to file

- `bash -lc 'cd "<ABS_PATH>" && claude -p "<TASK_PROMPT>" --output-format text > /tmp/claude-last.txt && cat /tmp/claude-last.txt'`

### JSON structured output

- `bash -lc 'cd "<ABS_PATH>" && claude -p "<TASK_PROMPT>" --output-format json'`

## Guardrails

1. Do not use dangerous flags:
   - Never use `--dangerously-skip-permissions`.
2. Do not place raw secrets/tokens in prompts.
3. Respect Nexus git policy:
   - Mutating git on the Nexus code repo is blocked via `shell_exec`.
4. Use absolute paths for `cd` targets and file operations.
5. Restrict `--allowedTools` to the minimum set needed for the task.
6. If Claude Code fails due to network/auth/provider issues, report exact error and continue task with native tools.

## Completion Protocol

1. Summarize what Claude Code changed or concluded.
2. Validate with relevant checks (typecheck/build/test/lint as appropriate).
3. Report risks, unresolved items, and next actions clearly.
