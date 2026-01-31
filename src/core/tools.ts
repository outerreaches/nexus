import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export type ToolContext = {
  workspaceDir: string;
  stateDir: string;
  codeDir: string;
  db?: unknown;
  browser?: unknown;
  registry?: unknown;
  processManager?: unknown;
  telegram?: unknown;
  allowShellExec?: boolean;
  allowCodeEdit?: boolean;
  requestRestart?: (reason: string, delayMs?: number) => void;
  request?: { channel: string; channelKey: string; agentId: string; sessionId: string };
  nowMs: () => number;
  log: (msg: string) => void;
};

export type ToolDefinition<TParams extends z.ZodTypeAny> = {
  name: string;
  description: string;
  parameters: TParams;
  execute: (args: z.infer<TParams>, ctx: ToolContext) => Promise<string>;
};

export type Tool = {
  name: string;
  description: string;
  jsonSchema: Record<string, unknown>;
  execute: (args: unknown, ctx: ToolContext) => Promise<string>;
};

export function defineTool<TParams extends z.ZodTypeAny>(def: ToolDefinition<TParams>): Tool {
  // OpenAI tool schemas expect JSON Schema (Draft 7-ish). In particular, they require
  // `exclusiveMinimum`/`exclusiveMaximum` to be numbers (not booleans like OpenAPI 3.0).
  const jsonSchema = zodToJsonSchema(def.parameters, {
    target: "jsonSchema7",
  }) as unknown as Record<string, unknown>;
  return {
    name: def.name,
    description: def.description,
    jsonSchema,
    execute: async (args: unknown, ctx: ToolContext) => {
      const parsed = def.parameters.parse(args) as z.infer<TParams>;
      return def.execute(parsed, ctx);
    },
  };
}
