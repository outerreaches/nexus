import { z } from "zod";

import { defineTool } from "../core/tools.js";

export const planTask = defineTool({
  name: "plan_task",
  description:
    "Create a task plan before using other tools. Classify complexity, list steps, and identify parallel groups. " +
    "Must be called once at the start of a run.",
  parameters: z.object({
    complexity: z.enum(["simple", "complex"]).describe("simple: answer directly; complex: requires multiple steps/tools"),
    steps: z.array(z.string().min(1)).min(1).max(12).describe("Ordered list of steps to complete the task"),
    parallelGroups: z
      .array(z.array(z.string().min(1)).min(1).max(6))
      .max(6)
      .optional()
      .describe("Optional groups of steps that can run in parallel"),
  }),
  execute: async (args, ctx) => {
    if (ctx.planState?.completed) {
      return "ERROR: plan already exists for this run";
    }
    ctx.planState = {
      completed: true,
      complexity: args.complexity,
      steps: args.steps,
      parallelGroups: args.parallelGroups,
      createdAt: ctx.nowMs(),
    };
    return JSON.stringify(
      {
        ok: true,
        complexity: args.complexity,
        steps: args.steps,
        parallelGroups: args.parallelGroups ?? [],
      },
      null,
      2,
    );
  },
});
