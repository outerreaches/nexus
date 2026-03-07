import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import { resolveWithinRoots } from "./path-utils.js";

const execFileAsync = promisify(execFile);

const MAX_READ_LINES = 1_000;
const MAX_READ_BYTES = 192 * 1024;
const MAX_READ_SEARCH_MATCHES = 500;
const DIFF_CONTEXT_LINES = 3;
const ABSOLUTE_PATH_ERROR = "ERROR: full absolute `path` is required.";

const FILE_PATCH_MAX_OUTPUT_BYTES = 12 * 1024;

type FileToolContext = {
  workspaceDir: string;
  stateDir: string;
  codeDir: string;
  allowCodeEdit?: boolean;
  allowCodeWrite?: boolean;
  request?: {
    preset?: string;
  };
};

function allowedRoots(ctx: FileToolContext): string[] {
  return [ctx.stateDir, ctx.workspaceDir, ...(ctx.allowCodeEdit ? [ctx.codeDir] : [])];
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

function isUnderRoot(targetPath: string, rootDir: string): boolean {
  const rel = path.relative(resolveComparisonPath(rootDir), resolveComparisonPath(targetPath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveAbsolutePath(params: {
  ctx: FileToolContext;
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

function codeWritePolicyError(params: {
  ctx: FileToolContext;
  targetPath: string;
}): string | null {
  if (!isUnderRoot(params.targetPath, params.ctx.codeDir)) return null;
  if (params.ctx.request?.preset === "orchestrator") {
    return (
      "ERROR: orchestrator must not edit repository code directly. " +
      "Spawn a coder worker with taskType='write' for code changes, or taskType='review'/'walkthrough' for read-only code tasks."
    );
  }
  if (!params.ctx.allowCodeWrite) {
    return (
      "ERROR: code root is read-only in this runtime. " +
      "Enable host writable code mount and set NEXUS_ALLOW_CODE_WRITE=1 for direct code edits."
    );
  }
  return null;
}

function truncateByBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return { text, truncated: false };
  }
  return { text: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

function normalizePosixRelative(relPath: string): string {
  return relPath.split(path.sep).join("/");
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(glob: string): RegExp {
  const source = normalizePosixRelative(glob.trim().replace(/^\.\//, ""));
  if (!source || source === "**") return /^.*$/;

  let out = "^";
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;

    if (ch === "*") {
      const next = source[i + 1];
      if (next === "*") {
        const after = source[i + 2];
        if (after === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }

    if (ch === "?") {
      out += "[^/]";
      continue;
    }

    out += escapeRegExp(ch);
  }

  out += "$";
  return new RegExp(out);
}

function matchesGlobCandidate(relPath: string, glob: string): boolean {
  const normalizedPath = normalizePosixRelative(relPath);
  const normalizedGlob = normalizePosixRelative(glob);
  if (normalizedGlob === "**") return true;
  const re = globToRegExp(normalizedGlob);
  return re.test(normalizedPath);
}

function buildLineDiff(before: string, after: string): string {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);

  let start = 0;
  while (
    start < beforeLines.length &&
    start < afterLines.length &&
    beforeLines[start] === afterLines[start]
  ) {
    start += 1;
  }

  let endBefore = beforeLines.length - 1;
  let endAfter = afterLines.length - 1;
  while (endBefore >= start && endAfter >= start && beforeLines[endBefore] === afterLines[endAfter]) {
    endBefore -= 1;
    endAfter -= 1;
  }

  const beforeCount = Math.max(0, endBefore - start + 1);
  const afterCount = Math.max(0, endAfter - start + 1);
  if (beforeCount === 0 && afterCount === 0) {
    return "No changes.";
  }

  const contextStart = Math.max(0, start - DIFF_CONTEXT_LINES);
  const contextEnd = Math.min(
    Math.max(endBefore, endAfter) + DIFF_CONTEXT_LINES,
    Math.max(beforeLines.length, afterLines.length) - 1,
  );

  const beforeContextCount = Math.max(0, Math.min(endBefore, contextEnd) - contextStart + 1);
  const afterContextCount = Math.max(0, Math.min(endAfter, contextEnd) - contextStart + 1);

  const diffLines = [`@@ -${contextStart + 1},${beforeContextCount} +${contextStart + 1},${afterContextCount} @@`];

  for (let i = contextStart; i <= contextEnd; i += 1) {
    const inBefore = i >= start && i <= endBefore;
    if (inBefore) {
      diffLines.push(`-${beforeLines[i] ?? ""}`);
    } else if (i < beforeLines.length) {
      diffLines.push(` ${beforeLines[i] ?? ""}`);
    }
  }
  for (let i = contextStart; i <= contextEnd; i += 1) {
    if (i >= start && i <= endAfter) {
      diffLines.push(`+${afterLines[i] ?? ""}`);
    }
  }

  const diffText = diffLines.join("\n");
  const trimmed = truncateByBytes(diffText, 4_000);
  return trimmed.truncated ? `${trimmed.text}\n[diff truncated]` : trimmed.text;
}

type SearchMatch = {
  line: number;
  text: string;
};

function findSearchMatches(params: {
  lines: string[];
  search: string;
  searchRegex: boolean;
  caseSensitive: boolean;
  maxMatches: number;
}): { matches: SearchMatch[]; totalMatches: number; truncatedByMatchLimit: boolean; error?: string } {
  const matches: SearchMatch[] = [];
  let totalMatches = 0;

  let regex: RegExp | null = null;
  if (params.searchRegex) {
    try {
      regex = new RegExp(params.search, params.caseSensitive ? "" : "i");
    } catch (err) {
      return {
        matches: [],
        totalMatches: 0,
        truncatedByMatchLimit: false,
        error: `ERROR: invalid search regex: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const needle = params.caseSensitive ? params.search : params.search.toLowerCase();

  for (let i = 0; i < params.lines.length; i += 1) {
    const line = params.lines[i] ?? "";
    const hay = params.caseSensitive ? line : line.toLowerCase();
    const found = regex ? regex.test(line) : hay.includes(needle);
    if (!found) continue;

    totalMatches += 1;
    if (matches.length < params.maxMatches) {
      matches.push({
        line: i + 1,
        text: line,
      });
    }
  }

  return {
    matches,
    totalMatches,
    truncatedByMatchLimit: totalMatches > params.maxMatches,
  };
}

function renderSearchOutput(params: {
  lines: string[];
  matches: SearchMatch[];
  totalMatches: number;
  contextLines: number;
  truncatedByMatchLimit: boolean;
}): string {
  if (params.totalMatches === 0) {
    return "OK: no matches.";
  }

  const matchedLineNumbers = new Set(params.matches.map((m) => m.line));
  const included = new Set<number>();
  for (const match of params.matches) {
    const start = Math.max(1, match.line - params.contextLines);
    const end = Math.min(params.lines.length, match.line + params.contextLines);
    for (let n = start; n <= end; n += 1) included.add(n);
  }

  const sorted = Array.from(included.values()).sort((a, b) => a - b);
  const out: string[] = [];
  out.push(
    `Search matches: ${params.totalMatches}${params.truncatedByMatchLimit ? ` (showing first ${params.matches.length})` : ""}`,
  );
  out.push("");

  let prev = -1;
  for (const lineNo of sorted) {
    if (prev > 0 && lineNo - prev > 1) out.push("...");
    const marker = matchedLineNumbers.has(lineNo) ? ">" : " ";
    out.push(`${marker} ${lineNo}: ${params.lines[lineNo - 1] ?? ""}`);
    prev = lineNo;
  }

  return out.join("\n");
}

function findOccurrences(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let index = 0;
  for (;;) {
    const pos = haystack.indexOf(needle, index);
    if (pos < 0) break;
    out.push(pos);
    index = pos + needle.length;
  }
  return out;
}

function sanitizePatchPath(raw: string): string | null {
  let value = raw.trim();
  if (!value || value === "/dev/null") return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (value.startsWith("a/") || value.startsWith("b/")) {
    value = value.slice(2);
  }
  if (!value || path.isAbsolute(value)) return null;

  const normalized = path.normalize(value).replace(/\\/g, "/");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    return null;
  }
  return normalized;
}

function extractPatchPaths(patchText: string): string[] {
  const files = new Set<string>();
  const lines = patchText.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("--- ") && !line.startsWith("+++ ")) continue;
    const candidate = line.slice(4);
    const tabIdx = candidate.indexOf("\t");
    const rawPath = tabIdx >= 0 ? candidate.slice(0, tabIdx) : candidate;
    const clean = sanitizePatchPath(rawPath);
    if (clean) files.add(clean);
  }
  return Array.from(files.values()).sort((a, b) => a.localeCompare(b));
}

function truncatePatchCommandOutput(text: string): string {
  return truncateByBytes(text.trim(), FILE_PATCH_MAX_OUTPUT_BYTES).text;
}

async function runGitApply(params: {
  cwd: string;
  patchPath: string;
  strip: number;
  checkOnly: boolean;
}): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; error: string }> {
  const checkArgs = [
    "apply",
    "--no-index",
    "--whitespace=nowarn",
    `-p${params.strip}`,
    "--check",
    params.patchPath,
  ];

  try {
    await execFileAsync("git", checkArgs, {
      cwd: params.cwd,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
    });
  } catch (err) {
    const anyErr = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (anyErr.code === "ENOENT") {
      return { ok: false, error: "ERROR: git executable not found (required for file_patch)." };
    }
    const detail = truncatePatchCommandOutput([anyErr.message ?? "", anyErr.stdout ?? "", anyErr.stderr ?? ""].join("\n"));
    return { ok: false, error: `ERROR: patch check failed\n${detail}` };
  }

  if (params.checkOnly) {
    return { ok: true, stdout: "", stderr: "" };
  }

  const applyArgs = [
    "apply",
    "--no-index",
    "--whitespace=nowarn",
    `-p${params.strip}`,
    params.patchPath,
  ];

  try {
    const { stdout, stderr } = await execFileAsync("git", applyArgs, {
      cwd: params.cwd,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
    });
    return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err) {
    const anyErr = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (anyErr.code === "ENOENT") {
      return { ok: false, error: "ERROR: git executable not found (required for file_patch)." };
    }
    const detail = truncatePatchCommandOutput([anyErr.message ?? "", anyErr.stdout ?? "", anyErr.stderr ?? ""].join("\n"));
    return { ok: false, error: `ERROR: failed to apply patch\n${detail}` };
  }
}

export const fileRead = defineTool({
  name: "file_read",
  description:
    "Read a text file (optionally by range, offset/limit, or in-file search). Absolute path is required. " +
    `Output is truncated to ${MAX_READ_LINES} lines or ${Math.round(MAX_READ_BYTES / 1024)}KB.`,
  parameters: z.object({
    path: z.string().describe("Absolute file path (required)."),
    startLine: z.number().int().positive().optional().describe("1-based start line"),
    endLine: z.number().int().positive().optional().describe("1-based end line (inclusive)"),
    offset: z.number().int().positive().optional().describe("1-based line offset (pi-style)"),
    limit: z.number().int().positive().optional().describe("Maximum number of lines to read (pi-style)"),
    withLineNumbers: z.boolean().default(false).describe("Prefix lines with 1-based line numbers (e.g., '12: ...')."),
    search: z.string().min(1).optional().describe("Optional in-file search query. Returns matching lines with context."),
    searchRegex: z.boolean().default(false).describe("Treat `search` as a regex pattern when true."),
    caseSensitive: z.boolean().default(false).describe("Use case-sensitive matching for `search`."),
    contextLines: z.number().int().min(0).max(20).default(2).describe("Context lines before/after each search match."),
    maxMatches: z.number().int().min(1).max(MAX_READ_SEARCH_MATCHES).default(80).describe("Maximum search matches to include."),
  }),
  execute: async (
    { path: inputPath, startLine, endLine, offset, limit, withLineNumbers, search, searchRegex, caseSensitive, contextLines, maxMatches },
    ctx,
  ) => {
    const resolved = resolveAbsolutePath({ ctx, inputPath });
    if (!resolved.ok) return resolved.error;
    const fullPath = resolved.fullPath;

    let text: string;
    try {
      text = await fs.readFile(fullPath, "utf8");
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }

    const rawLines = text.split(/\r?\n/);
    const hadTrailingNewline = text.endsWith("\n");
    const lines = hadTrailingNewline ? rawLines.slice(0, -1) : rawLines;

    if (typeof search === "string" && search.length > 0) {
      const searchResult = findSearchMatches({
        lines,
        search,
        searchRegex,
        caseSensitive,
        maxMatches,
      });
      if (searchResult.error) return searchResult.error;

      let output = renderSearchOutput({
        lines,
        matches: searchResult.matches,
        totalMatches: searchResult.totalMatches,
        contextLines,
        truncatedByMatchLimit: searchResult.truncatedByMatchLimit,
      });

      const byteTrimmed = truncateByBytes(output, MAX_READ_BYTES);
      output = byteTrimmed.text;
      if (byteTrimmed.truncated) {
        output += `\n\n[Output truncated to ${Math.round(MAX_READ_BYTES / 1024)}KB. Narrow the search or lower contextLines.]`;
      }
      return output;
    }

    const resolvedStartLine = startLine ?? offset ?? 1;
    const resolvedEndLine = endLine ?? (limit ? resolvedStartLine + limit - 1 : lines.length);
    const start = Math.max(resolvedStartLine - 1, 0);
    const end = Math.min(resolvedEndLine - 1, lines.length - 1);
    let slice = lines.slice(start, end + 1);

    let truncatedByLines = false;
    if (slice.length > MAX_READ_LINES) {
      slice = slice.slice(0, MAX_READ_LINES);
      truncatedByLines = true;
    }

    const numbered = withLineNumbers
      ? slice.map((line, i) => `${start + i + 1}: ${line}`)
      : slice;
    let output = numbered.join("\n");
    const byteTrimmed = truncateByBytes(output, MAX_READ_BYTES);
    if (!startLine && !endLine && !offset && !limit && !withLineNumbers && !truncatedByLines && !byteTrimmed.truncated) {
      return text;
    }
    output = byteTrimmed.text;

    if (truncatedByLines || byteTrimmed.truncated) {
      const shownLines = slice.length;
      const endLineShown = start + shownLines;
      const nextStart = endLineShown + 1;
      const truncationNotes: string[] = [];
      if (truncatedByLines) {
        truncationNotes.push(
          `Showing lines ${start + 1}-${endLineShown} of ${lines.length}. Use startLine=${nextStart} to continue.`,
        );
      }
      if (byteTrimmed.truncated) {
        truncationNotes.push(
          `Output truncated to ${Math.round(MAX_READ_BYTES / 1024)}KB. Use a smaller line range to continue.`,
        );
      }
      output += `\n\n[${truncationNotes.join(" ")}]`;
    }

    return output;
  },
});

export const fileWrite = defineTool({
  name: "file_write",
  description:
    "Write a text file (creates parent dirs). Absolute path is required. " +
    "Use mode 'create' (default) for new files, 'append' to add to existing files, " +
    "or 'overwrite' to replace existing files entirely. To modify part of a file, use file_edit instead.",
  parameters: z.object({
    path: z.string().describe("Absolute file path (required)."),
    content: z.string().describe("File contents"),
    mode: z
      .enum(["create", "overwrite", "append"])
      .default("create")
      .describe("'create' fails if file exists, 'overwrite' replaces, 'append' adds to end"),
  }),
  execute: async ({ path: inputPath, content, mode }, ctx) => {
    const resolved = resolveAbsolutePath({ ctx, inputPath });
    if (!resolved.ok) return resolved.error;
    const fullPath = resolved.fullPath;
    const policyError = codeWritePolicyError({ ctx, targetPath: fullPath });
    if (policyError) return policyError;
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    if (mode === "create") {
      try {
        await fs.access(fullPath);
        return `ERROR: file already exists at ${fullPath}. Use file_edit to modify existing files, or mode 'overwrite' to replace entirely.`;
      } catch {
        // File doesn't exist, proceed with creation
      }
    }

    if (mode === "append") {
      await fs.appendFile(fullPath, content, "utf8");
    } else {
      await fs.writeFile(fullPath, content, "utf8");
    }
    return `OK: wrote ${fullPath}`;
  },
});

export const fileList = defineTool({
  name: "file_list",
  description: "List files/directories. Absolute path is required.",
  parameters: z.object({
    path: z.string().describe("Absolute directory path (required)."),
    recursive: z.boolean().default(false),
    maxEntries: z.number().int().positive().max(5_000).default(200),
    filterGlob: z.string().optional().describe("Optional include glob (relative to path), e.g. '**/*.test.ts'."),
    excludeGlob: z.string().optional().describe("Optional exclude glob (relative to path)."),
  }),
  execute: async ({ path: inputPath, recursive, maxEntries, filterGlob, excludeGlob }, ctx) => {
    const resolved = resolveAbsolutePath({ ctx, inputPath });
    if (!resolved.ok) return resolved.error;
    const fullPath = resolved.fullPath;

    const includeGlob = filterGlob?.trim() || null;
    const skipGlob = excludeGlob?.trim() || null;

    const results: string[] = [];
    async function walk(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const fullEntryPath = path.join(dir, entry.name);
        const rel = path.relative(fullPath, fullEntryPath);
        const relPosix = normalizePosixRelative(rel);
        const display = entry.isDirectory() ? `${relPosix}/` : relPosix;

        const included = includeGlob ? matchesGlobCandidate(display, includeGlob) : true;
        const excluded = skipGlob ? matchesGlobCandidate(display, skipGlob) : false;
        if (included && !excluded) {
          results.push(display);
          if (results.length >= maxEntries) return;
        }

        if (recursive && entry.isDirectory()) {
          await walk(fullEntryPath);
          if (results.length >= maxEntries) return;
        }
      }
    }

    try {
      await walk(fullPath);
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (results.length === 0) {
      return "";
    }

    return results.join("\n");
  },
});

export const fileEdit = defineTool({
  name: "file_edit",
  description:
    "Edit a file by replacing an exact string match. Absolute path is required. " +
    "By default requires a unique match; use occurrence to select a specific match index.",
  parameters: z.object({
    path: z.string().describe("Absolute file path (required)."),
    find: z.string().describe("Exact text to find"),
    replace: z.string().describe("Replacement text"),
    occurrence: z.number().int().positive().optional().describe("1-based occurrence index when find matches multiple times."),
  }),
  execute: async ({ path: inputPath, find, replace, occurrence }, ctx) => {
    const resolved = resolveAbsolutePath({ ctx, inputPath });
    if (!resolved.ok) return resolved.error;
    const fullPath = resolved.fullPath;
    const policyError = codeWritePolicyError({ ctx, targetPath: fullPath });
    if (policyError) return policyError;
    if (find.length === 0) {
      return "ERROR: find text must be non-empty.";
    }

    let text: string;
    try {
      text = await fs.readFile(fullPath, "utf8");
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }

    const indexes = findOccurrences(text, find);
    if (indexes.length === 0) {
      return "ERROR: find text not found. Use file_read with withLineNumbers:true, then use file_edit_lines to edit by line range instead. To append new content, use file_write with mode 'append'.";
    }

    if (indexes.length > 1 && occurrence === undefined) {
      return `ERROR: find text is not unique (${indexes.length} matches). Provide more context or set occurrence (1-${indexes.length}).`;
    }

    const targetOccurrence = occurrence ?? 1;
    if (targetOccurrence > indexes.length) {
      return `ERROR: occurrence ${targetOccurrence} is out of range (matches=${indexes.length}).`;
    }

    const idx = indexes[targetOccurrence - 1]!;
    const next = text.slice(0, idx) + replace + text.slice(idx + find.length);
    if (next === text) {
      return "ERROR: replacement produced no changes. Check the find/replace text for exact matches.";
    }

    await fs.writeFile(fullPath, next, "utf8");
    const diff = buildLineDiff(text, next);
    const suffix = indexes.length > 1 ? ` (occurrence ${targetOccurrence}/${indexes.length})` : "";
    return `OK${suffix}\n\nDiff:\n${diff}`;
  },
});

export const filePatch = defineTool({
  name: "file_patch",
  description:
    "Apply a unified diff patch under a root directory. Uses git apply --no-index. " +
    "Absolute rootPath is required.",
  parameters: z.object({
    rootPath: z.string().describe("Absolute directory path where patch paths are resolved."),
    patch: z.string().min(1).describe("Unified diff patch content."),
    strip: z.number().int().min(0).max(6).default(0).describe("Equivalent to git apply -pN."),
    checkOnly: z.boolean().default(false).describe("Validate patch only; do not modify files."),
  }),
  execute: async ({ rootPath: inputRootPath, patch, strip, checkOnly }, ctx) => {
    const resolved = resolveAbsolutePath({ ctx, inputPath: inputRootPath });
    if (!resolved.ok) return resolved.error;
    const fullRootPath = resolved.fullPath;

    let stat;
    try {
      stat = await fs.stat(fullRootPath);
    } catch (err) {
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!stat.isDirectory()) {
      return "ERROR: rootPath must be a directory.";
    }

    const patchPaths = extractPatchPaths(patch);
    if (patchPaths.length === 0) {
      return "ERROR: patch does not contain any file paths (expected ---/+++ headers).";
    }

    for (const relPatchPath of patchPaths) {
      const targetPath = path.resolve(fullRootPath, relPatchPath);
      if (!isUnderRoot(targetPath, fullRootPath)) {
        return `ERROR: patch path escapes rootPath: ${relPatchPath}`;
      }
      const policyError = codeWritePolicyError({ ctx, targetPath });
      if (policyError) return policyError;
    }

    const tempDir = path.join(ctx.stateDir, "tmp", "file-patch");
    await fs.mkdir(tempDir, { recursive: true });
    const tempPatchPath = path.join(
      tempDir,
      `patch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.diff`,
    );

    try {
      await fs.writeFile(tempPatchPath, patch, "utf8");
      const applyResult = await runGitApply({
        cwd: fullRootPath,
        patchPath: tempPatchPath,
        strip,
        checkOnly,
      });
      if (!applyResult.ok) return applyResult.error;

      const changed = patchPaths.join(", ");
      const detail = truncatePatchCommandOutput([applyResult.stdout, applyResult.stderr].filter(Boolean).join("\n"));
      if (checkOnly) {
        return `OK: patch check passed for ${patchPaths.length} file(s): ${changed}`;
      }
      return detail
        ? `OK: patch applied to ${patchPaths.length} file(s): ${changed}\n\n${detail}`
        : `OK: patch applied to ${patchPaths.length} file(s): ${changed}`;
    } finally {
      try {
        await fs.rm(tempPatchPath, { force: true });
      } catch {
        // ignore temp cleanup failures
      }
    }
  },
});

export const fileEditLines = defineTool({
  name: "file_edit_lines",
  description: "Edit a file by replacing a 1-based line range (inclusive). Absolute path is required.",
  parameters: z.object({
    path: z.string().describe("Absolute file path (required)."),
    startLine: z.number().int().positive().describe("1-based start line"),
    endLine: z.number().int().positive().optional().describe("1-based end line (inclusive, defaults to startLine)"),
    content: z.string().describe("Replacement text (empty string deletes the range)"),
  }),
  execute: async ({ path: inputPath, startLine, endLine, content }, ctx) => {
    const resolved = resolveAbsolutePath({ ctx, inputPath });
    if (!resolved.ok) return resolved.error;
    const fullPath = resolved.fullPath;
    const policyError = codeWritePolicyError({ ctx, targetPath: fullPath });
    if (policyError) return policyError;
    const text = await fs.readFile(fullPath, "utf8");
    const rawLines = text.split(/\r?\n/);
    const hadTrailingNewline = text.endsWith("\n");
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = hadTrailingNewline ? rawLines.slice(0, -1) : rawLines;

    const startIdx = startLine - 1;
    const endIdx = (endLine ?? startLine) - 1;
    if (startIdx < 0 || startIdx >= lines.length) {
      return `ERROR: startLine out of range (1-${lines.length})`;
    }
    if (endIdx < startIdx) {
      return "ERROR: endLine must be >= startLine";
    }
    if (endIdx >= lines.length) {
      return `ERROR: endLine out of range (1-${lines.length})`;
    }

    const replacementLines = content.length === 0 ? [] : content.split(/\r?\n/);
    lines.splice(startIdx, endIdx - startIdx + 1, ...replacementLines);
    let next = lines.join(newline);
    if (hadTrailingNewline) next += newline;
    await fs.writeFile(fullPath, next, "utf8");
    return "OK";
  },
});
