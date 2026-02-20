import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import { resolveWithinRoots } from "./path-utils.js";

const MAX_READ_LINES = 500;
const MAX_READ_BYTES = 64 * 1024;
const DIFF_CONTEXT_LINES = 3;
const ABSOLUTE_PATH_ERROR = "ERROR: full absolute `path` is required.";

type FileToolContext = {
  workspaceDir: string;
  stateDir: string;
  codeDir: string;
  allowCodeEdit?: boolean;
};

function allowedRoots(ctx: FileToolContext): string[] {
  return [ctx.stateDir, ctx.workspaceDir, ...(ctx.allowCodeEdit ? [ctx.codeDir] : [])];
}

function isUnderRoot(targetPath: string, rootDir: string): boolean {
  const rel = path.relative(rootDir, targetPath);
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
    "Read a text file (optionally with line ranges). Absolute path is required. " +
    `Output is truncated to ${MAX_READ_LINES} lines or ${Math.round(MAX_READ_BYTES / 1024)}KB; ` +
    "use startLine/endLine or offset/limit to continue.",
  parameters: z.object({
    path: z.string().describe("Absolute file path (required)."),
    startLine: z.number().int().positive().optional().describe("1-based start line"),
    endLine: z.number().int().positive().optional().describe("1-based end line (inclusive)"),
    offset: z.number().int().positive().optional().describe("1-based line offset (pi-style)"),
    limit: z.number().int().positive().optional().describe("Maximum number of lines to read (pi-style)"),
    withLineNumbers: z.boolean().default(false).describe("Prefix lines with 1-based line numbers (e.g., '12: ...')."),
  }),
  execute: async (
    { path: inputPath, startLine, endLine, offset, limit, withLineNumbers },
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
    if (isUnderRoot(fullPath, ctx.codeDir) && !ctx.allowCodeWrite) {
      return (
        "ERROR: code root is read-only in this runtime. " +
        "Enable host writable code mount and set NEXUS_ALLOW_CODE_WRITE=1 for direct code edits."
      );
    }
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
  description: "List files/directories. Absolute path is required.",
  parameters: z.object({
    path: z.string().describe("Absolute directory path (required)."),
    recursive: z.boolean().default(false),
    maxEntries: z.number().int().positive().default(200),
  }),
  execute: async ({ path: inputPath, recursive, maxEntries }, ctx) => {
    const resolved = resolveAbsolutePath({ ctx, inputPath });
    if (!resolved.ok) return resolved.error;
    const fullPath = resolved.fullPath;

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
      return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
    return results.join("\n");
  },
});

export const fileEdit = defineTool({
  name: "file_edit",
  description:
    "Edit a file by replacing an exact, unique string match. Absolute path is required. " +
    "The find text must match exactly and appear only once. Returns a diff of the change.",
  parameters: z.object({
    path: z.string().describe("Absolute file path (required)."),
    find: z.string().describe("Exact text to find"),
    replace: z.string().describe("Replacement text"),
  }),
  execute: async ({ path: inputPath, find, replace }, ctx) => {
    const resolved = resolveAbsolutePath({ ctx, inputPath });
    if (!resolved.ok) return resolved.error;
    const fullPath = resolved.fullPath;
    if (isUnderRoot(fullPath, ctx.codeDir) && !ctx.allowCodeWrite) {
      return (
        "ERROR: code root is read-only in this runtime. " +
        "Enable host writable code mount and set NEXUS_ALLOW_CODE_WRITE=1 for direct code edits."
      );
    }
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
    if (isUnderRoot(fullPath, ctx.codeDir) && !ctx.allowCodeWrite) {
      return (
        "ERROR: code root is read-only in this runtime. " +
        "Enable host writable code mount and set NEXUS_ALLOW_CODE_WRITE=1 for direct code edits."
      );
    }
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
