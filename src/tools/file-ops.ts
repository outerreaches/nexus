import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { defineTool } from "../core/tools.js";
import { resolveWithinRoots } from "./path-utils.js";

export const fileRead = defineTool({
  name: "file_read",
  description: "Read a text file from the workspace/state/code roots (optionally with line ranges).",
  parameters: z.object({
    root: z.enum(["workspace", "state", "code"]).default("workspace"),
    path: z.string().describe("File path (relative to root, or absolute within allowed roots)"),
    startLine: z.number().int().positive().optional().describe("1-based start line"),
    endLine: z.number().int().positive().optional().describe("1-based end line (inclusive)"),
    withLineNumbers: z.boolean().default(false).describe("Prefix lines with 1-based line numbers (e.g., '12: ...')."),
  }),
  execute: async ({ root, path: inputPath, startLine, endLine, withLineNumbers }, ctx) => {
    if (root === "code" && !ctx.allowCodeEdit) return "ERROR: code root is disabled by policy";
    const allowedRoots = [ctx.workspaceDir, ctx.stateDir, ...(ctx.allowCodeEdit ? [ctx.codeDir] : [])];
    const baseRoot = root === "workspace" ? ctx.workspaceDir : root === "state" ? ctx.stateDir : ctx.codeDir;
    const fullPath = resolveWithinRoots({
      inputPath,
      defaultRoot: baseRoot,
      roots: allowedRoots,
    });
    const text = await fs.readFile(fullPath, "utf8");
    const wantsRange = Boolean(startLine || endLine || withLineNumbers);
    if (!wantsRange) return text;
    const rawLines = text.split(/\r?\n/);
    const hadTrailingNewline = text.endsWith("\n");
    const lines = hadTrailingNewline ? rawLines.slice(0, -1) : rawLines;
    const start = Math.max((startLine ?? 1) - 1, 0);
    const end = Math.min((endLine ?? lines.length) - 1, lines.length - 1);
    const slice = lines.slice(start, end + 1);
    if (!withLineNumbers) return slice.join("\n");
    return slice.map((line, i) => `${start + i + 1}: ${line}`).join("\n");
  },
});

export const fileWrite = defineTool({
  name: "file_write",
  description: "Write a text file to the workspace/state/code roots (creates parent dirs).",
  parameters: z.object({
    root: z.enum(["workspace", "state", "code"]).default("workspace"),
    path: z.string().describe("File path (relative to root, or absolute within allowed roots)"),
    content: z.string().describe("File contents"),
    mode: z.enum(["overwrite", "append"]).default("overwrite"),
  }),
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
  description: "List files/directories under the workspace/state/code roots.",
  parameters: z.object({
    root: z.enum(["workspace", "state", "code"]).default("workspace"),
    path: z.string().default(".").describe("Directory path (relative to root, or absolute within allowed roots)"),
    recursive: z.boolean().default(false),
    maxEntries: z.number().int().positive().default(200),
  }),
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

    await walk(fullPath);
    return results.join("\n");
  },
});

export const fileEdit = defineTool({
  name: "file_edit",
  description: "Edit a file by replacing the first occurrence of a string (workspace/state/code roots).",
  parameters: z.object({
    root: z.enum(["workspace", "state", "code"]).default("workspace"),
    path: z.string().describe("File path (relative to root, or absolute within allowed roots)"),
    find: z.string().describe("Exact text to find"),
    replace: z.string().describe("Replacement text"),
  }),
  execute: async ({ root, path: inputPath, find, replace }, ctx) => {
    if (root === "code" && !ctx.allowCodeEdit) return "ERROR: code root is disabled by policy";
    const allowedRoots = [ctx.workspaceDir, ctx.stateDir, ...(ctx.allowCodeEdit ? [ctx.codeDir] : [])];
    const baseRoot = root === "workspace" ? ctx.workspaceDir : root === "state" ? ctx.stateDir : ctx.codeDir;
    const fullPath = resolveWithinRoots({
      inputPath,
      defaultRoot: baseRoot,
      roots: allowedRoots,
    });
    const text = await fs.readFile(fullPath, "utf8");
    const idx = text.indexOf(find);
    if (idx === -1) return "ERROR: find text not found";
    const next = text.slice(0, idx) + replace + text.slice(idx + find.length);
    await fs.writeFile(fullPath, next, "utf8");
    return "OK";
  },
});

export const fileEditLines = defineTool({
  name: "file_edit_lines",
  description: "Edit a file by replacing a 1-based line range (inclusive).",
  parameters: z.object({
    root: z.enum(["workspace", "state", "code"]).default("workspace"),
    path: z.string().describe("File path (relative to root, or absolute within allowed roots)"),
    startLine: z.number().int().positive().describe("1-based start line"),
    endLine: z.number().int().positive().optional().describe("1-based end line (inclusive, defaults to startLine)"),
    content: z.string().describe("Replacement text (empty string deletes the range)"),
  }),
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
