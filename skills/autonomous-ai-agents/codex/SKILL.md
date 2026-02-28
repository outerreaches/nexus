---
name: codex-cli
description: Delegate coding tasks to Codex CLI through Nexus shell tools with safe execution-mode selection.
triggers: codex, codex cli, gpt-5.3-codex, run codex, codex review
---

# Codex CLI (Nexus)

Use this skill when a task should be delegated to Codex CLI instead of being solved directly.

## Preflight (always do first)

1. Confirm Codex is available:
   - `command -v codex`
   - `codex --version`
2. Confirm auth:
   - `codex login status`
3. If Codex is missing or not authenticated, stop and report the blocker.

## Execution Mode Selection (strict)

1. Use `shell_exec` for short, stateless, non-interactive runs:
   - Preferred default:
     - `codex exec -C "<ABS_PATH>" --skip-git-repo-check --ephemeral -m gpt-5.3-codex "<PROMPT>"`
2. Use `shell_interactive` only for stateful multi-step workflows:
   - Required loop: `open -> send -> read -> ... -> close`
   - Never send multiple commands without reading output in between.
   - Never use sleep loops for waiting.
3. Use process tools for long-running/background tasks:
   - local: `process_start -> process_status/process_logs -> process_stop`
   - node: `node_manage` action=`process_start|process_status|process_logs|process_stop`

## Command Patterns

### One-shot coding task

- `codex exec -C "<ABS_PATH>" --skip-git-repo-check --ephemeral -m gpt-5.3-codex "<TASK_PROMPT>"`

### One-shot review task

- `codex exec -C "<ABS_PATH>" --skip-git-repo-check --ephemeral -m gpt-5.3-codex "Review current changes vs origin/main. Report findings by severity with file paths and line references, then list residual risks."`

### Capture final response to file

- `codex exec -C "<ABS_PATH>" --skip-git-repo-check --ephemeral -m gpt-5.3-codex -o /tmp/codex-last.txt "<TASK_PROMPT>" && cat /tmp/codex-last.txt`

## Guardrails

1. Do not use dangerous bypass flags:
   - Never use `--dangerously-bypass-approvals-and-sandbox`.
2. Do not place raw secrets/tokens in prompts.
3. Respect Nexus git policy:
   - Mutating git on the Nexus code repo is blocked via `shell_exec`.
4. Use absolute paths for `-C` and file operations.
5. If Codex fails due network/auth/provider issues, report exact error and continue task with native tools.

## Completion Protocol

1. Summarize what Codex changed or concluded.
2. Validate with relevant checks (typecheck/build/test/lint as appropriate).
3. Report risks, unresolved items, and next actions clearly.
