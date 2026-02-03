import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import { resolveWithinRoots } from "./path-utils.js";

const MAX_READ_LINES = 200;
const MAX_READ_BYTES = 24 * 1024;
const DIFF_CONTEXT_LINES = 3;
const FILE_ROOTS = ["workspace", "state", "code"] as const;
type FileRoot = (typeof FILE_ROOTS)[number];
const FILE_ROOT_SET = new Set<string>(FILE_ROOTS);

function splitRootPrefix(value: string): { root: FileRoot; path: string } | null {
  const trimmed = value.trim().replace(/^[\\/]+/, "");
  if (!trimmed) return null;
  const parts = trimmed.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const maybeRoot = parts[0];
  if (!FILE_ROOT_SET.has(maybeRoot)) return null;
  return { root: maybeRoot as FileRoot, path: parts.slice(1).join("/") };
}

function coerceRootAndPath(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const obj = { ...(input as Record<string, unknown>) };
  const rawRoot = typeof obj.root === "string" ? obj.root.trim() : undefined;
  const rawPath = typeof obj.path === "string" ? obj.path.trim() : undefined;

  let root: string | undefined = rawRoot;
  let pathValue: string | undefined = rawPath;

  if (root) {
    const fromRoot = splitRootPrefix(root);
    if (fromRoot) {
      root = fromRoot.root;
      if (!pathValue || pathValue === "." || pathValue === "") {
        pathValue = fromRoot.path || undefined;
      }
    }
  }

  const rootIsValid = root ? FILE_ROOT_SET.has(root) : false;
  if ((!root || !rootIsValid) && pathValue) {
    const fromPath = splitRootPrefix(pathValue);
    if (fromPath) {
      root = fromPath.root;
      pathValue = fromPath.path || undefined;
    }
  }

  if (root) obj.root = root;
  if (pathValue) obj.path = pathValue;
  return obj;
}

function withRootPathCoercion<T extends z.ZodTypeAny>(schema: T): z.ZodEffects<T, z.infer<T>, unknown> {
  return z.preprocess(coerceRootAndPath, schema);
}

function rootPrefixHint(root: FileRoot, inputPath: string): string | null {
  const parsed = splitRootPrefix(inputPath);
  if (!parsed || parsed.root === root) return null;
  const hintedPath = parsed.path || ".";
  return `ERROR: path looks rooted. Use root="${parsed.root}" and path="${hintedPath}".`;
}

function isErrCode(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: string }).code === code);
}

function truncateByBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return { text, truncated: false };
  }
  return { text: buffer.subarray(0, maxBytes).toString("utf8"), truncated: true };
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
    const inAfter = i >= start && i <= endAfter;
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
  const trimmed = truncateByBytes(diffText, 4000);
  return trimmed.truncated ? `${trimmed.text}\n[diff truncated]` : trimmed.text;
}

export const fileRead = defineTool({
  name: "file_read",
  description:
    "Read a text file from the workspace/state/code roots (optionally with line ranges). " +
    `Output is truncated to ${MAX_READ_LINES} lines or ${Math.round(MAX_READ_BYTES / 1024)}KB; ` +
    "use startLine/endLine or offset/limit to continue. " +
    "Example: root='code', path='src/core/prompt.ts'.",
  parameters: withRootPathCoercion(
    z.object({
      root: z.enum(FILE_ROOTS).default("workspace"),
      path: z.string().describe("File path (relative to root, or absolute within allowed roots)"),
      startLine: z.number().int().positive().optional().describe("1-based start line"),
      endLine: z.number().int().positive().optional().describe("1-based end line (inclusive)"),
      offset: z.number().int().positive().optional().describe("1-based line offset (pi-style)"),
      limit: z.number().int().positive().optional().describe("Maximum number of lines to read (pi-style)"),
      withLineNumbers: z.boolean().default(false).describe("Prefix lines with 1-based line numbers (e.g., '12: ...')."),
    }),
  ),
  execute: async (
    { root, path: inputPath, startLine, endLine, offset, limit, withLineNumbers },
    ctx,
  ) => {
    if (root === "code" && !ctx.allowCodeEdit) return "ERROR: code root is disabled by policy";
    const allowedRoots = [ctx.workspaceDir, ctx.stateDir, ...(ctx.allowCodeEdit ? [ctx.codeDir] : [])];
    const baseRoot = root === "workspace" ? ctx.workspaceDir : root === "state" ? ctx.stateDir : ctx.codeDir;
    const fullPath = resolveWithinRoots({
      inputPath,
      defaultRoot: baseRoot,
      roots: allowedRoots,
    });
    let text: string;
    try {
      text = await fs.readFile(fullPath, "utf8");
    } catch (err) {
      if (isErrCode(err, "ENOENT") || isErrCode(err, "ENOTDIR")) {
        const hint = rootPrefixHint(root, inputPath);
        if (hint) return hint;
      }
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
    const wantsRange = Boolean(startLine || endLine || withLineNumbers);
    if (!wantsRange) return text;
    const rawLines = text.split(/\r?\n/);
    const hadTrailingNewline = text.endsWith("\n");
    const lines = hadTrailingNewline ? rawLines.slice(0, -1) : rawLines;
    const resolvedStartLine = startLine ?? offset;
    const resolvedEndLine = endLine ?? (resolvedStartLine && limit ? resolvedStartLine + limit - 1 : undefined);
    const start = Math.max((resolvedStartLine ?? 1) - 1, 0);
    const end = Math.min((resolvedEndLine ?? lines.length) - 1, lines.length - 1);
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
    "Write a text file to the workspace/state/code roots (creates parent dirs). " +
    "Use mode 'create' (default) for new files, 'append' to add to existing files, " +
    "or 'overwrite' to replace existing files entirely. To modify part of a file, use file_edit instead.",
  parameters: withRootPathCoercion(
    z.object({
      root: z.enum(FILE_ROOTS).default("workspace"),
      path: z.string().describe("File path (relative to root, or absolute within allowed roots)"),
      content: z.string().describe("File contents"),
      mode: z
        .enum(["create", "overwrite", "append"])
        .default("create")
        .describe("'create' fails if file exists, 'overwrite' replaces, 'append' adds to end"),
    }),
  ),
  execute: async ({ root, path: inputPath, content, mode }, ctx) => {
    if (root === "code" && !ctx.allowCodeEdit) return "ERROR: code root is disabled by policy";
    const allowedRoots = [ctx.workspaceDir, ctx.stateDir, ...(ctx.allowCodeEdit ? [ctx.codeDir] : [])];
    const baseRoot = root === "workspace" ? ctx.workspaceDir : root === "state" ? ctx.stateDir : ctx.codeDir;
    const fullPath = resolveWithinRoots({
      inputPath,
      defaultRoot: baseRoot,
      roots: allowedRoots,
    });
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    // Check if file exists for create mode
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
  description: "List files/directories under the workspace/state/code roots. Example: root='code', path='src'.",
  parameters: withRootPathCoercion(
    z.object({
      root: z.enum(FILE_ROOTS).default("workspace"),
      path: z.string().default(".").describe("Directory path (relative to root, or absolute within allowed roots)"),
      recursive: z.boolean().default(false),
      maxEntries: z.number().int().positive().default(200),
    }),
  ),
  execute: async ({ root, path: inputPath, recursive, maxEntries }, ctx) => {
    if (root === "code" && !ctx.allowCodeEdit) return "ERROR: code root is disabled by policy";
    const allowedRoots = [ctx.workspaceDir, ctx.stateDir, ...(ctx.allowCodeEdit ? [ctx.codeDir] : [])];
    const baseRoot = root === "workspace" ? ctx.workspaceDir : root === "state" ? ctx.stateDir : ctx.codeDir;
    const fullPath = resolveWithinRoots({
      inputPath,
      defaultRoot: baseRoot,
      roots: allowedRoots,
    });

    const results: string[] = [];
    async function walk(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const rel = path.relative(fullPath, path.join(dir, entry.name));
        results.push(entry.isDirectory() ? `${rel}/` : rel);
        if (results.length >= maxEntries) return;
        if (recursive && entry.isDirectory()) {
          await walk(path.join(dir, entry.name));
          if (results.length >= maxEntries) return;
        }
      }
    }

    try {
      await walk(fullPath);
    } catch (err) {
      if (isErrCode(err, "ENOENT") || isErrCode(err, "ENOTDIR")) {
        const hint = rootPrefixHint(root, inputPath);
        if (hint) return hint;
      }
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
    return results.join("\n");
  },
});

export const fileEdit = defineTool({
  name: "file_edit",
  description:
    "Edit a file by replacing an exact, unique string match (workspace/state/code roots). " +
    "The find text must match exactly and appear only once. Returns a diff of the change.",
  parameters: withRootPathCoercion(
    z.object({
      root: z.enum(FILE_ROOTS).default("workspace"),
      path: z.string().describe("File path (relative to root, or absolute within allowed roots)"),
      find: z.string().describe("Exact text to find"),
      replace: z.string().describe("Replacement text"),
    }),
  ),
  execute: async ({ root, path: inputPath, find, replace }, ctx) => {
    if (root === "code" && !ctx.allowCodeEdit) return "ERROR: code root is disabled by policy";
    const allowedRoots = [ctx.workspaceDir, ctx.stateDir, ...(ctx.allowCodeEdit ? [ctx.codeDir] : [])];
    const baseRoot = root === "workspace" ? ctx.workspaceDir : root === "state" ? ctx.stateDir : ctx.codeDir;
    const fullPath = resolveWithinRoots({
      inputPath,
      defaultRoot: baseRoot,
      roots: allowedRoots,
    });
    if (find.length === 0) {
      return "ERROR: find text must be non-empty.";
    }
    const text = await fs.readFile(fullPath, "utf8");
    const idx = text.indexOf(find);
    if (idx === -1) {
      return "ERROR: find text not found. Use file_read with withLineNumbers:true, then use file_edit_lines to edit by line range instead. To append new content, use file_write with mode 'append'.";
    }
    const occurrences = text.split(find).length - 1;
    if (occurrences > 1) {
      return `ERROR: find text is not unique (${occurrences} matches). Provide more context to make it unique.`;
    }
    const next = text.slice(0, idx) + replace + text.slice(idx + find.length);
    if (next === text) {
      return "ERROR: replacement produced no changes. Check the find/replace text for exact matches.";
    }
    await fs.writeFile(fullPath, next, "utf8");
    const diff = buildLineDiff(text, next);
    return `OK\n\nDiff:\n${diff}`;
  },
});

export const fileEditLines = defineTool({
  name: "file_edit_lines",
  description: "Edit a file by replacing a 1-based line range (inclusive).",
  parameters: withRootPathCoercion(
    z.object({
      root: z.enum(FILE_ROOTS).default("workspace"),
      path: z.string().describe("File path (relative to root, or absolute within allowed roots)"),
      startLine: z.number().int().positive().describe("1-based start line"),
      endLine: z.number().int().positive().optional().describe("1-based end line (inclusive, defaults to startLine)"),
      content: z.string().describe("Replacement text (empty string deletes the range)"),
    }),
  ),
  execute: async ({ root, path: inputPath, startLine, endLine, content }, ctx) => {
    if (root === "code" && !ctx.allowCodeEdit) return "ERROR: code root is disabled by policy";
    const allowedRoots = [ctx.workspaceDir, ctx.stateDir, ...(ctx.allowCodeEdit ? [ctx.codeDir] : [])];
    const baseRoot = root === "workspace" ? ctx.workspaceDir : root === "state" ? ctx.stateDir : ctx.codeDir;
    const fullPath = resolveWithinRoots({
      inputPath,
      defaultRoot: baseRoot,
      roots: allowedRoots,
    });
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
