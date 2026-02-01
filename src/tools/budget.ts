import { z } from "zod";

import { defineTool } from "../core/tools.js";

export const budgetStatus = defineTool({
  name: "budget_status",
  description:
    "Check remaining budget for this run (iterations and tool calls). Use this to decide whether to wrap up or continue working on complex tasks.",
  parameters: z.object({}),
  execute: async (_args, ctx) => {
    const info = ctx.budgetInfo;
    if (!info) return "Budget info not available.";

    const iterPct = Math.round((info.iterationsUsed / info.maxIterations) * 100);
    const toolPct = Math.round((info.toolCallsUsed / info.maxToolCalls) * 100);

    return JSON.stringify(
      {
        iterations: { used: info.iterationsUsed, max: info.maxIterations, percent: iterPct },
        tool_calls: { used: info.toolCallsUsed, max: info.maxToolCalls, percent: toolPct },
        recommendation:
          iterPct >= 80 || toolPct >= 80
            ? "Budget is running low. Wrap up current task or summarize progress."
            : iterPct >= 50 || toolPct >= 50
              ? "Budget is about half used. Plan remaining steps carefully."
              : "Plenty of budget remaining.",
      },
      null,
      2,
    );
  },
});
