# CODEGUIDE

This file is loaded into the **coder** prompt. Keep it short and operational.

## Core Workflow
1. Locate the repo root under `codeDir` (must include `package.json` and `src/`).
2. Read before editing (`file_read` with line ranges).
3. Apply minimal edits (`file_edit`, `file_edit_lines`, `file_write`) using absolute paths.
4. Validate (`npm run typecheck`, `npm run build`).
5. Deploy in the same coder run using `ha_deploy` with `action="apply"`.

## Hard Boundaries
- Coder may edit files under `codeDir`.
- Use absolute paths under `workspaceDir` for scratch files.
- Do not use `gateway_restart` for code rollout.
- Do not run mutating git commands from coder runs (`git add/commit/push/reset`).
- Use `ha_deploy` for host-side git + Docker rollout.

## Runtime Paths
- `stateDir`: persistent state/config (`SOUL.md`, `AGENTS.md`, `USER.md`, `CODEGUIDE.md`, `HEARTBEAT.md`, `NOTES.md`)
- `codeDir`: source tree for code edits
- `workspaceDir`: scratch area

Production recommendation:
```json
{
  "codeDir": "${NEXUS_CODE_DIR}",
  "workspaceDir": "${NEXUS_WORKSPACE_DIR}"
}
```

Expected mounts:
- `/data/code` -> `NEXUS_CODE_DIR`
- `/data/workspace` -> `NEXUS_WORKSPACE_DIR`

Sanity check:
```text
file_list path="/data/code"
```

## Preset Routing Rule
When adding/updating presets:
- `llm.primary.provider` must match a configured provider key (usually `default` or `local`).
- For OpenRouter models, keep `provider: "default"` and set `model` explicitly (examples: `anthropic/claude-opus-4.6`, `openai/gpt-5.2-codex`).

## Retry Policy (Enforced)
Tool errors may include normalized tags like `[ERROR_CLASS=... retry=...]`. This policy is now **enforced** by the runner:
- `retry=no`: do not repeat the same tool call with identical args; it will be blocked for the rest of the run.
- `retry=yes`: at most one identical retry is allowed; further identical calls are blocked.
- `retry=after_backoff`: same as `retry=yes`, but wait/back off first.

## Shell Probes (Avoid False Failures)
For exploratory `shell_exec` probes (grep/head/curl checks), treat “no match” as an expected outcome:
- Make probes non-fatal: append `|| true`, or emit explicit `YES/NO` output.
- Prefer small single-purpose commands over long pipelines so failures are easier to interpret.

## State File Edits
Use absolute paths under `stateDir`, for example:
```text
file_edit path="/data/nexus/CODEGUIDE.md"
```

For existing files, prefer `file_edit`/`file_edit_lines`.
Use `file_write mode="append"` for additions and `file_write mode="overwrite"` only for full replacement.

## Troubleshooting
- Read-only edit failures: verify writable `/data/code` and `NEXUS_ALLOW_CODE_WRITE=1`.
- Missing files: verify `file_list path="/data/code"` shows `package.json`.
- No behavior change after deploy: verify `ha_deploy` completed successfully.
- HA issues: verify only one active node via dashboard HA status.
