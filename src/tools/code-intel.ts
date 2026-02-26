import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import { resolveWithinRoots } from "./path-utils.js";

const execFileAsync = promisify(execFile);

const ABSOLUTE_PATH_ERROR = "ERROR: full absolute `path` is required.";

type CodeToolContext = {
  workspaceDir: string;
  stateDir: string;
  codeDir: string;
  allowCodeEdit?: boolean;
};

type CodeSearchResult = {
  kind: "match" | "context";
  file: string;
  line: number;
  column: number | null;
  text: string;
};

function allowedRoots(ctx: CodeToolContext): string[] {
  return [ctx.stateDir, ctx.workspaceDir, ...(ctx.allowCodeEdit ? [ctx.codeDir] : [])];
}

function resolveAbsolutePath(params: {
  ctx: CodeToolContext;
  inputPath: string;
}): { ok: true; fullPath: string } | { ok: false; error: string } {
  const trimmed = params.inputPath.trim();
  if (!trimmed) return { ok: false, error: "ERROR: path is required." };
  if (!path.isAbsolute(trimmed)) {
    return { ok: false, error: ABSOLUTE_PATH_ERROR };
  }
  try {
    const fullPath = resolveWithinRoots({
      inputPath: trimmed,
      defaultRoot: params.ctx.workspaceDir,
      roots: allowedRoots(params.ctx),
    });
    return { ok: true, fullPath };
  } catch (err) {
    return { ok: false, error: `ERROR: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…(+${text.length - maxChars} chars)`;
}

function normalizeDisplayPath(rootPath: string, rawPath: string): string {
  const resolved = path.isAbsolute(rawPath) ? rawPath : path.resolve(rootPath, rawPath);
  const rel = path.relative(rootPath, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return resolved;
  return rel;
}

async function runCommand(params: {
  binary: string;
  args: string[];
  cwd?: string;
  allowCodeOne?: boolean;
}): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; error: string; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(params.binary, params.args, {
      cwd: params.cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      ok: true,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
    };
  } catch (err) {
    const anyErr = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (anyErr.code === "ENOENT") {
      return {
        ok: false,
        error: `ERROR: ${params.binary} executable not found in PATH.`,
        stdout: anyErr.stdout ?? "",
        stderr: anyErr.stderr ?? "",
      };
    }
    if (params.allowCodeOne && Number(anyErr.code) === 1) {
      return {
        ok: true,
        stdout: anyErr.stdout ?? "",
        stderr: anyErr.stderr ?? "",
      };
    }
    const message = [anyErr.message ?? "", anyErr.stderr ?? "", anyErr.stdout ?? ""]
      .filter(Boolean)
      .join("\n");
    return {
      ok: false,
      error: `ERROR: command failed (${params.binary} ${params.args.join(" ")}): ${truncate(message, 600)}`,
      stdout: anyErr.stdout ?? "",
      stderr: anyErr.stderr ?? "",
    };
  }
}

function parseCodeSearchJson(params: {
  stdout: string;
  rootPath: string;
  maxResults: number;
}): { results: CodeSearchResult[]; truncated: boolean; totalEvents: number } {
  const results: CodeSearchResult[] = [];
  let totalEvents = 0;
  let truncated = false;

  const lines = params.stdout.split(/\r?\n/);
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const event = parsed as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "";
    if (type !== "match" && type !== "context") continue;

    const data = event.data as Record<string, unknown> | undefined;
    const pathData = data?.path as Record<string, unknown> | undefined;
    const linesData = data?.lines as Record<string, unknown> | undefined;
    const rawPath = typeof pathData?.text === "string" ? pathData.text : "";
    const line = typeof data?.line_number === "number" ? data.line_number : 0;
    if (!rawPath || !Number.isFinite(line) || line <= 0) continue;

    totalEvents += 1;
    if (results.length >= params.maxResults) {
      truncated = true;
      continue;
    }

    const file = normalizeDisplayPath(params.rootPath, rawPath);
    const text = typeof linesData?.text === "string" ? linesData.text.replace(/\r?\n$/, "") : "";

    let column: number | null = null;
    if (type === "match") {
      const submatches = Array.isArray(data?.submatches) ? data?.submatches as Array<Record<string, unknown>> : [];
      const first = submatches[0];
      const start = typeof first?.start === "number" ? first.start : null;
      if (start !== null && Number.isFinite(start)) {
        column = start + 1;
      }
    }

    results.push({
      kind: type,
      file,
      line,
      column,
      text,
    });
  }

  return { results, truncated, totalEvents };
}

export const codeSearch = defineTool({
  name: "code_search",
  description:
    "Search code using ripgrep and return structured file/line matches. " +
    "Use this for fast codebase navigation instead of shell grep.",
  parameters: z.object({
    path: z.string().describe("Absolute path to a file or directory to search."),
    query: z.string().min(1).describe("Search query (literal by default)."),
    literal: z.boolean().default(true).describe("Treat query as literal text (default true)."),
    caseSensitive: z.boolean().default(false),
    wordMatch: z.boolean().default(false).describe("Require whole-word matches."),
    contextLines: z.number().int().min(0).max(6).default(0),
    includeGlobs: z.array(z.string().min(1)).max(40).optional().describe("Optional include globs for ripgrep (-g)."),
    excludeGlobs: z.array(z.string().min(1)).max(40).optional().describe("Optional exclude globs for ripgrep (-g '!pattern')."),
    maxResults: z.number().int().min(1).max(1_000).default(200),
  }),
  execute: async ({ path: inputPath, query, literal, caseSensitive, wordMatch, contextLines, includeGlobs, excludeGlobs, maxResults }, ctx) => {
    const resolved = resolveAbsolutePath({ ctx, inputPath });
    if (!resolved.ok) return resolved.error;
    const fullPath = resolved.fullPath;

    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
    const rootPath = stat.isDirectory() ? fullPath : path.dirname(fullPath);

    const args: string[] = ["--json", "--line-number", "--column", "--no-heading", "--color", "never"];
    if (literal) args.push("-F");
    if (!caseSensitive) args.push("-i");
    if (wordMatch) args.push("-w");
    if (contextLines > 0) {
      args.push("-C", String(contextLines));
    }
    if (Array.isArray(includeGlobs)) {
      for (const pattern of includeGlobs) args.push("-g", pattern);
    }
    if (Array.isArray(excludeGlobs)) {
      for (const pattern of excludeGlobs) args.push("-g", `!${pattern}`);
    }
    args.push(query, fullPath);

    const run = await runCommand({
      binary: "rg",
      args,
      allowCodeOne: true,
    });
    if (!run.ok) return run.error;

    const parsed = parseCodeSearchJson({
      stdout: run.stdout,
      rootPath,
      maxResults,
    });

    return JSON.stringify(
      {
        ok: true,
        query,
        path: fullPath,
        totalEvents: parsed.totalEvents,
        returned: parsed.results.length,
        truncated: parsed.truncated,
        results: parsed.results,
      },
      null,
      2,
    );
  },
});

export const fileGlob = defineTool({
  name: "file_glob",
  description:
    "Find files quickly using ripgrep's --files mode with glob filters. " +
    "Returns paths relative to the provided directory.",
  parameters: z.object({
    path: z.string().describe("Absolute directory path to scan."),
    patterns: z.array(z.string().min(1)).max(40).default(["**/*"]).describe("Include glob patterns."),
    exclude: z.array(z.string().min(1)).max(40).default([]).describe("Exclude glob patterns."),
    includeHidden: z.boolean().default(false),
    maxEntries: z.number().int().min(1).max(10_000).default(500),
  }),
  execute: async ({ path: inputPath, patterns, exclude, includeHidden, maxEntries }, ctx) => {
    const resolved = resolveAbsolutePath({ ctx, inputPath });
    if (!resolved.ok) return resolved.error;
    const fullPath = resolved.fullPath;

    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!stat.isDirectory()) {
      return "ERROR: file_glob path must be a directory.";
    }

    const args: string[] = ["--files", "--color", "never"];
    if (includeHidden) args.push("--hidden");
    for (const pattern of patterns) {
      args.push("-g", pattern);
    }
    for (const pattern of exclude) {
      args.push("-g", `!${pattern}`);
    }
    args.push(fullPath);

    const run = await runCommand({
      binary: "rg",
      args,
      allowCodeOne: true,
    });
    if (!run.ok) return run.error;

    const lines = run.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => normalizeDisplayPath(fullPath, line));

    const truncated = lines.length > maxEntries;
    const files = truncated ? lines.slice(0, maxEntries) : lines;

    return JSON.stringify(
      {
        ok: true,
        path: fullPath,
        returned: files.length,
        truncated,
        files,
      },
      null,
      2,
    );
  },
});

export const codeDiff = defineTool({
  name: "code_diff",
  description:
    "Show a structured git diff summary for a repository/worktree. " +
    "Useful for pre-deploy review of aggregate changes.",
  parameters: z.object({
    path: z.string().optional().describe("Optional absolute repo root path. Defaults to codeDir."),
    staged: z.boolean().default(false).describe("Use staged diff (--cached)."),
    contextLines: z.number().int().min(0).max(20).default(3),
    maxChars: z.number().int().min(1_000).max(120_000).default(30_000),
    maxFileEntries: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(1_000)
      .describe("Maximum changed/untracked file paths to include in the response lists."),
    includeUntracked: z.boolean().default(true),
    filesOnly: z.boolean().default(false),
  }),
  execute: async ({ path: inputPath, staged, contextLines, maxChars, maxFileEntries, includeUntracked, filesOnly }, ctx) => {
    const resolvedRoot = inputPath
      ? resolveAbsolutePath({ ctx, inputPath })
      : { ok: true as const, fullPath: ctx.codeDir };
    if (!resolvedRoot.ok) return resolvedRoot.error;
    const rootPath = resolvedRoot.fullPath;

    const repoProbe = await runCommand({
      binary: "git",
      args: ["-C", rootPath, "rev-parse", "--is-inside-work-tree"],
    });
    if (!repoProbe.ok) {
      return `ERROR: path is not a git repository: ${rootPath}`;
    }

    const diffBaseArgs = ["-C", rootPath, "diff", ...(staged ? ["--cached"] : [])];

    const nameOnly = await runCommand({
      binary: "git",
      args: [...diffBaseArgs, "--name-only"],
      allowCodeOne: true,
    });
    if (!nameOnly.ok) return nameOnly.error;

    const stat = await runCommand({
      binary: "git",
      args: [...diffBaseArgs, "--stat", "--no-color"],
      allowCodeOne: true,
    });
    if (!stat.ok) return stat.error;

    let diffText = "";
    let truncated = false;
    if (!filesOnly) {
      const diff = await runCommand({
        binary: "git",
        args: [...diffBaseArgs, "--no-color", `-U${contextLines}`],
        allowCodeOne: true,
      });
      if (!diff.ok) return diff.error;
      diffText = diff.stdout ?? "";
      if (diffText.length > maxChars) {
        diffText = `${diffText.slice(0, maxChars)}\n\n[…diff truncated ${diffText.length - maxChars} chars…]`;
        truncated = true;
      }
    }

    let untrackedAll: string[] = [];
    let untracked: string[] = [];
    let untrackedTruncated = false;
    if (includeUntracked) {
      const untrackedCmd = await runCommand({
        binary: "git",
        args: ["-C", rootPath, "ls-files", "--others", "--exclude-standard"],
        allowCodeOne: true,
      });
      if (!untrackedCmd.ok) return untrackedCmd.error;
      untrackedAll = (untrackedCmd.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      untrackedTruncated = untrackedAll.length > maxFileEntries;
      untracked = untrackedTruncated ? untrackedAll.slice(0, maxFileEntries) : untrackedAll;
    }

    const changedFilesAll = (nameOnly.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const changedFilesTruncated = changedFilesAll.length > maxFileEntries;
    const changedFiles = changedFilesTruncated ? changedFilesAll.slice(0, maxFileEntries) : changedFilesAll;
    const payloadTruncated = truncated || changedFilesTruncated || untrackedTruncated;

    return JSON.stringify(
      {
        ok: true,
        path: rootPath,
        staged,
        changedFileCount: changedFilesAll.length,
        changedFilesReturned: changedFiles.length,
        changedFilesTruncated,
        changedFiles,
        untrackedCount: untrackedAll.length,
        untrackedReturned: untracked.length,
        untrackedTruncated,
        untracked,
        stat: (stat.stdout ?? "").trim(),
        filesOnly,
        diff: filesOnly ? null : diffText,
        truncated: payloadTruncated,
      },
      null,
      2,
    );
  },
});
