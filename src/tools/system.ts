import { exec } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { defineTool } from "../core/tools.js";

/** Hard cap on tool-result size to prevent context blow-up (chars, not bytes). */
const MAX_OUTPUT_CHARS = 60_000;

export function truncateShellOutput(text: string, max: number = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const omitted = text.length - max;
  return `${text.slice(0, half)}\n\n[…truncated ${omitted.toLocaleString()} chars…]\n\n${text.slice(-half)}`;
}

const MUTATING_GIT_SUBCMDS = new Set([
  "add", "commit", "push", "reset", "checkout", "switch", "stash",
  "rebase", "merge", "clean", "rm", "mv", "restore", "pull", "fetch",
  "cherry-pick", "revert", "tag", "branch", "init",
]);

/**
 * Returns true if the command is a mutating git operation targeting the code
 * directory. Commands with `-C <other-dir>` are allowed (they target a
 * different repo). Read-only commands like status/log/diff are allowed.
 */
function isUnderRoot(targetPath: string, rootPath: string): boolean {
  const rel = path.relative(resolveComparisonPath(rootPath), resolveComparisonPath(targetPath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveComparisonPath(targetPath: string): string {
  let cursor = path.resolve(targetPath);
  const tail: string[] = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    tail.unshift(path.basename(cursor));
    cursor = parent;
  }
  const base = existsSync(cursor) ? realpathSync.native(cursor) : path.resolve(cursor);
  return tail.length > 0 ? path.join(base, ...tail) : base;
}

export function isPathUnderRoot(targetPath: string, rootPath: string): boolean {
  return isUnderRoot(targetPath, rootPath);
}

function resolveCommandPath(input: string, cwd: string): string {
  if (path.isAbsolute(input)) return path.resolve(input);
  return path.resolve(cwd, input);
}

export function isMutatingGitOnCodeDir(command: string, codeDir: string, options?: { cwd?: string }): boolean {
  const commandCwd = options?.cwd ?? codeDir;
  // Quick check: does this command invoke git at all?
  if (!/(^|\s|&&|\||;)git\s/.test(command)) return false;

  // Extract individual commands (split on && ; |)
  const parts = command.split(/&&|;|\|/).map((s) => s.trim());
  for (const part of parts) {
    // Match "git ..." or "cd <somewhere> && git ..."
    const gitMatch = part.match(/(?:^|\s)git\s+(.*)/);
    if (!gitMatch) continue;

    const args = gitMatch[1].trim();

    // If -C is used and points somewhere other than codeDir, allow it
    const dashCMatch = args.match(/^-C\s+(\S+)\s+(.*)/);
    if (dashCMatch) {
      const targetDir = resolveCommandPath(dashCMatch[1], commandCwd);
      if (!isUnderRoot(targetDir, codeDir)) continue;
      // -C points at codeDir — check the subcommand
      const subcmd = dashCMatch[2].split(/\s/)[0];
      if (MUTATING_GIT_SUBCMDS.has(subcmd)) return true;
      continue;
    }

    // No -C — this targets the command cwd.
    if (!isUnderRoot(commandCwd, codeDir)) continue;
    const subcmd = args.split(/\s/)[0];
    if (MUTATING_GIT_SUBCMDS.has(subcmd)) return true;
  }

  return false;
}

const ORCHESTRATOR_SHELL_DELEGATE_RE = /(^|[;&|]\s*|\s)(node|npm|npx|pnpm|yarn|bun|tsx|ts-node)\b/i;

export function isOrchestratorShellDelegationCommand(command: string): boolean {
  return ORCHESTRATOR_SHELL_DELEGATE_RE.test(command);
}

export const shellExec = defineTool({
  name: "shell_exec",
  description:
    "Run a short-lived shell command (guarded; may be disabled). For long-running jobs/daemons use process_start.",
  nodeRoutable: true,
  parameters: z.object({
    command: z.string(),
    timeoutMs: z.number().int().positive().default(60_000),
    security: z
      .object({
        requireNexusBackend: z
          .boolean()
          .optional()
          .describe("Require routing to a Nexus backend node; fail if unmet."),
        requireHermesMode: z
          .boolean()
          .optional()
          .describe("Require routing to a Nexus node advertising hermes.mode.hermes; fail if unmet."),
      })
      .optional(),
  }),
  execute: async ({ command, timeoutMs }, ctx) => {
    if (!ctx.allowShellExec) return "ERROR: shell_exec is disabled by policy";
    if (ctx.abortSignal?.aborted) return "ERROR: run cancelled";
    if (ctx.request?.preset === "orchestrator" && isOrchestratorShellDelegationCommand(command)) {
      return (
        "ERROR: orchestrator must not use shell_exec to run local Node/package-manager commands. " +
        "Spawn a coder worker for code/deploy workflows, or use a different tool for the task."
      );
    }

    // Block mutating git commands that target the code repository.
    // Read-only commands (status, log, diff, show) are allowed.
    // Commands explicitly using -C to target a different directory are allowed.
    if (isMutatingGitOnCodeDir(command, ctx.codeDir, { cwd: ctx.codeDir })) {
      return "ERROR: Mutating git commands on the code repository are not allowed from agents. Use ha_deploy to queue a deploy.";
    }

    const cwd = ctx.codeDir;
    return await new Promise((resolve) => {
      exec(
        command,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          signal: ctx.abortSignal,
        },
        (err, stdout, stderr) => {
        if (err) {
          if (ctx.abortSignal?.aborted) {
            resolve("ERROR: run cancelled");
            return;
          }
          const anyErr = err as any;
          const isTimeout =
            Boolean(anyErr?.killed) &&
            typeof timeoutMs === "number" &&
            (String(err.message).toLowerCase().includes("timed out") || anyErr?.code === "ETIMEDOUT");
          const hint = isTimeout
            ? `\n\nHINT: This command exceeded ${timeoutMs}ms. If it should keep running (server/scheduler), start it with process_start and inspect with process_logs.`
            : "\n\nHINT: If this keeps failing with the same command, stop retrying and inspect STDERR (or switch approach)." +
              "\nFor exploratory probes, avoid shell control operators by default; run a single command and treat expected no-match/not-found outcomes as signal.";
          resolve(truncateShellOutput(`ERROR: ${err.message}${hint}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`));
        }
        else resolve(truncateShellOutput([stdout, stderr].filter(Boolean).join("\n")));
        },
      );
    });
  },
});
