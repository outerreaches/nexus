import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import JSON5 from "json5";
import { z } from "zod";

import type { Tool, ToolContext } from "../core/tools.js";

const JsonSchema = z.record(z.unknown());

const CustomToolSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("shell"),
    name: z.string(),
    description: z.string(),
    parameters: JsonSchema,
    command: z.string(),
  }),
  z.object({
    kind: z.literal("http"),
    name: z.string(),
    description: z.string(),
    parameters: JsonSchema,
    url: z.string().url(),
    method: z.string().default("GET"),
    headers: z.record(z.string()).default({}),
    bodyTemplate: z.string().optional(),
  }),
]);

type CustomTool = z.infer<typeof CustomToolSchema>;

type ModuleToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: unknown, ctx: ToolContext) => Promise<string> | string;
};

function interpolate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_, key) => {
    const v = (vars as any)[key];
    if (v === undefined || v === null) return "";
    if (typeof v === "string") return v;
    return JSON.stringify(v);
  });
}

async function loadCustomToolFile(filePath: string): Promise<CustomTool> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON5.parse(raw) as unknown;
  return CustomToolSchema.parse(parsed);
}

async function loadCustomModuleTool(filePath: string): Promise<Tool> {
  const url = pathToFileURL(filePath).toString() + `?t=${Date.now()}`;
  const mod = (await import(url)) as any;
  const def = (mod?.default ?? mod) as ModuleToolDefinition;
  if (!def || typeof def !== "object") throw new Error("Module tool has no default export.");
  if (typeof def.name !== "string" || def.name.trim() === "") throw new Error("Module tool missing name.");
  if (typeof def.description !== "string") throw new Error("Module tool missing description.");
  if (!def.parameters || typeof def.parameters !== "object") throw new Error("Module tool missing parameters.");
  if (typeof def.execute !== "function") throw new Error("Module tool missing execute().");

  return {
    name: def.name,
    description: def.description,
    jsonSchema: def.parameters,
    execute: async (args: unknown, ctx: ToolContext) => {
      const out = await def.execute(args, ctx);
      return typeof out === "string" ? out : JSON.stringify(out);
    },
  };
}

export async function loadCustomTools(stateDir: string): Promise<Tool[]> {
  const toolsDir = path.join(stateDir, "tools");
  await fs.mkdir(toolsDir, { recursive: true });

  const entries = await fs.readdir(toolsDir, { withFileTypes: true });
  const jsonToolFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".tool.json"))
    .map((e) => path.join(toolsDir, e.name));

  const moduleToolFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".tool.mjs"))
    .map((e) => path.join(toolsDir, e.name));

  const tools: Tool[] = [];
  for (const filePath of jsonToolFiles) {
    try {
      const tool = await loadCustomToolFile(filePath);
      tools.push(toTool(tool));
    } catch (err) {
      console.warn(`Skipping custom tool ${filePath}:`, err);
    }
  }

  for (const filePath of moduleToolFiles) {
    try {
      tools.push(await loadCustomModuleTool(filePath));
    } catch (err) {
      console.warn(`Skipping custom module tool ${filePath}:`, err);
    }
  }
  return tools;
}

function toTool(tool: CustomTool): Tool {
  const execute = async (args: unknown, ctx: ToolContext): Promise<string> => {
    const vars = (args && typeof args === "object") ? (args as Record<string, unknown>) : {};
    if (tool.kind === "shell") {
      if (!ctx.allowShellExec) return "ERROR: shell tools are disabled by policy";
      // Delegate to the built-in shell tool implementation by spawning via node's shell tool, if enabled.
      const { exec } = await import("node:child_process");
      const command = interpolate(tool.command, vars);
      return await new Promise((resolve) => {
        exec(command, { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) resolve(`ERROR: ${err.message}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`);
          else resolve([stdout, stderr].filter(Boolean).join("\n"));
        });
      });
    }

    const url = interpolate(tool.url, vars);
    const body = tool.bodyTemplate ? interpolate(tool.bodyTemplate, vars) : undefined;
    const res = await fetch(url, {
      method: tool.method,
      headers: { ...tool.headers, ...(body ? { "Content-Type": tool.headers["Content-Type"] ?? "application/json" } : {}) },
      body,
    });
    const text = await res.text().catch(() => "");
    if (!res.ok) return `ERROR: ${res.status} ${res.statusText}${text ? `\n\n${text}` : ""}`;
    return text;
  };

  return {
    name: tool.name,
    description: tool.description,
    jsonSchema: tool.parameters,
    execute,
  };
}
