import { z } from "zod";

import { defineTool } from "../core/tools.js";

export const paperTrade = defineTool({
  name: "paper_trade",
  description: "Record a paper trade decision (no real money).",
  parameters: z.object({
    instrument: z.string(),
    side: z.enum(["long", "short"]),
    size: z.number().positive().describe("Position size (units)"),
    entryPrice: z.number().positive().optional(),
    reasoning: z.string(),
  }),
  execute: async ({ instrument, side, size, entryPrice, reasoning }, ctx) => {
    const dbAny = ctx.db as any;
    if (!dbAny?.db) return "ERROR: database unavailable";
    dbAny.db
      .prepare(
        "INSERT INTO paper_trades (created_at, instrument, side, size, entry_price, exit_price, status, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(ctx.nowMs(), instrument, side, size, entryPrice ?? null, null, "open", reasoning);
    return "OK: paper trade recorded";
  },
});

export const portfolioStatus = defineTool({
  name: "portfolio_status",
  description: "Show recent paper trades.",
  parameters: z.object({
    limit: z.number().int().positive().default(20),
  }),
  execute: async ({ limit }, ctx) => {
    const dbAny = ctx.db as any;
    if (!dbAny?.db) return "ERROR: database unavailable";
    const rows = dbAny.db
      .prepare(
        "SELECT id, created_at, instrument, side, size, entry_price, status FROM paper_trades ORDER BY id DESC LIMIT ?",
      )
      .all(limit) as {
      id: number;
      created_at: number;
      instrument: string;
      side: string;
      size: number;
      entry_price: number | null;
      status: string;
    }[];

    if (rows.length === 0) return "No trades yet.";
    return rows
      .map((r) => `${r.id}\t${new Date(r.created_at).toISOString()}\t${r.instrument}\t${r.side}\t${r.size}\t${r.entry_price ?? ""}\t${r.status}`)
      .join("\n");
  },
});

