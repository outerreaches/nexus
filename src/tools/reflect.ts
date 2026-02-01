import { z } from "zod";

import { defineTool } from "../core/tools.js";
import type { NexusDatabase } from "../storage/database.js";

function requireDb(ctx: { db?: unknown }): NexusDatabase | null {
  return (ctx.db as NexusDatabase | undefined) ?? null;
}

function currentAgentId(ctx: { request?: { agentId: string } }): string {
  return ctx.request?.agentId ? String(ctx.request.agentId) : "main";
}

export const reflect = defineTool({
  name: "reflect",
  description:
    "Review recent conversation history from the current session and generate a structured reflection. " +
    "Extracts key decisions, learnings, and action items. Use this periodically (e.g. during heartbeat ticks) " +
    "to build long-term memory from conversations. Store important findings with memory_store.",
  parameters: z.object({
    maxMessages: z.number().int().min(10).max(200).default(50).describe("How many recent messages to review"),
  }),
  execute: async (args, ctx) => {
    const db = requireDb(ctx);
    if (!db) return "ERROR: database is not available";

    const sessionId = ctx.request?.sessionId;
    if (!sessionId) return "ERROR: no active session (reflect must be called within a conversation)";

    const agentId = currentAgentId(ctx);

    // Load recent messages from this session
    const rows = db.db
      .prepare(
        "SELECT role, content, name FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(sessionId, args.maxMessages) as { role: string; content: string; name: string | null }[];

    if (rows.length < 5) return "Not enough conversation history to reflect on (need at least 5 messages).";

    // Reverse to chronological order
    rows.reverse();

    // Build a summary of the conversation for the agent to analyze
    const conversationSummary: string[] = [];
    let userMsgCount = 0;
    let assistantMsgCount = 0;
    let toolCallCount = 0;
    const toolsUsed = new Set<string>();
    const topics: string[] = [];

    for (const row of rows) {
      if (row.role === "user") {
        userMsgCount++;
        // Extract first 150 chars of user messages as topic hints
        const preview = row.content.slice(0, 150).replace(/\n/g, " ").trim();
        if (preview && !preview.startsWith("HEARTBEAT") && !preview.startsWith("SCHEDULED JOB")) {
          topics.push(preview);
        }
      } else if (row.role === "assistant") {
        assistantMsgCount++;
      } else if (row.role === "tool") {
        toolCallCount++;
        if (row.name) toolsUsed.add(row.name);
      }
    }

    // Check existing memories to avoid duplication
    const existingMemories = db.db
      .prepare("SELECT key FROM memories WHERE agent_id = ? ORDER BY updated_at DESC LIMIT 20")
      .all(agentId) as { key: string }[];
    const existingKeys = existingMemories.map((m) => m.key);

    const report = [
      "# Reflection Report",
      "",
      `**Session**: ${sessionId}`,
      `**Messages reviewed**: ${rows.length} (${userMsgCount} user, ${assistantMsgCount} assistant, ${toolCallCount} tool)`,
      `**Tools used**: ${toolsUsed.size > 0 ? [...toolsUsed].join(", ") : "none"}`,
      "",
      "## Conversation Topics",
      ...topics.slice(0, 10).map((t, i) => `${i + 1}. ${t}`),
      "",
      "## Existing Memories",
      existingKeys.length > 0
        ? existingKeys.map((k) => `- ${k}`).join("\n")
        : "(none yet)",
      "",
      "## Instructions",
      "Based on this session review, you should now:",
      "1. Identify key decisions, learnings, or preferences expressed by the user",
      "2. Store important findings using `memory_store` (avoid duplicating existing memories)",
      "3. Note any action items or follow-ups in NOTES.md",
      "4. If you learned a reusable workflow, consider creating a skill with `skill_create`",
      "5. If any of your prompt files (SOUL.md, AGENTS.md, etc.) should be updated based on learnings, do so",
    ];

    return report.join("\n");
  },
});
